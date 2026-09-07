const express = require('express');
const { query, withTx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');

const router = express.Router();
const STATUSES = ['new', 'out_for_delivery', 'delivered', 'canceled'];

router.get('/', async (req, res, next) => {
  try {
    const params = [];
    const where = [];
    if (req.query.status) {
      params.push(req.query.status);
      where.push(`d.status = $${params.length}`);
    }
    const { rows } = await query(
      `SELECT d.id, d.sale_id, d.status, d.address, d.recipient_name, d.recipient_phone,
              d.note, d.created_at, d.updated_at,
              s.customer_id, s.total, s.source_location_id, s.location_id,
              c.full_name AS customer_name, c.phone AS customer_phone
       FROM deliveries d
       JOIN sales s ON s.id = d.sale_id
       LEFT JOIN customers c ON c.id = s.customer_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY d.created_at DESC
       LIMIT 200`,
      params
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.patch('/:id', requireRole('owner', 'seller', 'warehouse'), async (req, res, next) => {
  try {
    const status = req.body.status;
    const fields = ['address', 'recipient_name', 'recipient_phone', 'note', 'status'];
    if (status && !STATUSES.includes(status)) throw badRequest('invalid_delivery_status');

    const result = await withTx(async (tx) => {
      const cur = await tx.query(`SELECT * FROM deliveries WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!cur.rows[0]) throw notFound('delivery_not_found');

      const sets = ['updated_at = now()'];
      const params = [];
      for (const f of fields) {
        if (req.body[f] !== undefined) {
          params.push(req.body[f]);
          sets.push(`${f} = $${params.length}`);
        }
      }
      if (params.length === 0) throw badRequest('no_fields');
      params.push(req.params.id);

      const upd = await tx.query(
        `UPDATE deliveries SET ${sets.join(', ')}
         WHERE id = $${params.length}
         RETURNING *`,
        params
      );
      return upd.rows[0];
    });

    res.json(result);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
