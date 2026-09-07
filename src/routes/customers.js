const express = require('express');
const { query, withTx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { markOverdue } = require('../lib/credit');

const router = express.Router();

router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const params = [];
    let where = '';
    if (q) {
      params.push(`%${q}%`);
      where = `WHERE full_name ILIKE $1 OR COALESCE(phone,'') ILIKE $1`;
    }
    const { rows } = await query(
      `SELECT id, full_name, phone, note, credit_limit, credit_balance, created_at
       FROM customers
       ${where}
       ORDER BY id DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/', requireRole('owner', 'seller'), async (req, res, next) => {
  try {
    const { full_name, phone, note, credit_limit } = req.body || {};
    if (!full_name && !phone) throw badRequest('name_or_phone_required');

    const { rows } = await query(
      `INSERT INTO customers (full_name, phone, note, credit_limit)
       VALUES ($1,$2,$3,COALESCE($4,0))
       RETURNING id, full_name, phone, note, credit_limit, credit_balance, created_at`,
      [full_name || null, phone || null, note || null, credit_limit || 0]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', requireRole('owner', 'seller'), async (req, res, next) => {
  try {
    const fields = ['full_name', 'phone', 'note', 'credit_limit'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body[f] !== undefined) {
        params.push(req.body[f]);
        sets.push(`${f} = $${params.length}`);
      }
    }
    if (!sets.length) throw badRequest('no_fields');
    params.push(req.params.id);

    const { rows } = await query(
      `UPDATE customers SET ${sets.join(', ')}
       WHERE id = $${params.length}
       RETURNING id, full_name, phone, note, credit_limit, credit_balance, created_at`,
      params
    );
    if (!rows[0]) throw notFound('customer_not_found');
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

router.get('/:id/ledger', async (req, res, next) => {
  try {
    const customerId = Number(req.params.id);

    const ledger = await withTx(async (tx) => {
      const cust = await tx.query(
        `SELECT id, full_name, phone, note, credit_limit, credit_balance, created_at
         FROM customers WHERE id = $1`,
        [customerId]
      );
      if (!cust.rows[0]) throw notFound('customer_not_found');

      // A qoida: overdue faqat installment mavjud bo'lsa, read-time yangilanadi
      await markOverdue(tx, customerId);

      const sales = await tx.query(
        `SELECT id, location_id, seller_id, status, total,
                paid_cash, paid_card, paid_total, credit_total, credit_status, created_at
         FROM sales
         WHERE customer_id = $1
         ORDER BY created_at DESC
         LIMIT 200`,
        [customerId]
      );

      const installments = await tx.query(
        `SELECT id, sale_id, installment_no, due_date, amount_due, amount_paid, status, paid_at
         FROM credit_installments
         WHERE customer_id = $1
         ORDER BY due_date ASC, installment_no ASC`,
        [customerId]
      );

      const payments = await tx.query(
        `SELECT id, sale_id, amount, method, received_by, received_at, note
         FROM credit_payments
         WHERE customer_id = $1
         ORDER BY received_at DESC
         LIMIT 200`,
        [customerId]
      );

      const pending = installments.rows.filter((i) => i.status === 'pending');
      const overdue = installments.rows.filter((i) => i.status === 'overdue');

      return {
        customer: cust.rows[0],
        sales: sales.rows,
        installments: installments.rows,
        payments: payments.rows,
        summary: {
          credit_balance: cust.rows[0].credit_balance,
          pending_count: pending.length,
          overdue_count: overdue.length,
          schedule_pending_sales: sales.rows.filter((s) => s.credit_status === 'schedule_pending').length,
        },
      };
    });

    res.json(ledger);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
