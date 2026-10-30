import { getAddress, type Address, type Hex } from "viem";
import { leafHash, merkleRoot } from "./merkle";
import { rulesHash, type Rules } from "./rules";

/** One $WIF Transfer log, with the timestamp of its block. */
export interface RawTransfer {
  from: Address;
  to: Address;
  value: bigint;
  blockNumber: bigint;
  logIndex: number;
  timestamp: number;
  txHash?: Hex;
}

export interface ElectionView {
  voteStart: number; // unix seconds, inclusive
  voteEnd: number; // unix seconds, inclusive (the contract only lets anyone sweep AFTER this second)
  voteCost: bigint;
  optionCount: number;
}

export interface VerifyInput {
  election: ElectionView;
  /** boxes[option] = counterfactual deposit address of that option. */
  boxes: Address[];
  /** Every $WIF Transfer whose `to` is one of the boxes (any time; the core filters by window). */
  transfers: RawTransfer[];
  /** Incoming $WIF transfers per candidate voter (any time; used to find the funder). */
  incoming: Map<Address, RawTransfer[]>;
  /** Addresses that have contract code. Anything not listed is treated as an EOA. */
  contracts: Set<Address>;
  rules: Rules;
}

export interface Entry {
  index: number;
  voter: Address;
  option: number;
  blockNumber: bigint;
  logIndex: number;
  txHash?: Hex;
  funder: Address | null;
}

export type RejectReason =
  | "before_start"
  | "after_end"
  | "below_vote_cost"
  | "contract_voter"
  | "duplicate_wallet"
  | "funder_cap";

export interface Rejected {
  voter: Address;
  option: number;
  blockNumber: bigint;
  logIndex: number;
  reason: RejectReason;
  /** the funder whose group was over the cap, for reason = funder_cap */
  funder?: Address;
}

export interface VerifyResult {
  entries: Entry[];
  rejected: Rejected[];
  optionVotes: number[];
  /** raw = every transfer in the window that met the vote cost, before any rule */
  rawQualifying: number[];
  root: Hex;
  rulesHash: Hex;
  leaves: Hex[];
}

const lc = (a: Address) => a.toLowerCase() as Address;
const order = (a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }) =>
  a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex;

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The deterministic heart of the verifier. Pure: same input => same output, byte for byte.
 * No clocks, no network, no randomness. This is the function anyone re-runs to check a committed result.
 */
export function verify(input: VerifyInput): VerifyResult {
  const { election, boxes, rules } = input;
  const contracts = new Set([...input.contracts].map(lc));
  const boxIndex = new Map(boxes.map((b, i) => [lc(b), i]));
  const incomingByWallet = new Map([...input.incoming].map(([k, v]) => [lc(k), v]));

  const rejected: Rejected[] = [];
  const rawQualifying = new Array<number>(election.optionCount).fill(0);

  // 1. Transfers into a box, oldest first (block, then log index).
  const ordered = input.transfers
    .filter((t) => boxIndex.has(lc(t.to)))
    .slice()
    .sort(order);

  // 2. Candidate votes: first qualifying transfer per wallet.
  const firstVote = new Map<Address, { t: RawTransfer; option: number }>();
  for (const t of ordered) {
    const option = boxIndex.get(lc(t.to))!;
    const voter = lc(t.from);
    const base = { voter: getAddress(voter), option, blockNumber: t.blockNumber, logIndex: t.logIndex };
    if (t.timestamp < election.voteStart) {
      rejected.push({ ...base, reason: "before_start" });
      continue;
    }
    if (t.timestamp > election.voteEnd) {
      rejected.push({ ...base, reason: "after_end" });
      continue;
    }
    if (t.value < election.voteCost) {
      rejected.push({ ...base, reason: "below_vote_cost" });
      continue;
    }
    rawQualifying[option] += 1;
    if (rules.excludeContractVoters && contracts.has(voter)) {
      rejected.push({ ...base, reason: "contract_voter" });
      continue;
    }
    if (rules.oneVotePerWallet && firstVote.has(voter)) {
      rejected.push({ ...base, reason: "duplicate_wallet" });
      continue;
    }
    firstVote.set(voter, { t, option });
  }

  // 3. Funder grouping, applied in vote order so the outcome never depends on iteration order.
  const candidates = [...firstVote.entries()]
    .map(([voter, v]) => ({ voter, ...v }))
    .sort((a, b) => order(a.t, b.t));

  const perFunder = new Map<Address, number>();
  const entries: Entry[] = [];
  for (const c of candidates) {
    const funder = findFunder(c.voter, c.t, incomingByWallet.get(c.voter) ?? [], contracts);
    if (rules.maxPerFunder > 0 && funder) {
      const used = perFunder.get(funder) ?? 0;
      if (used >= rules.maxPerFunder) {
        rejected.push({
          voter: getAddress(c.voter),
          option: c.option,
          blockNumber: c.t.blockNumber,
          logIndex: c.t.logIndex,
          reason: "funder_cap",
          funder: getAddress(funder),
        });
        continue;
      }
      perFunder.set(funder, used + 1);
    }
    entries.push({
      index: entries.length,
      voter: getAddress(c.voter),
      option: c.option,
      blockNumber: c.t.blockNumber,
      logIndex: c.t.logIndex,
      txHash: c.t.txHash,
      funder: funder ? getAddress(funder) : null,
    });
  }

  const optionVotes = new Array<number>(election.optionCount).fill(0);
  for (const e of entries) optionVotes[e.option] += 1;

  const leaves = entries.map((e) => leafHash(e.index, e.voter, e.option));
  return {
    entries,
    rejected,
    optionVotes,
    rawQualifying,
    leaves,
    root: merkleRoot(leaves),
    rulesHash: rulesHash(rules),
  };
}

/** Earliest EOA that sent this wallet $WIF strictly before it voted. Contract senders are skipped. */
function findFunder(voter: Address, vote: RawTransfer, incoming: RawTransfer[], contracts: Set<Address>): Address | null {
  const before = incoming
    .filter((t) => lc(t.to) === voter && t.value > 0n && order(t, vote) < 0)
    .sort(order);
  for (const t of before) {
    const f = lc(t.from);
    if (f === ZERO || f === voter || contracts.has(f)) continue;
    return f;
  }
  return null;
}
