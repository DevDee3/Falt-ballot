"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Tally } from "@/components/Tally";
import { ElectionRow } from "@/components/ElectionRow";
import { configured } from "@/lib/config";
import { getAllMetas, getGlobalStats, getToken, type ElectionMeta, type TokenInfo } from "@/lib/data";
import { fmtToken } from "@/lib/format";

function ReadingSheet() {
  return (
    <div className="sheet" aria-label="How to read a tally sheet">
      <div className="sheet-head">
        <b>Reading a tally sheet</b>
        <span className="muted">example</span>
      </div>
      <div className="sheet-row">
        <div className="row-top"><span className="row-name">Counted by the verifier</span><span className="row-count num">12</span></div>
        <Tally count={12} kind="verified" />
      </div>
      <div className="sheet-row">
        <div className="row-top"><span className="row-name">Sent, not verified yet</span><span className="row-count num">7</span></div>
        <Tally count={7} kind="raw" />
      </div>
      <div className="sheet-row">
        <div className="row-top"><span className="row-name">Rejected, struck through</span><span className="row-count num">4</span></div>
        <Tally count={4} kind="rejected" />
        <p className="muted" style={{ fontSize: 15 }}>Same wallet twice, a contract, or too many wallets funded by one sender.</p>
      </div>
    </div>
  );
}

function Elections() {
  const [metas, setMetas] = useState<ElectionMeta[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!configured) return;
    getAllMetas().then(setMetas).catch((e) => setErr(e?.shortMessage ?? e?.message ?? "Could not load elections."));
  }, []);

  if (!configured) {
    return (
      <div className="notice">
        <b>This app is not pointed at a FlatBallot contract yet.</b>
        <p style={{ marginTop: 6 }}>Set <span className="mono">NEXT_PUBLIC_BALLOT</span> and <span className="mono">NEXT_PUBLIC_DEPLOY_BLOCK</span>, then reload.</p>
      </div>
    );
  }
  if (err) return <div className="notice error">{err}</div>;
  if (!metas) return <p className="muted" aria-busy="true">Loading elections…</p>;
  if (metas.length === 0) {
    return (
      <div className="notice">
        <b>No elections yet.</b>
        <p style={{ marginTop: 6 }}>The first one takes a single transaction. <Link href="/create"><u>Start an election</u></Link>.</p>
      </div>
    );
  }
  return <div className="elist">{metas.map((m) => <ElectionRow key={m.id.toString()} meta={m} />)}</div>;
}

function Stats() {
  const [s, setS] = useState<{ elections: bigint; burned: bigint } | null>(null);
  const [tk, setTk] = useState<TokenInfo | null>(null);
  useEffect(() => {
    if (!configured) return;
    Promise.all([getGlobalStats(), getToken()]).then(([g, t]) => { setS(g); setTk(t); }).catch(() => {});
  }, []);
  if (!s || !tk) return null;
  return (
    <p className="muted num" style={{ marginTop: 18 }}>
      {s.elections.toString()} {s.elections === 1n ? "election" : "elections"} so far, {fmtToken(s.burned, tk.decimals, 0)} ${tk.symbol} burned through them.
    </p>
  );
}

export default function Home() {
  return (
    <>
      <div className="wrap hero">
        <div>
          <h1>Run a public vote on $WIF.</h1>
          <p className="lede">
            Pick the options, fund a prize pool, share the deposit addresses. Voters send $WIF to the option they back. Every vote is burned, and anyone can recompute the result from the chain.
          </p>
          <div className="actions">
            <a className="btn primary" href="/create">Start an election</a>
            <a className="btn" href="#elections">See live elections</a>
          </div>
          <Stats />
        </div>
        <ReadingSheet />
      </div>

      <section className="section" aria-labelledby="how">
        <div className="wrap">
          <div className="section-head"><h2 id="how">How a vote travels</h2></div>
          <ol className="steps">
            <li>
              <h3>Send</h3>
              <p>Send at least the vote cost in $WIF to an option&apos;s deposit address. Any wallet works. You can also vote with one click by connecting a wallet.</p>
            </li>
            <li>
              <h3>Burn</h3>
              <p>When voting closes, anyone can open an option&apos;s box. It burns every $WIF inside and records the total on-chain.</p>
            </li>
            <li>
              <h3>Verify</h3>
              <p>A public script counts one vote per wallet, rejects contracts and wallet clusters, and commits a Merkle root. Run it yourself to check.</p>
            </li>
            <li>
              <h3>Claim</h3>
              <p>Prizes are drawn from a block that did not exist when the root was committed. Winners claim with a Merkle proof.</p>
            </li>
          </ol>
        </div>
      </section>

      <section className="section" id="elections" aria-labelledby="el">
        <div className="wrap">
          <div className="section-head">
            <h2 id="el">Elections</h2>
          </div>
          <Elections />
        </div>
      </section>
    </>
  );
}
