"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { isAddress, parseEventLogs, parseUnits, zeroAddress, type Address } from "viem";
import { useWallet } from "@/components/WalletProvider";
import { erc20Abi, flatBallotAbi, publicClient, readableError, writeAndWait } from "@/lib/chain";
import { CONFIG, configured } from "@/lib/config";
import { getBondAmount, getToken, type TokenInfo } from "@/lib/data";
import { fmtToken } from "@/lib/format";

interface Opt { label: string; beneficiary: string }

function parseTokenAmount(value: string, decimals: number): bigint | null {
  const text = value.trim();
  // Keep the form predictable: decimal notation only, no commas or signs.
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  try {
    return parseUnits(text, decimals);
  } catch {
    return null;
  }
}

const DURATIONS = [
  { label: "30 minutes", s: 30 * 60 },
  { label: "6 hours", s: 6 * 3600 },
  { label: "24 hours", s: 24 * 3600 },
  { label: "3 days", s: 3 * 86400 },
  { label: "7 days", s: 7 * 86400 },
  { label: "14 days", s: 14 * 86400 },
];

export default function Create() {
  const { account, connectWallet, connecting } = useWallet();
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [bond, setBond] = useState<bigint | null>(null);

  const [title, setTitle] = useState("");
  const [opts, setOpts] = useState<Opt[]>([{ label: "", beneficiary: "" }, { label: "", beneficiary: "" }]);
  const [duration, setDuration] = useState(DURATIONS[2].s);
  const [voteCost, setVoteCost] = useState("1");
  const [minVotes, setMinVotes] = useState("10");
  const [slots, setSlots] = useState("10");
  const [bountyPct, setBountyPct] = useState("0");
  const [prize, setPrize] = useState("0");
  const [resolver, setResolver] = useState("");
  const [metadata, setMetadata] = useState("");

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => {
    if (!configured) return;
    Promise.all([getToken(), getBondAmount()]).then(([t, b]) => { setToken(t); setBond(b); }).catch((e) => setError(readableError(e)));
  }, []);

  const parsed = useMemo(() => {
    if (!token) return null;
    const cost = parseTokenAmount(voteCost || "0", token.decimals);
    const pr = parseTokenAmount(prize || "0", token.decimals);
    return cost === null || pr === null ? null : { cost, pr };
  }, [token, voteCost, prize]);

  const problems: string[] = [];
  if (!title.trim()) problems.push("Add a title.");
  if (title.length > 140) problems.push("The title can be 140 characters at most.");
  if (opts.length < 2) problems.push("Add at least two options.");
  if (opts.some((o) => !o.label.trim())) problems.push("Every option needs a name.");
  if (opts.some((o) => o.label.length > 64)) problems.push("Option names can be 64 characters at most.");
  if (opts.some((o) => o.beneficiary.trim() && !isAddress(o.beneficiary.trim()))) problems.push("A bounty address is not a valid address.");
  if (token && !parsed) problems.push("Enter valid numbers for the vote cost and prize (for example, 1 or 0.5).");
  if (parsed && token && parsed.cost < 10n ** BigInt(token.decimals)) problems.push("The vote cost must be at least 1 $WIF.");
  if (!(Number(minVotes) >= 1)) problems.push("Minimum votes must be at least 1.");
  if (!(Number(slots) >= 1 && Number(slots) <= 100)) problems.push("Prize draws must be between 1 and 100.");
  if (!(Number(bountyPct) >= 0 && Number(bountyPct) <= 50)) problems.push("The bounty share must be between 0% and 50%.");
  if (resolver.trim() && !isAddress(resolver.trim())) problems.push("The resolver is not a valid address.");

  async function submit() {
    if (!token || bond === null || !parsed) return;
    setError(null);
    setCreatedId(null);
    try {
      const from = account ?? (await connectWallet());
      if (!from) throw new Error("Connect a wallet to continue.");

      const needed = bond + parsed.pr;
      setBusy("Checking your $WIF balance…");
      const [balance, allowance, block] = await Promise.all([
        publicClient.readContract({ address: CONFIG.wif, abi: erc20Abi, functionName: "balanceOf", args: [from] }),
        publicClient.readContract({ address: CONFIG.wif, abi: erc20Abi, functionName: "allowance", args: [from, CONFIG.ballot as Address] }),
        publicClient.getBlock({ blockTag: "latest" }),
      ]);
      if (balance < needed) throw new Error(`You need ${fmtToken(needed, token.decimals)} $${token.symbol} (bond plus prize pool) and hold ${fmtToken(balance, token.decimals)}.`);

      if (allowance < needed) {
        setBusy("Approve $WIF in your wallet…");
        await writeAndWait(from, { address: CONFIG.wif, abi: erc20Abi, functionName: "approve", args: [CONFIG.ballot as Address, needed] });
      }

      setBusy("Create the election in your wallet…");
      const start = Number(block.timestamp);
      const params = {
        title: title.trim(),
        labels: opts.map((o) => o.label.trim()),
        beneficiaries: opts.map((o) => (o.beneficiary.trim() ? (o.beneficiary.trim() as Address) : zeroAddress)),
        resolver: (resolver.trim() || zeroAddress) as Address,
        voteStart: 0,
        voteEnd: start + duration,
        voteCost: parsed.cost,
        minVotes: BigInt(Math.floor(Number(minVotes))),
        slots: Math.floor(Number(slots)),
        bountyBps: Math.round(Number(bountyPct) * 100),
        initialPrize: parsed.pr,
        metadataURI: metadata.trim(),
      };
      const hash = await writeAndWait(from, { address: CONFIG.ballot as Address, abi: flatBallotAbi, functionName: "createElection", args: [params] });
      const receipt = await publicClient.getTransactionReceipt({ hash });
      const logs = parseEventLogs({ abi: flatBallotAbi, logs: receipt.logs, eventName: "ElectionCreated" });
      const id = (logs[0] as any)?.args?.id as bigint | undefined;
      setCreatedId(id !== undefined ? id.toString() : "");
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(null);
    }
  }

  if (!configured) {
    return (
      <div className="wrap" style={{ paddingBlock: 48 }}>
        <div className="notice"><b>This app is not pointed at a FlatBallot contract yet.</b> Set <span className="mono">NEXT_PUBLIC_BALLOT</span> and reload.</div>
      </div>
    );
  }

  const set = (i: number, patch: Partial<Opt>) => setOpts((o) => o.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div className="wrap" style={{ paddingBlock: "clamp(28px, 5vw, 56px) 72px" }}>
      <h1 style={{ fontSize: "clamp(36px, 6vw, 64px)", marginBottom: 14 }}>Start an election</h1>
      <p className="lede" style={{ marginBottom: 32 }}>
        You lock a bond and a prize pool. The bond comes back if enough verified people vote, and is burned if they don&apos;t.
      </p>

      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="field">
          <label htmlFor="title">Question</label>
          <input id="title" className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Who is the best trader on the timeline?" maxLength={140} required />
        </div>

        <div className="field">
          <span className="label">Options</span>
          <span className="hint">Each option gets its own deposit address. The optional bounty address is paid a share of the pool if that option wins.</span>
          <div className="stack">
            {opts.map((o, i) => (
              <div className="optrow" key={i}>
                <input className="input" aria-label={`Option ${i + 1} name`} placeholder={`Option ${i + 1}`} value={o.label} maxLength={64} onChange={(e) => set(i, { label: e.target.value })} />
                <input className="input mono" aria-label={`Option ${i + 1} bounty address`} placeholder="Bounty address (optional)" value={o.beneficiary} onChange={(e) => set(i, { beneficiary: e.target.value })} />
                <button type="button" className="btn small" disabled={opts.length <= 2} onClick={() => setOpts((x) => x.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <div><button type="button" className="btn small" disabled={opts.length >= 16} onClick={() => setOpts((x) => [...x, { label: "", beneficiary: "" }])}>Add option</button></div>
          </div>
        </div>

        <div className="grid2">
          <div className="field">
            <label htmlFor="dur">Voting stays open for</label>
            <select id="dur" className="select" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {DURATIONS.map((d) => <option key={d.s} value={d.s}>{d.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="cost">Cost of one vote ($WIF)</label>
            <input id="cost" className="input" inputMode="decimal" value={voteCost} onChange={(e) => setVoteCost(e.target.value)} />
            <span className="hint">At least 1. Voters can send more, but it still counts as one vote.</span>
          </div>
        </div>

        <div className="grid2">
          <div className="field">
            <label htmlFor="prize">Prize pool you add ($WIF)</label>
            <input id="prize" className="input" inputMode="decimal" value={prize} onChange={(e) => setPrize(e.target.value)} />
            <span className="hint">Anyone can add more until results are committed. 5% of the pool is burned at the end.</span>
          </div>
          <div className="field">
            <label htmlFor="slots">Prize draws among voters</label>
            <input id="slots" className="input" inputMode="numeric" value={slots} onChange={(e) => setSlots(e.target.value)} />
            <span className="hint">1 to 100 equal prizes, drawn with replacement.</span>
          </div>
        </div>

        <div className="grid2">
          <div className="field">
            <label htmlFor="min">Verified votes to get the bond back</label>
            <input id="min" className="input" inputMode="numeric" value={minVotes} onChange={(e) => setMinVotes(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="bounty">Winner&apos;s bounty share of the pool (%)</label>
            <input id="bounty" className="input" inputMode="decimal" value={bountyPct} onChange={(e) => setBountyPct(e.target.value)} />
            <span className="hint">0 to 50. Only paid if the winning option has a bounty address.</span>
          </div>
        </div>

        <details>
          <summary style={{ cursor: "pointer", fontWeight: 600 }}>Advanced</summary>
          <div className="stack" style={{ marginTop: 14 }}>
            <div className="field">
              <label htmlFor="res">Resolver address</label>
              <input id="res" className="input mono" value={resolver} onChange={(e) => setResolver(e.target.value)} placeholder="Defaults to your wallet" />
              <span className="hint">The resolver runs the public verifier and commits the result. It can never commit more votes than were burned.</span>
            </div>
            <div className="field">
              <label htmlFor="meta">Details link</label>
              <input id="meta" className="input" value={metadata} onChange={(e) => setMetadata(e.target.value)} placeholder="https:// or ipfs:// (optional)" />
            </div>
          </div>
        </details>

        <div className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>Bond (locked, returned or burned)</span>
            <b className="num">{bond !== null && token ? `${fmtToken(bond, token.decimals)} $${token.symbol}` : "…"}</b>
          </div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span>Prize pool you add</span>
            <b className="num">{parsed && token ? `${fmtToken(parsed.pr, token.decimals)} $${token.symbol}` : "…"}</b>
          </div>
          <div className="row" style={{ justifyContent: "space-between", borderTop: "1px solid var(--rule)", paddingTop: 12 }}>
            <span>You pay now</span>
            <b className="num">{bond !== null && parsed && token ? `${fmtToken(bond + parsed.pr, token.decimals)} $${token.symbol}` : "…"}</b>
          </div>
        </div>

        {problems.length > 0 && title !== "" && (
          <div className="notice" role="status"><ul style={{ margin: 0, paddingLeft: 20 }}>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
        )}
        {error && <div className="notice error" role="alert">{error}</div>}
        {createdId !== null && (
          <div className="notice ok" role="status">
            Election created. {createdId ? <Link href={`/e/${createdId}`}><u>Open election #{createdId}</u></Link> : <>Find it on the <Link href="/"><u>home page</u></Link>.</>}
          </div>
        )}

        <div className="row">
          {account ? (
            <button className="btn primary" type="submit" disabled={!!busy || problems.length > 0 || !token || bond === null}>
              {busy ?? "Create election"}
            </button>
          ) : (
            <button className="btn primary" type="button" disabled={connecting} onClick={() => void connectWallet()}>
              {connecting ? "Connecting…" : "Connect wallet to continue"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
