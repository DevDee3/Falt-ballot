import { encodePacked, keccak256, type Address, type Hex } from "viem";

/** leaf = keccak256(abi.encodePacked(uint256 index, address voter, uint8 option)) — matches FlatBallot.claimPrize */
export function leafHash(index: number | bigint, voter: Address, option: number): Hex {
  return keccak256(encodePacked(["uint256", "address", "uint8"], [BigInt(index), voter, option]));
}

/** Sorted-pair keccak256 (matches FlatBallot._verify). */
export function hashPair(a: Hex, b: Hex): Hex {
  // equal-length 0x-prefixed lowercase hex compares like unsigned integers
  return a.toLowerCase() < b.toLowerCase()
    ? keccak256(`0x${a.slice(2)}${b.slice(2)}` as Hex)
    : keccak256(`0x${b.slice(2)}${a.slice(2)}` as Hex);
}

function nextLevel(level: Hex[]): Hex[] {
  const next: Hex[] = [];
  for (let i = 0; i < level.length; i += 2) {
    next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]); // odd node promoted unchanged
  }
  return next;
}

export const EMPTY_ROOT: Hex = `0x${"00".repeat(32)}`;

export function merkleRoot(leaves: Hex[]): Hex {
  if (leaves.length === 0) return EMPTY_ROOT;
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0];
}

export function merkleProof(leaves: Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new Error("index out of range");
  const proof: Hex[] = [];
  let level = leaves;
  let idx = index;
  while (level.length > 1) {
    const sib = idx ^ 1;
    if (sib < level.length) proof.push(level[sib]);
    level = nextLevel(level);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export function verifyProof(proof: Hex[], root: Hex, leaf: Hex): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return h.toLowerCase() === root.toLowerCase();
}
