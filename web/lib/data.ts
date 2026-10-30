import type { Address } from "viem";
import { flatBallotAbi, erc20Abi, publicClient } from "./chain";
import { CONFIG } from "./config";

export interface TokenInfo {
  decimals: number;
  symbol: string;
}

let tokenPromise: Promise<TokenInfo> | null = null;
export function getToken(): Promise<TokenInfo> {
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const [decimals, symbol] = await Promise.all([
        publicClient.readContract({ address: CONFIG.wif, abi: erc20Abi, functionName: "decimals" }),
        publicClient.readContract({ address: CONFIG.wif, abi: erc20Abi, functionName: "symbol" }),
      ]);
      return { decimals: Number(decimals), symbol: String(symbol) };
    })().catch((e) => {
      tokenPromise = null;
      throw e;
    });
  }
  return tokenPromise;
}

export interface ElectionMeta {
  id: bigint;
  creator: Address;
  resolver: Address;
  title: string;
  labels: string[];
  beneficiaries: Address[];
  metadataURI: string;
  blockNumber: bigint;
}

export interface ElectionState {
  creator: Address;
  resolver: Address;
  status: number; // 0 none, 1 open, 2 committed, 3 finalized, 4 cancelled
  optionCount: number;
  slots: number;
  bountyBps: number;
  voteStart: number;
  voteEnd: number;
  voteCost: bigint;
  minVotes: bigint;
  pool: bigint;
  root: `0x${string}`;
  rulesHash: `0x${string}`;
  entryCount: bigint;
  seedBlock: bigint;
  seed: `0x${string}`;
  finalizedAt: number;
  winnerOption: number;
  voterPool: bigint;
  prizePerSlot: bigint;
  bounty: bigint;
  bountyTo: Address;
  claimedTotal: bigint;
  bountyClaimed: boolean;
  unclaimedSwept: boolean;
}

export const STATUS_NAME = ["None", "Open", "Committed", "Finalized", "Cancelled"] as const;

const ballot = () => CONFIG.ballot as Address;

async function scanCreated(args: { id?: bigint }): Promise<ElectionMeta[]> {
  const latest = await publicClient.getBlockNumber();
  const out: ElectionMeta[] = [];
  for (let from = CONFIG.deployBlock; from <= latest; from += CONFIG.logChunk) {
    const to = from + CONFIG.logChunk - 1n > latest ? latest : from + CONFIG.logChunk - 1n;
    const logs = await publicClient.getContractEvents({
      address: ballot(),
      abi: flatBallotAbi,
      eventName: "ElectionCreated",
      args: args.id !== undefined ? { id: args.id } : undefined,
      fromBlock: from,
      toBlock: to,
    });
    for (const l of logs as any[]) {
      const p = l.args.params;
      out.push({
        id: l.args.id,
        creator: l.args.creator,
        resolver: l.args.resolver,
        title: p.title,
        labels: [...p.labels],
        beneficiaries: [...p.beneficiaries],
        metadataURI: p.metadataURI,
        blockNumber: l.blockNumber,
      });
    }
  }
  return out;
}

const metaCache = new Map<string, ElectionMeta>();

export async function getElectionMeta(id: bigint): Promise<ElectionMeta> {
  const hit = metaCache.get(id.toString());
  if (hit) return hit;
  const found = (await scanCreated({ id }))[0];
  if (!found) throw new Error(`Election #${id} was not found. Check the deploy block in the app settings.`);
  metaCache.set(id.toString(), found);
  return found;
}

export async function getAllMetas(): Promise<ElectionMeta[]> {
  const metas = await scanCreated({});
  for (const m of metas) metaCache.set(m.id.toString(), m);
  return metas.sort((a, b) => (a.id < b.id ? 1 : -1));
}

export async function getElectionState(id: bigint): Promise<ElectionState> {
  const e = (await publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "getElection", args: [id] })) as any;
  return {
    creator: e.creator,
    resolver: e.resolver,
    status: e.status,
    optionCount: e.optionCount,
    slots: e.slots,
    bountyBps: e.bountyBps,
    voteStart: Number(e.voteStart),
    voteEnd: Number(e.voteEnd),
    voteCost: e.voteCost,
    minVotes: e.minVotes,
    pool: e.pool,
    root: e.root,
    rulesHash: e.rulesHash,
    entryCount: e.entryCount,
    seedBlock: e.seedBlock,
    seed: e.seed,
    finalizedAt: Number(e.finalizedAt),
    winnerOption: e.winnerOption,
    voterPool: e.voterPool,
    prizePerSlot: e.prizePerSlot,
    bounty: e.bounty,
    bountyTo: e.bountyTo,
    claimedTotal: e.claimedTotal,
    bountyClaimed: e.bountyClaimed,
    unclaimedSwept: e.unclaimedSwept,
  };
}

export interface Tally {
  boxes: Address[];
  /** live balance in each box, in token units (only meaningful before sweep) */
  pending: bigint[];
  /** WIF burned per option at sweep; empty before the first sweep */
  swept: bigint[];
  sweptMask: bigint;
  /** committed verified votes per option; empty before commit */
  verified: bigint[];
  l2Block: bigint;
  now: number;
}

export async function getTally(id: bigint, optionCount: number): Promise<Tally> {
  const idx = Array.from({ length: optionCount }, (_, i) => BigInt(i));
  const [boxes, pending, swept, sweptMask, verified, l2Block, block] = await Promise.all([
    Promise.all(idx.map((o) => publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "boxAddress", args: [id, o] }))),
    Promise.all(idx.map((o) => publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "pendingRaw", args: [id, o] }))),
    publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "getSweptAmounts", args: [id] }),
    publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "sweptMask", args: [id] }),
    publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "getOptionVotes", args: [id] }),
    publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "l2Block" }),
    publicClient.getBlock(),
  ]);
  return {
    boxes: boxes as Address[],
    pending: pending as bigint[],
    swept: [...(swept as readonly bigint[])],
    sweptMask: sweptMask as bigint,
    verified: [...(verified as readonly bigint[])],
    l2Block: l2Block as bigint,
    now: Number(block.timestamp),
  };
}

export async function getGlobalStats() {
  const [next, burned] = await Promise.all([
    publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "nextElectionId" }),
    publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "totalBurned" }),
  ]);
  return { elections: next as bigint, burned: burned as bigint };
}

export async function getBondAmount(): Promise<bigint> {
  return (await publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "bondAmount" })) as bigint;
}

export async function getUnit(): Promise<bigint> {
  return (await publicClient.readContract({ address: ballot(), abi: flatBallotAbi, functionName: "unit" })) as bigint;
}
