export interface BlockRange {
  fromBlock: number;
  toBlock: number;
  safeHead: number;
  hasMore: boolean;
}

export function calculateRange(
  cursor: number,
  head: number,
  confirmations: number,
  chunkSize: number,
): BlockRange | null {
  const safeHead = head - confirmations;

  if (safeHead <= cursor) {
    return null;
  }

  const fromBlock = cursor + 1;
  const toBlock = Math.min(safeHead, fromBlock + chunkSize - 1);

  return {
    fromBlock,
    toBlock,
    safeHead,
    hasMore: safeHead > toBlock,
  };
}
