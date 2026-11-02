import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  monthly_budget_cents INTEGER NOT NULL,
  per_purchase_cap_cents INTEGER NOT NULL,
  auto_approve_under_cents INTEGER NOT NULL DEFAULT 0,
  allowed_categories TEXT NOT NULL DEFAULT '[]',
  blocked_merchants TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS purchase_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  amount_cents INTEGER NOT NULL,
  merchant TEXT NOT NULL,
  category TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_requests_agent ON purchase_requests(agent_id, created_at);
CREATE INDEX IF NOT EXISTS idx_requests_status ON purchase_requests(status);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES purchase_requests(id),
  provider TEXT NOT NULL,
  provider_card_id TEXT NOT NULL,
  pan TEXT NOT NULL,
  cvv TEXT NOT NULL,
  exp_month INTEGER NOT NULL,
  exp_year INTEGER NOT NULL,
  last4 TEXT NOT NULL,
  spend_limit_cents INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT,
  request_id TEXT,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Adds columns introduced after the first release to existing databases. */
function migrate(db: Db): void {
  const has = (table: string, column: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  if (!has("purchase_requests", "risk_flags")) {
    db.exec("ALTER TABLE purchase_requests ADD COLUMN risk_flags TEXT NOT NULL DEFAULT '[]'");
  }
  if (!has("purchase_requests", "product")) {
    db.exec("ALTER TABLE purchase_requests ADD COLUMN product TEXT");
    db.exec("ALTER TABLE purchase_requests ADD COLUMN product_url TEXT");
    db.exec("ALTER TABLE purchase_requests ADD COLUMN price_check TEXT");
  }
  if (!has("purchase_requests", "idempotency_key")) {
    db.exec("ALTER TABLE purchase_requests ADD COLUMN idempotency_key TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_requests_idem ON purchase_requests(agent_id, idempotency_key)");
  }
  if (!has("purchase_requests", "auto_approved")) {
    // Remembers auto-approval after a charge moves the status to 'completed'.
    db.exec("ALTER TABLE purchase_requests ADD COLUMN auto_approved INTEGER NOT NULL DEFAULT 0");
    db.exec(
      "UPDATE purchase_requests SET auto_approved = 1 WHERE status = 'auto_approved' OR (status = 'completed' AND decision_reason LIKE 'Under the%auto-approve limit.')",
    );
  }
  if (!has("purchase_requests", "approved_with")) {
    // How the money was approved: auto, owner (a tap) or owner_passkey (Face ID). Goes into signed approvals.
    db.exec("ALTER TABLE purchase_requests ADD COLUMN approved_with TEXT");
    db.exec("UPDATE purchase_requests SET approved_with = CASE WHEN auto_approved = 1 THEN 'auto' ELSE 'owner' END WHERE status IN ('approved', 'auto_approved', 'completed')");
  }
  if (!has("cards", "charge_token")) {
    // The card network's id for the charge, so a webhook delivered twice is only counted once.
    db.exec("ALTER TABLE cards ADD COLUMN charge_token TEXT");
  }
  if (!has("events", "hash")) {
    // Each entry's hash covers the one before it, so editing or deleting history is detectable.
    db.exec("ALTER TABLE events ADD COLUMN hash TEXT");
  }
}

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
