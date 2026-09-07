-- Idempotent patch: delivery + source stock + transfer types + restock min qty
-- Mavjud DB (001 ni oldin ishlatganlar) uchun.

ALTER TYPE inv_movement_type ADD VALUE IF NOT EXISTS 'transfer_out';
ALTER TYPE inv_movement_type ADD VALUE IF NOT EXISTS 'transfer_in';

DO $$ BEGIN
  CREATE TYPE delivery_status AS ENUM ('new', 'out_for_delivery', 'delivered', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS store_min_qty NUMERIC(18,3) NOT NULL DEFAULT 0;

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS source_location_id BIGINT REFERENCES locations(id);

ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS has_delivery BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE sales
SET source_location_id = location_id
WHERE source_location_id IS NULL;

DO $$ BEGIN
  ALTER TABLE sales
    ALTER COLUMN source_location_id SET NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_sales_source_location ON sales(source_location_id);
CREATE INDEX IF NOT EXISTS idx_sales_has_delivery ON sales(has_delivery);

CREATE TABLE IF NOT EXISTS deliveries (
  id              BIGSERIAL PRIMARY KEY,
  sale_id         BIGINT NOT NULL UNIQUE REFERENCES sales(id) ON DELETE CASCADE,
  status          delivery_status NOT NULL DEFAULT 'new',
  address         TEXT NOT NULL,
  recipient_name  TEXT,
  recipient_phone TEXT,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status);
