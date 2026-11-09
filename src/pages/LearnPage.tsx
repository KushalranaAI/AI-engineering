import { ArrowRight, CalendarDays, Check, Hammer } from "lucide-react";
import { Link } from "react-router-dom";
import { LEVELS, PHASES, TOTAL_SESSIONS, levelsInPhase, sessionsOf } from "../curriculum";
import { useChatSource } from "../chat/store";
import { isLevelDone, levelFraction, nextModule, sessionsDone, useProgress } from "../state/progress";
import { moduleHref } from "../ui/CourseLayout";

/** The whole path on one page: what each level is for, where you are, and what's next. */
export function LearnPage() {
  const p = useProgress();
  const next = nextModule(p);
  const done = sessionsDone(p);
  useChatSource("path", {
    label: "The path",
    suggestions: ["Which levels matter most for interviews?", "Can I skip any levels?", "How do the phases build on each other?"],
    build: () => ({ levels: LEVELS.map((l) => ({ level: l.number, title: l.title, phase: l.phase, summary: l.summary, progress: `${Math.round(levelFraction(p, l) * 100)}%`, interviewWeight: l.interviewWeight })) }),
  });
  return (
    <div className="page learn">
      <header className="learn-head">
        <div>
          <h1>The path</h1>
          <p className="lead">{LEVELS.length} levels in {PHASES.length} phases. Each one builds on the ones before it, so go in order, starting wherever you are.</p>
        </div>
        <div className="learn-progress">
          <span className="meter big"><span style={{ width: `${(done / TOTAL_SESSIONS) * 100}%` }} /></span>
          <span className="muted small">{done} of {TOTAL_SESSIONS} study sessions</span>
          {next && (
            <Link className="btn primary" to={moduleHref(next)}>
              Continue: {next.title} <ArrowRight size={15} />
            </Link>
          )}
        </div>
      </header>

      <ol className="path">
        {PHASES.map((ph, pi) => (
          <li key={ph.id} className="path-phase" style={{ "--ph": `var(--ph-${ph.id})` } as React.CSSProperties}>
            <div className="path-phase-head">
              <span className="path-phase-num">Phase {pi + 1}</span>
              <h2>{ph.title}</h2>
              <span className="muted small">{ph.tagline}</span>
            </div>
            <ol className="path-levels">
              {levelsInPhase(ph.id).map((l) => {
                const f = levelFraction(p, l);
                const isDone = isLevelDone(p, l);
                const here = next && l.modules.some((m) => m.id === next.id);
                const skipped = l.number < p.startLevel && f === 0;
                return (
                  <li key={l.number}>
                    <Link to={`/level/${l.number}`} className={`path-level${isDone ? " done" : ""}${here ? " here" : ""}${skipped ? " skipped" : ""}`}>
                      <span className="pl-num">{isDone ? <Check size={14} strokeWidth={3} /> : l.number}</span>
                      <span className="pl-body">
                        <span className="pl-title">
                          {l.title}
                          {here && <span className="pl-tag">You are here</span>}
                          {skipped && <span className="pl-tag muted">Skipped</span>}
                        </span>
                        <span className="pl-sum">{l.summary}</span>
                        <span className="pl-meta">
                          {l.modules.length} modules · {sessionsOf(l)} sessions
                          {l.projects.length > 0 && <> · <Hammer size={12} aria-hidden /> {l.projects.length === 1 ? l.projects[0].title : `${l.projects.length} projects`}</>}
                        </span>
                      </span>
                      <span className="pl-progress">
                        {f > 0 && !isDone && <span className="meter"><span style={{ width: `${f * 100}%` }} /></span>}
                        <ArrowRight size={16} aria-hidden />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </li>
        ))}
      </ol>

      <Link to="/sprint" className="sprint-link">
        <CalendarDays size={18} aria-hidden />
        <span>
          <b>Short on time? The 100-day sprint</b>
          <span>The core levels on a calendar: about two focused hours a day.</span>
        </span>
        <ArrowRight size={16} />
      </Link>
    </div>
  );
}
