#!/usr/bin/env -S npx tsx
/**
 * flat-ballot verifier CLI
 *
 *   verify  --rpc URL --ballot 0x.. --wif 0x.. --id N --from-block B --funder-from-block F [--max-per-funder 3] [--json out.json]
 *           Recompute the verified tally from chain data. If the election is already committed, compare it
 *           to the on-chain root and exit non-zero on a mismatch ("reproduce this result").
 *
 *   commit  (same flags) --pk 0xRESOLVER_KEY
 *           Resolver only: sweep unswept boxes, then commit the result on-chain.
 */
import { writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { flatBallotAbi } from "./abi";
import { computeFromChain, STATUS } from "./chain";
import { canonicalRules } from "./rules";

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? "true" : argv[++i];
  }
  return out;
}
const need = (f: Record<string, string>, k: string) => {
  if (!f[k]) throw new Error(`missing --${k}`);
  return f[k];
};
const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (cmd !== "verify" && cmd !== "commit") {
    console.log("usage: cli.ts <verify|commit> --rpc URL --ballot 0x.. --wif 0x.. --id N --from-block B --funder-from-block F");
    process.exit(2);
  }
  const rpc = need(f, "rpc");
  const ballot = need(f, "ballot") as Address;
  const wif = need(f, "wif") as Address;
  const id = BigInt(need(f, "id"));
  const client = createPublicClient({ transport: http(rpc) });

  const g = await computeFromChain(client, {
    ballot,
    wif,
    id,
    fromBlock: BigInt(need(f, "from-block")),
    funderFromBlock: BigInt(need(f, "funder-from-block")),
    maxPerFunder: f["max-per-funder"] ? Number(f["max-per-funder"]) : undefined,
    chunk: f.chunk ? BigInt(f.chunk) : undefined,
  });
  const { election, result, rules } = g;

  console.log(`election #${id}  status=${STATUS[election.status]}  options=${election.optionCount}`);
  console.log(`rules: ${canonicalRules(rules)}`);
  console.log(`rulesHash: ${result.rulesHash}`);
  console.log(`raw qualifying per option : ${result.rawQualifying.join(", ")}`);
  console.log(`verified votes per option : ${result.optionVotes.join(", ")}`);
  console.log(`entries: ${result.entries.length}   rejected: ${result.rejected.length}`);
  console.log(`merkle root: ${result.root}`);
  if (f.json) {
    writeFileSync(f.json, json({ election, boxes: g.boxes, rules, ...result }));
    console.log(`wrote ${f.json}`);
  }

  if (cmd === "verify") {
    if (election.status >= 2) {
      const ok = election.root.toLowerCase() === result.root.toLowerCase() && election.rulesHash.toLowerCase() === result.rulesHash.toLowerCase();
      console.log(ok ? "REPRODUCED: on-chain commitment matches this recomputation" : "MISMATCH: on-chain commitment differs from this recomputation");
      process.exit(ok ? 0 : 1);
    }
    console.log("not committed yet: nothing to compare against");
    return;
  }

  // commit
  const account = privateKeyToAccount(need(f, "pk") as Hex);
  const wallet = createWalletClient({ account, transport: http(rpc) });
  if (account.address.toLowerCase() !== election.resolver.toLowerCase()) throw new Error("--pk is not this election's resolver");
  if (election.status !== 1) throw new Error(`election is ${STATUS[election.status]}, expected Open`);

  const mask = (await client.readContract({ address: ballot, abi: flatBallotAbi, functionName: "sweptMask", args: [id] })) as bigint;
  for (let o = 0; o < election.optionCount; o++) {
    if ((mask >> BigInt(o)) & 1n) continue;
    const h = await wallet.writeContract({ chain: null, address: ballot, abi: flatBallotAbi, functionName: "sweep", args: [id, BigInt(o)] });
    await client.waitForTransactionReceipt({ hash: h });
    console.log(`swept option ${o}: ${h}`);
  }
  // Re-run after sweeping so the on-chain burned amounts are what we commit against (votes <= burned is enforced).
  const hash = await wallet.writeContract({
    chain: null,
    address: ballot,
    abi: flatBallotAbi,
    functionName: "commitResults",
    args: [id, result.root, result.rulesHash, result.optionVotes.map(BigInt)],
  });
  await client.waitForTransactionReceipt({ hash });
  console.log(`committed: ${hash}`);
}

main().catch((e) => {
  console.error(e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
