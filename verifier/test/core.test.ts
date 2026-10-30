import { describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import { verify, type RawTransfer, type VerifyInput } from "../src/core.js";
import { leafHash, merkleProof, merkleRoot, verifyProof } from "../src/merkle.js";
import { canonicalRules, makeRules, rulesHash } from "../src/rules.js";

const addr = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const BOX0 = addr(0xb0);
const BOX1 = addr(0xb1);
const UNIT = 10n ** 18n;
const START = 1000;
const END = 2000;

let log = 0;
const tr = (from: Address, to: Address, o: Partial<RawTransfer> = {}): RawTransfer => ({
  from,
  to,
  value: UNIT,
  blockNumber: 100n,
  logIndex: log++,
  timestamp: 1500,
  ...o,
});

function input(transfers: RawTransfer[], o: Partial<VerifyInput> = {}): VerifyInput {
  return {
    election: { voteStart: START, voteEnd: END, voteCost: UNIT, optionCount: 2 },
    boxes: [BOX0, BOX1],
    transfers,
    incoming: new Map(),
    contracts: new Set(),
    rules: makeRules(1, 3),
    ...o,
  };
}

describe("verify: basic counting", () => {
  it("counts one vote per wallet per option", () => {
    const r = verify(input([tr(addr(1), BOX0), tr(addr(2), BOX0), tr(addr(3), BOX1)]));
    expect(r.optionVotes).toEqual([2, 1]);
    expect(r.entries.map((e) => e.index)).toEqual([0, 1, 2]);
    expect(r.rejected).toHaveLength(0);
  });

  it("only a wallet's FIRST vote counts, even across options", () => {
    const r = verify(
      input([
        tr(addr(1), BOX0, { blockNumber: 100n }),
        tr(addr(1), BOX1, { blockNumber: 101n }),
        tr(addr(1), BOX0, { blockNumber: 102n }),
      ]),
    );
    expect(r.optionVotes).toEqual([1, 0]);
    expect(r.rejected.map((x) => x.reason)).toEqual(["duplicate_wallet", "duplicate_wallet"]);
  });

  it("orders by block then log index, regardless of input order", () => {
    const a = tr(addr(1), BOX0, { blockNumber: 105n, logIndex: 1 });
    const b = tr(addr(2), BOX1, { blockNumber: 104n, logIndex: 9 });
    const c = tr(addr(3), BOX0, { blockNumber: 105n, logIndex: 0 });
    const r1 = verify(input([a, b, c]));
    const r2 = verify(input([c, a, b]));
    expect(r1.entries.map((e) => e.voter)).toEqual([addr(2), addr(3), addr(1)]);
    expect(r2.root).toBe(r1.root);
    expect(r2.entries).toEqual(r1.entries);
  });

  it("enforces the time window inclusively", () => {
    const r = verify(
      input([
        tr(addr(1), BOX0, { timestamp: START - 1 }),
        tr(addr(2), BOX0, { timestamp: START }),
        tr(addr(3), BOX0, { timestamp: END }),
        tr(addr(4), BOX0, { timestamp: END + 1 }),
      ]),
    );
    expect(r.optionVotes).toEqual([2, 0]);
    expect(r.rejected.map((x) => x.reason).sort()).toEqual(["after_end", "before_start"]);
  });

  it("rejects transfers below the vote cost, and accepts overpayment as ONE vote", () => {
    const r = verify(input([tr(addr(1), BOX0, { value: UNIT - 1n }), tr(addr(2), BOX0, { value: 50n * UNIT })]));
    expect(r.optionVotes).toEqual([1, 0]);
    expect(r.rejected[0].reason).toBe("below_vote_cost");
  });

  it("ignores transfers that are not into a box", () => {
    const r = verify(input([tr(addr(1), addr(0x999))]));
    expect(r.entries).toHaveLength(0);
    expect(r.root).toBe(merkleRoot([]));
  });

  it("rejects contract voters", () => {
    const r = verify(input([tr(addr(0xc0), BOX0), tr(addr(2), BOX0)], { contracts: new Set([addr(0xc0)]) }));
    expect(r.optionVotes).toEqual([1, 0]);
    expect(r.rejected[0].reason).toBe("contract_voter");
  });

  it("never exceeds what was burned: verified <= rawQualifying per option", () => {
    const r = verify(input([tr(addr(1), BOX0), tr(addr(1), BOX0), tr(addr(2), BOX0)]));
    expect(r.rawQualifying).toEqual([3, 0]);
    expect(r.optionVotes[0]).toBeLessThanOrEqual(r.rawQualifying[0]);
  });
});

describe("verify: funder grouping", () => {
  const FARMER = addr(0xfa);
  const fund = (to: Address, from: Address = FARMER, block = 10n): RawTransfer[] => [
    tr(from, to, { blockNumber: block, timestamp: 500 }),
  ];

  it("caps wallets funded by the same EOA, keeping the earliest votes", () => {
    const voters = [1, 2, 3, 4, 5].map(addr);
    const incoming = new Map(voters.map((v) => [v, fund(v)]));
    const transfers = voters.map((v, i) => tr(v, BOX0, { blockNumber: 100n + BigInt(i) }));
    const r = verify(input(transfers, { incoming }));
    expect(r.optionVotes).toEqual([3, 0]);
    expect(r.entries.map((e) => e.voter)).toEqual([addr(1), addr(2), addr(3)]);
    const capped = r.rejected.filter((x) => x.reason === "funder_cap");
    expect(capped.map((x) => x.voter)).toEqual([addr(4), addr(5)]);
    expect(capped[0].funder).toBe(FARMER);
  });

  it("does not group wallets funded by contracts (DEX pools / routers)", () => {
    const POOL = addr(0x900);
    const voters = [1, 2, 3, 4, 5].map(addr);
    const incoming = new Map(voters.map((v) => [v, fund(v, POOL)]));
    const transfers = voters.map((v, i) => tr(v, BOX0, { blockNumber: 100n + BigInt(i) }));
    const r = verify(input(transfers, { incoming, contracts: new Set([POOL]) }));
    expect(r.optionVotes).toEqual([5, 0]);
  });

  it("skips contract senders and uses the earliest EOA as the funder", () => {
    const POOL = addr(0x900);
    const v = addr(1);
    const incoming = new Map([
      [v, [tr(POOL, v, { blockNumber: 5n, timestamp: 400 }), tr(FARMER, v, { blockNumber: 6n, timestamp: 450 })]],
    ]);
    const r = verify(input([tr(v, BOX0)], { incoming, contracts: new Set([POOL]) }));
    expect(r.entries[0].funder).toBe(FARMER);
  });

  it("ignores funding that happens after the vote", () => {
    const v = addr(1);
    const incoming = new Map([[v, [tr(FARMER, v, { blockNumber: 500n })]]]);
    const r = verify(input([tr(v, BOX0, { blockNumber: 100n })], { incoming }));
    expect(r.entries[0].funder).toBeNull();
  });

  it("maxPerFunder = 0 disables grouping", () => {
    const voters = [1, 2, 3, 4, 5].map(addr);
    const incoming = new Map(voters.map((v) => [v, fund(v)]));
    const transfers = voters.map((v, i) => tr(v, BOX0, { blockNumber: 100n + BigInt(i) }));
    const r = verify(input(transfers, { incoming, rules: makeRules(1, 0) }));
    expect(r.optionVotes).toEqual([5, 0]);
  });

  it("is insensitive to address casing in the incoming map", () => {
    const v = addr(0xabc);
    const incoming = new Map([[v.toLowerCase() as Address, [tr(FARMER, v, { blockNumber: 5n })]]]);
    const r = verify(input([tr(v, BOX0)], { incoming }));
    expect(r.entries[0].funder).toBe(FARMER);
  });
});

describe("merkle", () => {
  const mk = (n: number) => Array.from({ length: n }, (_, i) => leafHash(i, addr(i + 1), i % 2));

  it("every proof verifies, for many tree sizes", () => {
    for (let n = 1; n <= 40; n++) {
      const leaves = mk(n);
      const root = merkleRoot(leaves);
      for (let i = 0; i < n; i++) expect(verifyProof(merkleProof(leaves, i), root, leaves[i])).toBe(true);
    }
  });

  it("a wrong leaf or wrong root never verifies", () => {
    const leaves = mk(9);
    const root = merkleRoot(leaves);
    const proof = merkleProof(leaves, 3);
    expect(verifyProof(proof, root, leafHash(3, addr(999), 0))).toBe(false);
    expect(verifyProof(proof, merkleRoot(mk(8)), leaves[3])).toBe(false);
  });

  it("single leaf: root is the leaf, empty proof", () => {
    const leaves = mk(1);
    expect(merkleRoot(leaves)).toBe(leaves[0]);
    expect(merkleProof(leaves, 0)).toEqual([]);
  });
});

describe("rules", () => {
  it("canonical form and hash are stable and sensitive to every field", () => {
    const a = makeRules(100, 3);
    expect(canonicalRules(a)).toBe(
      '{"excludeContractVoters":true,"funderFromBlock":"100","maxPerFunder":3,"oneVotePerWallet":true,"version":"flat-ballot-rules-v1"}',
    );
    expect(rulesHash(a)).toBe(rulesHash(makeRules(100n, 3)));
    expect(rulesHash(a)).not.toBe(rulesHash(makeRules(101, 3)));
    expect(rulesHash(a)).not.toBe(rulesHash(makeRules(100, 2)));
  });
});
