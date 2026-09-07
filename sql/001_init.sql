-- POS/ERP MVP schema
-- Penya/ustama yo'q. Overdue faqat status.

CREATE TYPE user_role AS ENUM ('owner', 'seller', 'warehouse');
CREATE TYPE sale_status AS ENUM ('completed', 'canceled');
CREATE TYPE credit_status AS ENUM ('none', 'schedule_pending', 'active', 'paid');
CREATE TYPE installment_status AS ENUM ('pending', 'paid', 'overdue');
CREATE TYPE payment_method AS ENUM ('cash', 'card');
CREATE TYPE inv_movement_type AS ENUM (
  'in', 'adjustment', 'sale_out', 'return_in', 'transfer_out', 'transfer_in'
);
CREATE TYPE delivery_status AS ENUM ('new', 'out_for_delivery', 'delivered', 'canceled');

CREATE TABLE locations (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'store',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  full_name     TEXT NOT NULL,
  phone         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role          user_role NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_role ON users(role);

CREATE TABLE customers (
  id             BIGSERIAL PRIMARY KEY,
  full_name      TEXT,
  phone          TEXT,
  note           TEXT,
  credit_limit   NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit_balance NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_customers_credit_nonneg CHECK (credit_balance >= 0 AND credit_limit >= 0)
);

CREATE INDEX idx_customers_phone ON customers(phone);

CREATE TABLE products (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  sku          TEXT NOT NULL UNIQUE,
  barcode      TEXT,
  unit         TEXT NOT NULL DEFAULT 'pcs',
  retail_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  store_min_qty NUMERIC(18,3) NOT NULL DEFAULT 0,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_products_active ON products(is_active);
CREATE INDEX idx_products_barcode ON products(barcode);

CREATE TABLE sales (
  id            BIGSERIAL PRIMARY KEY,
  location_id   BIGINT NOT NULL REFERENCES locations(id),
  source_location_id BIGINT NOT NULL REFERENCES locations(id),
  seller_id     BIGINT NOT NULL REFERENCES users(id),
  customer_id   BIGINT REFERENCES customers(id),
  has_delivery  BOOLEAN NOT NULL DEFAULT FALSE,

  status        sale_status NOT NULL DEFAULT 'completed',

  subtotal      NUMERIC(18,2) NOT NULL,
  discount      NUMERIC(18,2) NOT NULL DEFAULT 0,
  total         NUMERIC(18,2) NOT NULL,

  paid_cash     NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_card     NUMERIC(18,2) NOT NULL DEFAULT 0,
  paid_total    NUMERIC(18,2) NOT NULL DEFAULT 0,

  credit_total  NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit_status credit_status NOT NULL DEFAULT 'none',

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ck_sales_amounts_nonneg CHECK (
    subtotal >= 0 AND discount >= 0 AND total >= 0
    AND paid_cash >= 0 AND paid_card >= 0 AND paid_total >= 0
    AND credit_total >= 0
  )
);

CREATE INDEX idx_sales_created_at ON sales(created_at);
CREATE INDEX idx_sales_customer ON sales(customer_id);
CREATE INDEX idx_sales_credit_status ON sales(credit_status);
CREATE INDEX idx_sales_location ON sales(location_id);
CREATE INDEX idx_sales_source_location ON sales(source_location_id);
CREATE INDEX idx_sales_has_delivery ON sales(has_delivery);

CREATE TABLE sale_items (
  id                 BIGSERIAL PRIMARY KEY,
  sale_id            BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id         BIGINT NOT NULL REFERENCES products(id),
  qty                NUMERIC(18,3) NOT NULL,
  unit_price         NUMERIC(18,2) NOT NULL,
  line_total         NUMERIC(18,2) NOT NULL,
  unit_cost_snapshot NUMERIC(18,2),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_sale_items_qty_pos CHECK (qty > 0)
);

CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);

CREATE TABLE inventory_movements (
  id           BIGSERIAL PRIMARY KEY,
  location_id  BIGINT NOT NULL REFERENCES locations(id),
  product_id   BIGINT NOT NULL REFERENCES products(id),
  type         inv_movement_type NOT NULL,
  qty          NUMERIC(18,3) NOT NULL,
  unit_cost    NUMERIC(18,2),
  ref_type     TEXT,
  ref_id       BIGINT,
  note         TEXT,
  created_by   BIGINT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_inv_mov_loc_prod ON inventory_movements(location_id, product_id);
CREATE INDEX idx_inv_mov_created_at ON inventory_movements(created_at);

CREATE TABLE inventory_balance (
  location_id  BIGINT NOT NULL REFERENCES locations(id),
  product_id   BIGINT NOT NULL REFERENCES products(id),
  qty_on_hand  NUMERIC(18,3) NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (location_id, product_id)
);

CREATE TABLE credit_installments (
  id              BIGSERIAL PRIMARY KEY,
  sale_id         BIGINT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  customer_id     BIGINT NOT NULL REFERENCES customers(id),
  installment_no  INT NOT NULL,
  due_date        DATE NOT NULL,
  amount_due      NUMERIC(18,2) NOT NULL,
  amount_paid     NUMERIC(18,2) NOT NULL DEFAULT 0,
  status          installment_status NOT NULL DEFAULT 'pending',
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_installment_amounts_nonneg CHECK (amount_due > 0 AND amount_paid >= 0),
  CONSTRAINT uq_installment_no_per_sale UNIQUE (sale_id, installment_no)
);

CREATE INDEX idx_installments_customer_due ON credit_installments(customer_id, due_date);
CREATE INDEX idx_installments_status ON credit_installments(status);
CREATE INDEX idx_installments_sale ON credit_installments(sale_id);

CREATE TABLE credit_payments (
  id           BIGSERIAL PRIMARY KEY,
  customer_id  BIGINT NOT NULL REFERENCES customers(id),
  sale_id      BIGINT REFERENCES sales(id),
  amount       NUMERIC(18,2) NOT NULL,
  method       payment_method NOT NULL,
  received_by  BIGINT REFERENCES users(id),
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  note         TEXT,
  CONSTRAINT ck_credit_payment_amount_pos CHECK (amount > 0)
);

CREATE INDEX idx_credit_payments_customer ON credit_payments(customer_id, received_at);

CREATE TABLE deliveries (
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

CREATE INDEX idx_deliveries_status ON deliveries(status);

