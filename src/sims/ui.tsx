/* Shared building blocks for the simulators: controls, readouts, the page frame and a tiny SVG chart. */
import { useId, useMemo, type KeyboardEvent, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Lightbulb, Sparkles } from "lucide-react";

/* ---------------------------------------------------------------- Slider */

export interface SliderProps {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** log-scale slider: equal travel per decade (min must be > 0) */
  log?: boolean;
  /** custom display of the value */
  format?: (v: number) => string;
  hint?: ReactNode;
  disabled?: boolean;
}

const LOG_STEPS = 1000;

export function Slider({ label, value, onChange, min, max, step = 1, unit, log, format, hint, disabled }: SliderProps) {
  const id = useId();
  const shown = format ? format(value) : `${value.toLocaleString("en-US")}${unit ? ` ${unit}` : ""}`;
  const toPos = (v: number) => (log ? Math.round((Math.log(v / min) / Math.log(max / min)) * LOG_STEPS) : v);
  const fromPos = (p: number) => {
    if (!log) return p;
    const raw = min * Math.pow(max / min, p / LOG_STEPS);
    const snapped = Math.round(raw / step) * step;
    return Math.min(max, Math.max(min, snapped));
  };
  const pos = toPos(value);
  const lo = log ? 0 : min;
  const hi = log ? LOG_STEPS : max;
  const pct = ((pos - lo) / (hi - lo)) * 100;
  return (
    <div className={`sim-slider${disabled ? " disabled" : ""}`}>
      <div className="sim-slider-head">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} className="sim-slider-value">
          {shown}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={lo}
        max={hi}
        step={log ? 1 : step}
        value={pos}
        disabled={disabled}
        aria-valuetext={shown}
        style={{ ["--fill" as string]: `${Math.max(0, Math.min(100, pct))}%` }}
        onChange={(e) => onChange(fromPos(Number(e.target.value)))}
      />
      {hint && <div className="sim-slider-hint">{hint}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- Segmented */

export interface Option<T> {
  value: T;
  label: ReactNode;
  title?: string;
}

/** A segmented control (radio group). Arrow keys move the selection. */
export function Segmented<T extends string | number>({ label, options, value, onChange, hideLabel }: { label: string; options: Option<T>[]; value: T; onChange: (v: T) => void; hideLabel?: boolean }) {
  const id = useId();
  const idx = options.findIndex((o) => o.value === value);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const n = (idx + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
    onChange(options[n].value);
    const btn = e.currentTarget.querySelectorAll<HTMLButtonElement>("button")[n];
    btn?.focus();
  };
  return (
    <div className="sim-field">
      <span id={id} className={hideLabel ? "sim-sr" : "sim-field-label"}>
        {label}
      </span>
      <div className="sim-seg" role="radiogroup" aria-labelledby={id} onKeyDown={onKey}>
        {options.map((o, i) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={o.value === value}
            tabIndex={i === (idx < 0 ? 0 : idx) ? 0 : -1}
            title={o.title}
            className={o.value === value ? "on" : ""}
            onClick={() => onChange(o.value)}
          >
            {o.value === value && <motion.span layoutId={`${id}-pill`} className="sim-seg-pill" transition={{ type: "spring", bounce: 0.15, duration: 0.35 }} />}
            <span className="sim-seg-text">{o.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Select */

export function Select<T extends string>({ label, options, value, onChange, hint }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="sim-field">
      <label htmlFor={id} className="sim-field-label">
        {label}
      </label>
      <select id={id} className="sim-select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <div className="sim-slider-hint">{hint}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- Toggle */

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="sim-toggle">
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <label htmlFor={id}>
        {label}
        {hint && <span className="sim-slider-hint">{hint}</span>}
      </label>
    </div>
  );
}

/** A titled block inside the controls column */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="sim-group">
      <legend>{title}</legend>
      {children}
    </fieldset>
  );
}

/* ---------------------------------------------------------------- Readout */

export type Tone = "good" | "warm" | "bad" | "neutral" | "accent";

export function Readout({ label, value, unit, tone = "neutral", hint }: { label: string; value: ReactNode; unit?: string; tone?: Tone; hint?: ReactNode }) {
  return (
    <div className={`sim-readout ${tone}`}>
      <div className="sim-readout-label">{label}</div>
      <div className="sim-readout-value">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={String(value)} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
            {value}
          </motion.span>
        </AnimatePresence>
        {unit && <span className="sim-readout-unit">{unit}</span>}
      </div>
      {hint && <div className="sim-readout-hint">{hint}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- SimFrame */

export interface SimFrameProps {
  controls: ReactNode;
  /** the main visual */
  children: ReactNode;
  readouts?: ReactNode;
  /** 2-4 plain sentences built from the live numbers */
  explain: ReactNode;
  realLife?: string;
  /** optional row above the visual (legend, play button...) */
  toolbar?: ReactNode;
}

export function SimFrame({ controls, children, readouts, explain, realLife, toolbar }: SimFrameProps) {
  return (
    <div className="sim">
      <div className="sim-grid">
        <aside className="sim-controls" aria-label="Simulator controls">
          {controls}
        </aside>
        <div className="sim-main">
          {readouts && <div className="sim-readouts">{readouts}</div>}
          <section className="sim-visual" aria-label="Visualisation">
            {toolbar && <div className="sim-toolbar">{toolbar}</div>}
            {children}
          </section>
          <section className="sim-explain" aria-live="polite">
            <h4>
              <Lightbulb size={13} aria-hidden /> What you're seeing
            </h4>
            <div className="sim-explain-body">{explain}</div>
          </section>
          {realLife && (
            <p className="sim-real">
              <Sparkles size={14} aria-hidden />
              <span>
                <b>In real life: </b>
                {realLife}
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** A horizontal stacked bar (HTML). Segments animate their width. */
export function StackBar({ segments, total, ariaLabel, height = 30 }: { segments: { label: string; value: number; color: string; striped?: boolean }[]; total: number; ariaLabel: string; height?: number }) {
  return (
    <div className="sim-stack" role="img" aria-label={ariaLabel} style={{ height }}>
      {segments.map((s) => (
        <motion.div
          key={s.label}
          className={`sim-stack-seg${s.striped ? " striped" : ""}`}
          style={{ background: s.color }}
          initial={false}
          animate={{ width: `${Math.max(0, (s.value / total) * 100)}%` }}
          transition={{ duration: 0.35, ease: [0.2, 0.7, 0.2, 1] }}
          title={s.label}
        />
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: ReactNode; color: string; dashed?: boolean; striped?: boolean }[] }) {
  return (
    <ul className="sim-legend">
      {items.map((it, i) => (
        <li key={i}>
          <span className={`sim-swatch${it.dashed ? " dashed" : ""}${it.striped ? " striped" : ""}`} style={{ ["--c" as string]: it.color }} aria-hidden />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------------------------------------- Chart */

export interface Series {
  name: string;
  color: string;
  points: [number, number][];
  dashed?: boolean;
  width?: number;
  /** draw an area under the line */
  area?: boolean;
}

export interface Dot {
  x: number;
  y: number;
  color: string;
  label?: string;
  r?: number;
  /** label position */
  anchor?: "left" | "right" | "above" | "below";
}

export interface RefLine {
  x?: number;
  y?: number;
  label?: string;
  color?: string;
}

export interface ChartProps {
  series?: Series[];
  dots?: Dot[];
  refs?: RefLine[];
  xLog?: boolean;
  yLog?: boolean;
  xDomain?: [number, number];
  yDomain?: [number, number];
  xLabel?: string;
  yLabel?: string;
  xFormat?: (v: number) => string;
  yFormat?: (v: number) => string;
  height?: number;
  ariaLabel: string;
  legend?: boolean;
  /** shaded vertical band, e.g. "over the SLO" */
  band?: { x0: number; x1: number; color: string; label?: string };
}

const W = 600;
const M = { l: 58, r: 16, t: 14, b: 44 };

function niceStep(span: number, target: number) {
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n >= 5 ? 10 : n >= 2 ? 5 : n >= 1 ? 2 : 1) * mag;
}

export function linearTicks(lo: number, hi: number, target = 5): number[] {
  if (hi <= lo) return [lo];
  const step = niceStep(hi - lo, target);
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

export function logTicks(lo: number, hi: number): number[] {
  const a = Math.floor(Math.log10(lo));
  const b = Math.ceil(Math.log10(hi));
  const all: number[] = [];
  for (let e = a; e <= b; e++) {
    const v = Math.pow(10, e);
    if (v >= lo * 0.999 && v <= hi * 1.001) all.push(v);
  }
  if (all.length <= 7) return all;
  const every = Math.ceil(all.length / 6);
  return all.filter((_, i) => i % every === 0);
}

const defaultFmt = (v: number) => {
  const abs = Math.abs(v);
  if (abs >= 1e15) return `${+(v / 1e15).toFixed(1)}P`;
  if (abs >= 1e12) return `${+(v / 1e12).toFixed(1)}T`;
  if (abs >= 1e9) return `${+(v / 1e9).toFixed(1)}G`;
  if (abs >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${+(v / 1e3).toFixed(1)}k`;
  if (abs > 0 && abs < 1) return `${+v.toPrecision(2)}`;
  return `${+v.toFixed(1)}`;
};

/** A small dependency-free SVG chart: lines, dots, reference lines, linear or log axes. Scales to its container width. */
export function Chart({ series = [], dots = [], refs = [], xLog, yLog, xDomain, yDomain, xLabel, yLabel, xFormat = defaultFmt, yFormat = defaultFmt, height = 280, ariaLabel, legend = true, band }: ChartProps) {
  const clipId = useId().replace(/:/g, "");
  const H = height;
  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;

  const [x0, x1, y0, y1] = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const s of series) for (const [x, y] of s.points) if (Number.isFinite(x) && Number.isFinite(y)) xs.push(x), ys.push(y);
    for (const d of dots) xs.push(d.x), ys.push(d.y);
    const ext = (vals: number[], log?: boolean): [number, number] => {
      const v = log ? vals.filter((n) => n > 0) : vals;
      if (!v.length) return log ? [1, 10] : [0, 1];
      let lo = Math.min(...v);
      let hi = Math.max(...v);
      if (log) return [Math.pow(10, Math.floor(Math.log10(lo))), Math.pow(10, Math.ceil(Math.log10(hi)))];
      lo = Math.min(0, lo);
      if (hi === lo) hi = lo + 1;
      return [lo, hi + (hi - lo) * 0.06];
    };
    const xd = xDomain ?? ext(xs, xLog);
    const yd = yDomain ?? ext(ys, yLog);
    return [xd[0], xd[1], yd[0], yd[1]];
  }, [series, dots, xDomain, yDomain, xLog, yLog]);

  const sx = (x: number) => M.l + (xLog ? (Math.log10(Math.max(x, 1e-30)) - Math.log10(x0)) / (Math.log10(x1) - Math.log10(x0)) : (x - x0) / (x1 - x0)) * pw;
  const sy = (y: number) => M.t + ph - (yLog ? (Math.log10(Math.max(y, 1e-30)) - Math.log10(y0)) / (Math.log10(y1) - Math.log10(y0)) : (y - y0) / (y1 - y0)) * ph;

  const xt = xLog ? logTicks(x0, x1) : linearTicks(x0, x1, 6);
  const yt = yLog ? logTicks(y0, y1) : linearTicks(y0, y1, 5);
  const path = (pts: [number, number][]) =>
    pts
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
      .map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`)
      .join(" ");

  return (
    <figure className="sim-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} preserveAspectRatio="xMidYMid meet">
        <defs>
          <clipPath id={clipId}>
            <rect x={M.l} y={M.t - 2} width={pw} height={ph + 4} />
          </clipPath>
        </defs>
        {band && (
          <g>
            <rect x={sx(Math.max(band.x0, x0))} y={M.t} width={Math.max(0, sx(Math.min(band.x1, x1)) - sx(Math.max(band.x0, x0)))} height={ph} fill={band.color} opacity={0.09} />
            {band.label && (
              <text x={sx(Math.min(band.x1, x1)) - 6} y={M.t + 14} textAnchor="end" className="sim-chart-ref-label" fill={band.color}>
                {band.label}
              </text>
            )}
          </g>
        )}
        {/* grid + ticks */}
        {yt.map((v) => (
          <g key={`y${v}`}>
            <line x1={M.l} x2={W - M.r} y1={sy(v)} y2={sy(v)} className="sim-chart-grid" />
            <text x={M.l - 8} y={sy(v)} dy="0.32em" textAnchor="end" className="sim-chart-tick">
              {yFormat(v)}
            </text>
          </g>
        ))}
        {xt.map((v) => (
          <g key={`x${v}`}>
            <line x1={sx(v)} x2={sx(v)} y1={M.t} y2={M.t + ph} className="sim-chart-grid" />
            <text x={sx(v)} y={M.t + ph + 16} textAnchor="middle" className="sim-chart-tick">
              {xFormat(v)}
            </text>
          </g>
        ))}
        <line x1={M.l} x2={W - M.r} y1={M.t + ph} y2={M.t + ph} className="sim-chart-axis" />
        <line x1={M.l} x2={M.l} y1={M.t} y2={M.t + ph} className="sim-chart-axis" />
        {xLabel && (
          <text x={M.l + pw / 2} y={H - 6} textAnchor="middle" className="sim-chart-label">
            {xLabel}
          </text>
        )}
        {yLabel && (
          <text transform={`translate(13 ${M.t + ph / 2}) rotate(-90)`} textAnchor="middle" className="sim-chart-label">
            {yLabel}
          </text>
        )}
        <g clipPath={`url(#${clipId})`}>
          {series.map((s) => {
            const d = path(s.points);
            if (!d) return null;
            return (
              <g key={s.name}>
                {s.area && s.points.length > 1 && (
                  <motion.path
                    initial={false}
                    animate={{ d: `${d} L${sx(s.points[s.points.length - 1][0]).toFixed(1)},${(M.t + ph).toFixed(1)} L${sx(s.points[0][0]).toFixed(1)},${(M.t + ph).toFixed(1)} Z` }}
                    transition={{ duration: 0.3 }}
                    fill={s.color}
                    opacity={0.1}
                    stroke="none"
                  />
                )}
                <motion.path initial={false} animate={{ d }} transition={{ duration: 0.3 }} fill="none" stroke={s.color} strokeWidth={s.width ?? 2.2} strokeDasharray={s.dashed ? "5 4" : undefined} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {refs.map((r, i) => {
            const c = r.color ?? "var(--muted)";
            if (r.x !== undefined && r.x >= x0 && r.x <= x1)
              return (
                <g key={`r${i}`}>
                  <line x1={sx(r.x)} x2={sx(r.x)} y1={M.t} y2={M.t + ph} stroke={c} strokeDasharray="3 4" strokeWidth={1.3} />
                  {r.label && (
                    <text x={sx(r.x) + 5} y={M.t + 12} className="sim-chart-ref-label" fill={c}>
                      {r.label}
                    </text>
                  )}
                </g>
              );
            if (r.y !== undefined && r.y >= y0 && r.y <= y1)
              return (
                <g key={`r${i}`}>
                  <line x1={M.l} x2={W - M.r} y1={sy(r.y)} y2={sy(r.y)} stroke={c} strokeDasharray="3 4" strokeWidth={1.3} />
                  {r.label && (
                    <text x={W - M.r - 4} y={sy(r.y) - 5} textAnchor="end" className="sim-chart-ref-label" fill={c}>
                      {r.label}
                    </text>
                  )}
                </g>
              );
            return null;
          })}
        </g>
        {dots.map((d, i) => {
          const cx = sx(d.x);
          const cy = sy(d.y);
          const a = d.anchor ?? "right";
          const lx = a === "left" ? cx - 9 : a === "right" ? cx + 9 : cx;
          const ly = a === "above" ? cy - 10 : a === "below" ? cy + 16 : cy;
          return (
            <g key={`d${i}`}>
              <motion.circle initial={false} animate={{ cx, cy }} transition={{ duration: 0.3 }} r={d.r ?? 5.5} fill={d.color} stroke="var(--panel)" strokeWidth={2} />
              {d.label && (
                <motion.text initial={false} animate={{ x: lx, y: ly }} transition={{ duration: 0.3 }} dy="0.32em" textAnchor={a === "left" ? "end" : a === "right" ? "start" : "middle"} className="sim-chart-dot-label" fill={d.color}>
                  {d.label}
                </motion.text>
              )}
            </g>
          );
        })}
      </svg>
      {legend && series.length > 1 && <Legend items={series.map((s) => ({ label: s.name, color: s.color, dashed: s.dashed }))} />}
    </figure>
  );
}

/** Small "hint" paragraph used under visuals */
export function Note({ children, tone }: { children: ReactNode; tone?: Tone }) {
  return <p className={`sim-note${tone ? ` ${tone}` : ""}`}>{children}</p>;
}
