import { keccak256, toBytes, type Hex } from "viem";

/**
 * The ruleset is part of the result: its hash is committed on-chain next to the Merkle root, so
 * anyone can see exactly which rules produced a tally and re-run them.
 */
export interface Rules {
  version: "flat-ballot-rules-v1";
  /** Only externally-owned accounts vote. Contracts (routers, pools, multisigs) are rejected. */
  excludeContractVoters: true;
  /** A wallet's FIRST qualifying transfer is its vote; later transfers (any option) are ignored. */
  oneVotePerWallet: true;
  /**
   * Wallets are grouped by their "funder": the first EOA that ever sent them $WIF before they voted.
   * Contract senders (DEX pools, routers) are skipped when looking for a funder. At most this many
   * wallets per funder count, in vote order. Set to 0 to disable funder grouping.
   */
  maxPerFunder: number;
  /** Funding lookups start here (the $WIF deployment block); part of the rules for reproducibility. */
  funderFromBlock: string;
}

export const DEFAULT_RULES: Omit<Rules, "funderFromBlock"> = {
  version: "flat-ballot-rules-v1",
  excludeContractVoters: true,
  oneVotePerWallet: true,
  maxPerFunder: 3,
};

export function makeRules(funderFromBlock: bigint | number, maxPerFunder = DEFAULT_RULES.maxPerFunder): Rules {
  return { ...DEFAULT_RULES, maxPerFunder, funderFromBlock: BigInt(funderFromBlock).toString() };
}

/** Canonical JSON: keys sorted, no whitespace. The hash is over its UTF-8 bytes. */
export function canonicalRules(rules: Rules): string {
  const sorted = Object.fromEntries(Object.entries(rules).sort(([a], [b]) => (a < b ? -1 : 1)));
  return JSON.stringify(sorted);
}

export function rulesHash(rules: Rules): Hex {
  return keccak256(toBytes(canonicalRules(rules)));
}
