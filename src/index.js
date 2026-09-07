require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { AppError } = require('./lib/errors');

const authRoutes = require('./routes/auth');
const productRoutes = require('./routes/products');
const inventoryRoutes = require('./routes/inventory');
const customerRoutes = require('./routes/customers');
const salesRoutes = require('./routes/sales');
const creditRoutes = require('./routes/credit');
const reportRoutes = require('./routes/reports');
const locationRoutes = require('./routes/locations');
const alertRoutes = require('./routes/alerts');
const deliveryRoutes = require('./routes/deliveries');
const { authRequired } = require('./middleware/auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRoutes);
app.get('/me', authRequired, authRoutes.meHandler);

app.use(authRequired);
app.use('/locations', locationRoutes);
app.use('/products', productRoutes);
app.use('/inventory', inventoryRoutes);
app.use('/customers', customerRoutes);
app.use('/sales', salesRoutes);
app.use('/credit', creditRoutes);
app.use('/reports', reportRoutes);
app.use('/alerts', alertRoutes);
app.use('/deliveries', deliveryRoutes);

app.use((_req, _res, next) => next(new AppError(404, 'route_not_found')));

app.use((err, _req, res, _next) => {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.code, message: err.message });
  }
  if (err.code && String(err.code).startsWith('23')) {
    return res.status(400).json({ error: 'db_constraint', message: err.message });
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const port = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(port, () => {
    console.log(`POS ERP listening on :${port}`);
  });
}

module.exports = app;
