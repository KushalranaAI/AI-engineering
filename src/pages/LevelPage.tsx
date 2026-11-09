import { ArrowLeft, ArrowRight, BookOpen, Check, Hammer, Network } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { LEVELS, TOTAL_SESSIONS, levelByNumber, phaseById, practiceFor, sessionsOf, type Level } from "../curriculum";
import { guideFor } from "../curriculum/guides";
import { lessonFor } from "../curriculum/lessons";
import { useChatSource } from "../chat/store";
import { stagesForModule } from "../studio/journeys";
import { FLOW, flowDone, isLevelDone, levelFraction, moduleFraction, nextModule, projectFraction, projectStepCount, useProgress } from "../state/progress";
import { AskButton } from "../ui/bits";
import { CourseLayout, moduleHref } from "../ui/CourseLayout";

export function LevelPage() {
  const { n = "" } = useParams();
  const level = /^\d+$/.test(n) ? levelByNumber(Number(n)) : undefined;
  if (!level)
    return (
      <div className="page narrow">
        <div className="empty-state">
          <h1>Level not found</h1>
          <Link className="btn" to="/learn"><ArrowLeft size={16} /> Back to the path</Link>
        </div>
      </div>
    );
  return (
    <CourseLayout level={level.number}>
      <LevelView key={level.number} level={level} />
    </CourseLayout>
  );
}

function LevelView({ level }: { level: Level }) {
  const p = useProgress();
  const phase = phaseById(level.phase);
  const next = nextModule(p);
  const nextHere = next && level.modules.some((m) => m.id === next.id) ? next : undefined;
  const f = levelFraction(p, level);
  const sessions = sessionsOf(level);
  const cumulative = LEVELS.filter((l) => l.number <= level.number).reduce((s, l) => s + sessionsOf(l), 0);
  const prev = levelByNumber(level.number - 1);
  const after = levelByNumber(level.number + 1);
  const unmet = level.assumes.map((a) => levelByNumber(a)!).filter((l) => l && !isLevelDone(p, l) && l.number >= p.startLevel);
  const stages = [...new Map(level.modules.flatMap((m) => stagesForModule(m.id)).map((s) => [`${s.journey.id}:${s.index}`, s])).values()].slice(0, 3);

  useChatSource("level", {
    label: `Level ${level.number} · ${level.title}`,
    suggestions: [`What will I be able to do after Level ${level.number}?`, "Which module here is the hardest, and why?", "Am I ready for this level? Ask me 3 questions."],
    build: () => ({
      level: level.number,
      title: level.title,
      summary: level.summary,
      interview: `${level.interviewWeight}/10: ${level.interviewNote}`,
      onTheJob: `${level.jobWeight}/10: ${level.jobNote}`,
      modules: level.modules.map((m) => ({ id: m.id, title: m.title, outcome: m.outcome, done: !!p.modules[m.id] })),
      projects: level.projects.map((pr) => pr.title),
    }),
  });

  return (
    <div className="level" style={{ "--ph": `var(--ph-${level.phase})` } as React.CSSProperties}>
      <header className="level-head">
        <span className="level-kicker"><i />{phase.title} · Level {level.number}</span>
        <h1>{level.title}</h1>
        <p className="lead">{level.summary}</p>
        <div className="level-actions">
          {nextHere ? (
            <Link className="btn primary big" to={moduleHref(nextHere)}>
              {f > 0 ? "Continue" : "Start"}: {nextHere.title} <ArrowRight size={17} />
            </Link>
          ) : isLevelDone(p, level) ? (
            <span className="done-pill"><Check size={15} strokeWidth={3} /> Level complete</span>
          ) : (
            <Link className="btn primary big" to={moduleHref(level.modules.find((m) => !p.modules[m.id]) ?? level.modules[0])}>
              Start this level <ArrowRight size={17} />
            </Link>
          )}
          <span className="muted small">{Math.round(f * 100)}% done · {sessions} study sessions (about {sessions} hours)</span>
        </div>
        {unmet.length > 0 && (
          <p className="level-warn">
            This level assumes {unmet.map((l, i) => <span key={l.number}>{i > 0 && " and "}<Link to={`/level/${l.number}`}>Level {l.number}</Link></span>)}. If those ideas are new to you, start there.
          </p>
        )}
      </header>

      <section className="why">
        <div>
          <h3>In interviews · {level.interviewWeight}/10</h3>
          <p>{level.interviewNote}</p>
        </div>
        <div>
          <h3>On the job · {level.jobWeight}/10</h3>
          <p>{level.jobNote}</p>
        </div>
      </section>

      <section>
        <h2 className="section-title">Modules</h2>
        <ol className="mod-list">
          {level.modules.map((m, i) => {
            const mf = moduleFraction(p, m);
            const isDone = mf >= 1;
            const lesson = lessonFor(m.id);
            const practice = practiceFor(m.id);
            const isNext = nextHere?.id === m.id;
            return (
              <li key={m.id}>
                <Link to={moduleHref(m)} className={`mod-row${isDone ? " done" : ""}${isNext ? " next" : ""}${m.projectId ? " project" : ""}`}>
                  <span className="mod-num">{isDone ? <Check size={14} strokeWidth={3} /> : m.projectId ? <Hammer size={14} /> : i + 1}</span>
                  <span className="mod-body">
                    <span className="mod-title">{m.title}{isNext && <span className="pl-tag">Next</span>}</span>
                    <span className="mod-out">{m.outcome}</span>
                    <span className="mod-meta">
                      {m.projectId ? (
                        <>Project · {projectStepCount(m.projectId)} steps{guideFor(m.projectId) ? " with full code" : ""}</>
                      ) : (
                        <>
                          {lesson ? `${lesson.minutes} min read` : "Lesson coming"}
                          {practice ? ` · build: ${practice.build.title}` : ""}
                        </>
                      )}
                    </span>
                  </span>
                  <span className="mod-state">
                    {!m.projectId && !isDone && flowDone(p, m) > 0 && (
                      <span className="mini-dots" aria-label={`${flowDone(p, m)} of 4 steps`}>
                        {FLOW.map((s) => <i key={s} className={p.flow[`${m.id}:${s}`] ? "on" : ""} />)}
                      </span>
                    )}
                    {m.projectId && !isDone && projectFraction(p, m.projectId) > 0 && <span className="muted small">{Math.round(projectFraction(p, m.projectId) * 100)}%</span>}
                    <ArrowRight size={16} aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      </section>

      {stages.length > 0 && (
        <section>
          <h2 className="section-title">See it as a system</h2>
          <div className="stage-links">
            {stages.map(({ journey, index, stage }) => (
              <Link key={`${journey.id}${index}`} to={`/studio/j/${journey.id}/${index + 1}`} className="stage-link">
                <Network size={16} aria-hidden />
                <span>
                  <b>{stage.title}</b>
                  <span>{journey.title} · stage {index + 1}</span>
                </span>
                <ArrowRight size={15} />
              </Link>
            ))}
          </div>
        </section>
      )}

      <section className="level-foot">
        <p className="muted small">
          <BookOpen size={13} aria-hidden /> {cumulative} of {TOTAL_SESSIONS} sessions through the end of this level.
        </p>
        <AskButton question={`Am I ready for Level ${level.number} (${level.title})? Ask me 3 short questions, one at a time, about what it assumes.`} label="Check if I'm ready" />
        <div className="pager">
          {prev ? (
            <Link className="pager-card" to={`/level/${prev.number}`}>
              <small><ArrowLeft size={12} /> Level {prev.number}</small>
              <b>{prev.title}</b>
            </Link>
          ) : <span />}
          {after ? (
            <Link className="pager-card next" to={`/level/${after.number}`}>
              <small>Level {after.number} <ArrowRight size={12} /></small>
              <b>{after.title}</b>
            </Link>
          ) : <span />}
        </div>
      </section>
    </div>
  );
}
