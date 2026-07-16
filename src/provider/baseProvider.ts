import { ethers } from "ethers";

import type { AppConfig } from "../config";

export interface BaseProviderClient {
  getBlockNumber(): Promise<number>;
  getLogs(filter: ethers.Filter): Promise<ethers.Log[]>;
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

  return {
    getBlockNumber() {
      return providers[0].getBlockNumber();
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
  };
}
