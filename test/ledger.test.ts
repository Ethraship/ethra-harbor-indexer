import assert from "node:assert/strict";
import test from "node:test";

import { getAddress } from "ethers";

import {
  ZERO_ADDRESS,
  applyAccrue,
  applyDeposit,
  applyTransfer,
  applyWithdraw,
  settle,
  type AccountLedger,
  type LedgerState,
} from "../src/indexer/ledger";

function emptyState(): LedgerState {
  return {
    globalIndexRaw: 0n,
    totalSupplyRaw: 0n,
    cumulativePerfFeeSharesRaw: 0n,
    cumulativeMgmtFeeSharesRaw: 0n,
    accounts: new Map(),
  };
}

function getAccount(state: LedgerState, address: string): AccountLedger {
  const account = state.accounts.get(address);

  assert.ok(account, `expected account for ${address}`);
  return account;
}

test("single user second mint only earns fees accrued before the new shares existed", () => {
  const state = emptyState();
  const user = "0x1111111111111111111111111111111111111111";

  applyTransfer(state, {
    from: ZERO_ADDRESS,
    to: user,
    shares: 2n,
    block: 1,
    logIndex: 0,
  });
  applyAccrue(state, {
    performanceFeeShares: 20n,
    managementFeeShares: 0n,
    block: 2,
    logIndex: 0,
  });
  applyTransfer(state, {
    from: ZERO_ADDRESS,
    to: user,
    shares: 7n,
    block: 3,
    logIndex: 0,
  });
  applyAccrue(state, {
    performanceFeeShares: 90n,
    managementFeeShares: 0n,
    block: 4,
    logIndex: 0,
  });

  settle(getAccount(state, user), state.globalIndexRaw);

  assert.deepEqual(getAccount(state, user), {
    balanceRaw: 9n,
    rewardDebtRaw: state.globalIndexRaw,
    earnedPerfFeeSharesRaw: 110n,
    lifetimeDepositedRaw: 0n,
    lifetimeWithdrawnRaw: 0n,
    touched: true,
    updatedBlockNumber: 3,
    updatedLogIndex: 0,
  });
  assert.equal(state.totalSupplyRaw, 9n);
  assert.equal(state.cumulativePerfFeeSharesRaw, 110n);
  assert.equal(state.cumulativeMgmtFeeSharesRaw, 0n);
});

test("multi user split distributes performance fees by existing balance", () => {
  const state = emptyState();
  const a = getAddress("0x1111111111111111111111111111111111111111");
  const b = getAddress("0x2222222222222222222222222222222222222222");

  applyTransfer(state, {
    from: ZERO_ADDRESS,
    to: a,
    shares: 250n,
    block: 1,
    logIndex: 0,
  });
  applyTransfer(state, {
    from: ZERO_ADDRESS,
    to: b,
    shares: 750n,
    block: 1,
    logIndex: 1,
  });
  applyAccrue(state, {
    performanceFeeShares: 1000n,
    managementFeeShares: 0n,
    block: 2,
    logIndex: 0,
  });

  settle(getAccount(state, a), state.globalIndexRaw);
  settle(getAccount(state, b), state.globalIndexRaw);

  assert.equal(getAccount(state, a).earnedPerfFeeSharesRaw, 250n);
  assert.equal(getAccount(state, b).earnedPerfFeeSharesRaw, 750n);
});

test("admin balances stay in the denominator and do not over-credit app users", () => {
  const state = emptyState();
  const admin = getAddress("0x3333333333333333333333333333333333333333");
  const user = getAddress("0x4444444444444444444444444444444444444444");

  applyTransfer(state, {
    from: ZERO_ADDRESS,
    to: admin,
    shares: 100n,
    block: 1,
    logIndex: 0,
  });
  applyTransfer(state, {
    from: ZERO_ADDRESS,
    to: user,
    shares: 900n,
    block: 1,
    logIndex: 1,
  });
  applyAccrue(state, {
    performanceFeeShares: 1000n,
    managementFeeShares: 25n,
    block: 2,
    logIndex: 0,
  });

  settle(getAccount(state, admin), state.globalIndexRaw);
  settle(getAccount(state, user), state.globalIndexRaw);

  assert.equal(getAccount(state, admin).earnedPerfFeeSharesRaw, 100n);
  assert.equal(getAccount(state, user).earnedPerfFeeSharesRaw, 900n);
  assert.equal(state.cumulativeMgmtFeeSharesRaw, 25n);
});

test("unknown holder still accrues into its own earned balance", () => {
  const state = emptyState();
  const holder = getAddress("0x5555555555555555555555555555555555555555");

  applyTransfer(state, {
    from: ZERO_ADDRESS,
    to: holder,
    shares: 123n,
    block: 1,
    logIndex: 0,
  });
  applyAccrue(state, {
    performanceFeeShares: 123n,
    managementFeeShares: 0n,
    block: 2,
    logIndex: 0,
  });

  settle(getAccount(state, holder), state.globalIndexRaw);

  assert.equal(getAccount(state, holder).earnedPerfFeeSharesRaw, 123n);
  assert.equal(state.totalSupplyRaw, 123n);
});

test("withdrawal before accrual prevents new fees from being earned", () => {
  const state = emptyState();
  const user = getAddress("0x6666666666666666666666666666666666666666");

  applyTransfer(state, {
    from: ZERO_ADDRESS,
    to: user,
    shares: 100n,
    block: 1,
    logIndex: 0,
  });
  applyAccrue(state, {
    performanceFeeShares: 50n,
    managementFeeShares: 0n,
    block: 2,
    logIndex: 0,
  });
  applyTransfer(state, {
    from: user,
    to: ZERO_ADDRESS,
    shares: 100n,
    block: 3,
    logIndex: 0,
  });
  applyWithdraw(state, {
    onBehalf: user,
    assets: 100n,
    shares: 100n,
    block: 4,
    logIndex: 0,
  });
  applyAccrue(state, {
    performanceFeeShares: 50n,
    managementFeeShares: 0n,
    block: 5,
    logIndex: 0,
  });

  settle(getAccount(state, user), state.globalIndexRaw);

  assert.equal(getAccount(state, user).earnedPerfFeeSharesRaw, 50n);
  assert.equal(getAccount(state, user).balanceRaw, 0n);
  assert.equal(getAccount(state, user).lifetimeWithdrawnRaw, 100n);
});

test("transfer follows shares so the receiver earns later fees", () => {
  const state = emptyState();
  const alice = getAddress("0x7777777777777777777777777777777777777777");
  const bob = getAddress("0x8888888888888888888888888888888888888888");

  applyTransfer(state, {
    from: ZERO_ADDRESS,
    to: alice,
    shares: 100n,
    block: 1,
    logIndex: 0,
  });
  applyAccrue(state, {
    performanceFeeShares: 100n,
    managementFeeShares: 0n,
    block: 2,
    logIndex: 0,
  });
  applyTransfer(state, {
    from: alice,
    to: bob,
    shares: 100n,
    block: 3,
    logIndex: 0,
  });
  applyAccrue(state, {
    performanceFeeShares: 100n,
    managementFeeShares: 0n,
    block: 4,
    logIndex: 0,
  });

  settle(getAccount(state, alice), state.globalIndexRaw);
  settle(getAccount(state, bob), state.globalIndexRaw);

  assert.equal(getAccount(state, alice).earnedPerfFeeSharesRaw, 100n);
  assert.equal(getAccount(state, bob).earnedPerfFeeSharesRaw, 100n);
  assert.equal(getAccount(state, alice).touched, true);
  assert.equal(getAccount(state, bob).touched, true);
  assert.equal(getAccount(state, alice).updatedBlockNumber, 3);
  assert.equal(getAccount(state, alice).updatedLogIndex, 0);
  assert.equal(getAccount(state, bob).updatedBlockNumber, 3);
  assert.equal(getAccount(state, bob).updatedLogIndex, 0);
});

test("deposit is lifetime-only and does not change balance or total supply", () => {
  const state = emptyState();
  const user = getAddress("0x9999999999999999999999999999999999999999");

  applyDeposit(state, {
    onBehalf: user,
    shares: 42n,
    assets: 42n,
    block: 1,
    logIndex: 0,
  });

  const account = getAccount(state, user);

  assert.equal(account.balanceRaw, 0n);
  assert.equal(account.lifetimeDepositedRaw, 42n);
  assert.equal(account.rewardDebtRaw, 0n);
  assert.equal(state.totalSupplyRaw, 0n);
});

test("withdraw is lifetime-only and does not change balance or total supply", () => {
  const state = emptyState();
  const user = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  applyTransfer(state, {
    from: ZERO_ADDRESS,
    to: user,
    shares: 50n,
    block: 1,
    logIndex: 0,
  });
  applyWithdraw(state, {
    onBehalf: user,
    shares: 10n,
    assets: 10n,
    block: 2,
    logIndex: 0,
  });

  const account = getAccount(state, user);

  assert.equal(account.balanceRaw, 50n);
  assert.equal(account.lifetimeWithdrawnRaw, 10n);
  assert.equal(account.rewardDebtRaw, 0n);
  assert.equal(state.totalSupplyRaw, 50n);
});
