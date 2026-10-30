"use client";

import { useEffect, useState } from "react";
import type { Address } from "viem";
import { computeFromChain, type VerifyResult, type Rules, canonicalRules } from "@verifier";
import { publicClient, flatBallotAbi } from "@/lib/chain";
import { CONFIG } from "@/lib/config";
import type { ElectionMeta, ElectionState, Tally as TallyData, TokenInfo } from "@/lib/data";
import { fmtToken, shortAddr } from "@/lib/format";
import { Tally } from "./Tally";
import { useAction } from "./useAction";
import { useWallet } from "./WalletProvider";

const REASON: Record<string, string> = {
  before_start: "Sent before voting opened",
  after_end: "Sent after voting closed",
  below_vote_cost: "Less than the vote cost",
  contract_voter: "Sent from a contract",
  duplicate_wallet: "This wallet already voted",
  funder_cap: "Too many wallets funded by the same sender",
};

export interface Computed {
  result: VerifyResult;
  rules: Rules;
}

export function VerifyPanel({
  meta,
  state,
  tally,
  token,
  now,
  computed,
  onComputed,
  onChanged,
  autoRun = false,
}: {
  meta: ElectionMeta;
  state: ElectionState;
  tally: TallyData;
  token: TokenInfo;
  now: number;
  computed: Computed | null;
  onComputed: (c: Computed) => void;
  onChanged: () => void;
  /** recompute once on mount (used when results are already committed) */
  autoRun?: boolean;
}) {
  const { account } = useWallet();
  const act = useAction(onChanged);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showRejected, setShowRejected] = useState(false);

  const closed = now > state.voteEnd;
  const allSwept = tally.sweptMask === (1n << BigInt(state.optionCount)) - 1n;
  const isResolver = !!account && account.toLowerCase() === state.resolver.toLowerCase();
  const committed = state.status >= 2;

  async function recompute() {
    setBusy(true);
    setErr(null);
    try {
      const g = await computeFromChain(publicClient as any, {
        ballot: CONFIG.ballot as Address,
        wif: CONFIG.wif,
        id: meta.id,
        fromBlock: meta.blockNumber,
        funderFromBlock: CONFIG.wifDeployBlock,
        chunk: CONFIG.logChunk,
      });
      onComputed({ result: g.result, rules: g.rules });
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.message ?? "Could not recompute from the chain.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (autoRun && !computed) void recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun]);

  const r = computed?.result;
  const matches = r && committed ? r.root.toLowerCase() === state.root.toLowerCase() && r.rulesHash.toLowerCase() === state.rulesHash.toLowerCase() : null;

  return (
    <section className="panel" aria-labelledby="verify-h">
      <div>
        <h3 id="verify-h">Check the result yourself</h3>
        <p className="muted" style={{ marginTop: 6 }}>
          This runs the same public script the resolver uses, in your browser, against the chain. {committed ? "It then compares your answer with what was committed." : "It shows what the resolver should commit."}
        </p>
      </div>

      <div className="row">
        <button className="btn" onClick={recompute} disabled={busy}>{busy ? "Reading the chain…" : r ? "Recompute again" : "Recompute from the chain"}</button>
        {matches === true && <span className="chip live"><span className="dot" />Matches the on-chain commitment</span>}
        {matches === false && <span className="chip warn"><span className="dot" />Does not match the on-chain commitment</span>}
      </div>
      {err && <div className="notice error" role="alert">{err}</div>}

      {r && computed && (
        <>
          <div className="scroll-x">
            <table className="plain">
              <thead><tr><th>Option</th><th>Burned</th><th>Sent in time</th><th>Counted</th></tr></thead>
              <tbody>
                {meta.labels.map((l, i) => {
                  const burned = tally.swept.length > i && (tally.sweptMask >> BigInt(i)) & 1n ? tally.swept[i] : tally.pending[i];
                  const rej = r.rejected.filter((x) => x.option === i).length;
                  return (
                    <tr key={i}>
                      <td>{l}</td>
                      <td className="num">{fmtToken(burned, token.decimals)} ${token.symbol}</td>
                      <td className="num">{r.rawQualifying[i]}</td>
                      <td>
                        <div className="row" style={{ gap: 10 }}>
                          <Tally count={r.optionVotes[i]} kind="verified" />
                          <b className="num">{r.optionVotes[i]}</b>
                          {rej > 0 && <><Tally count={rej} kind="rejected" /><span className="num" style={{ color: "var(--red-ink)" }}>{rej} struck</span></>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="legend" aria-hidden>
            <span><i style={{ background: "var(--ink)" }} />Counted</span>
            <span><i style={{ background: "var(--red)" }} />Struck by a rule</span>
          </div>

          <dl className="stack" style={{ margin: 0 }}>
            <div><dt className="muted">Merkle root</dt><dd className="mono" style={{ margin: 0 }}>{r.root}</dd></div>
            <div><dt className="muted">Rules hash</dt><dd className="mono" style={{ margin: 0 }}>{r.rulesHash}</dd></div>
            <div><dt className="muted">Rules</dt><dd className="mono" style={{ margin: 0 }}>{canonicalRules(computed.rules)}</dd></div>
          </dl>

          {r.rejected.length > 0 && (
            <div>
              <button className="btn small" onClick={() => setShowRejected((v) => !v)} aria-expanded={showRejected}>
                {showRejected ? "Hide" : "Show"} {r.rejected.length} struck {r.rejected.length === 1 ? "transfer" : "transfers"}
              </button>
              {showRejected && (
                <div className="scroll-x" style={{ marginTop: 12 }}>
                  <table className="plain">
                    <thead><tr><th>Wallet</th><th>Option</th><th>Reason</th></tr></thead>
                    <tbody>
                      {r.rejected.map((x, i) => (
                        <tr key={i}>
                          <td className="mono" title={x.voter}>{shortAddr(x.voter)}</td>
                          <td>{meta.labels[x.option]}</td>
                          <td>{REASON[x.reason]}{x.funder ? ` (${shortAddr(x.funder)})` : ""}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {state.status === 1 && closed && allSwept && isResolver && (
            <div className="stack">
              <p>You are this election&apos;s resolver. Committing locks this result on-chain.</p>
              <div className="row">
                <button
                  className="btn primary"
                  disabled={!!act.busy}
                  onClick={() =>
                    act.run("Commit in your wallet…", (from) =>
                      act.write(from, {
                        address: CONFIG.ballot as Address,
                        abi: flatBallotAbi,
                        functionName: "commitResults",
                        args: [meta.id, r.root, r.rulesHash, r.optionVotes.map((v) => BigInt(v))],
                      }),
                    )
                  }
                >
                  {act.busy ?? "Commit this result"}
                </button>
              </div>
              {act.error && <div className="notice error" role="alert">{act.error}</div>}
            </div>
          )}
        </>
      )}
    </section>
  );
}
