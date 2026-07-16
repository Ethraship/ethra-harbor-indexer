export const MORPHO_VAULT_ABI = [
  "event Deposit(address indexed sender, address indexed onBehalf, uint256 assets, uint256 shares)",
  "event Withdraw(address indexed sender, address indexed receiver, address indexed onBehalf, uint256 assets, uint256 shares)",
  "event Transfer(address indexed from, address indexed to, uint256 shares)",
  "event AccrueInterest(uint256 previousTotalAssets, uint256 newTotalAssets, uint256 performanceFeeShares, uint256 managementFeeShares)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];
