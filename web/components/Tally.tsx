/**
 * A tally sheet. Four vertical strokes and a diagonal make a group of five.
 * ink = verified, pale = counted but not yet verified, red + struck = rejected by the verifier.
 * Strokes are nudged by a fixed pseudo-random offset (seeded by position) so the page looks pen-drawn
 * but renders identically every time.
 */
type Kind = "verified" | "raw" | "rejected";

const COLOR: Record<Kind, string> = { verified: "#0f2233", raw: "#6f8796", rejected: "#d6303b" };
const MAX_STROKES = 150; // beyond this the sheet shows a multiplier instead of a wall of ink

const jitter = (n: number, salt: number) => {
  const x = Math.sin((n + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x) - 0.5; // -0.5 .. 0.5
};

export function Tally({ count, kind = "verified", label }: { count: number; kind?: Kind; label?: string }) {
  const total = Math.max(0, Math.floor(count));
  const shown = Math.min(total, MAX_STROKES);
  const scale = total > MAX_STROKES ? Math.ceil(total / MAX_STROKES) : 1;
  const strokes = scale > 1 ? Math.ceil(total / scale) : shown;
  const groups = Math.ceil(strokes / 5);
  const H = 34;
  const GW = 48;
  const width = Math.max(groups * GW, GW);
  const color = COLOR[kind];
  const sw = kind === "rejected" ? 2 : 2.6;

  const els: JSX.Element[] = [];
  for (let g = 0; g < groups; g++) {
    const inGroup = Math.min(5, strokes - g * 5);
    const x0 = g * GW + 5;
    for (let s = 0; s < Math.min(inGroup, 4); s++) {
      const i = g * 5 + s;
      const x = x0 + s * 8 + jitter(i, 1) * 2;
      els.push(
        <line key={`v${i}`} x1={x} y1={4 + jitter(i, 2) * 2} x2={x + jitter(i, 3) * 2.4} y2={H - 4 + jitter(i, 4) * 2} stroke={color} strokeWidth={sw} strokeLinecap="round" />,
      );
    }
    if (inGroup === 5) {
      const i = g * 5 + 4;
      els.push(
        <line key={`d${i}`} x1={x0 - 4} y1={H - 6 + jitter(i, 5) * 2} x2={x0 + 36} y2={7 + jitter(i, 6) * 2} stroke={color} strokeWidth={sw} strokeLinecap="round" />,
      );
    }
  }

  const aria = label ?? `${total} ${kind} ${total === 1 ? "vote" : "votes"}`;
  if (total === 0) {
    return (
      <svg className="tally" role="img" aria-label={aria} width={GW} height={H} viewBox={`0 0 ${GW} ${H}`}>
        <line x1="2" y1={H - 6} x2={GW - 2} y2={H - 6} stroke="#b2c1c7" strokeWidth="2" strokeDasharray="3 5" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, maxWidth: "100%" }}>
      <svg className="tally" role="img" aria-label={aria} width={width} height={H} viewBox={`0 0 ${width} ${H}`} style={{ maxWidth: "100%" }}>
        {els}
        {kind === "rejected" && <line x1="0" y1={H / 2} x2={width} y2={H / 2 + 2} stroke="#d6303b" strokeWidth="1.4" />}
      </svg>
      {scale > 1 && <span className="num muted" aria-hidden>×{scale}</span>}
    </span>
  );
}
