import { Download, Flame, Hammer, Layers, NotebookPen, RotateCcw, Trophy, Upload, X } from "lucide-react";
import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { LEVELS, PROJECTS, TOTAL_SESSIONS, moduleById, projectById } from "../curriculum";
import { lessonFor, splitChecks } from "../curriculum/lessons";
import { useChatSource } from "../chat/store";
import { isLevelDone, levelFraction, projectsShipped, sessionsDone, streak, today, useProgress } from "../state/progress";
import { Meter, PhaseIcon, phaseStyle } from "../ui/bits";

const WEEKS = 26;

function Heatmap({ days }: { days: Record<string, number> }) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (WEEKS * 7 - 1) - end.getDay()); // start on a Sunday
  const cells: { date: string; n: number; future: boolean }[] = [];
  for (const d = new Date(start); cells.length < WEEKS * 7 + 7; d.setDate(d.getDate() + 1)) {
    const k = today(d);
    cells.push({ date: k, n: days[k] ?? 0, future: d > end });
  }
  const lvl = (n: number) => (n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 10 ? 3 : 4);
  return (
    <div className="heatmap" role="img" aria-label="Study activity over the last six months">
      {cells.map((c) => (
        <i key={c.date} className={c.future ? "future" : `h${lvl(c.n)}`} title={c.future ? "" : `${c.date}: ${c.n} item${c.n === 1 ? "" : "s"}`} />
      ))}
    </div>
  );
}

export function ProgressPage() {
  const p = useProgress();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState("");
  const done = sessionsDone(p);
  const st = streak(p.days);
  const activeDays = Object.values(p.days).filter((n) => n > 0).length;
  const review = Object.entries(p.checks)
    .filter(([, v]) => v === false)
    .map(([k]) => {
      const [mid, i] = k.split(":");
      const m = moduleById(mid);
      const lesson = lessonFor(mid);
      const q = lesson ? splitChecks(lesson.body).checks[Number(i)]?.q : undefined;
      return m && q ? { m, q } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const notes = Object.entries(p.notes).filter(([, t]) => t.trim());

  useChatSource("progress", {
    label: "Your progress",
    suggestions: ["Based on my progress, what should I focus on this week?", "Quiz me on the questions I marked for review", "Am I going too fast or too slow?"],
    build: () => ({
      sessionsDone: done,
      totalSessions: TOTAL_SESSIONS,
      streakDays: st,
      activeDays,
      levels: LEVELS.map((l) => `L${l.number} ${l.title}: ${Math.round(levelFraction(p, l) * 100)}%`),
      projectsShipped: projectsShipped(p),
      questionsToReview: review.map((r) => `${r.m.id}: ${r.q}`),
    }),
  });

  const exportData = () => {
    const { topics, modules, steps, links, notes, checks, days, startLevel, sprintStart, dailyGoal } = p;
    const blob = new Blob([JSON.stringify({ app: "ai-engineer-path", version: 1, exportedAt: new Date().toISOString(), data: { topics, modules, steps, links, notes, checks, days, startLevel, sprintStart, dailyGoal } }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `ai-engineer-path-progress-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importData = async (file: File) => {
    try {
      const json = JSON.parse(await file.text());
      const data = json?.app === "ai-engineer-path" ? json.data : json;
      if (!data || typeof data !== "object") throw new Error("not a progress file");
      if (!confirm("Replace your current progress with this file?")) return;
      p.replace(data);
      setMsg("Progress restored.");
    } catch (e) {
      setMsg(`Couldn't read that file (${e instanceof Error ? e.message : e}).`);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">Your progress</p>
        <h1>Small steps, most days.</h1>
        <p className="lead">Everything here is stored in this browser only. Export a backup now and then, or to move to another computer.</p>
      </header>

      <div className="stat-cards">
        <div className="card stat"><Flame size={18} className="rule-icon" /><b className="stat-big">{st}</b><span className="muted small">day streak</span></div>
        <div className="card stat"><Layers size={18} className="rule-icon" /><b className="stat-big">{done}<small>/{TOTAL_SESSIONS}</small></b><span className="muted small">sessions done</span></div>
        <div className="card stat"><Hammer size={18} className="rule-icon" /><b className="stat-big">{projectsShipped(p)}<small>/{PROJECTS.length}</small></b><span className="muted small">projects shipped</span></div>
        <div className="card stat"><Trophy size={18} className="rule-icon" /><b className="stat-big">{LEVELS.filter((l) => isLevelDone(p, l)).length}<small>/16</small></b><span className="muted small">levels done</span></div>
      </div>

      <section className="card">
        <div className="row between"><h4>Activity · last 6 months</h4><span className="muted small">{activeDays} active days</span></div>
        <Heatmap days={p.days} />
      </section>

      <h2 className="section-title">By level</h2>
      <div className="level-bars">
        {LEVELS.map((l) => (
          <Link key={l.number} to={`/level/${l.number}`} className="level-bar" style={phaseStyle(l.phase)}>
            <span className="phase-icon sm"><PhaseIcon phase={l.phase} size={13} /></span>
            <span className="level-bar-title">L{l.number} {l.title}</span>
            <Meter value={levelFraction(p, l)} />
            <span className="muted small num">{Math.round(levelFraction(p, l) * 100)}%</span>
          </Link>
        ))}
      </div>

      <h2 className="section-title">To review <span className="count">{review.length}</span></h2>
      {review.length ? (
        <div className="stack">
          {review.map(({ m, q }, i) => (
            <Link key={i} to={`/learn/${m.id}`} className="card review-row">
              <span className="tag">M{m.id} · {m.title}</span>
              <span>{q.replace(/[*_`]/g, "")}</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="muted">Nothing yet. When you answer a "Check yourself" question and mark it "Review later", it shows up here.</p>
      )}

      <h2 className="section-title"><NotebookPen size={18} /> Notes <span className="count">{notes.length}</span></h2>
      {notes.length ? (
        <div className="cards three">
          {notes.map(([id, text]) => {
            const m = moduleById(id);
            const pr = projectById(id);
            return (
              <Link key={id} to={m ? `/learn/${id}` : `/project/${id}`} className="card note-card">
                <span className="tag">{m ? `M${m.id} · ${m.title}` : pr ? `Project · ${pr.title}` : id}</span>
                <p className="clamp4">{text}</p>
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="muted">Notes you write on lessons and projects collect here.</p>
      )}

      <h2 className="section-title">Backup</h2>
      <div className="card row gap">
        <button className="btn" onClick={exportData}><Download size={15} /> Export progress</button>
        <button className="btn" onClick={() => fileRef.current?.click()}><Upload size={15} /> Import</button>
        <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={(e) => e.target.files?.[0] && importData(e.target.files[0])} />
        <span className="grow" />
        <button className="btn ghost danger" onClick={() => confirm("Erase all progress, notes and links in this browser? This can't be undone.") && (p.reset(), setMsg("Progress erased."))}>
          <RotateCcw size={15} /> Reset everything
        </button>
      </div>
      {msg && <p className="hint">{msg} <button className="icon-btn sm" onClick={() => setMsg("")} aria-label="Dismiss"><X size={13} /></button></p>}
    </div>
  );
}
