const express = require('express');
const { query, withTx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { round2, toNum, eq2 } = require('../lib/money');
const { applyMovement, getQtyOnHand } = require('../lib/inventory');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const params = [];
    const where = [`s.status = 'completed'`];

    if (req.query.credit_status) {
      params.push(req.query.credit_status);
      where.push(`s.credit_status = $${params.length}`);
    }
    if (req.query.customer_id) {
      params.push(Number(req.query.customer_id));
      where.push(`s.customer_id = $${params.length}`);
    }
    if (req.query.location_id) {
      params.push(Number(req.query.location_id));
      where.push(`s.location_id = $${params.length}`);
    }
    if (req.query.source_location_id) {
      params.push(Number(req.query.source_location_id));
      where.push(`s.source_location_id = $${params.length}`);
    }
    if (req.query.has_delivery === 'true' || req.query.has_delivery === 'false') {
      params.push(req.query.has_delivery === 'true');
      where.push(`s.has_delivery = $${params.length}`);
    }
    if (req.query.date) {
      params.push(req.query.date);
      where.push(`s.created_at::date = $${params.length}::date`);
    }
    if (req.query.from) {
      params.push(req.query.from);
      where.push(`s.created_at >= $${params.length}::timestamptz`);
    }
    if (req.query.to) {
      params.push(req.query.to);
      where.push(`s.created_at < $${params.length}::timestamptz`);
    }

    const { rows } = await query(
      `SELECT s.id, s.location_id, s.source_location_id, s.has_delivery,
              s.seller_id, s.customer_id,
              s.status, s.subtotal, s.discount, s.total,
              s.paid_cash, s.paid_card, s.paid_total,
              s.credit_total, s.credit_status, s.created_at,
              c.full_name AS customer_name, u.full_name AS seller_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       JOIN users u ON u.id = s.seller_id
       WHERE ${where.join(' AND ')}
       ORDER BY s.created_at DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows: sales } = await query(
      `SELECT s.*, c.full_name AS customer_name, u.full_name AS seller_name
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
       JOIN users u ON u.id = s.seller_id
       WHERE s.id = $1`,
      [req.params.id]
    );
    if (!sales[0]) throw notFound('sale_not_found');

    const { rows: items } = await query(
      `SELECT si.*, p.name AS product_name, p.sku
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
       WHERE si.sale_id = $1
       ORDER BY si.id`,
      [req.params.id]
    );

    const { rows: installments } = await query(
      `SELECT id, installment_no, due_date, amount_due, amount_paid, status, paid_at
       FROM credit_installments
       WHERE sale_id = $1
       ORDER BY installment_no`,
      [req.params.id]
    );

    const { rows: deliveries } = await query(
      `SELECT id, status, address, recipient_name, recipient_phone, note, created_at, updated_at
       FROM deliveries WHERE sale_id = $1`,
      [req.params.id]
    );

    res.json({ ...sales[0], items, installments, delivery: deliveries[0] || null });
  } catch (e) {
    next(e);
  }
});

router.post('/', requireRole('owner', 'seller'), async (req, res, next) => {
  try {
    const locationId = Number(req.body.location_id);
    const sourceLocationId = Number(req.body.source_location_id || req.body.location_id);
    const sellerId = Number(req.body.seller_id || req.user.id);
    const customerId = req.body.customer_id != null ? Number(req.body.customer_id) : null;
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const payments = req.body.payments || {};
    const cash = round2(payments.cash ?? 0);
    const card = round2(payments.card ?? 0);
    const discount = round2(req.body.discount ?? 0);
    const allowNegativeStock = Boolean(req.body.allow_negative_stock);
    const hasDelivery = Boolean(req.body.has_delivery);
    const delivery = req.body.delivery || {};

    if (!locationId) throw badRequest('location_id_required');
    if (!sourceLocationId) throw badRequest('source_location_id_required');
    if (!items.length) throw badRequest('items_required');
    if (cash < 0 || card < 0 || discount < 0) throw badRequest('amounts_must_be_nonnegative');
    if (hasDelivery && !String(delivery.address || '').trim()) {
      throw badRequest('delivery_address_required');
    }

    const result = await withTx(async (tx) => {
      const loc = await tx.query(
        `SELECT id FROM locations WHERE id = $1 AND is_active`,
        [locationId]
      );
      if (!loc.rows[0]) throw notFound('location_not_found');
      const src = await tx.query(
        `SELECT id FROM locations WHERE id = $1 AND is_active`,
        [sourceLocationId]
      );
      if (!src.rows[0]) throw notFound('source_location_not_found');

      if (customerId) {
        const c = await tx.query(`SELECT id FROM customers WHERE id = $1 FOR UPDATE`, [customerId]);
        if (!c.rows[0]) throw notFound('customer_not_found');
      }

      let subtotal = 0;
      const normalized = [];

      for (const it of items) {
        const productId = Number(it.product_id);
        const qty = toNum(it.qty);
        if (!productId || qty <= 0) throw badRequest('invalid_item');

        const prod = await tx.query(
          `SELECT id, retail_price, is_active FROM products WHERE id = $1`,
          [productId]
        );
        if (!prod.rows[0] || !prod.rows[0].is_active) throw badRequest('product_inactive_or_missing');

        const unitPrice = it.unit_price != null ? round2(it.unit_price) : round2(prod.rows[0].retail_price);
        if (unitPrice < 0) throw badRequest('invalid_unit_price');

        const lineTotal = round2(qty * unitPrice);
        subtotal = round2(subtotal + lineTotal);
        normalized.push({ productId, qty, unitPrice, lineTotal });
      }

      const total = round2(Math.max(0, subtotal - discount));
      const paidTotal = round2(cash + card);
      if (paidTotal > total) throw badRequest('paid_exceeds_total');

      const creditTotal = round2(Math.max(0, total - paidTotal));

      // Qoida: nasiya bo'lsa customer majburiy
      if (creditTotal > 0 && !customerId) {
        throw badRequest('customer_required_for_credit');
      }

      const creditStatus = creditTotal > 0 ? 'schedule_pending' : 'none';

      const saleIns = await tx.query(
        `INSERT INTO sales
           (location_id, source_location_id, has_delivery,
            seller_id, customer_id, status,
            subtotal, discount, total,
            paid_cash, paid_card, paid_total,
            credit_total, credit_status)
         VALUES
           ($1,$2,$3,
            $4,$5,'completed',
            $6,$7,$8,
            $9,$10,$11,
            $12,$13)
         RETURNING *`,
        [
          locationId, sourceLocationId, hasDelivery,
          sellerId, customerId,
          subtotal, discount, total,
          cash, card, paidTotal,
          creditTotal, creditStatus,
        ]
      );
      const sale = saleIns.rows[0];

      for (const it of normalized) {
        await tx.query(
          `INSERT INTO sale_items (sale_id, product_id, qty, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5)`,
          [sale.id, it.productId, it.qty, it.unitPrice, it.lineTotal]
        );

        if (!allowNegativeStock) {
          const onHand = await getQtyOnHand(tx, sourceLocationId, it.productId);
          if (onHand < it.qty) {
            throw badRequest(
              'insufficient_stock',
              `product ${it.productId} source=${sourceLocationId}: on_hand=${onHand}, qty=${it.qty}`
            );
          }
        }

        await applyMovement(tx, {
          locationId: sourceLocationId,
          productId: it.productId,
          type: 'sale_out',
          qty: it.qty,
          refType: 'sale',
          refId: sale.id,
          createdBy: sellerId,
        });
      }

      let deliveryRow = null;
      if (hasDelivery) {
        const d = await tx.query(
          `INSERT INTO deliveries
             (sale_id, status, address, recipient_name, recipient_phone, note)
           VALUES ($1, 'new', $2, $3, $4, $5)
           RETURNING *`,
          [
            sale.id,
            String(delivery.address).trim(),
            delivery.recipient_name || null,
            delivery.recipient_phone || null,
            delivery.note || null,
          ]
        );
        deliveryRow = d.rows[0];
      }

      if (creditTotal > 0) {
        await tx.query(
          `UPDATE customers
           SET credit_balance = credit_balance + $1
           WHERE id = $2`,
          [creditTotal, customerId]
        );
      }

      return {
        sale_id: sale.id,
        source_location_id: sale.source_location_id,
        has_delivery: sale.has_delivery,
        total: sale.total,
        paid_total: sale.paid_total,
        credit_total: sale.credit_total,
        credit_status: sale.credit_status,
        delivery: deliveryRow,
      };
    });

    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/:id/installments', requireRole('owner', 'seller'), async (req, res, next) => {
  try {
    const saleId = Number(req.params.id);
    const installments = Array.isArray(req.body.installments) ? req.body.installments : [];
    if (!installments.length) throw badRequest('installments_required');

    const result = await withTx(async (tx) => {
      const saleRes = await tx.query(
        `SELECT id, customer_id, credit_total, credit_status
         FROM sales
         WHERE id = $1
         FOR UPDATE`,
        [saleId]
      );
      const sale = saleRes.rows[0];
      if (!sale) throw notFound('sale_not_found');
      if (!sale.customer_id) throw badRequest('customer_required');
      if (toNum(sale.credit_total) <= 0) throw badRequest('sale_has_no_credit');

      // MVP: once only
      if (sale.credit_status !== 'schedule_pending') {
        throw badRequest('schedule_already_set_or_not_pending');
      }

      const sumDue = round2(installments.reduce((s, x) => s + toNum(x.amount_due), 0));
      if (!eq2(sumDue, sale.credit_total)) {
        throw badRequest('sum_must_equal_credit_total', `sum=${sumDue} credit_total=${sale.credit_total}`);
      }

      let no = 1;
      const created = [];
      for (const inst of installments) {
        if (!inst.due_date) throw badRequest('due_date_required');
        if (toNum(inst.amount_due) <= 0) throw badRequest('amount_due_must_be_positive');

        const ins = await tx.query(
          `INSERT INTO credit_installments
             (sale_id, customer_id, installment_no, due_date, amount_due)
           VALUES ($1,$2,$3,$4,$5)
           RETURNING id, installment_no, due_date, amount_due, amount_paid, status`,
          [sale.id, sale.customer_id, no, inst.due_date, round2(inst.amount_due)]
        );
        created.push(ins.rows[0]);
        no += 1;
      }

      await tx.query(`UPDATE sales SET credit_status = 'active' WHERE id = $1`, [sale.id]);

      return { ok: true, sale_id: sale.id, credit_status: 'active', installments: created };
    });

    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
