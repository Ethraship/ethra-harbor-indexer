import { ethers } from "ethers";

import type { AppConfig } from "../config";
import { MORPHO_VAULT_ABI } from "../abi/morphoVault";

export interface VaultTotalsSnapshot {
  blockNumber: number;
  totalAssetsRaw: string;
  totalSupplyRaw: string;
}

export interface BaseProviderClient {
  getBlockNumber(): Promise<number>;
  getLogs(filter: ethers.Filter): Promise<ethers.Log[]>;
  readVaultTotals?(config: AppConfig): Promise<VaultTotalsSnapshot>;
}

const BASE_NETWORK = {
  chainId: 8453,
  name: "base",
} as const;

const STATIC_PROVIDER_OPTIONS = {
  staticNetwork: true,
} as const;

export function createBaseProviderClient(config: AppConfig): BaseProviderClient {
  const providers = config.reconcileRpcUrls.map(
    (url) => new ethers.JsonRpcProvider(url, BASE_NETWORK, STATIC_PROVIDER_OPTIONS),
  );

  async function readVaultTotals(config: AppConfig): Promise<VaultTotalsSnapshot> {
    let lastError: unknown;

    for (const provider of providers) {
      try {
        const blockNumber = await provider.getBlockNumber();
        const contract = new ethers.Contract(
          config.contractAddress,
          MORPHO_VAULT_ABI,
          provider,
        );
        const [totalAssetsRaw, totalSupplyRaw] = await Promise.all([
          contract.totalAssets({ blockTag: blockNumber }),
          contract.totalSupply({ blockTag: blockNumber }),
        ]);

        return {
          blockNumber,
          totalAssetsRaw: totalAssetsRaw.toString(),
          totalSupplyRaw: totalSupplyRaw.toString(),
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  return {
    async getBlockNumber() {
      let lastError: unknown;

      for (const provider of providers) {
        try {
          return await provider.getBlockNumber();
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError;
    },
    async getLogs(filter) {
      let lastError: unknown;

      for (const provider of providers) {
        try {
          return await provider.getLogs(filter);
        } catch (error) {
          lastError = error;
        }
      }

      throw lastError;
    },
    async readVaultTotals(readConfig) {
      return readVaultTotals(readConfig);
    },
  };
}
