import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const MIGRATIONS = [
  {
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
      sender TEXT NOT NULL,
      on_behalf TEXT NOT NULL,
      assets TEXT NOT NULL,
      shares TEXT NOT NULL,
      raw_log_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(chain_id, tx_hash, log_index)
    );

    CREATE INDEX IF NOT EXISTS idx_deposit_events_block ON deposit_events(block_number);

    CREATE TABLE IF NOT EXISTS crawl_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL,
      from_block INTEGER NOT NULL,
      to_block INTEGER NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `,
  },
  {
    name: "002_vault_position_indexer",
    sql: `
    CREATE TABLE IF NOT EXISTS withdraw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL, contract_address TEXT NOT NULL,
      block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL, tx_index INTEGER NOT NULL, log_index INTEGER NOT NULL,
      sender TEXT NOT NULL, receiver TEXT NOT NULL, on_behalf TEXT NOT NULL,
      assets TEXT NOT NULL, shares TEXT NOT NULL, raw_log_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, UNIQUE(chain_id, tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_withdraw_events_block ON withdraw_events(block_number);

    CREATE TABLE IF NOT EXISTS transfer_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL, contract_address TEXT NOT NULL,
      block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL, tx_index INTEGER NOT NULL, log_index INTEGER NOT NULL,
      from_address TEXT NOT NULL, to_address TEXT NOT NULL, shares TEXT NOT NULL,
      raw_log_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(chain_id, tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS idx_transfer_events_block ON transfer_events(block_number);

    CREATE TABLE IF NOT EXISTS accrue_interest_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chain_id INTEGER NOT NULL, contract_address TEXT NOT NULL,
      block_number INTEGER NOT NULL, block_hash TEXT NOT NULL,
      tx_hash TEXT NOT NULL, tx_index INTEGER NOT NULL, log_index INTEGER NOT NULL,
      previous_total_assets TEXT NOT NULL, new_total_assets TEXT NOT NULL,
      performance_fee_shares TEXT NOT NULL, management_fee_shares TEXT NOT NULL,
      total_supply_before_raw TEXT NOT NULL, global_index_after_raw TEXT NOT NULL,
      raw_log_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE(chain_id, tx_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS account_positions (
      address TEXT PRIMARY KEY,
      balance_raw TEXT NOT NULL DEFAULT '0',
      reward_debt_raw TEXT NOT NULL DEFAULT '0',
      earned_performance_fee_shares_raw TEXT NOT NULL DEFAULT '0',
      lifetime_deposited_raw TEXT NOT NULL DEFAULT '0',
      lifetime_withdrawn_raw TEXT NOT NULL DEFAULT '0',
      updated_block_number INTEGER NOT NULL DEFAULT 0,
      updated_log_index INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS vault_reward_state (
      id TEXT PRIMARY KEY,
      global_performance_fee_index_raw TEXT NOT NULL DEFAULT '0',
      total_supply_raw TEXT NOT NULL DEFAULT '0',
      cumulative_performance_fee_shares_raw TEXT NOT NULL DEFAULT '0',
      cumulative_management_fee_shares_raw TEXT NOT NULL DEFAULT '0',
      updated_block_number INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS share_price_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      block_number INTEGER NOT NULL,
      total_assets_raw TEXT NOT NULL,
      total_supply_raw TEXT NOT NULL,
      captured_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_block ON share_price_snapshots(block_number);
  `,
  },
  {
    name: "003_accrue_interest_perf_fee_index",
    sql: `
    CREATE INDEX IF NOT EXISTS idx_accrue_perf_fee_latest
      ON accrue_interest_events(
        chain_id,
        contract_address,
        block_number DESC,
        tx_index DESC,
        log_index DESC
      )
      WHERE performance_fee_shares != '0';
  `,
  },
  {
    name: "004_vship_boost_accounting",
    sql: `
    CREATE TABLE IF NOT EXISTS reward_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      base_boost_bps TEXT NOT NULL,
      vship_price_usd_raw TEXT NOT NULL,
      vship_price_usd_decimals INTEGER NOT NULL,
      vship_token_decimals INTEGER NOT NULL,
      fee_mint_stale_blocks INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO reward_config (
      id, base_boost_bps, vship_price_usd_raw, vship_price_usd_decimals,
      vship_token_decimals, fee_mint_stale_blocks, updated_at
    ) VALUES (1, '40000', '50000', 6, 6, 20000, 0);

    CREATE TABLE IF NOT EXISTS wallet_boost (
      address TEXT PRIMARY KEY,
      additional_boost_bps TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wallet_vship_state (
      address TEXT PRIMARY KEY,
      fee_watermark_raw TEXT NOT NULL,
      crystallized_vship_raw TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS boost_change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      changed_at INTEGER NOT NULL,
      change_type TEXT NOT NULL,
      address TEXT,
      old_bps TEXT NOT NULL,
      new_bps TEXT NOT NULL,
      actor TEXT NOT NULL,
      settled_wallet_count INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS vship_settlement_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settled_at INTEGER NOT NULL,
      address TEXT NOT NULL,
      fee_before_raw TEXT NOT NULL,
      fee_after_raw TEXT NOT NULL,
      fee_delta_raw TEXT NOT NULL,
      boost_bps_applied TEXT NOT NULL,
      vship_minted_raw TEXT NOT NULL,
      crystallized_vship_after_raw TEXT NOT NULL,
      reason TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_boost_change_events_changed_at
      ON boost_change_events(changed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vship_settlement_events_address_settled_at
      ON vship_settlement_events(address, settled_at DESC);
  `,
  },
] as const;

const RESET_REQUIRED_ERROR =
  "Local vault DB schema changed during development. Delete the existing SQLite database file and rerun the indexer.";

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

  const appliedMigrations = new Set(
    (
      db.prepare("SELECT name FROM migrations ORDER BY id").all() as Array<{ name: string }>
    ).map((row) => row.name),
  );

  if (
    appliedMigrations.has("001_initial_schema") &&
    !appliedMigrations.has("002_vault_position_indexer")
  ) {
    throw new Error(RESET_REQUIRED_ERROR);
  }

  if (appliedMigrations.has(MIGRATIONS[MIGRATIONS.length - 1]!.name)) {
    return;
  }

  const applyMigrations = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (appliedMigrations.has(migration.name)) {
        continue;
      }

      db.exec(migration.sql);
      db.prepare(
        "INSERT INTO migrations (name, applied_at) VALUES (?, ?)",
      ).run(migration.name, Date.now());
    }
  });

  applyMigrations();
}

export * from "./deposits";
export * from "./rewards";
export * from "./vault";
