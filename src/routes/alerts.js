const express = require('express');
const { query } = require('../db');
const { badRequest } = require('../lib/errors');
const { toNum } = require('../lib/money');

const router = express.Router();

// Do'konda kam, omborda bor — "ombordan olib kel" ro'yxati
router.get('/restock', async (req, res, next) => {
  try {
    const storeId = Number(req.query.store_location_id);
    const warehouseId = Number(req.query.warehouse_location_id);
    if (!storeId || !warehouseId) {
      throw badRequest('store_and_warehouse_location_required');
    }
    if (storeId === warehouseId) throw badRequest('locations_must_differ');

    const { rows } = await query(
      `SELECT
         p.id AS product_id,
         p.name,
         p.sku,
         p.unit,
         p.store_min_qty,
         COALESCE(store.qty_on_hand, 0) AS store_qty,
         COALESCE(wh.qty_on_hand, 0) AS warehouse_qty,
         GREATEST(
           p.store_min_qty - COALESCE(store.qty_on_hand, 0),
           0
         ) AS suggest_transfer_qty
       FROM products p
       LEFT JOIN inventory_balance store
         ON store.product_id = p.id AND store.location_id = $1
       LEFT JOIN inventory_balance wh
         ON wh.product_id = p.id AND wh.location_id = $2
       WHERE p.is_active = TRUE
         AND COALESCE(store.qty_on_hand, 0) <= p.store_min_qty
         AND COALESCE(wh.qty_on_hand, 0) > 0
       ORDER BY (p.store_min_qty - COALESCE(store.qty_on_hand, 0)) DESC, p.name`,
      [storeId, warehouseId]
    );

    res.json(
      rows.map((r) => ({
        ...r,
        store_qty: toNum(r.store_qty),
        warehouse_qty: toNum(r.warehouse_qty),
        store_min_qty: toNum(r.store_min_qty),
        suggest_transfer_qty: toNum(r.suggest_transfer_qty),
      }))
    );
  } catch (e) {
    next(e);
  }
});

module.exports = router;
