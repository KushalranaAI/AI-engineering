import { Check, ChevronRight, Hammer, PanelLeft, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { LEVELS, PHASES, TOTAL_SESSIONS, levelsInPhase } from "../curriculum";
import { isLevelDone, levelFraction, moduleFraction, nextModule, sessionsDone, useProgress } from "../state/progress";

/** A module's link: capstones open their project guide. */
export const moduleHref = (m: { id: string; projectId?: string }) => (m.projectId ? `/project/${m.projectId}` : `/learn/${m.id}`);

/** Learning pages share this layout: the whole path on the left, always showing where you are. */
export function CourseLayout({ level, moduleId, children }: { level: number; moduleId?: string; children: ReactNode }) {
  const p = useProgress();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<number>(level);
  const { pathname } = useLocation();
  const next = nextModule(p);
  const done = sessionsDone(p);
  const activeRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => setExpanded(level), [level]);
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [moduleId]);

  return (
    <div className="course">
      <button className="course-toggle btn small" onClick={() => setOpen(true)} aria-label="Open the course outline">
        <PanelLeft size={15} /> Outline
      </button>
      <aside className={`course-side${open ? " open" : ""}`} aria-label="Course outline">
        <div className="cs-head">
          <div className="row between">
            <b>Your path</b>
            <button className="icon-btn sm course-close" onClick={() => setOpen(false)} aria-label="Close outline"><X size={15} /></button>
          </div>
          <div className="cs-progress">
            <span className="meter"><span style={{ width: `${(done / TOTAL_SESSIONS) * 100}%` }} /></span>
            <span className="muted small">{Math.round((done / TOTAL_SESSIONS) * 100)}%</span>
          </div>
        </div>
        <nav className="cs-body">
          {PHASES.map((ph) => (
            <div key={ph.id} className="cs-phase">
              <div className="cs-phase-title"><i style={{ background: `var(--ph-${ph.id})` }} />{ph.title}</div>
              {levelsInPhase(ph.id).map((l) => {
                const isOpen = expanded === l.number;
                const f = levelFraction(p, l);
                const here = l.number === level;
                return (
                  <div key={l.number} className={`cs-level${here ? " here" : ""}`}>
                    <div className="cs-level-row">
                      <button className="cs-caret" onClick={() => setExpanded(isOpen ? -1 : l.number)} aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} level ${l.number}`}>
                        <ChevronRight size={14} className={isOpen ? "rot" : ""} />
                      </button>
                      <Link to={`/level/${l.number}`} className={`cs-level-link${pathname === `/level/${l.number}` ? " active" : ""}`}>
                        <span className={`cs-lnum${isLevelDone(p, l) ? " done" : ""}`}>{isLevelDone(p, l) ? <Check size={11} strokeWidth={3} /> : l.number}</span>
                        <span className="cs-ltitle">{l.title}</span>
                        {f > 0 && f < 1 && <span className="cs-lpct">{Math.round(f * 100)}%</span>}
                      </Link>
                    </div>
                    {isOpen && (
                      <ol className="cs-modules">
                        {l.modules.map((m) => {
                          const mf = moduleFraction(p, m);
                          const active = m.id === moduleId;
                          return (
                            <li key={m.id}>
                              <Link ref={active ? activeRef : undefined} to={moduleHref(m)} className={`cs-mod${active ? " active" : ""}${mf >= 1 ? " done" : ""}${next?.id === m.id ? " next" : ""}`}>
                                <span className="cs-dot" aria-hidden>{mf >= 1 ? <Check size={10} strokeWidth={3} /> : m.projectId ? <Hammer size={10} /> : mf > 0 ? <i style={{ height: `${mf * 100}%` }} /> : null}</span>
                                <span className="cs-mtitle">{m.title}</span>
                                {next?.id === m.id && !active && <span className="cs-next">next</span>}
                              </Link>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      {open && <div className="course-scrim" onClick={() => setOpen(false)} />}
      <div className="course-main">{children}</div>
    </div>
  );
}

export const levelCount = LEVELS.length;
