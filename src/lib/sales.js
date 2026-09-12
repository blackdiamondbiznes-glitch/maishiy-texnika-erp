const { badRequest, notFound } = require('./errors');
const { round2, toNum } = require('./money');
const { applyMovement, getQtyOnHand } = require('./inventory');

async function cancelSale(tx, { saleId, userId, note }) {
  const saleRes = await tx.query(
    `SELECT id, status, customer_id, source_location_id,
            paid_cash, paid_card, credit_total, credit_status
     FROM sales
     WHERE id = $1
     FOR UPDATE`,
    [saleId]
  );
  const sale = saleRes.rows[0];
  if (!sale) throw notFound('sale_not_found');
  if (sale.status === 'canceled') throw badRequest('sale_already_canceled');
  if (sale.status !== 'completed') throw badRequest('sale_not_completed');

  const movementNote = note || 'sale_cancel';
  const creditTotal = round2(sale.credit_total);
  let creditReversed = 0;

  if (creditTotal > 0) {
    if (!sale.customer_id) throw badRequest('customer_required_for_credit');

    const custRes = await tx.query(
      `SELECT id, credit_balance FROM customers WHERE id = $1 FOR UPDATE`,
      [sale.customer_id]
    );
    if (!custRes.rows[0]) throw notFound('customer_not_found');

    const instRes = await tx.query(
      `SELECT id, amount_paid
       FROM credit_installments
       WHERE sale_id = $1
       FOR UPDATE`,
      [sale.id]
    );
    const collected = instRes.rows.reduce((s, r) => s + toNum(r.amount_paid), 0);
    if (collected > 0 || sale.credit_status === 'paid') {
      throw badRequest(
        'credit_already_collected',
        'cancel blocked: this sale has collected credit payments'
      );
    }

    const balance = round2(custRes.rows[0].credit_balance);
    if (balance < creditTotal) {
      throw badRequest(
        'cannot_reverse_credit',
        `balance=${balance} credit_total=${creditTotal}`
      );
    }

    await tx.query(
      `UPDATE customers SET credit_balance = credit_balance - $1 WHERE id = $2`,
      [creditTotal, sale.customer_id]
    );
    await tx.query(`DELETE FROM credit_installments WHERE sale_id = $1`, [sale.id]);
    creditReversed = creditTotal;
  }

  const itemsRes = await tx.query(
    `SELECT product_id, qty FROM sale_items WHERE sale_id = $1 ORDER BY id`,
    [sale.id]
  );
  const stockReturned = [];
  for (const it of itemsRes.rows) {
    await applyMovement(tx, {
      locationId: sale.source_location_id,
      productId: it.product_id,
      type: 'return_in',
      qty: toNum(it.qty),
      refType: 'sale',
      refId: sale.id,
      note: movementNote,
      createdBy: userId,
    });
    stockReturned.push({
      product_id: it.product_id,
      qty: toNum(it.qty),
      location_id: sale.source_location_id,
      qty_on_hand: await getQtyOnHand(tx, sale.source_location_id, it.product_id),
    });
  }

  const delRow = await tx.query(
    `SELECT id, status FROM deliveries WHERE sale_id = $1 FOR UPDATE`,
    [sale.id]
  );
  // delivered does not block: this endpoint is the full return. Stock already left on sale_out.
  let deliveryStatus = null;
  if (delRow.rows[0]) {
    const delRes = await tx.query(
      `UPDATE deliveries
       SET status = 'canceled', updated_at = now()
       WHERE id = $1
       RETURNING status`,
      [delRow.rows[0].id]
    );
    deliveryStatus = delRes.rows[0].status;
  }

  await tx.query(
    `UPDATE sales SET status = 'canceled', credit_status = 'none' WHERE id = $1`,
    [sale.id]
  );

  return {
    ok: true,
    sale_id: sale.id,
    status: 'canceled',
    credit_status: 'none',
    stock_returned: stockReturned,
    credit_reversed: creditReversed,
    refund_cash: round2(sale.paid_cash),
    refund_card: round2(sale.paid_card),
    delivery_status: deliveryStatus,
  };
}

module.exports = { cancelSale };
