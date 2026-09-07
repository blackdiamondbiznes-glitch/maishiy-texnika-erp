const express = require('express');
const { withTx } = require('../db');
const { requireRole } = require('../middleware/auth');
const { badRequest, notFound } = require('../lib/errors');
const { round2, toNum } = require('../lib/money');
const { markOverdue, refreshSaleCreditStatus } = require('../lib/credit');

const router = express.Router();

// Owner: schedule_pending sales
router.get('/schedule-pending', requireRole('owner'), async (req, res, next) => {
  try {
    const { query } = require('../db');
    const { rows } = await query(
      `SELECT s.id, s.customer_id, c.full_name AS customer_name, c.phone,
              s.total, s.paid_total, s.credit_total, s.credit_status, s.created_at
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       WHERE s.credit_status = 'schedule_pending'
         AND s.status = 'completed'
       ORDER BY s.created_at ASC`
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// Owner: overdue installments (faqat jadval kiritilganlar)
router.get('/overdue', requireRole('owner', 'seller'), async (req, res, next) => {
  try {
    const rows = await withTx(async (tx) => {
      await markOverdue(tx);
      const r = await tx.query(
        `SELECT ci.id, ci.sale_id, ci.customer_id, c.full_name AS customer_name, c.phone,
                ci.installment_no, ci.due_date, ci.amount_due, ci.amount_paid,
                (ci.amount_due - ci.amount_paid) AS open_amount,
                ci.status
         FROM credit_installments ci
         JOIN customers c ON c.id = ci.customer_id
         WHERE ci.status = 'overdue'
         ORDER BY ci.due_date ASC, ci.id ASC`
      );
      return r.rows;
    });
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

router.post('/payments', requireRole('owner', 'seller'), async (req, res, next) => {
  try {
    const customerId = Number(req.body.customer_id);
    const saleId = req.body.sale_id != null ? Number(req.body.sale_id) : null;
    const amount = round2(req.body.amount);
    const method = req.body.method;
    const note = req.body.note || null;
    const receivedBy = req.body.received_by != null ? Number(req.body.received_by) : req.user.id;

    if (!customerId) throw badRequest('customer_id_required');
    if (amount <= 0) throw badRequest('amount_must_be_positive');
    if (!['cash', 'card'].includes(method)) throw badRequest('invalid_method');

    const result = await withTx(async (tx) => {
      const custRes = await tx.query(
        `SELECT id, credit_balance FROM customers WHERE id = $1 FOR UPDATE`,
        [customerId]
      );
      const customer = custRes.rows[0];
      if (!customer) throw notFound('customer_not_found');

      // MVP: overpay blok
      if (amount > toNum(customer.credit_balance)) {
        throw badRequest('amount_exceeds_balance', `balance=${customer.credit_balance}`);
      }

      if (saleId) {
        const s = await tx.query(
          `SELECT id FROM sales WHERE id = $1 AND customer_id = $2`,
          [saleId, customerId]
        );
        if (!s.rows[0]) throw badRequest('sale_not_found_for_customer');
      }

      const payRes = await tx.query(
        `INSERT INTO credit_payments
           (customer_id, sale_id, amount, method, received_by, note)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [customerId, saleId, amount, method, receivedBy, note]
      );
      const pay = payRes.rows[0];

      await tx.query(
        `UPDATE customers SET credit_balance = credit_balance - $1 WHERE id = $2`,
        [amount, customerId]
      );

      let remaining = amount;
      const touchedSales = new Set();

      // FIFO: eng eski due_date, so'ng id. sale_id berilsa shu sale'dan boshlaymiz,
      // qolganini boshqa installmentlarga yoyamiz.
      const instRes = await tx.query(
        `SELECT id, sale_id, amount_due, amount_paid, status
         FROM credit_installments
         WHERE customer_id = $1
           AND status IN ('pending', 'overdue')
           ${saleId ? 'AND sale_id = $2' : ''}
         ORDER BY due_date ASC, id ASC
         FOR UPDATE`,
        saleId ? [customerId, saleId] : [customerId]
      );

      let installments = instRes.rows;

      // agar sale_id berilgan va shu sale to'liq yopilsa, qolgan summa boshqa sale'larga FIFO
      async function applyToList(list) {
        for (const inst of list) {
          if (remaining <= 0) break;
          const due = toNum(inst.amount_due);
          const paid = toNum(inst.amount_paid);
          const open = round2(due - paid);
          if (open <= 0) continue;

          const payPart = Math.min(open, remaining);
          const newPaid = round2(paid + payPart);
          const newStatus = newPaid >= due ? 'paid' : inst.status;

          await tx.query(
            `UPDATE credit_installments
             SET amount_paid = $2,
                 status = $3,
                 paid_at = CASE WHEN $3 = 'paid' THEN now() ELSE paid_at END
             WHERE id = $1`,
            [inst.id, newPaid, newStatus]
          );

          remaining = round2(remaining - payPart);
          touchedSales.add(inst.sale_id);
        }
      }

      await applyToList(installments);

      if (remaining > 0 && saleId) {
        const rest = await tx.query(
          `SELECT id, sale_id, amount_due, amount_paid, status
           FROM credit_installments
           WHERE customer_id = $1
             AND sale_id <> $2
             AND status IN ('pending', 'overdue')
           ORDER BY due_date ASC, id ASC
           FOR UPDATE`,
          [customerId, saleId]
        );
        await applyToList(rest.rows);
      }

      await markOverdue(tx, customerId);

      for (const sid of touchedSales) {
        await refreshSaleCreditStatus(tx, sid);
      }

      const bal = await tx.query(`SELECT credit_balance FROM customers WHERE id = $1`, [customerId]);

      return {
        ok: true,
        payment_id: pay.id,
        applied: round2(amount - remaining),
        unapplied: remaining,
        credit_balance: bal.rows[0].credit_balance,
      };
    });

    res.status(201).json(result);
  } catch (e) {
    next(e);
  }
});

module.exports = router;
