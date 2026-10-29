-- Payments (hosted edition): plan orders paid by UPI and the bank alerts that confirm them. Mirrors the orders and
-- payment_inbox base tables in src/server/db.ts. Orders belong to the verified email a plan applies to (like
-- memberships), so they stay as the payment record even if someone wipes their content.
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  plan TEXT NOT NULL,
  period TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  method TEXT NOT NULL DEFAULT 'upi',
  status TEXT NOT NULL,
  utr TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  decided_by TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_email ON orders(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_utr ON orders(utr) WHERE utr IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  sender TEXT NOT NULL DEFAULT '',
  dkim TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  amount INTEGER,
  utr TEXT,
  order_id TEXT,
  outcome TEXT NOT NULL,
  excerpt TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_payment_inbox_at ON payment_inbox(at);
