const jwt = require('jsonwebtoken');
const { unauthorized, forbidden } = require('../lib/errors');

function authRequired(req, _res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized('missing_token'));

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = {
      id: Number(payload.sub),
      role: payload.role,
      full_name: payload.full_name,
    };
    next();
  } catch (_e) {
    next(unauthorized('invalid_token'));
  }
}

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden('insufficient_role'));
    next();
  };
}

module.exports = { authRequired, requireRole };
