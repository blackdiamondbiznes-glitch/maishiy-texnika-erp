const express = require('express');
const { query, withTx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { applyMovement, getQtyOnHand } = require('../lib/inventory');
const { toNum } = require('../lib/money');

const router = express.Router();

router.get('/balance', async (req, res, next) => {
  try {
    const locationId = Number(req.query.location_id);
    if (!locationId) throw badRequest('location_id_required');

    const q = String(req.query.q || '').trim();
    const params = [locationId];
    let extra = '';
    if (q) {
      params.push(`%${q}%`);
      extra = `AND (p.name ILIKE $2 OR p.sku ILIKE $2)`;
    }

    const { rows } = await query(
      `SELECT p.id AS product_id, p.name, p.sku, p.unit, p.retail_price, p.store_min_qty,
              COALESCE(b.qty_on_hand, 0) AS qty_on_hand,
              b.updated_at
       FROM products p
       LEFT JOIN inventory_balance b
         ON b.product_id = p.id AND b.location_id = $1
       WHERE p.is_active = TRUE ${extra}
       ORDER BY p.name`,
      params
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/in', requireRole('owner', 'warehouse'), async (req, res, next) => {
  try {
    const locationId = Number(req.body.location_id);
    const productId = Number(req.body.product_id);
    const qty = toNum(req.body.qty);
    const unitCost = req.body.unit_cost != null ? toNum(req.body.unit_cost) : null;
    const note = req.body.note || null;

    if (!locationId || !productId) throw badRequest('location_and_product_required');
    if (qty <= 0) throw badRequest('qty_must_be_positive');

    const result = await withTx(async (tx) => {
      const prod = await tx.query(`SELECT id FROM products WHERE id = $1`, [productId]);
      if (!prod.rows[0]) throw notFound('product_not_found');
      const loc = await tx.query(`SELECT id FROM locations WHERE id = $1 AND is_active`, [locationId]);
      if (!loc.rows[0]) throw notFound('location_not_found');

      await applyMovement(tx, {
        locationId,
        productId,
        type: 'in',
        qty,
        unitCost,
        refType: 'manual_in',
        note,
        createdBy: req.user.id,
      });

      const onHand = await getQtyOnHand(tx, locationId, productId);
      return { ok: true, product_id: productId, location_id: locationId, qty_on_hand: onHand };
    });

    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/adjust', requireRole('owner', 'warehouse'), async (req, res, next) => {
  try {
    const locationId = Number(req.body.location_id);
    const productId = Number(req.body.product_id);
    const qty = toNum(req.body.qty); // signed: + increase, - decrease
    const note = req.body.note || null;

    if (!locationId || !productId) throw badRequest('location_and_product_required');
    if (qty === 0) throw badRequest('qty_must_be_nonzero');
    if (!note) throw badRequest('note_required_for_adjustment');

    const result = await withTx(async (tx) => {
      const prod = await tx.query(`SELECT id FROM products WHERE id = $1`, [productId]);
      if (!prod.rows[0]) throw notFound('product_not_found');

      await applyMovement(tx, {
        locationId,
        productId,
        type: 'adjustment',
        qty,
        refType: 'manual_adjust',
        note,
        createdBy: req.user.id,
      });

      const onHand = await getQtyOnHand(tx, locationId, productId);
      return { ok: true, product_id: productId, location_id: locationId, qty_on_hand: onHand };
    });

    res.json(result);
  } catch (e) {
    next(e);
  }
});

router.post('/transfer', requireRole('owner', 'warehouse'), async (req, res, next) => {
  try {
    const fromLocationId = Number(req.body.from_location_id);
    const toLocationId = Number(req.body.to_location_id);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const note = req.body.note || null;

    if (!fromLocationId || !toLocationId) throw badRequest('from_and_to_required');
    if (fromLocationId === toLocationId) throw badRequest('locations_must_differ');
    if (!items.length) throw badRequest('items_required');

    const result = await withTx(async (tx) => {
      const locs = await tx.query(
        `SELECT id FROM locations WHERE id IN ($1,$2) AND is_active`,
        [fromLocationId, toLocationId]
      );
      if (locs.rows.length !== 2) throw notFound('location_not_found');

      const moved = [];
      for (const it of items) {
        const productId = Number(it.product_id);
        const qty = toNum(it.qty);
        if (!productId || qty <= 0) throw badRequest('invalid_item');

        const prod = await tx.query(`SELECT id FROM products WHERE id = $1`, [productId]);
        if (!prod.rows[0]) throw notFound('product_not_found');

        const onHand = await getQtyOnHand(tx, fromLocationId, productId);
        if (onHand < qty) {
          throw badRequest(
            'insufficient_stock',
            `product ${productId} from=${fromLocationId}: on_hand=${onHand}, qty=${qty}`
          );
        }

        await applyMovement(tx, {
          locationId: fromLocationId,
          productId,
          type: 'transfer_out',
          qty,
          refType: 'transfer',
          note,
          createdBy: req.user.id,
        });
        await applyMovement(tx, {
          locationId: toLocationId,
          productId,
          type: 'transfer_in',
          qty,
          refType: 'transfer',
          note,
          createdBy: req.user.id,
        });

        moved.push({
          product_id: productId,
          qty,
          from_qty: await getQtyOnHand(tx, fromLocationId, productId),
          to_qty: await getQtyOnHand(tx, toLocationId, productId),
        });
      }

      return {
        ok: true,
        from_location_id: fromLocationId,
        to_location_id: toLocationId,
        items: moved,
      };
    });

    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
