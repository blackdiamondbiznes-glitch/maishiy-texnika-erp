require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function readSql(name) {
  return fs.readFileSync(path.join(__dirname, '../sql', name), 'utf8');
}

async function main() {
  const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const exists = await client.query(
      `SELECT to_regclass('public.sales') AS sales`
    );
    const hasSales = Boolean(exists.rows[0].sales);

    if (!hasSales) {
      await client.query(readSql('001_init.sql'));
      console.log('Applied sql/001_init.sql (fresh schema + delivery/transfer)');
      return;
    }

    const col = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'sales' AND column_name = 'source_location_id'`
    );
    if (col.rowCount) {
      console.log('Schema already up to date');
      return;
    }

    await client.query(readSql('002_delivery_transfer.sql'));
    console.log('Applied sql/002_delivery_transfer.sql (patch)');
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
