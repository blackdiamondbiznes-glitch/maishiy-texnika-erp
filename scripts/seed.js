require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Client } = require('pg');

async function upsertLocation(client, name, type) {
  const found = await client.query(
    `SELECT id FROM locations WHERE name = $1 LIMIT 1`,
    [name]
  );
  if (found.rows[0]) return found.rows[0].id;
  const ins = await client.query(
    `INSERT INTO locations (name, type) VALUES ($1, $2) RETURNING id`,
    [name, type]
  );
  return ins.rows[0].id;
}

async function main() {
  const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const storeName = process.env.SEED_LOCATION_NAME || "Asosiy do'kon";
    const warehouseName = process.env.SEED_WAREHOUSE_NAME || 'Ombor';
    const name = process.env.SEED_OWNER_NAME || 'Owner';
    const phone = process.env.SEED_OWNER_PHONE || '998901234567';
    const password = process.env.SEED_OWNER_PASSWORD || 'admin123';
    const hash = await bcrypt.hash(password, 10);

    const storeId = await upsertLocation(client, storeName, 'store');
    const warehouseId = await upsertLocation(client, warehouseName, 'warehouse');

    const existing = await client.query(`SELECT id FROM users WHERE phone = $1`, [phone]);
    if (!existing.rows[0]) {
      await client.query(
        `INSERT INTO users (full_name, phone, password_hash, role)
         VALUES ($1,$2,$3,'owner')`,
        [name, phone, hash]
      );
      console.log(`Owner seeded: phone=${phone} password=${password}`);
    } else {
      console.log(`Owner already exists: phone=${phone}`);
    }

    console.log(`store location_id=${storeId}`);
    console.log(`warehouse location_id=${warehouseId}`);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
