"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { parseUnits, type Address } from "viem";
import { merkleProof } from "@verifier";
import { CopyAddress } from "@/components/CopyAddress";
import { phase, optionCount } from "@/components/ElectionRow";
import { Tally } from "@/components/Tally";
import { useAction } from "@/components/useAction";
import { VerifyPanel, type Computed } from "@/components/VerifyPanel";
import { useWallet } from "@/components/WalletProvider";
import { erc20Abi, flatBallotAbi, publicClient } from "@/lib/chain";
import { CONFIG, configured } from "@/lib/config";
import {
  getElectionMeta,
  getElectionState,
  getTally,
  getToken,
  STATUS_NAME,
  type ElectionMeta,
  type ElectionState,
  type Tally as TallyData,
  type TokenInfo,
} from "@/lib/data";
import { explorerTx, fmtDate, fmtDuration, fmtToken, shortAddr } from "@/lib/format";

const BALLOT = () => CONFIG.ballot as Address;
// mirrors FlatBallot.SEED_WINDOW, COMMIT_WINDOW and CLAIM_WINDOW
const SEED_WINDOW = 200n;
const COMMIT_WINDOW = 3 * 86400;
const CLAIM_WINDOW = 30 * 86400;

interface Ctx {
  meta: ElectionMeta;
  state: ElectionState;
  tally: TallyData;
  token: TokenInfo;
  now: number;
  refresh: () => void;
}

function TxNote({ tx }: { tx: string | null }) {
  if (!tx) return null;
  return (
    <div className="notice ok" role="status">
      Done. <a href={explorerTx(CONFIG.explorer, tx)} target="_blank" rel="noreferrer"><u>View transaction</u></a>
    </div>
  );
}

function Facts({ meta, state, tally, token, now }: Ctx) {
  const remaining = state.voteEnd - now;
  return (
    <div className="facts">
      <div className="fact"><b>{fmtToken(state.pool, token.decimals, 0)} ${token.symbol}</b><span>Prize pool</span></div>
      <div className="fact"><b>{fmtToken(state.voteCost, token.decimals)} ${token.symbol}</b><span>Cost of one vote</span></div>
      <div className="fact">
        <b>{now <= state.voteEnd && now >= state.voteStart ? fmtDuration(remaining) : fmtDate(state.voteEnd)}</b>
        <span>{now <= state.voteEnd && now >= state.voteStart ? "Until voting closes" : now < state.voteStart ? "Voting closes" : "Voting closed"}</span>
      </div>
      <div className="fact"><b>{state.slots}</b><span>Prize draws among voters</span></div>
      {state.bountyBps > 0 && <div className="fact"><b>{state.bountyBps / 100}%</b><span>Of the pool to the winner&apos;s bounty address</span></div>}
    </div>
  );
}

function VoteBlock({ ctx, i }: { ctx: Ctx; i: number }) {
  const { meta, state, tally, token, now, refresh } = ctx;
  const { account } = useWallet();
  const act = useAction(refresh);
  const [showAddr, setShowAddr] = useState(false);
  const open = now <= state.voteEnd && state.status === 1;
  if (!open) return null;
  const box = tally.boxes[i];
  const notYet = now < state.voteStart;
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="vote-actions">
        <button
          className="btn small primary"
          disabled={!!act.busy || notYet}
          onClick={() =>
            act.run("Confirm in your wallet…", async (from) => {
              const bal = await publicClient.readContract({ address: CONFIG.wif, abi: erc20Abi, functionName: "balanceOf", args: [from] });
              if (bal < state.voteCost) throw new Error(`You hold ${fmtToken(bal, token.decimals)} $${token.symbol}, and a vote costs ${fmtToken(state.voteCost, token.decimals)}.`);
              return act.write(from, { address: CONFIG.wif, abi: erc20Abi, functionName: "transfer", args: [box, state.voteCost] });
            })
          }
        >
          {act.busy ?? (account ? `Vote for ${meta.labels[i]}` : `Connect and vote for ${meta.labels[i]}`)}
        </button>
        <button className="link-btn" onClick={() => setShowAddr((v) => !v)} aria-expanded={showAddr}>
          {showAddr ? "Hide deposit address" : "Vote from another wallet"}
        </button>
      </div>
      {showAddr && (
        <>
          <p className="muted" style={{ fontSize: 15 }}>Send at least {fmtToken(state.voteCost, token.decimals)} ${token.symbol} to this address from any wallet. Nothing else to do.</p>
          <CopyAddress address={box} label={meta.labels[i]} />
        </>
      )}
      {act.error && <div className="notice error" role="alert">{act.error}</div>}
      <TxNote tx={act.tx} />
    </div>
  );
}

function OptionsSheet({ ctx }: { ctx: Ctx }) {
  const { meta, state, tally, now } = ctx;
  const finished = state.status === 3;
  return (
    <div className="sheet">
      <div className="sheet-head">
        <b>Tally sheet</b>
        <span className="muted" style={{ fontSize: 15 }}>
          {state.status >= 2 ? "Counted votes (verified)" : "Live count of $WIF sent, not yet verified"}
        </span>
      </div>
      {meta.labels.map((label, i) => {
        const c = optionCount(state, tally, i);
        const isWinner = finished && state.winnerOption === i;
        return (
          <div className="sheet-row" key={i}>
            <div className="row-top">
              <span className="row-name">{label} {isWinner && <span className="winner-mark">Winner</span>}</span>
              <span className="row-count">{c.n} <small>{c.n === 1 ? "vote" : "votes"}{c.kind === "raw" ? ", unverified" : ""}</small></span>
            </div>
            <Tally count={c.n} kind={c.kind} label={`${label}: ${c.n} votes`} />
            <VoteBlock ctx={ctx} i={i} />
          </div>
        );
      })}
      {now < state.voteStart && state.status === 1 && (
        <div className="sheet-row"><p className="muted">Voting opens {fmtDate(state.voteStart)}. Transfers sent before then are burned but never counted.</p></div>
      )}
    </div>
  );
}

function CountingActions({ ctx }: { ctx: Ctx }) {
  const { meta, state, tally, now, refresh } = ctx;
  const act = useAction(refresh);
  if (state.status !== 1 || now <= state.voteEnd) return null;

  const unswept = Array.from({ length: state.optionCount }, (_, i) => i).filter((i) => !((tally.sweptMask >> BigInt(i)) & 1n));
  const deadline = state.voteEnd + COMMIT_WINDOW;

  return (
    <section className="panel" aria-labelledby="count-h">
      <h3 id="count-h">Voting is closed</h3>
      {unswept.length > 0 ? (
        <>
          <p>The next step is to burn the votes in each option&apos;s box. Anyone can do it, and it costs only gas.</p>
          <div className="row">
            <button
              className="btn primary"
              disabled={!!act.busy}
              onClick={() =>
                act.run("Burning votes…", async (from) => {
                  let last: any;
                  for (const i of unswept) last = await act.write(from, { address: BALLOT(), abi: flatBallotAbi, functionName: "sweep", args: [meta.id, BigInt(i)] });
                  return last;
                })
              }
            >
              {act.busy ?? `Burn votes for ${unswept.length === state.optionCount ? "all options" : `${unswept.length} remaining`}`}
            </button>
          </div>
        </>
      ) : (
        <p>All votes are burned. The resolver now commits the verified result, due by {fmtDate(deadline)}.</p>
      )}
      {now > deadline && (
        <div className="stack">
          <p className="muted">The resolver missed the deadline. Anyone can cancel the election. The bond is burned and contributors can take their money back.</p>
          <div className="row">
            <button className="btn danger" disabled={!!act.busy} onClick={() => act.run("Cancelling…", (from) => act.write(from, { address: BALLOT(), abi: flatBallotAbi, functionName: "cancelUncommitted", args: [meta.id] }))}>
              Cancel this election
            </button>
          </div>
        </div>
      )}
      {act.error && <div className="notice error" role="alert">{act.error}</div>}
      <TxNote tx={act.tx} />
    </section>
  );
}

function DrawActions({ ctx }: { ctx: Ctx }) {
  const { meta, state, tally, refresh } = ctx;
  const act = useAction(refresh);
  if (state.status !== 2) return null;
  const cur = tally.l2Block;
  const ready = cur > state.seedBlock && cur <= state.seedBlock + SEED_WINDOW;
  const stale = cur > state.seedBlock + SEED_WINDOW;
  return (
    <section className="panel" aria-labelledby="draw-h">
      <h3 id="draw-h">Result committed. Prize draw next.</h3>
      <p>The draw uses the hash of block {state.seedBlock.toString()}, which did not exist when the result was committed, so nobody could pick the outcome in advance.</p>
      {!ready && !stale && <p className="muted num">Waiting for block {state.seedBlock.toString()}. The chain is at {cur.toString()}.</p>}
      <div className="row">
        {ready && (
          <button className="btn primary" disabled={!!act.busy} onClick={() => act.run("Drawing…", (from) => act.write(from, { address: BALLOT(), abi: flatBallotAbi, functionName: "finalize", args: [meta.id] }))}>
            {act.busy ?? "Draw the prizes"}
          </button>
        )}
        {stale && (
          <button className="btn" disabled={!!act.busy} onClick={() => act.run("Moving the draw block…", (from) => act.write(from, { address: BALLOT(), abi: flatBallotAbi, functionName: "reseed", args: [meta.id] }))}>
            {act.busy ?? "Pick a new draw block"}
          </button>
        )}
      </div>
      {stale && <p className="muted">Nobody drew in time, so the draw block must move forward. The committed result does not change.</p>}
      {act.error && <div className="notice error" role="alert">{act.error}</div>}
      <TxNote tx={act.tx} />
    </section>
  );
}

function ClaimPanel({ ctx, computed }: { ctx: Ctx; computed: Computed | null }) {
  const { meta, state, token, now, refresh } = ctx;
  const { account } = useWallet();
  const act = useAction(() => { refresh(); void load(); });
  const [rows, setRows] = useState<{ slot: number; idx: number; claimed: boolean }[] | null>(null);
  const r = computed?.result;
  const rootOk = !!r && r.root.toLowerCase() === state.root.toLowerCase();

  const load = useCallback(async () => {
    const out: { slot: number; idx: number; claimed: boolean }[] = [];
    for (let s = 0; s < state.slots; s++) {
      const [idx, claimed] = await Promise.all([
        publicClient.readContract({ address: BALLOT(), abi: flatBallotAbi, functionName: "winnerIndex", args: [meta.id, BigInt(s)] }),
        publicClient.readContract({ address: BALLOT(), abi: flatBallotAbi, functionName: "slotClaimed", args: [meta.id, BigInt(s)] }),
      ]);
      out.push({ slot: s, idx: Number(idx), claimed: claimed as boolean });
    }
    setRows(out);
  }, [meta.id, state.slots]);

  useEffect(() => {
    if (state.status === 3) void load();
  }, [state.status, load]);

  if (state.status !== 3) return null;
  const windowOpen = now <= state.finalizedAt + CLAIM_WINDOW;

  return (
    <section className="panel" aria-labelledby="claim-h">
      <h3 id="claim-h">Prizes</h3>
      <p>
        {fmtToken(state.prizePerSlot, token.decimals)} ${token.symbol} per draw, {state.slots} {state.slots === 1 ? "draw" : "draws"}. Anyone can send a claim, and the money always goes to the winning voter.
        {windowOpen ? ` Claims stay open until ${fmtDate(state.finalizedAt + CLAIM_WINDOW)}.` : " The claim window has closed."}
      </p>

      {state.bounty > 0n && (
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span>Winner&apos;s bounty: <b className="num">{fmtToken(state.bounty, token.decimals)} ${token.symbol}</b> to <span className="mono">{shortAddr(state.bountyTo)}</span></span>
          {state.bountyClaimed ? (
            <span className="chip closed">Paid</span>
          ) : (
            <button className="btn small" disabled={!!act.busy} onClick={() => act.run("Paying the bounty…", (from) => act.write(from, { address: BALLOT(), abi: flatBallotAbi, functionName: "claimBounty", args: [meta.id] }))}>Pay the bounty</button>
          )}
        </div>
      )}

      {!r && <p className="muted">Recomputing the voter list so winners can be matched to claim proofs…</p>}
      {r && !rootOk && <div className="notice error" role="alert">Your recomputation does not match the committed root, so claim proofs cannot be built here. Check that the app uses the same $WIF deploy block as the resolver.</div>}

      {r && rootOk && rows && (
        <div className="scroll-x">
          <table className="plain">
            <thead><tr><th>Draw</th><th>Winning voter</th><th>Voted for</th><th></th></tr></thead>
            <tbody>
              {rows.map((row) => {
                const e = r.entries[row.idx];
                const mine = !!account && e && e.voter.toLowerCase() === account.toLowerCase();
                return (
                  <tr key={row.slot} style={mine ? { background: "#eaf5f2" } : undefined}>
                    <td className="num">{row.slot + 1}</td>
                    <td className="mono" title={e?.voter}>{e ? shortAddr(e.voter) : "?"} {mine && <b>(you)</b>}</td>
                    <td>{e ? meta.labels[e.option] : "?"}</td>
                    <td>
                      {row.claimed ? (
                        <span className="chip closed">Paid</span>
                      ) : (
                        windowOpen && e && (
                          <button
                            className="btn small"
                            disabled={!!act.busy}
                            onClick={() =>
                              act.run("Claiming…", (from) =>
                                act.write(from, {
                                  address: BALLOT(),
                                  abi: flatBallotAbi,
                                  functionName: "claimPrize",
                                  args: [meta.id, BigInt(row.slot), BigInt(row.idx), e.voter, e.option, merkleProof(r.leaves, row.idx)],
                                }),
                              )
                            }
                          >
                            Send claim
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!windowOpen && !state.unclaimedSwept && (
        <div className="row">
          <button className="btn small" disabled={!!act.busy} onClick={() => act.run("Returning unclaimed prizes…", (from) => act.write(from, { address: BALLOT(), abi: flatBallotAbi, functionName: "sweepUnclaimed", args: [meta.id] }))}>
            Return unclaimed prizes to the creator
          </button>
        </div>
      )}
      {act.error && <div className="notice error" role="alert">{act.error}</div>}
      <TxNote tx={act.tx} />
    </section>
  );
}

function BoostPanel({ ctx }: { ctx: Ctx }) {
  const { meta, state, token, now, refresh } = ctx;
  const act = useAction(refresh);
  const [amount, setAmount] = useState("");
  if (state.status !== 1 || now > state.voteEnd + COMMIT_WINDOW) return null;
  let parsed: bigint | null = null;
  try {
    parsed = amount ? parseUnits(amount, token.decimals) : null;
  } catch {
    parsed = null;
  }
  return (
    <section className="panel" aria-labelledby="boost-h">
      <h3 id="boost-h">Add to the prize pool</h3>
      <p className="muted">Anyone can top up the pool until the result is committed. 5% of the final pool is burned.</p>
      <div className="row">
        <input className="input" style={{ maxWidth: 220 }} inputMode="decimal" aria-label="Amount of $WIF to add" placeholder="Amount in $WIF" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <button
          className="btn"
          disabled={!!act.busy || !parsed || parsed <= 0n}
          onClick={() =>
            act.run("Adding to the pool…", async (from) => {
              if (!parsed) return;
              const allowance = await publicClient.readContract({ address: CONFIG.wif, abi: erc20Abi, functionName: "allowance", args: [from, BALLOT()] });
              if (allowance < parsed) await act.write(from, { address: CONFIG.wif, abi: erc20Abi, functionName: "approve", args: [BALLOT(), parsed] });
              const h = await act.write(from, { address: BALLOT(), abi: flatBallotAbi, functionName: "boost", args: [meta.id, parsed] });
              setAmount("");
              return h;
            })
          }
        >
          {act.busy ?? "Add to the pool"}
        </button>
      </div>
      {act.error && <div className="notice error" role="alert">{act.error}</div>}
      <TxNote tx={act.tx} />
    </section>
  );
}

function CancelledPanel({ ctx }: { ctx: Ctx }) {
  const { meta, state, token, refresh } = ctx;
  const { account } = useWallet();
  const act = useAction(() => { refresh(); void load(); });
  const [mine, setMine] = useState<bigint | null>(null);
  const load = useCallback(async () => {
    if (!account) return setMine(null);
    const v = await publicClient.readContract({ address: BALLOT(), abi: flatBallotAbi, functionName: "contributed", args: [meta.id, account] });
    setMine(v as bigint);
  }, [account, meta.id]);
  useEffect(() => { if (state.status === 4) void load(); }, [state.status, load]);
  if (state.status !== 4) return null;
  return (
    <section className="panel" aria-labelledby="cancel-h">
      <h3 id="cancel-h">This election was cancelled</h3>
      <p>The creator&apos;s bond was burned. Everyone who added to the prize pool can take their own contribution back.</p>
      {!account ? <p className="muted">Connect your wallet to see what you can take back.</p> : mine === null ? null : mine > 0n ? (
        <div className="row">
          <button className="btn primary" disabled={!!act.busy} onClick={() => act.run("Refunding…", (from) => act.write(from, { address: BALLOT(), abi: flatBallotAbi, functionName: "refund", args: [meta.id] }))}>
            {act.busy ?? `Take back ${fmtToken(mine, token.decimals)} $${token.symbol}`}
          </button>
        </div>
      ) : <p className="muted">You have nothing to take back from this election.</p>}
      {act.error && <div className="notice error" role="alert">{act.error}</div>}
      <TxNote tx={act.tx} />
    </section>
  );
}

export default function ElectionPage() {
  const params = useParams<{ id: string }>();
  const [meta, setMeta] = useState<ElectionMeta | null>(null);
  const [state, setState] = useState<ElectionState | null>(null);
  const [tally, setTally] = useState<TallyData | null>(null);
  const [token, setToken] = useState<TokenInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [computed, setComputed] = useState<Computed | null>(null);
  const [clock, setClock] = useState(() => Math.floor(Date.now() / 1000));
  const [fetchedAt, setFetchedAt] = useState(() => Math.floor(Date.now() / 1000));

  const id = useMemo(() => {
    try {
      return BigInt(params.id);
    } catch {
      return null;
    }
  }, [params.id]);

  const refresh = useCallback(async () => {
    if (id === null || !configured) return;
    try {
      const [m, tk] = await Promise.all([getElectionMeta(id), getToken()]);
      const s = await getElectionState(id);
      const t = await getTally(id, s.optionCount);
      setMeta(m);
      setToken(tk);
      setState(s);
      setTally(t);
      setFetchedAt(Math.floor(Date.now() / 1000));
      setErr(null);
    } catch (e: any) {
      setErr(e?.shortMessage ?? e?.message ?? "Could not load this election.");
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    const poll = setInterval(refresh, 10_000);
    const tick = setInterval(() => setClock(Math.floor(Date.now() / 1000)), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  if (!configured) return <div className="wrap" style={{ paddingBlock: 48 }}><div className="notice">This app is not pointed at a FlatBallot contract yet. Set <span className="mono">NEXT_PUBLIC_BALLOT</span> and reload.</div></div>;
  if (id === null) return <div className="wrap" style={{ paddingBlock: 48 }}><div className="notice error">That is not a valid election number. <Link href="/"><u>Back to all elections</u></Link></div></div>;
  if (err && !state) return <div className="wrap" style={{ paddingBlock: 48 }}><div className="notice error">{err}</div></div>;
  if (!meta || !state || !tally || !token) return <div className="wrap" style={{ paddingBlock: 48 }} aria-busy="true"><p className="muted">Loading election #{params.id}…</p></div>;

  // chain time at the last poll, advanced by the local seconds elapsed since (works on chains whose clock is skewed)
  const now = tally.now + Math.max(0, clock - fetchedAt);
  const ctx: Ctx = { meta, state, tally, token, now, refresh };
  const p = phase(state, now);

  return (
    <div className="wrap" style={{ paddingBottom: 80 }}>
      <div className="detail-head">
        <div className="row">
          <span className={`chip ${p.tone}`}><span className="dot" />{p.label}</span>
          <span className="muted">Election #{meta.id.toString()} · {STATUS_NAME[state.status]}</span>
        </div>
        <h1 style={{ fontSize: "clamp(32px, 5.5vw, 60px)" }}>{meta.title}</h1>
        <p className="muted">
          Created by <a className="mono" href={`${CONFIG.explorer}/address/${state.creator}`} target="_blank" rel="noreferrer">{shortAddr(state.creator)}</a>
          {" · "}Resolver <a className="mono" href={`${CONFIG.explorer}/address/${state.resolver}`} target="_blank" rel="noreferrer">{shortAddr(state.resolver)}</a>
          {meta.metadataURI && <> · <a href={meta.metadataURI} target="_blank" rel="noreferrer"><u>Details</u></a></>}
        </p>
      </div>

      <div className="stack" style={{ gap: 28 }}>
        <Facts {...ctx} />
        <OptionsSheet ctx={ctx} />
        <CountingActions ctx={ctx} />
        <DrawActions ctx={ctx} />
        <ClaimPanel ctx={ctx} computed={computed} />
        <CancelledPanel ctx={ctx} />
        {state.status !== 4 && (
          <VerifyPanel meta={meta} state={state} tally={tally} token={token} now={now} computed={computed} onComputed={setComputed} onChanged={refresh} autoRun={state.status >= 2} />
        )}
        <BoostPanel ctx={ctx} />
      </div>
    </div>
  );
}
