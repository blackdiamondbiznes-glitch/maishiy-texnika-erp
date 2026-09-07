const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');

const router = express.Router();

const PRODUCT_COLS = `id, name, sku, barcode, unit, retail_price, store_min_qty, is_active, created_at`;

router.get('/', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const active = req.query.is_active;
    const params = [];
    const where = [];

    if (q) {
      params.push(`%${q}%`);
      where.push(`(name ILIKE $${params.length} OR sku ILIKE $${params.length} OR COALESCE(barcode,'') ILIKE $${params.length})`);
    }
    if (active === 'true' || active === 'false') {
      params.push(active === 'true');
      where.push(`is_active = $${params.length}`);
    }

    const sql = `
      SELECT ${PRODUCT_COLS}
      FROM products
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY name ASC
      LIMIT 500
    `;
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ${PRODUCT_COLS} FROM products WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) throw notFound('product_not_found');
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

router.post('/', requireRole('owner', 'warehouse'), async (req, res, next) => {
  try {
    const { name, sku, barcode, unit, retail_price, store_min_qty, is_active } = req.body || {};
    if (!name || !sku) throw badRequest('name_and_sku_required');

    const { rows } = await query(
      `INSERT INTO products (name, sku, barcode, unit, retail_price, store_min_qty, is_active)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,0),COALESCE($7, TRUE))
       RETURNING ${PRODUCT_COLS}`,
      [name, sku, barcode || null, unit || 'pcs', Number(retail_price || 0), store_min_qty, is_active]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return next(badRequest('sku_already_exists'));
    next(e);
  }
});

router.patch('/:id', requireRole('owner', 'warehouse'), async (req, res, next) => {
  try {
    const fields = ['name', 'sku', 'barcode', 'unit', 'retail_price', 'store_min_qty', 'is_active'];
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
      `UPDATE products SET ${sets.join(', ')}
       WHERE id = $${params.length}
       RETURNING ${PRODUCT_COLS}`,
      params
    );
    if (!rows[0]) throw notFound('product_not_found');
    res.json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return next(badRequest('sku_already_exists'));
    next(e);
  }
});

module.exports = router;
