import { Blocks, Bot, MessagesSquare, Monitor, Moon, Search, Server, ShieldCheck, Sparkles, Sun, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { phaseById, type PhaseId } from "../curriculum";
import { useChat } from "../chat/store";

const PHASE_ICONS: Record<PhaseId, LucideIcon> = {
  foundations: Blocks,
  retrieval: Search,
  agentic: Bot,
  trust: ShieldCheck,
  production: Server,
  frontier: Sparkles,
  interview: MessagesSquare,
};

export function PhaseIcon({ phase, size = 16 }: { phase: PhaseId; size?: number }) {
  const Icon = PHASE_ICONS[phase];
  return <Icon size={size} aria-hidden />;
}

/** a phase colour applied through a CSS variable, so children can use var(--ph) */
export const phaseStyle = (phase: PhaseId) => ({ "--ph": `var(--ph-${phase})` }) as React.CSSProperties;

export function PhaseTag({ phase }: { phase: PhaseId }) {
  return (
    <span className="phase-tag" style={phaseStyle(phase)}>
      <PhaseIcon phase={phase} size={12} /> {phaseById(phase).title}
    </span>
  );
}

export function Ring({ value, size = 36, stroke = 3 }: { value: number; size?: number; stroke?: number }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-fill" strokeWidth={stroke} strokeDasharray={`${c * Math.min(1, Math.max(0, value))} ${c}`} />
    </svg>
  );
}

export function Meter({ value, label }: { value: number; label?: string }) {
  return (
    <span className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}>
      <span style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }} />
    </span>
  );
}

/** a 10-segment bar for "interview weight" and "on-the-job weight" */
export function Weight({ value }: { value: number }) {
  return (
    <span className="weight" aria-label={`${value} out of 10`}>
      {Array.from({ length: 10 }, (_, i) => <i key={i} className={i < value ? "on" : ""} />)}
    </span>
  );
}

/* ---------- theme ---------- */
type Theme = "system" | "light" | "dark";
const THEME_KEY = "ai-path:theme";

function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t === "system") el.removeAttribute("data-theme");
  else el.setAttribute("data-theme", t);
}

export function initTheme() {
  try {
    applyTheme((localStorage.getItem(THEME_KEY) as Theme) || "system");
  } catch {
    /* storage blocked: follow the system */
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as Theme) || "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* not persisted */
    }
  }, [theme]);
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <button className="icon-btn" onClick={() => setTheme(next[theme])} title={`Theme: ${theme} (click to change)`} aria-label={`Theme: ${theme}`}>
      <Icon size={16} />
    </button>
  );
}

/** a button that opens the tutor with a question about the current screen */
export function AskButton({ question, label, className = "btn small" }: { question: string; label: string; className?: string }) {
  const { pathname } = useLocation();
  const ask = useChat((s) => s.ask);
  return (
    <button className={`${className} ask-btn`} onClick={() => ask(question, pathname)}>
      <Sparkles size={14} /> {label}
    </button>
  );
}
