import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const INITIAL_MIGRATION = {
  name: "001_initial_schema",
  sql: `
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS indexer_state (
      id TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      last_scanned_block INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS deposit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      contract_address TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      tx_index INTEGER NOT NULL,
      log_index INTEGER NOT NULL,
      commitment TEXT NOT NULL,
      leaf_index INTEGER,
      token TEXT NOT NULL,
      amount TEXT NOT NULL,
      encrypted_claim TEXT NOT NULL,
      event_timestamp TEXT NOT NULL,
      raw_log_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(chain_id, tx_hash, log_index)
    );

    CREATE INDEX IF NOT EXISTS idx_deposit_events_block ON deposit_events(block_number);
    CREATE INDEX IF NOT EXISTS idx_deposit_events_commitment ON deposit_events(commitment);
    CREATE INDEX IF NOT EXISTS idx_deposit_events_token ON deposit_events(token);

    CREATE TABLE IF NOT EXISTS crawl_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      from_block INTEGER NOT NULL,
      to_block INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `,
} as const;

export function openDatabase(databasePath: string): Database.Database {
  if (databasePath !== ":memory:") {
    const directoryPath = path.dirname(databasePath);
    if (!fs.existsSync(directoryPath)) {
      fs.mkdirSync(directoryPath, { recursive: true });
    }
  }

  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");

  return db;
}

export function closeDatabase(db: Database.Database): void {
  db.close();
}

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);

  const existingMigration = db.prepare(
    "SELECT 1 FROM migrations WHERE name = ?",
  ).get(INITIAL_MIGRATION.name);

  if (existingMigration) {
    return;
  }

  const applyMigration = db.transaction(() => {
    db.exec(INITIAL_MIGRATION.sql);
    db.prepare(
      "INSERT INTO migrations (name, applied_at) VALUES (?, ?)",
    ).run(INITIAL_MIGRATION.name, Date.now());
  });

  applyMigration();
}

export * from "./deposits";
