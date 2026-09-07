const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/auth');
const { badRequest } = require('../lib/errors');

const router = express.Router();

router.get('/', async (_req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, type, is_active, created_at
       FROM locations
       WHERE is_active = TRUE
       ORDER BY id`
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/', requireRole('owner'), async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim();
    if (!name) throw badRequest('name_required');
    const { rows } = await query(
      `INSERT INTO locations (name, type)
       VALUES ($1, COALESCE($2, 'store'))
       RETURNING id, name, type, is_active, created_at`,
      [name, req.body.type || 'store']
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
