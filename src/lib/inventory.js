const { round3 } = require('./money');

async function ensureBalance(client, locationId, productId) {
  await client.query(
    `INSERT INTO inventory_balance (location_id, product_id, qty_on_hand)
     VALUES ($1, $2, 0)
     ON CONFLICT (location_id, product_id) DO NOTHING`,
    [locationId, productId]
  );
}

async function applyMovement(client, {
  locationId,
  productId,
  type,
  qty,
  unitCost = null,
  refType = null,
  refId = null,
  note = null,
  createdBy = null,
}) {
  const signedQty = round3(qty);
  await client.query(
    `INSERT INTO inventory_movements
       (location_id, product_id, type, qty, unit_cost, ref_type, ref_id, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [locationId, productId, type, signedQty, unitCost, refType, refId, note, createdBy]
  );

  await ensureBalance(client, locationId, productId);

  // in / return_in / transfer_in increase
  // sale_out / transfer_out decrease
  // adjustment: signed qty from caller
  let delta;
  if (type === 'in' || type === 'return_in' || type === 'transfer_in') {
    delta = Math.abs(signedQty);
  } else if (type === 'sale_out' || type === 'transfer_out') {
    delta = -Math.abs(signedQty);
  } else {
    delta = signedQty;
  }

  await client.query(
    `UPDATE inventory_balance
     SET qty_on_hand = qty_on_hand + $3,
         updated_at = now()
     WHERE location_id = $1 AND product_id = $2`,
    [locationId, productId, delta]
  );
}

async function getQtyOnHand(client, locationId, productId) {
  await ensureBalance(client, locationId, productId);
  const { rows } = await client.query(
    `SELECT qty_on_hand FROM inventory_balance
     WHERE location_id = $1 AND product_id = $2
     FOR UPDATE`,
    [locationId, productId]
  );
  return Number(rows[0]?.qty_on_hand || 0);
}

module.exports = { ensureBalance, applyMovement, getQtyOnHand };
