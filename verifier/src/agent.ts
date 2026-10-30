#!/usr/bin/env -S npx tsx
/**
 * Flat Ballot host agent.
 *
 * An autonomous wallet that runs $WIF elections end to end, with no human in the loop:
 *
 *   launch   pick a topic (Claude if ANTHROPIC_API_KEY is set, a built-in list otherwise), fund the prize
 *            pool and bond from the agent's own $WIF, and open an election.
 *   tend     for every election this agent resolves: after voting closes, recompute the verified tally with
 *            the PUBLIC verifier, sweep (burn) the boxes, commit the root, finalize once the seed block
 *            exists, then claim every prize on behalf of the winners (claims always pay the voter).
 *   loop     launch (if idle for LAUNCH_EVERY_HOURS) + tend, forever.
 *
 * Everything the agent does can be re-checked by anyone: `cli.ts verify` reproduces its commitments.
 *
 * env: RPC, BALLOT, WIF, PK, DEPLOY_BLOCK, WIF_DEPLOY_BLOCK
 *      optional: ANTHROPIC_API_KEY, PRIZE (whole $WIF, default 1000), VOTE_COST (default 1),
 *      DURATION_HOURS (default 48), MIN_VOTES (default 10), SLOTS (default 5), BOUNTY_BPS (default 1000),
 *      LAUNCH_EVERY_HOURS (default 72), POLL_SECONDS (default 120), LOG_CHUNK (default 5000)
 */
import { createPublicClient, createWalletClient, http, parseAbiItem, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flatBallotAbi } from "./abi";
import { computeFromChain, readElection, STATUS } from "./chain";
import { merkleProof } from "./merkle";

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const env = (k: string, d?: string) => {
  const v = process.env[k] ?? d;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const RPC = env("RPC");
const BALLOT = env("BALLOT") as Address;
const WIF = env("WIF") as Address;
const account = privateKeyToAccount(env("PK") as Hex);
const DEPLOY_BLOCK = BigInt(env("DEPLOY_BLOCK", "0"));
const WIF_DEPLOY_BLOCK = BigInt(env("WIF_DEPLOY_BLOCK", "0"));
const CHUNK = BigInt(env("LOG_CHUNK", "5000"));

const pub = createPublicClient({ transport: http(RPC) });
const wallet = createWalletClient({ account, transport: http(RPC) });
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

async function send(address: Address, abi: any, functionName: string, args: unknown[]): Promise<Hex> {
  const { request } = await pub.simulateContract({ account, address, abi, functionName, args } as any);
  const hash = await wallet.writeContract(request as any);
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
  return hash;
}

// ---------- topics ----------

interface Topic {
  title: string;
  labels: string[];
}

const FALLBACK: Topic[] = [
  { title: "Is the earth flat?", labels: ["Flat", "Round", "Ask the Wizard"] },
  { title: "Best $WIF meme format?", labels: ["Wojak", "Pepe", "Chad", "Original art"] },
  { title: "What should the community build next?", labels: ["A game", "A tipping bot", "A DEX hook", "More elections"] },
  { title: "Peak of the cycle: when?", labels: ["This quarter", "Next quarter", "Next year", "Never"] },
  { title: "Best place to hold a $WIF meetup?", labels: ["Lagos", "Singapore", "Lisbon", "Online"] },
];

async function pickTopic(existingTitles: string[]): Promise<Topic> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (key) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
          max_tokens: 400,
          messages: [
            {
              role: "user",
              content:
                `You host public community votes for $WIF, a playful memecoin on Robinhood Chain ("the world is flat"). ` +
                `Write ONE fun, clean, non-political, non-hateful poll. Do not repeat these: ${JSON.stringify(existingTitles.slice(-20))}. ` +
                `Reply with JSON only: {"title": string (max 100 chars), "labels": string[] (2-5 options, each max 40 chars)}.`,
            },
          ],
        }),
      });
      const j: any = await res.json();
      const text: string = j.content?.[0]?.text ?? "";
      const t = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Topic;
      if (t.title && t.title.length <= 140 && Array.isArray(t.labels) && t.labels.length >= 2 && t.labels.length <= 8 && t.labels.every((l) => l && l.length <= 64)) {
        return t;
      }
    } catch (e: any) {
      log("topic generation failed, using fallback:", e.message);
    }
  }
  return FALLBACK.find((t) => !existingTitles.includes(t.title)) ?? FALLBACK[Math.floor(Math.random() * FALLBACK.length)];
}

// ---------- election discovery ----------

interface Mine {
  id: bigint;
  title: string;
  createdBlock: bigint;
}

async function myElections(): Promise<Mine[]> {
  const head = await pub.getBlockNumber();
  const out: Mine[] = [];
  const ev = parseAbiItem(
    "event ElectionCreated(uint256 indexed id, address indexed creator, address resolver, uint40 start, (string title, string[] labels, address[] beneficiaries, address resolver, uint40 voteStart, uint40 voteEnd, uint256 voteCost, uint256 minVotes, uint16 slots, uint16 bountyBps, uint256 initialPrize, string metadataURI) params)",
  );
  for (let from = DEPLOY_BLOCK; from <= head; from += CHUNK) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    const logs = await pub.getLogs({ address: BALLOT, event: ev, fromBlock: from, toBlock: to });
    for (const l of logs) {
      const a: any = l.args;
      const resolver = (a.resolver as string).toLowerCase();
      if (resolver === account.address.toLowerCase() || (a.creator as string).toLowerCase() === account.address.toLowerCase()) {
        out.push({ id: a.id, title: a.params.title, createdBlock: l.blockNumber });
      }
    }
  }
  return out;
}

// ---------- actions ----------

async function launch() {
  const decimals = await pub.readContract({ address: WIF, abi: erc20Abi, functionName: "decimals" });
  const unit = (n: string) => parseUnits(n, decimals);
  const bond = (await pub.readContract({ address: BALLOT, abi: flatBallotAbi, functionName: "bondAmount" })) as bigint;
  const prize = unit(env("PRIZE", "1000"));
  const need = bond + prize;
  const bal = (await pub.readContract({ address: WIF, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
  if (bal < need) {
    log(`not enough $WIF to launch (have ${bal}, need ${need}); skipping`);
    return;
  }
  const allowance = (await pub.readContract({ address: WIF, abi: erc20Abi, functionName: "allowance", args: [account.address, BALLOT] })) as bigint;
  if (allowance < need) await send(WIF, erc20Abi, "approve", [BALLOT, need]);

  const mine = await myElections();
  const topic = await pickTopic(mine.map((m) => m.title));
  const now = Number((await pub.getBlock()).timestamp); // chain time, not wall clock
  const hash = await send(BALLOT, flatBallotAbi, "createElection", [
    {
      title: topic.title,
      labels: topic.labels,
      beneficiaries: topic.labels.map(() => "0x0000000000000000000000000000000000000000"),
      resolver: account.address,
      voteStart: 0,
      voteEnd: now + Number(env("DURATION_HOURS", "48")) * 3600,
      voteCost: unit(env("VOTE_COST", "1")),
      minVotes: BigInt(env("MIN_VOTES", "10")),
      slots: Number(env("SLOTS", "5")),
      bountyBps: Number(env("BOUNTY_BPS", "1000")),
      initialPrize: prize,
      metadataURI: "",
    },
  ]);
  log(`launched "${topic.title}" [${topic.labels.join(" / ")}] tx ${hash}`);
}

async function tendOne(m: Mine) {
  let e = await readElection(pub, BALLOT, m.id);
  const block = await pub.getBlock();
  const now = Number(block.timestamp);

  if (e.status === 1 && e.resolver.toLowerCase() === account.address.toLowerCase() && now > e.voteEnd) {
    const g = await computeFromChain(pub, {
      ballot: BALLOT, wif: WIF, id: m.id, fromBlock: m.createdBlock - 1n, funderFromBlock: WIF_DEPLOY_BLOCK, chunk: CHUNK,
    });
    const mask = (await pub.readContract({ address: BALLOT, abi: flatBallotAbi, functionName: "sweptMask", args: [m.id] })) as bigint;
    for (let o = 0; o < e.optionCount; o++) {
      if ((mask >> BigInt(o)) & 1n) continue;
      log(`#${m.id} swept option ${o}: ${await send(BALLOT, flatBallotAbi, "sweep", [m.id, BigInt(o)])}`);
    }
    const r = g.result;
    log(`#${m.id} verified votes ${r.optionVotes.join(",")} (raw ${r.rawQualifying.join(",")}, rejected ${r.rejected.length})`);
    log(`#${m.id} committed: ${await send(BALLOT, flatBallotAbi, "commitResults", [m.id, r.root, r.rulesHash, r.optionVotes.map(BigInt)])}`);
    e = await readElection(pub, BALLOT, m.id);
  }

  if (e.status === 2) {
    try {
      log(`#${m.id} finalized: ${await send(BALLOT, flatBallotAbi, "finalize", [m.id])}`);
      e = await readElection(pub, BALLOT, m.id);
    } catch (err: any) {
      log(`#${m.id} finalize not ready yet (${err.shortMessage ?? err.message})`);
    }
  }

  if (e.status === 3) {
    const g = await computeFromChain(pub, {
      ballot: BALLOT, wif: WIF, id: m.id, fromBlock: m.createdBlock - 1n, funderFromBlock: WIF_DEPLOY_BLOCK, chunk: CHUNK,
      toBlock: undefined,
    });
    if (g.result.root.toLowerCase() !== e.root.toLowerCase()) {
      log(`#${m.id} WARNING: recomputed root differs from the committed root; not claiming`);
      return;
    }
    for (let s = 0; s < e.slots; s++) {
      const claimed = await pub.readContract({ address: BALLOT, abi: flatBallotAbi, functionName: "slotClaimed", args: [m.id, BigInt(s)] });
      if (claimed) continue;
      const idx = (await pub.readContract({ address: BALLOT, abi: flatBallotAbi, functionName: "winnerIndex", args: [m.id, BigInt(s)] })) as bigint;
      const entry = g.result.entries[Number(idx)];
      try {
        await send(BALLOT, flatBallotAbi, "claimPrize", [m.id, BigInt(s), idx, entry.voter, entry.option, merkleProof(g.result.leaves, Number(idx))]);
        log(`#${m.id} prize slot ${s} paid to ${entry.voter}`);
      } catch (err: any) {
        log(`#${m.id} slot ${s} claim failed: ${err.shortMessage ?? err.message}`);
      }
    }
    try {
      await send(BALLOT, flatBallotAbi, "claimBounty", [m.id]);
      log(`#${m.id} bounty paid`);
    } catch {
      /* none, or already paid */
    }
  }
  log(`#${m.id} "${m.title}" status=${STATUS[e.status]}`);
}

async function tend() {
  for (const m of await myElections()) {
    try {
      await tendOne(m);
    } catch (e: any) {
      log(`#${m.id} error: ${e.shortMessage ?? e.message}`);
    }
  }
}

async function main() {
  const cmd = process.argv[2];
  log(`agent ${account.address} on ${BALLOT}`);
  if (cmd === "launch") return launch();
  if (cmd === "tend") return tend();
  if (cmd === "loop") {
    let lastLaunch = 0;
    for (;;) {
      try {
        if (Date.now() - lastLaunch > Number(env("LAUNCH_EVERY_HOURS", "72")) * 3600_000) {
          await launch();
          lastLaunch = Date.now();
        }
        await tend();
      } catch (e: any) {
        log("cycle error:", e.shortMessage ?? e.message);
      }
      await new Promise((r) => setTimeout(r, Number(env("POLL_SECONDS", "120")) * 1000));
    }
  }
  console.log("usage: agent.ts <launch|tend|loop>");
  process.exit(2);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
