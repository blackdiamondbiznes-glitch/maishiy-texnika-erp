const express = require('express');
const { query, withTx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { markOverdue } = require('../lib/credit');

const router = express.Router();

router.get('/daily', async (req, res, next) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const locationId = req.query.location_id ? Number(req.query.location_id) : null;

    const params = [date];
    let locFilter = '';
    if (locationId) {
      params.push(locationId);
      locFilter = `AND location_id = $2`;
    }

    const { rows } = await query(
      `SELECT
         COUNT(*)::int AS sales_count,
         COALESCE(SUM(total),0) AS total,
         COALESCE(SUM(paid_cash),0) AS cash,
         COALESCE(SUM(paid_card),0) AS card,
         COALESCE(SUM(credit_total),0) AS credit,
         COALESCE(SUM(discount),0) AS discount
       FROM sales
       WHERE status = 'completed'
         AND created_at::date = $1::date
         ${locFilter}`,
      params
    );

    res.json({
      date,
      location_id: locationId,
      ...rows[0],
    });
  } catch (e) {
    next(e);
  }
});

router.get('/owner-overview', requireRole('owner'), async (req, res, next) => {
  try {
    const data = await withTx(async (tx) => {
      await markOverdue(tx);

      const pending = await tx.query(
        `SELECT COUNT(*)::int AS count, COALESCE(SUM(credit_total),0) AS credit_total
         FROM sales
         WHERE credit_status = 'schedule_pending' AND status = 'completed'`
      );
      const overdue = await tx.query(
        `SELECT COUNT(*)::int AS count,
                COALESCE(SUM(amount_due - amount_paid),0) AS open_amount
         FROM credit_installments
         WHERE status = 'overdue'`
      );
      const balances = await tx.query(
        `SELECT COALESCE(SUM(credit_balance),0) AS customer_credit_balance
         FROM customers`
      );

      return {
        schedule_pending: pending.rows[0],
        overdue: overdue.rows[0],
        customer_credit_balance: balances.rows[0].customer_credit_balance,
      };
    });
    res.json(data);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
