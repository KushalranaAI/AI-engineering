import { Blocks, Bot, MessagesSquare, Moon, Search, Server, ShieldCheck, Sparkles, Sun, type LucideIcon } from "lucide-react";
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
/** Dark is the default (the family look). Light is an opt-in; an old "system" choice falls back to dark. */
type Theme = "dark" | "light";
const THEME_KEY = "ai-path:theme";

function readTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function applyTheme(t: Theme) {
  document.documentElement.setAttribute("data-theme", t);
}

export function initTheme() {
  applyTheme(readTheme());
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);
  useEffect(() => {
    applyTheme(theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* not persisted */
    }
  }, [theme]);
  const Icon = theme === "light" ? Moon : Sun;
  const to: Theme = theme === "light" ? "dark" : "light";
  return (
    <button className="icon-btn" onClick={() => setTheme(to)} title={`Switch to ${to} theme`} aria-label={`Switch to ${to} theme`}>
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
