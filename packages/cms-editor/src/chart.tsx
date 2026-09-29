// The `chart` Block Kit block: one series, drawn as inline SVG.
//
// Hand-drawn rather than a charting library, on the same reasoning as the rest of Block Kit:
// the editor ships to every deployment, and a chart dependency is a bundle cost paid by the
// ones that never render one. One series of labelled numbers is thirty lines of geometry.
//
// Colours come from `currentColor` and the theme's own tokens, so the dark theme needs no
// second palette. Each point carries a native `<title>`, which is the hover readout and the
// screen-reader text at once. The svg is a `group`, not an `img`: `img` makes its children
// presentational and would hide exactly those titles.

import type { AdminBlock } from "./types";
import { getI18n } from "./i18n";

type ChartBlock = Extract<AdminBlock, { type: "chart" }>;

const W = 640;
const H = 200;
// `left` is the y-axis gutter; labels are right-aligned 6px inside it, so 34px is the room
// a label actually has.
const PAD = { top: 12, right: 12, bottom: 24, left: 40 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** Round the axis maximum up to 1, 2, 5 x 10^n, so the top gridline is a readable number
 * instead of the series' own maximum (a "37" axis). */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const f = max / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return nice * exp;
}

/** Three significant digits for a small number, whole numbers from 100 up. A fixed decimal
 * place was wrong at both ends: 0.25 read "0.3" and 0.03 read "0.0". */
const num = (n: number): string => String(Math.abs(n) >= 100 ? Math.round(n) : Number(n.toPrecision(3)));
/** Axis labels only: compact, because the left gutter is 34px and `200000` overflows it.
 * Tooltips keep the exact value. */
const axis = (n: number): string => {
  const a = Math.abs(n);
  if (a >= 1e6) return `${Number((n / 1e6).toPrecision(3))}M`;
  if (a >= 1e4) return `${Number((n / 1e3).toPrecision(3))}k`;
  return num(n);
};
/** The exact value, for a tooltip: `num` rounds (it is for axis-sized labels), and a tooltip
 * that disagrees with the data the server sent is the picture-versus-data mismatch again. */
const exact = (n: number): string => String(Number.isInteger(n) ? n : Number(n.toFixed(4)));
const fmt = (n: number, unit?: string): string => `${exact(n)}${unit ? ` ${unit}` : ""}`;

export function ChartBlockView({ block }: { block: ChartBlock }) {
  const { points, unit } = block;
  if (points.length === 0) return <p className="text-sm text-fg-subtle">{block.empty ?? getI18n().t("blockkit.tableEmpty")}</p>;

  const top = niceMax(Math.max(...points.map((p) => p.value), 0));
  const y = (v: number) => PAD.top + PLOT_H - (Math.max(v, 0) / top) * PLOT_H;
  // A lone point has no width to span, so it sits in the middle rather than at x = NaN.
  const slot = PLOT_W / points.length;
  const x = (i: number) => (block.chart === "line" ? (points.length === 1 ? PAD.left + PLOT_W / 2 : PAD.left + (i / (points.length - 1)) * PLOT_W) : PAD.left + slot * i + slot / 2);

  // At most ~6 x labels, whatever the range: 90 daily labels would overprint into a smear.
  const step = Math.max(1, Math.ceil(points.length / 6));
  // A midline only where its label is a whole number for a whole-number axis: counts should
  // never read "2.5 pageviews".
  const grid = Number.isInteger(top) && top % 2 !== 0 ? [0, top] : [0, top / 2, top];

  return (
    <figure className="m-0">
      {block.title ? <figcaption className="mb-1 text-sm font-medium text-fg">{block.title}</figcaption> : null}
      <div className="rounded-lg border border-border bg-surface-card p-3">
        <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label={block.title || undefined} className="block h-auto w-full text-accent-strong">
          {grid.map((g) => (
            <g key={g}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y(g)} y2={y(g)} className="stroke-border" strokeWidth={1} />
              <text x={PAD.left - 6} y={y(g) + 4} textAnchor="end" className="fill-fg-subtle" fontSize={11}>{axis(g)}</text>
            </g>
          ))}
          {block.chart === "line" ? (
            <>
              <polyline fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} />
              {points.map((p, i) => (
                <circle key={i} cx={x(i)} cy={y(p.value)} r={points.length > 60 ? 1.5 : 3} fill="currentColor">
                  <title>{`${p.title ?? p.label}: ${fmt(p.value, unit)}`}</title>
                </circle>
              ))}
            </>
          ) : (
            points.map((p, i) => {
              const bw = Math.max(1, slot * 0.7);
              const h = PAD.top + PLOT_H - y(p.value);
              return (
                <rect key={i} x={x(i) - bw / 2} y={y(p.value)} width={bw} height={Math.max(h, p.value > 0 ? 1 : 0)} rx={1.5} fill="currentColor">
                  <title>{`${p.title ?? p.label}: ${fmt(p.value, unit)}`}</title>
                </rect>
              );
            })
          )}
          {points.map((p, i) =>
            i % step === 0 ? (
              <text key={i} x={x(i)} y={H - 6} textAnchor="middle" className="fill-fg-subtle" fontSize={11}>{p.label}</text>
            ) : null,
          )}
        </svg>
      </div>
    </figure>
  );
}
