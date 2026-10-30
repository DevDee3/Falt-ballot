import { getAddress, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { flatBallotAbi } from "./abi";
import { verify, type RawTransfer, type VerifyResult } from "./core";
import { makeRules, type Rules } from "./rules";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

export interface ChainElection {
  id: bigint;
  creator: Address;
  resolver: Address;
  status: number;
  optionCount: number;
  voteStart: number;
  voteEnd: number;
  voteCost: bigint;
  minVotes: bigint;
  pool: bigint;
  root: Hex;
  rulesHash: Hex;
  entryCount: bigint;
  seedBlock: bigint;
  slots: number;
  bountyBps: number;
  winnerOption: number;
  finalizedAt: number;
}

export const STATUS = ["None", "Open", "Committed", "Finalized", "Cancelled"] as const;

export async function readElection(client: PublicClient, ballot: Address, id: bigint): Promise<ChainElection> {
  const e = (await client.readContract({ address: ballot, abi: flatBallotAbi, functionName: "getElection", args: [id] })) as any;
  if (e.status === 0) throw new Error(`election ${id} does not exist`);
  return {
    id,
    creator: e.creator,
    resolver: e.resolver,
    status: e.status,
    optionCount: e.optionCount,
    voteStart: Number(e.voteStart),
    voteEnd: Number(e.voteEnd),
    voteCost: e.voteCost,
    minVotes: e.minVotes,
    pool: e.pool,
    root: e.root,
    rulesHash: e.rulesHash,
    entryCount: e.entryCount,
    seedBlock: e.seedBlock,
    slots: e.slots,
    bountyBps: e.bountyBps,
    winnerOption: e.winnerOption,
    finalizedAt: Number(e.finalizedAt),
  };
}

export async function readBoxes(client: PublicClient, ballot: Address, id: bigint, n: number): Promise<Address[]> {
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      client.readContract({ address: ballot, abi: flatBallotAbi, functionName: "boxAddress", args: [id, BigInt(i)] }) as Promise<Address>,
    ),
  );
}

export interface FetchOptions {
  /** inclusive block range for log queries */
  fromBlock: bigint;
  toBlock: bigint;
  /** max blocks per eth_getLogs call; lower this for strict RPCs */
  chunk?: bigint;
}

async function getTransfers(
  client: PublicClient,
  wif: Address,
  args: { to?: Address | Address[]; from?: Address | Address[] },
  { fromBlock, toBlock, chunk = 50_000n }: FetchOptions,
): Promise<{ log: any }[]> {
  const out: { log: any }[] = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;
    const logs = await client.getLogs({ address: wif, event: TRANSFER, args: args as any, fromBlock: start, toBlock: end });
    for (const log of logs) out.push({ log });
  }
  return out;
}

async function stamp(client: PublicClient, logs: { log: any }[], cache: Map<bigint, number>): Promise<RawTransfer[]> {
  const blocks = [...new Set(logs.map((l) => l.log.blockNumber as bigint))].filter((b) => !cache.has(b));
  await Promise.all(
    blocks.map(async (b) => {
      const blk = await client.getBlock({ blockNumber: b });
      cache.set(b, Number(blk.timestamp));
    }),
  );
  return logs.map(({ log }) => ({
    from: getAddress(log.args.from),
    to: getAddress(log.args.to),
    value: log.args.value as bigint,
    blockNumber: log.blockNumber as bigint,
    logIndex: log.logIndex as number,
    timestamp: cache.get(log.blockNumber as bigint)!,
    txHash: log.transactionHash as Hex,
  }));
}

export interface GatheredResult {
  election: ChainElection;
  boxes: Address[];
  rules: Rules;
  result: VerifyResult;
}

/**
 * Re-computes an election's verified tally from chain data only.
 * `funderFromBlock` is the $WIF deployment block (or any earlier block); it is recorded in the rules.
 */
export async function computeFromChain(
  client: PublicClient,
  opts: {
    ballot: Address;
    wif: Address;
    id: bigint;
    fromBlock: bigint; // block the election was created in (or earlier)
    toBlock?: bigint; // defaults to the latest block
    funderFromBlock: bigint;
    maxPerFunder?: number;
    chunk?: bigint;
  },
): Promise<GatheredResult> {
  const election = await readElection(client, opts.ballot, opts.id);
  const boxes = await readBoxes(client, opts.ballot, opts.id, election.optionCount);
  const toBlock = opts.toBlock ?? (await client.getBlockNumber());
  const cache = new Map<bigint, number>();

  const intoBoxes = await getTransfers(client, opts.wif, { to: boxes }, { fromBlock: opts.fromBlock, toBlock, chunk: opts.chunk });
  const transfers = await stamp(client, intoBoxes, cache);

  // Only wallets that could be counted need funder lookups.
  const candidates = [
    ...new Set(
      transfers
        .filter((t) => t.timestamp >= election.voteStart && t.timestamp <= election.voteEnd && t.value >= election.voteCost)
        .map((t) => t.from),
    ),
  ];

  const incoming = new Map<Address, RawTransfer[]>();
  const contracts = new Set<Address>();
  const known = new Set<Address>();
  const checkContract = async (a: Address) => {
    if (known.has(a)) return;
    known.add(a);
    const code = await client.getCode({ address: a });
    if (code && code !== "0x") contracts.add(a);
  };

  for (const voter of candidates) {
    const logs = await getTransfers(client, opts.wif, { to: voter }, { fromBlock: opts.funderFromBlock, toBlock, chunk: opts.chunk });
    incoming.set(voter, await stamp(client, logs, cache));
  }
  const toCheck = new Set<Address>(candidates);
  for (const list of incoming.values()) for (const t of list) toCheck.add(t.from);
  await Promise.all([...toCheck].map(checkContract));

  const rules = makeRules(opts.funderFromBlock, opts.maxPerFunder);
  const result = verify({
    election: {
      voteStart: election.voteStart,
      voteEnd: election.voteEnd,
      voteCost: election.voteCost,
      optionCount: election.optionCount,
    },
    boxes,
    transfers,
    incoming,
    contracts,
    rules,
  });
  return { election, boxes, rules, result };
}
