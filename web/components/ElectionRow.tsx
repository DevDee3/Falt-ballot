"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Tally } from "./Tally";
import { getElectionState, getTally, getToken, STATUS_NAME, type ElectionMeta, type ElectionState, type Tally as TallyData, type TokenInfo } from "@/lib/data";
import { fmtDate, fmtToken, fmtDuration } from "@/lib/format";

export function phase(s: ElectionState, nowSec: number): { label: string; tone: "live" | "closed" | "warn" } {
  if (s.status === 4) return { label: "Cancelled", tone: "warn" };
  if (s.status === 3) return { label: "Finished", tone: "closed" };
  if (s.status === 2) return { label: "Drawing prizes", tone: "closed" };
  if (nowSec < s.voteStart) return { label: "Not open yet", tone: "closed" };
  if (nowSec <= s.voteEnd) return { label: "Voting open", tone: "live" };
  return { label: "Counting", tone: "closed" };
}

/** votes shown for an option: committed verified > raw burned at sweep > live box balance */
export function optionCount(s: ElectionState, t: TallyData, i: number): { n: number; kind: "verified" | "raw" } {
  if (t.verified.length > i && s.status >= 2) return { n: Number(t.verified[i]), kind: "verified" };
  const cost = s.voteCost;
  const wei = t.swept.length > i && (t.sweptMask >> BigInt(i)) & 1n ? t.swept[i] : t.pending[i];
  return { n: Number(wei / cost), kind: "raw" };
}

export function ElectionRow({ meta }: { meta: ElectionMeta }) {
  const [state, setState] = useState<ElectionState | null>(null);
  const [tally, setTally] = useState<TallyData | null>(null);
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [s, tk] = await Promise.all([getElectionState(meta.id), getToken()]);
        const t = await getTally(meta.id, s.optionCount);
        if (live) {
          setState(s);
          setTally(t);
          setToken(tk);
        }
      } catch (e: any) {
        if (live) setErr(e?.shortMessage ?? e?.message ?? "Could not load this election.");
      }
    })();
    return () => {
      live = false;
    };
  }, [meta.id]);

  if (err) return <div className="notice error">Election #{meta.id.toString()}: {err}</div>;
  if (!state || !tally || !token) return <div className="elink" aria-busy="true"><span className="muted">Loading election #{meta.id.toString()}…</span></div>;

  const p = phase(state, tally.now);
  const top = meta.labels.map((l, i) => ({ l, ...optionCount(state, tally, i) })).sort((a, b) => b.n - a.n)[0];
  const remaining = state.voteEnd - tally.now;
  return (
    <Link href={`/e/${meta.id.toString()}`} className="elink">
      <div>
        <h3>{meta.title}</h3>
        <div style={{ marginTop: 8 }}>
          <Tally count={top?.n ?? 0} kind={top?.kind ?? "raw"} label={`Leading option has ${top?.n ?? 0} votes`} />
        </div>
      </div>
      <span className={`chip ${p.tone}`}><span className="dot" />{p.label}</span>
      <div className="meta">
        <span>{meta.labels.length} options</span>
        <span>Prize pool {fmtToken(state.pool, token.decimals, 0)} ${token.symbol}</span>
        <span>{p.tone === "live" && remaining > 0 ? `Closes in ${fmtDuration(remaining)}` : `Closes ${fmtDate(state.voteEnd)}`}</span>
        <span>{STATUS_NAME[state.status]}</span>
      </div>
    </Link>
  );
}
