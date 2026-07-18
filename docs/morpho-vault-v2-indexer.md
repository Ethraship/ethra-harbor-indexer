# Morpho Vault V2 Contract and Indexer Notes

Last checked: 2026-07-16

This note documents the deployed Morpho Vault V2 contract used by this Earn dashboard, the factory/source repository that deployed it, and the minimum context an agent needs to start building an indexer around it.

## Contract Summary

| Item | Value |
| --- | --- |
| Chain | Base mainnet |
| Chain ID | `8453` |
| RPC example | `https://mainnet.base.org` |
| Vault | `0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d` |
| Factory | `0x4501125508079A99ebBebCE205DeC9593C2b5857` |
| Factory label | `Morpho: Vault V2 Factory` |
| Asset | Base USDC, `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Asset decimals | `6` |
| Vault share decimals | `18` |
| Deployment tx | `0x13ec6b5e6993e4934c90deec278547d181c84e7da770db76c382cf8720ca1d49` |
| Deployment block | `48578255` |
| Constructor owner | `0xbd9611472c06a8464cfdbf781c5660b8c440c98c` |
| Deployment salt | `0x177ff4bda722b9d991cb0bcca7a2b4dc4c4367094a7769d42e6145044f2c9422` |

Current vault config observed on 2026-07-16:

| Read Method | Value |
| --- | --- |
| `owner()` | `0xe6Ee165bc0B05bEa7C5991D3b94B11aEa76c4FB9` |
| `curator()` | `0xe6Ee165bc0B05bEa7C5991D3b94B11aEa76c4FB9` |
| `asset()` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `receiveSharesGate()` | `0x0000000000000000000000000000000000000000` |
| `sendSharesGate()` | `0x0000000000000000000000000000000000000000` |
| `receiveAssetsGate()` | `0x0000000000000000000000000000000000000000` |
| `sendAssetsGate()` | `0x0000000000000000000000000000000000000000` |
| `liquidityAdapter()` | `0x7766C1a12153E4839b33F3514B56752152541560` |
| `adaptersLength()` | `1` |
| `adapters(0)` | `0x7766C1a12153E4839b33F3514B56752152541560` |
| `performanceFee()` | `500000000000000000` |
| `managementFee()` | `0` |

The constructor owner differs from the current owner, so an indexer should either replay configuration events from deployment or snapshot current configuration with read calls.

## Source Repositories

Protocol/factory source:

```bash
git clone https://github.com/morpho-org/vault-v2.git
```

Important files:

- `src/VaultV2Factory.sol`
- `src/VaultV2.sol`
- `src/interfaces/IVaultV2Factory.sol`
- `src/libraries/EventsLib.sol`

Direct source links:

- https://github.com/morpho-org/vault-v2
- https://github.com/morpho-org/vault-v2/blob/main/src/VaultV2Factory.sol
- https://github.com/morpho-org/vault-v2/blob/main/src/VaultV2.sol

Deployment helper repo, useful for deployment scripts but not the canonical protocol source:

```bash
git clone https://github.com/morpho-org/vault-v2-deployment.git
```

## Factory Deployment Model

`VaultV2Factory` deploys vaults with CREATE2:

```solidity
function createVaultV2(address owner, address asset, bytes32 salt) external returns (address)
```

It stores:

```solidity
mapping(address account => bool) public isVaultV2;
mapping(address owner => mapping(address asset => mapping(bytes32 salt => address))) public vaultV2;
```

The deployed vault can be verified from the factory:

```bash
cast call 0x4501125508079A99ebBebCE205DeC9593C2b5857 \
  "isVaultV2(address)(bool)" \
  0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d \
  --rpc-url https://mainnet.base.org

cast call 0x4501125508079A99ebBebCE205DeC9593C2b5857 \
  "vaultV2(address,address,bytes32)(address)" \
  0xbd9611472c06a8464cfdbf781c5660b8c440c98c \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
  0x177ff4bda722b9d991cb0bcca7a2b4dc4c4367094a7769d42e6145044f2c9422 \
  --rpc-url https://mainnet.base.org
```

## User-Facing Write Methods

The vault can be used directly without Privy as long as the caller controls the wallet/key and has enough Base gas. The main user methods are:

```solidity
deposit(uint256 assets, address onBehalf) returns (uint256 shares)
mint(uint256 shares, address onBehalf) returns (uint256 assets)
withdraw(uint256 assets, address receiver, address onBehalf) returns (uint256 shares)
redeem(uint256 shares, address receiver, address onBehalf) returns (uint256 assets)
```

Deposit flow:

1. User approves the vault to spend Base USDC.
2. User calls `deposit(rawUsdcAmount, userAddress)`.
3. Vault transfers USDC from the caller and mints vault shares to `onBehalf`.

Withdraw flow:

1. User calls `withdraw(rawUsdcAmount, receiver, userAddress)` to withdraw an asset amount.
2. Or user calls `redeem(rawShareAmount, receiver, userAddress)` to redeem a share amount.
3. For a full exit, `redeem(balanceOf(user), user, user)` is usually cleaner than choosing an asset amount.

Important: this contract's `maxDeposit`, `maxMint`, `maxWithdraw`, and `maxRedeem` methods intentionally return `0`, so an indexer or UI should not use them as availability/capacity signals. Use balances, gates, preview methods, and call simulations instead.

## Read Methods Useful for Indexers

Core state:

```solidity
asset() returns (address)
totalAssets() returns (uint256)
totalSupply() returns (uint256)
balanceOf(address account) returns (uint256)
allowance(address owner, address spender) returns (uint256)
convertToAssets(uint256 shares) returns (uint256)
convertToShares(uint256 assets) returns (uint256)
previewDeposit(uint256 assets) returns (uint256)
previewWithdraw(uint256 assets) returns (uint256)
previewRedeem(uint256 shares) returns (uint256)
accrueInterestView() returns (uint256 newTotalAssets, uint256 performanceFeeShares, uint256 managementFeeShares)
```

Config:

```solidity
owner() returns (address)
curator() returns (address)
receiveSharesGate() returns (address)
sendSharesGate() returns (address)
receiveAssetsGate() returns (address)
sendAssetsGate() returns (address)
liquidityAdapter() returns (address)
liquidityData() returns (bytes)
adaptersLength() returns (uint256)
adapters(uint256 index) returns (address)
performanceFee() returns (uint96)
managementFee() returns (uint96)
```

## Events to Index

Factory event:

```solidity
event CreateVaultV2(
  address indexed owner,
  address indexed asset,
  bytes32 salt,
  address indexed newVaultV2
);
```

Topic:

```text
CreateVaultV2(address,address,bytes32,address)
0x341ce009267aa0d78cc12b34155e223904a51ed49d144beb6eb8be87813edb4e
```

For this vault, the deployment log was emitted by the factory at block `48578255`, log index `0xbc`.

Vault creation event:

```solidity
event Constructor(address indexed owner, address indexed asset);
```

Topic:

```text
Constructor(address,address)
0x612d665a88b3ae6bc3e53207bfc2db673e2e05e2aa4a68043b618cc81295a27d
```

Primary position/accounting events:

```solidity
event Deposit(address indexed sender, address indexed onBehalf, uint256 assets, uint256 shares);
event Withdraw(address indexed sender, address indexed receiver, address indexed onBehalf, uint256 assets, uint256 shares);
event Transfer(address indexed from, address indexed to, uint256 shares);
event Approval(address indexed owner, address indexed spender, uint256 shares);
event AccrueInterest(uint256 previousTotalAssets, uint256 newTotalAssets, uint256 performanceFeeShares, uint256 managementFeeShares);
```

Topics:

```text
Deposit(address,address,uint256,uint256)
0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7

Withdraw(address,address,address,uint256,uint256)
0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db

Transfer(address,address,uint256)
0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef

AccrueInterest(uint256,uint256,uint256,uint256)
0x4dec04e750ca11537cabcd8a9eab06494de08da3735bc8871cd41250e190bc04
```

Configuration/allocation events worth indexing if the agent needs a full vault state timeline:

```solidity
SetOwner(address indexed newOwner)
SetCurator(address indexed newCurator)
SetReceiveSharesGate(address indexed newReceiveSharesGate)
SetSendSharesGate(address indexed newSendSharesGate)
SetReceiveAssetsGate(address indexed newReceiveAssetsGate)
SetSendAssetsGate(address indexed newSendAssetsGate)
SetAdapterRegistry(address indexed newAdapterRegistry)
AddAdapter(address indexed account)
RemoveAdapter(address indexed account)
SetLiquidityAdapterAndData(address indexed sender, address indexed newLiquidityAdapter, bytes indexed newLiquidityData)
SetPerformanceFee(uint256 newPerformanceFee)
SetPerformanceFeeRecipient(address indexed newPerformanceFeeRecipient)
SetManagementFee(uint256 newManagementFee)
SetManagementFeeRecipient(address indexed newManagementFeeRecipient)
SetMaxRate(uint256 newMaxRate)
SetForceDeallocatePenalty(address indexed adapter, uint256 forceDeallocatePenalty)
Allocate(address indexed sender, address indexed adapter, uint256 assets, bytes32[] ids, int256 change)
Deallocate(address indexed sender, address indexed adapter, uint256 assets, bytes32[] ids, int256 change)
ForceDeallocate(address indexed sender, address adapter, uint256 assets, address indexed onBehalf, bytes32[] ids, uint256 penaltyAssets)
```

## Suggested Indexer Bootstrap

For this single vault, start scanning at block `48578255`.

Index logs from these addresses:

- Factory: `0x4501125508079A99ebBebCE205DeC9593C2b5857`
- Vault: `0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d`
- Asset token, if wallet USDC movement is needed: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`

Minimum entities:

- `vaults`: address, factory, asset, assetDecimals, shareDecimals, constructorOwner, currentOwner, curator, deploymentTx, deploymentBlock, salt.
- `vault_config_snapshots`: vault, blockNumber, owner, curator, gates, adapters, fees.
- `accounts`: address.
- `share_balances`: vault, account, sharesRaw, updatedBlock.
- `positions`: vault, account, sharesRaw, currentAssetsRaw, netDepositedRaw, totalDepositedRaw, totalWithdrawnRaw, updatedBlock.
- `vault_events`: vault, txHash, logIndex, blockNumber, eventName, decodedArgs.
- `vault_account_events`: vault, account, txHash, logIndex, eventName, assetsRaw, sharesRaw.
- `vault_reward_state`: vault, globalPerformanceFeeIndexRaw, totalSupplyRaw, updatedBlock.
- `account_reward_state`: vault, account, rewardDebtRaw, earnedPerformanceFeeSharesRaw, updatedBlock.
- `performance_fee_accruals`: vault, txHash, logIndex, blockNumber, performanceFeeSharesRaw, totalSupplyBeforeRaw, globalPerformanceFeeIndexAfterRaw.

Position strategy:

1. Track `Transfer` events from the vault to maintain raw share balances. Mint is `from == address(0)`, burn is `to == address(0)`.
2. Track `Deposit` and `Withdraw` events for user activity and totals:
   - `Deposit.onBehalf` is the receiving account.
   - `Withdraw.onBehalf` is the share owner.
   - `Withdraw.receiver` is the asset recipient.
3. For current redeemable assets, call `previewRedeem(balanceOf(account))` or `convertToAssets(balanceOf(account))` at the indexed block/head.
4. For displayed earned yield, a simple approximation is `currentAssetsRaw - (totalDepositedRaw - totalWithdrawnRaw)`, floored at zero. Treat this as app-level analytics, not protocol accounting truth.
5. For historical share price, sample `totalAssets()`, `totalSupply()`, and/or `previewRedeem(10 ** shareDecimals)` at block boundaries. Be aware that Vault V2 has fee accrual logic, so current view methods may be a better source of truth than naive event-only math.

## Performance Fee Attribution

There is no Morpho event or state field that directly says "user X caused Y
performance fee." The vault computes fees globally from total assets and total
shares, then mints fee shares to the configured recipient. Attribution must be
reconstructed from vault-share ownership.

The most reliable and scalable approach is a global fee-per-share accumulator,
similar to a staking rewards index. This avoids writing one allocation row for
every user on every `AccrueInterest` event.

Required event order:

1. Process all vault logs in `(blockNumber, transactionIndex, logIndex)` order.
2. Use `Transfer` events as the canonical share-balance source.
3. When `AccrueInterest` emits `performanceFeeShares > 0`, apply the fee to the
   holders that existed immediately before the following fee mint transfer.

Accumulator state:

```text
globalPerformanceFeeIndexRaw
totalSupplyRaw
balanceRaw[account]
rewardDebtRaw[account]
earnedPerformanceFeeSharesRaw[account]
```

Use a large scale factor such as `10 ** 36` for index precision.

On `AccrueInterest`:

```text
if performanceFeeShares > 0 and totalSupplyRaw > 0:
  globalPerformanceFeeIndexRaw +=
    performanceFeeShares * SCALE / totalSupplyRaw
```

Then continue processing later logs. The fee mint itself will appear as a
`Transfer(address(0), performanceFeeRecipient, performanceFeeShares)` and should
update `totalSupplyRaw` and the recipient balance like any other mint.

Before any account balance changes, settle that account:

```text
pending =
  balanceRaw[account] *
  (globalPerformanceFeeIndexRaw - rewardDebtRaw[account]) /
  SCALE

earnedPerformanceFeeSharesRaw[account] += pending
rewardDebtRaw[account] = globalPerformanceFeeIndexRaw
```

On `Transfer(from, to, shares)`:

```text
if from != address(0):
  settle(from)
  balanceRaw[from] -= shares
else:
  totalSupplyRaw += shares

if to != address(0):
  settle(to)
  balanceRaw[to] += shares
  rewardDebtRaw[to] = globalPerformanceFeeIndexRaw
else:
  totalSupplyRaw -= shares
```

For a mint, only `to` needs settlement. For a burn, only `from` needs
settlement. For a normal transfer, settle both accounts before moving shares.

This model naturally handles repeated deposits. If a user deposits `$2`, yield
accrues, and then the same user deposits `$7`, the fee emitted at the start of
the `$7` deposit is attributed only to the shares that existed before the `$7`
deposit mint. The newly minted `$7` shares start earning attribution from the
next fee accrual onward.

Keep fee attribution in vault-share units first. The admin receives fee shares,
not USDC. If the app needs a USDC display value, compute it separately with an
explicit valuation block/time.

### Share Transfer Note

Vault shares are ERC-20 tokens, so a user can transfer them if the vault gates
allow it. The vault knows about the transfer because `transfer` and
`transferFrom` update the vault's own `balanceOf` mapping and emit `Transfer`
events.

This does not break the vault's own accounting:

- share transfers do not change `totalSupply`;
- share transfers do not change `totalAssets`;
- admin performance fees are still computed globally.

It also does not break the indexer if the indexer follows `Transfer` events.
Rewards should follow the shares. If Alice transfers shares to Bob before the
next `AccrueInterest`, Bob owns the economic position and receives future fee
attribution. Alice keeps any already-settled attribution from fee accruals that
happened before the transfer.

Important nuance: share transfers do not call `accrueInterest()`. Pending,
unaccrued yield moves with the transferred shares. This is consistent with
ERC-4626-style share ownership and does not require special handling beyond
processing transfers in order.

## Useful Cast Commands

Set shell constants:

```bash
export RPC_URL=https://mainnet.base.org
export VAULT=0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d
export FACTORY=0x4501125508079A99ebBebCE205DeC9593C2b5857
export USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

Read current vault state:

```bash
cast call $VAULT "asset()(address)" --rpc-url $RPC_URL
cast call $VAULT "owner()(address)" --rpc-url $RPC_URL
cast call $VAULT "curator()(address)" --rpc-url $RPC_URL
cast call $VAULT "totalAssets()(uint256)" --rpc-url $RPC_URL
cast call $VAULT "totalSupply()(uint256)" --rpc-url $RPC_URL
cast call $VAULT "liquidityAdapter()(address)" --rpc-url $RPC_URL
```

Read a wallet position:

```bash
export WALLET=0xYourWalletAddress

cast call $VAULT "balanceOf(address)(uint256)" $WALLET --rpc-url $RPC_URL
cast call $VAULT "previewRedeem(uint256)(uint256)" "$(cast call $VAULT "balanceOf(address)(uint256)" $WALLET --rpc-url $RPC_URL | awk '{print $1}')" --rpc-url $RPC_URL
cast call $USDC "balanceOf(address)(uint256)" $WALLET --rpc-url $RPC_URL
```

Inspect the deployment receipt:

```bash
cast receipt 0x13ec6b5e6993e4934c90deec278547d181c84e7da770db76c382cf8720ca1d49 \
  --rpc-url $RPC_URL
```

Verify event topics:

```bash
cast sig-event "CreateVaultV2(address,address,bytes32,address)"
cast sig-event "Deposit(address,address,uint256,uint256)"
cast sig-event "Withdraw(address,address,address,uint256,uint256)"
cast sig-event "Transfer(address,address,uint256)"
```

## Direct Interaction Reminder

This vault can be interacted with directly from an EOA or any wallet capable of signing Base transactions. Privy is not required by the contract. Privy is only one signing/orchestration layer used by this dashboard for embedded wallets.

Deposit one USDC:

```bash
export WALLET=0xYourWalletAddress
export AMOUNT=1000000

cast send $USDC "approve(address,uint256)" $VAULT $AMOUNT \
  --rpc-url $RPC_URL --chain 8453 --account earn-wallet

cast send $VAULT "deposit(uint256,address)" $AMOUNT $WALLET \
  --rpc-url $RPC_URL --chain 8453 --account earn-wallet
```

Withdraw one USDC:

```bash
export WITHDRAW_ASSETS=1000000

cast send $VAULT "withdraw(uint256,address,address)" $WITHDRAW_ASSETS $WALLET $WALLET \
  --rpc-url $RPC_URL --chain 8453 --account earn-wallet
```

Redeem all shares:

```bash
export SHARES=$(cast call $VAULT "balanceOf(address)(uint256)" $WALLET --rpc-url $RPC_URL | awk '{print $1}')

cast send $VAULT "redeem(uint256,address,address)" $SHARES $WALLET $WALLET \
  --rpc-url $RPC_URL --chain 8453 --account earn-wallet
```

## References

- Vault on BaseScan: https://basescan.org/address/0x9d2f57159eca69265a9b9efaaa8bc2b6b2df364d
- Factory on BaseScan: https://basescan.org/address/0x4501125508079A99ebBebCE205DeC9593C2b5857
- Deployment tx: https://basescan.org/tx/0x13ec6b5e6993e4934c90deec278547d181c84e7da770db76c382cf8720ca1d49
- Morpho Vault V2 source: https://github.com/morpho-org/vault-v2
- VaultV2Factory source: https://github.com/morpho-org/vault-v2/blob/main/src/VaultV2Factory.sol
- VaultV2 source: https://github.com/morpho-org/vault-v2/blob/main/src/VaultV2.sol
