import type Database from "better-sqlite3";
import { getAddress } from "ethers";

export interface RewardConfigRow {
  baseBoostBps: bigint;
  vshipPriceUsdRaw: bigint;
  vshipPriceUsdDecimals: number;
  vshipTokenDecimals: number;
  feeMintStaleBlocks: number;
  updatedAt: number;
}

export interface BoostChangeEventInput {
  changedAt: number;
  changeType: "base" | "wallet_additional";
  address: string | null;
  oldBps: bigint;
  newBps: bigint;
  actor: string;
  settledWalletCount: number;
}

export interface BoostChangeEventRow extends BoostChangeEventInput {
  id: number;
}

export interface VshipSettlementEventInput {
  settledAt: number;
  address: string;
  feeBeforeRaw: bigint;
  feeAfterRaw: bigint;
  feeDeltaRaw: bigint;
  boostBpsApplied: bigint;
  vshipMintedRaw: bigint;
  crystallizedVshipAfterRaw: bigint;
  reason: "base_boost_change" | "wallet_boost_change";
}

export interface VshipSettlementEventRow extends VshipSettlementEventInput {
  id: number;
}

function normalizeAddress(address: string): string {
  return getAddress(address);
}

export function readRewardConfig(db: Database.Database): RewardConfigRow {
  const row = db.prepare(`
    SELECT
      base_boost_bps,
      vship_price_usd_raw,
      vship_price_usd_decimals,
      vship_token_decimals,
      fee_mint_stale_blocks,
      updated_at
    FROM reward_config
    WHERE id = 1
  `).get() as {
    base_boost_bps: string;
    vship_price_usd_raw: string;
    vship_price_usd_decimals: number;
    vship_token_decimals: number;
    fee_mint_stale_blocks: number;
    updated_at: number;
  };

  return {
    baseBoostBps: BigInt(row.base_boost_bps),
    vshipPriceUsdRaw: BigInt(row.vship_price_usd_raw),
    vshipPriceUsdDecimals: row.vship_price_usd_decimals,
    vshipTokenDecimals: row.vship_token_decimals,
    feeMintStaleBlocks: row.fee_mint_stale_blocks,
    updatedAt: row.updated_at,
  };
}

export function updateBaseBoostBps(
  db: Database.Database,
  baseBoostBps: bigint,
  updatedAt: number,
): void {
  db.prepare(`
    UPDATE reward_config
    SET base_boost_bps = ?, updated_at = ?
    WHERE id = 1
  `).run(baseBoostBps.toString(), updatedAt);
}

export function readWalletAdditionalBoostBps(
  db: Database.Database,
  address: string,
): bigint {
  const row = db.prepare(`
    SELECT additional_boost_bps
    FROM wallet_boost
    WHERE address = ?
  `).get(normalizeAddress(address)) as { additional_boost_bps: string } | undefined;

  return row ? BigInt(row.additional_boost_bps) : 0n;
}

export function upsertWalletAdditionalBoostBps(
  db: Database.Database,
  address: string,
  additionalBoostBps: bigint,
  updatedAt: number,
): void {
  db.prepare(`
    INSERT INTO wallet_boost (address, additional_boost_bps, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      additional_boost_bps = excluded.additional_boost_bps,
      updated_at = excluded.updated_at
  `).run(normalizeAddress(address), additionalBoostBps.toString(), updatedAt);
}

export function readWalletVshipState(
  db: Database.Database,
  address: string,
): { feeWatermarkRaw: bigint; crystallizedVshipRaw: bigint } | null {
  const row = db.prepare(`
    SELECT fee_watermark_raw, crystallized_vship_raw
    FROM wallet_vship_state
    WHERE address = ?
  `).get(normalizeAddress(address)) as {
    fee_watermark_raw: string;
    crystallized_vship_raw: string;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    feeWatermarkRaw: BigInt(row.fee_watermark_raw),
    crystallizedVshipRaw: BigInt(row.crystallized_vship_raw),
  };
}

export function upsertWalletVshipState(
  db: Database.Database,
  address: string,
  feeWatermarkRaw: bigint,
  crystallizedVshipRaw: bigint,
  updatedAt: number,
): void {
  db.prepare(`
    INSERT INTO wallet_vship_state (
      address,
      fee_watermark_raw,
      crystallized_vship_raw,
      updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(address) DO UPDATE SET
      fee_watermark_raw = excluded.fee_watermark_raw,
      crystallized_vship_raw = excluded.crystallized_vship_raw,
      updated_at = excluded.updated_at
  `).run(
    normalizeAddress(address),
    feeWatermarkRaw.toString(),
    crystallizedVshipRaw.toString(),
    updatedAt,
  );
}

export function insertBoostChangeEvent(
  db: Database.Database,
  event: BoostChangeEventInput,
): void {
  db.prepare(`
    INSERT INTO boost_change_events (
      changed_at,
      change_type,
      address,
      old_bps,
      new_bps,
      actor,
      settled_wallet_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.changedAt,
    event.changeType,
    event.address === null ? null : normalizeAddress(event.address),
    event.oldBps.toString(),
    event.newBps.toString(),
    event.actor,
    event.settledWalletCount,
  );
}

export function listBoostChangeEvents(
  db: Database.Database,
  limit?: number,
): BoostChangeEventRow[] {
  const rows = (limit === undefined
    ? db.prepare(`
        SELECT id, changed_at, change_type, address, old_bps, new_bps, actor, settled_wallet_count
        FROM boost_change_events
        ORDER BY changed_at DESC, id DESC
      `).all()
    : db.prepare(`
        SELECT id, changed_at, change_type, address, old_bps, new_bps, actor, settled_wallet_count
        FROM boost_change_events
        ORDER BY changed_at DESC, id DESC
        LIMIT ?
      `).all(limit)) as Array<{
    id: number;
    changed_at: number;
    change_type: "base" | "wallet_additional";
    address: string | null;
    old_bps: string;
    new_bps: string;
    actor: string;
    settled_wallet_count: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    changedAt: row.changed_at,
    changeType: row.change_type,
    address: row.address,
    oldBps: BigInt(row.old_bps),
    newBps: BigInt(row.new_bps),
    actor: row.actor,
    settledWalletCount: row.settled_wallet_count,
  }));
}

export function insertVshipSettlementEvent(
  db: Database.Database,
  event: VshipSettlementEventInput,
): void {
  db.prepare(`
    INSERT INTO vship_settlement_events (
      settled_at,
      address,
      fee_before_raw,
      fee_after_raw,
      fee_delta_raw,
      boost_bps_applied,
      vship_minted_raw,
      crystallized_vship_after_raw,
      reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.settledAt,
    normalizeAddress(event.address),
    event.feeBeforeRaw.toString(),
    event.feeAfterRaw.toString(),
    event.feeDeltaRaw.toString(),
    event.boostBpsApplied.toString(),
    event.vshipMintedRaw.toString(),
    event.crystallizedVshipAfterRaw.toString(),
    event.reason,
  );
}

export function listVshipSettlementEvents(
  db: Database.Database,
  address: string,
  limit?: number,
): VshipSettlementEventRow[] {
  const normalizedAddress = normalizeAddress(address);
  const rows = (limit === undefined
    ? db.prepare(`
        SELECT
          id,
          settled_at,
          address,
          fee_before_raw,
          fee_after_raw,
          fee_delta_raw,
          boost_bps_applied,
          vship_minted_raw,
          crystallized_vship_after_raw,
          reason
        FROM vship_settlement_events
        WHERE address = ?
        ORDER BY settled_at DESC, id DESC
      `).all(normalizedAddress)
    : db.prepare(`
        SELECT
          id,
          settled_at,
          address,
          fee_before_raw,
          fee_after_raw,
          fee_delta_raw,
          boost_bps_applied,
          vship_minted_raw,
          crystallized_vship_after_raw,
          reason
        FROM vship_settlement_events
        WHERE address = ?
        ORDER BY settled_at DESC, id DESC
        LIMIT ?
      `).all(normalizedAddress, limit)) as Array<{
    id: number;
    settled_at: number;
    address: string;
    fee_before_raw: string;
    fee_after_raw: string;
    fee_delta_raw: string;
    boost_bps_applied: string;
    vship_minted_raw: string;
    crystallized_vship_after_raw: string;
    reason: "base_boost_change" | "wallet_boost_change";
  }>;

  return rows.map((row) => ({
    id: row.id,
    settledAt: row.settled_at,
    address: row.address,
    feeBeforeRaw: BigInt(row.fee_before_raw),
    feeAfterRaw: BigInt(row.fee_after_raw),
    feeDeltaRaw: BigInt(row.fee_delta_raw),
    boostBpsApplied: BigInt(row.boost_bps_applied),
    vshipMintedRaw: BigInt(row.vship_minted_raw),
    crystallizedVshipAfterRaw: BigInt(row.crystallized_vship_after_raw),
    reason: row.reason,
  }));
}

export function listWalletBoostAddresses(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT address
    FROM wallet_boost
    ORDER BY address
  `).all() as Array<{ address: string }>).map((row) => row.address);
}

export function listWalletBoosts(
  db: Database.Database,
): Array<{ address: string; additionalBoostBps: bigint }> {
  const rows = db.prepare(`
    SELECT address, additional_boost_bps
    FROM wallet_boost
    WHERE CAST(additional_boost_bps AS INTEGER) > 0
    ORDER BY address ASC
  `).all() as Array<{ address: string; additional_boost_bps: string }>;

  return rows.map((row) => ({
    address: row.address,
    additionalBoostBps: BigInt(row.additional_boost_bps),
  }));
}

export function listWalletVshipAddresses(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT address
    FROM wallet_vship_state
    ORDER BY address
  `).all() as Array<{ address: string }>).map((row) => row.address);
}
