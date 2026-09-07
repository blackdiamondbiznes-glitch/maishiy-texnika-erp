const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../db');
const { authRequired } = require('../middleware/auth');
const { unauthorized, badRequest } = require('../lib/errors');

const router = express.Router();

router.post('/login', async (req, res, next) => {
  try {
    const phone = String(req.body.phone || '').trim();
    const password = String(req.body.password || '');
    if (!phone || !password) throw badRequest('phone_and_password_required');

    const { rows } = await query(
      `SELECT id, full_name, phone, password_hash, role, is_active
       FROM users WHERE phone = $1`,
      [phone]
    );
    const user = rows[0];
    if (!user || !user.is_active) throw unauthorized('invalid_credentials');

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) throw unauthorized('invalid_credentials');

    const token = jwt.sign(
      { sub: String(user.id), role: user.role, full_name: user.full_name },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        phone: user.phone,
        role: user.role,
      },
    });
  } catch (e) {
    next(e);
  }
});

async function meHandler(req, res, next) {
  try {
    const { rows } = await query(
      `SELECT id, full_name, phone, role, is_active, created_at
       FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows[0] || !rows[0].is_active) throw unauthorized('user_inactive');
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
}

router.get('/me', authRequired, meHandler);

router.meHandler = meHandler;
module.exports = router;
