const { round2 } = require('./money');

async function markOverdue(client, customerId = null) {
  if (customerId) {
    await client.query(
      `UPDATE credit_installments
       SET status = 'overdue'
       WHERE customer_id = $1
         AND status = 'pending'
         AND due_date < CURRENT_DATE`,
      [customerId]
    );
  } else {
    await client.query(
      `UPDATE credit_installments
       SET status = 'overdue'
       WHERE status = 'pending'
         AND due_date < CURRENT_DATE`
    );
  }
}

async function refreshSaleCreditStatus(client, saleId) {
  const { rows } = await client.query(
    `SELECT
        s.credit_total,
        s.credit_status,
        COALESCE(SUM(ci.amount_due), 0) AS due_sum,
        COALESCE(SUM(ci.amount_paid), 0) AS paid_sum,
        COUNT(ci.id) AS inst_count
     FROM sales s
     LEFT JOIN credit_installments ci ON ci.sale_id = s.id
     WHERE s.id = $1
     GROUP BY s.id`,
    [saleId]
  );
  if (!rows.length) return;
  const row = rows[0];
  if (row.credit_status === 'none' || row.credit_status === 'schedule_pending') return;
  if (Number(row.inst_count) === 0) return;

  const paid = round2(row.paid_sum);
  const due = round2(row.due_sum);
  if (paid >= due && due > 0) {
    await client.query(
      `UPDATE sales SET credit_status = 'paid' WHERE id = $1 AND credit_status <> 'paid'`,
      [saleId]
    );
  }
}

module.exports = { markOverdue, refreshSaleCreditStatus };
