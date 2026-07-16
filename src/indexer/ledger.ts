import { getAddress } from "ethers";

export const SCALE = 10n ** 36n;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface AccountLedger {
  balanceRaw: bigint;
  rewardDebtRaw: bigint;
  earnedPerfFeeSharesRaw: bigint;
  lifetimeDepositedRaw: bigint;
  lifetimeWithdrawnRaw: bigint;
  touched: boolean;
  updatedBlockNumber: number;
  updatedLogIndex: number;
}

export interface LedgerState {
  globalIndexRaw: bigint;
  totalSupplyRaw: bigint;
  cumulativePerfFeeSharesRaw: bigint;
  cumulativeMgmtFeeSharesRaw: bigint;
  accounts: Map<string, AccountLedger>;
}

export interface DepositEvent {
  onBehalf: string;
  assets: bigint;
  shares: bigint;
  block: number;
  logIndex: number;
}

export interface WithdrawEvent {
  onBehalf: string;
  assets: bigint;
  shares: bigint;
  block: number;
  logIndex: number;
}

export interface TransferEvent {
  from: string;
  to: string;
  shares: bigint;
  block: number;
  logIndex: number;
}

export interface AccrueEvent {
  performanceFeeShares: bigint;
  managementFeeShares: bigint;
  block: number;
  logIndex: number;
}

export interface AccrueResult {
  globalIndexAfterRaw: bigint;
  totalSupplyBeforeRaw: bigint;
}

function emptyAccount(): AccountLedger {
  return {
    balanceRaw: 0n,
    rewardDebtRaw: 0n,
    earnedPerfFeeSharesRaw: 0n,
    lifetimeDepositedRaw: 0n,
    lifetimeWithdrawnRaw: 0n,
    touched: false,
    updatedBlockNumber: 0,
    updatedLogIndex: 0,
  };
}

function normalizeAddress(address: string): string {
  return getAddress(address);
}

function getOrCreateAccount(state: LedgerState, address: string): AccountLedger {
  const key = normalizeAddress(address);
  let account = state.accounts.get(key);

  if (!account) {
    account = emptyAccount();
    state.accounts.set(key, account);
  }

  return account;
}

function settleWithIndex(account: AccountLedger, globalIndexRaw: bigint): void {
  if (account.balanceRaw > 0n && globalIndexRaw > account.rewardDebtRaw) {
    account.earnedPerfFeeSharesRaw +=
      (account.balanceRaw * (globalIndexRaw - account.rewardDebtRaw)) / SCALE;
  }

  account.rewardDebtRaw = globalIndexRaw;
}

function stamp(account: AccountLedger, block: number, logIndex: number): void {
  account.touched = true;
  account.updatedBlockNumber = block;
  account.updatedLogIndex = logIndex;
}

function assertEnoughBalance(account: AccountLedger, shares: bigint): void {
  if (shares > account.balanceRaw) {
    throw new RangeError("insufficient balance for ledger mutation");
  }
}

export function settle(account: AccountLedger, globalIndexRaw: bigint): void {
  settleWithIndex(account, globalIndexRaw);
}

export function applyDeposit(state: LedgerState, ev: DepositEvent): void {
  const account = getOrCreateAccount(state, ev.onBehalf);

  settleWithIndex(account, state.globalIndexRaw);
  account.balanceRaw += ev.shares;
  account.lifetimeDepositedRaw += ev.assets;
  state.totalSupplyRaw += ev.shares;
  account.rewardDebtRaw = state.globalIndexRaw;
  stamp(account, ev.block, ev.logIndex);
}

export function applyWithdraw(state: LedgerState, ev: WithdrawEvent): void {
  const account = getOrCreateAccount(state, ev.onBehalf);

  settleWithIndex(account, state.globalIndexRaw);
  assertEnoughBalance(account, ev.shares);
  account.balanceRaw -= ev.shares;
  account.lifetimeWithdrawnRaw += ev.assets;
  state.totalSupplyRaw -= ev.shares;
  account.rewardDebtRaw = state.globalIndexRaw;
  stamp(account, ev.block, ev.logIndex);
}

export function applyTransfer(state: LedgerState, ev: TransferEvent): void {
  const fromAddress = normalizeAddress(ev.from);
  const toAddress = normalizeAddress(ev.to);

  if (fromAddress === toAddress) {
    const account = getOrCreateAccount(state, fromAddress);

    settleWithIndex(account, state.globalIndexRaw);
    stamp(account, ev.block, ev.logIndex);
    return;
  }

  const fromAccount = fromAddress === ZERO_ADDRESS ? null : getOrCreateAccount(state, fromAddress);
  const toAccount = toAddress === ZERO_ADDRESS ? null : getOrCreateAccount(state, toAddress);

  if (fromAccount) {
    settleWithIndex(fromAccount, state.globalIndexRaw);
    assertEnoughBalance(fromAccount, ev.shares);
  }

  if (toAccount) {
    settleWithIndex(toAccount, state.globalIndexRaw);
  }

  if (fromAccount) {
    fromAccount.balanceRaw -= ev.shares;
    fromAccount.rewardDebtRaw = state.globalIndexRaw;
    stamp(fromAccount, ev.block, ev.logIndex);
  }

  if (toAccount) {
    toAccount.balanceRaw += ev.shares;
    toAccount.rewardDebtRaw = state.globalIndexRaw;
    stamp(toAccount, ev.block, ev.logIndex);
  }

  if (fromAddress === ZERO_ADDRESS) {
    state.totalSupplyRaw += ev.shares;
  } else if (toAddress === ZERO_ADDRESS) {
    state.totalSupplyRaw -= ev.shares;
  }
}

export function applyAccrue(state: LedgerState, ev: AccrueEvent): AccrueResult {
  const totalSupplyBeforeRaw = state.totalSupplyRaw;

  state.cumulativePerfFeeSharesRaw += ev.performanceFeeShares;
  state.cumulativeMgmtFeeSharesRaw += ev.managementFeeShares;

  if (ev.performanceFeeShares > 0n && totalSupplyBeforeRaw > 0n) {
    state.globalIndexRaw += (ev.performanceFeeShares * SCALE) / totalSupplyBeforeRaw;
  }

  return {
    globalIndexAfterRaw: state.globalIndexRaw,
    totalSupplyBeforeRaw,
  };
}
