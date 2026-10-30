import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { foundry } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { flatBallotAbi, flatBallotBytecode, mockWifAbi, mockWifBytecode } from "../src/abi.js";
import { computeFromChain } from "../src/chain.js";
import { leafHash, merkleProof, merkleRoot } from "../src/merkle.js";

/**
 * Real-EVM end-to-end: deploy, run an election, have the TS verifier commit the result, finalize,
 * and claim every prize with TS-built Merkle proofs. If the TS tree ever diverged from the Solidity
 * verifier, claimPrize would revert here.
 */
const PORT = 8745;
const RPC = `http://127.0.0.1:${PORT}`;
const ANVIL = process.env.ANVIL_BIN ?? "/root/.foundry/bin/anvil";
const UNIT = 10n ** 18n;
const BOND = 1_000n * UNIT;

// anvil's well-known dev keys
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

let proc: ChildProcess;
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const test = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC) });
const wallet = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain: foundry, transport: http(RPC) });

async function waitForRpc() {
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getBlockNumber();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

describe("e2e on anvil", () => {
  beforeAll(async () => {
    proc = spawn(ANVIL, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
    await waitForRpc();
  }, 30_000);
  afterAll(() => {
    proc?.kill();
  });

  it("full lifecycle: vote -> sweep -> verifier commit -> finalize -> claim with TS proofs", async () => {
    const [creator, resolverKey, farmer, honest] = KEYS;
    const creatorW = wallet(creator);
    const resolverW = wallet(resolverKey);
    const farmerW = wallet(farmer);
    const honestW = wallet(honest);

    // deploy mock WIF + ballot
    const deploy = async (abi: any, bytecode: Hex, args: any[] = []) => {
      const hash = await creatorW.deployContract({ abi, bytecode, args });
      return (await pub.waitForTransactionReceipt({ hash })).contractAddress as Address;
    };
    const wif = await deploy(mockWifAbi, mockWifBytecode as Hex);
    const ballot = await deploy(flatBallotAbi, flatBallotBytecode as Hex, [wif, BOND]);
    const wifDeployBlock = await pub.getBlockNumber();

    const send = async (w: ReturnType<typeof wallet>, address: Address, abi: any, fn: string, args: any[]) => {
      const hash = await w.writeContract({ address, abi, functionName: fn, args } as any);
      const r = await pub.waitForTransactionReceipt({ hash });
      expect(r.status).toBe("success");
      return r;
    };

    await send(creatorW, wif, mockWifAbi, "mint", [creatorW.account.address, 100_000n * UNIT]);
    await send(creatorW, wif, mockWifAbi, "approve", [ballot, 2n ** 256n - 1n]);

    // 6 voters: 2 honest-looking + 4 funded by ONE farmer (cap = 3 => one is rejected)
    const voters = Array.from({ length: 7 }, (_, i) => privateKeyToAccount(`0x${(0x1000 + i).toString(16).padStart(64, "0")}` as Hex));
    const farmerAddr = farmerW.account.address;
    const honestAddr = honestW.account.address;
    await send(creatorW, wif, mockWifAbi, "mint", [farmerAddr, 100n * UNIT]);
    await send(creatorW, wif, mockWifAbi, "mint", [honestAddr, 100n * UNIT]);
    await test.setBalance({ address: farmerAddr, value: parseEther("10") });
    await test.setBalance({ address: honestAddr, value: parseEther("10") });

    const blk = await pub.getBlock();
    const now = Number(blk.timestamp);
    const createReceipt = await send(creatorW, ballot, flatBallotAbi, "createElection", [
      {
        title: "Who is the G.O.A.T.?",
        labels: ["Alice", "Bob"],
        beneficiaries: [honestAddr, "0x0000000000000000000000000000000000000000"],
        resolver: resolverW.account.address,
        voteStart: 0,
        voteEnd: now + 3600,
        voteCost: UNIT,
        minVotes: 3n,
        slots: 5,
        bountyBps: 2000,
        initialPrize: 10_000n * UNIT,
        metadataURI: "",
      },
    ]);
    const id = 1n;

    const boxes = (await Promise.all([0n, 1n].map((o) => pub.readContract({ address: ballot, abi: flatBallotAbi, functionName: "boxAddress", args: [id, o] })))) as Address[];

    // farmer funds 4 sybil wallets, each then votes Alice
    for (let i = 0; i < 4; i++) {
      const v = voters[i];
      await test.setBalance({ address: v.address, value: parseEther("1") });
      await send(farmerW, wif, mockWifAbi, "transfer", [v.address, 2n * UNIT]);
      await send(wallet(`0x${(0x1000 + i).toString(16).padStart(64, "0")}` as Hex), wif, mockWifAbi, "transfer", [boxes[0], UNIT]);
    }
    // two honest-ish voters funded by the creator (a different funder) vote Bob
    for (let i = 4; i < 6; i++) {
      const v = voters[i];
      await test.setBalance({ address: v.address, value: parseEther("1") });
      await send(creatorW, wif, mockWifAbi, "transfer", [v.address, 2n * UNIT]);
      await send(wallet(`0x${(0x1000 + i).toString(16).padStart(64, "0")}` as Hex), wif, mockWifAbi, "transfer", [boxes[1], UNIT]);
    }
    // a duplicate from voter 4 (second vote must not count) and an underpaying voter 6
    await send(wallet(`0x${(0x1004).toString(16).padStart(64, "0")}` as Hex), wif, mockWifAbi, "transfer", [boxes[1], UNIT]);
    await send(creatorW, wif, mockWifAbi, "transfer", [voters[6].address, UNIT / 2n]);
    await test.setBalance({ address: voters[6].address, value: parseEther("1") });
    await send(wallet(`0x${(0x1006).toString(16).padStart(64, "0")}` as Hex), wif, mockWifAbi, "transfer", [boxes[0], UNIT / 2n]);

    // close voting, sweep both boxes
    await test.setNextBlockTimestamp({ timestamp: BigInt(now + 3601) });
    await test.mine({ blocks: 1 });
    await send(creatorW, ballot, flatBallotAbi, "sweep", [id, 0n]);
    await send(creatorW, ballot, flatBallotAbi, "sweep", [id, 1n]);

    // verifier recomputes everything from chain data
    const gathered = await computeFromChain(pub, {
      ballot,
      wif,
      id,
      fromBlock: createReceipt.blockNumber - 1n,
      funderFromBlock: wifDeployBlock,
      maxPerFunder: 3,
      chunk: 1000n,
    });
    const { result, rules } = gathered;
    // option 0: 4 farmer wallets, cap 3 => 3 ; option 1: 2 voters ; underpay + duplicate rejected
    expect(result.optionVotes).toEqual([3, 2]);
    expect(result.entries).toHaveLength(5);
    const reasons = result.rejected.map((r) => r.reason).sort();
    expect(reasons).toEqual(["below_vote_cost", "duplicate_wallet", "funder_cap"]);

    // commit as the resolver
    await send(resolverW, ballot, flatBallotAbi, "commitResults", [id, result.root, result.rulesHash, result.optionVotes.map(BigInt)]);
    const committed = (await pub.readContract({ address: ballot, abi: flatBallotAbi, functionName: "getElection", args: [id] })) as any;
    expect(committed.root).toBe(result.root);
    expect(committed.rulesHash).toBe(result.rulesHash);
    expect(committed.entryCount).toBe(5n);

    // mine past the seed block and finalize
    await test.mine({ blocks: 45 });
    await send(creatorW, ballot, flatBallotAbi, "finalize", [id]);
    const fin = (await pub.readContract({ address: ballot, abi: flatBallotAbi, functionName: "getElection", args: [id] })) as any;
    expect(fin.status).toBe(3);
    expect(fin.winnerOption).toBe(0);

    // claim EVERY slot with proofs built by the TS merkle code
    const before = await pub.readContract({ address: wif, abi: mockWifAbi, functionName: "balanceOf", args: [ballot] });
    for (let s = 0n; s < 5n; s++) {
      const idx = (await pub.readContract({ address: ballot, abi: flatBallotAbi, functionName: "winnerIndex", args: [id, s] })) as bigint;
      const entry = result.entries[Number(idx)];
      const proof = merkleProof(result.leaves, Number(idx));
      await send(creatorW, ballot, flatBallotAbi, "claimPrize", [id, s, idx, entry.voter, entry.option, proof]);
    }
    await send(creatorW, ballot, flatBallotAbi, "claimBounty", [id]);
    const after = (await pub.readContract({ address: wif, abi: mockWifAbi, functionName: "balanceOf", args: [ballot] })) as bigint;
    expect(after).toBeLessThan(before as bigint);

    // a forged proof / wrong leaf must be rejected by the contract
    const idx0 = (await pub.readContract({ address: ballot, abi: flatBallotAbi, functionName: "winnerIndex", args: [id, 0n] })) as bigint;
    await expect(
      creatorW.writeContract({
        address: ballot,
        abi: flatBallotAbi,
        functionName: "claimPrize",
        args: [id, 0n, idx0, farmerAddr, 0, merkleProof(result.leaves, Number(idx0))],
      } as any),
    ).rejects.toThrow();

    // tree parity: independent recomputation of the root
    expect(merkleRoot(result.entries.map((e) => leafHash(e.index, e.voter, e.option)))).toBe(result.root);
    expect(rules.funderFromBlock).toBe(wifDeployBlock.toString());
  }, 180_000);
});
