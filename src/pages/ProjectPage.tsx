import confetti from "canvas-confetti";
import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Clock, Coins, ExternalLink, Hammer, Layers, Rocket } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LEVELS, PHASES, PROJECTS, levelByNumber, moduleOfProject, projectById } from "../curriculum";
import { guideFor, type Guide } from "../curriculum/guides";
import { useChatSource } from "../chat/store";
import { projectFraction, projectStepCount, projectsShipped, useProgress } from "../state/progress";
import { AskButton } from "../ui/bits";
import { CourseLayout } from "../ui/CourseLayout";
import { Markdown } from "../ui/Markdown";
import { NotesBox } from "./ModulePage";

export function ProjectPage() {
  const { id = "", step } = useParams();
  const proj = projectById(id);
  if (!proj)
    return (
      <div className="page narrow">
        <div className="empty-state">
          <h1>Project not found</h1>
          <Link className="btn" to="/projects"><ArrowLeft size={16} /> All projects</Link>
        </div>
      </div>
    );
  const mod = moduleOfProject(proj.id);
  return (
    <CourseLayout level={proj.level} moduleId={mod?.id}>
      <ProjectView key={proj.id} id={proj.id} step={step} />
    </CourseLayout>
  );
}

function ProjectView({ id, step }: { id: string; step?: string }) {
  const proj = projectById(id)!;
  const guide = guideFor(id);
  const level = levelByNumber(proj.level)!;
  const p = useProgress();
  const total = projectStepCount(id);
  const f = projectFraction(p, id);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.closest(".course-main")?.scrollTo({ top: 0 });
  }, [step]);

  const stepIdx = step && /^\d+$/.test(step) ? Number(step) - 1 : step === "ship" ? total : -1;
  useChatSource("project", {
    label: `Project · ${proj.title}${stepIdx >= 0 && stepIdx < total ? ` · step ${stepIdx + 1}` : ""}`,
    suggestions: stepIdx >= 0 && stepIdx < total ? ["Explain this step's code line by line", "My output doesn't match: what should I check first?", "Why is it done this way and not simpler?"] : ["How should I plan my time for this project?", "What will make this stand out in a portfolio?"],
    build: () => ({
      project: proj.title,
      level: `L${level.number} ${level.title}`,
      summary: proj.summary,
      deliverable: proj.deliverable,
      currentStep: guide && stepIdx >= 0 && stepIdx < total ? { title: guide.steps[stepIdx].title, goal: guide.steps[stepIdx].goal, text: guide.steps[stepIdx].body.slice(0, 12000) } : undefined,
      stepsDone: Array.from({ length: total }, (_, i) => !!p.steps[`${id}:${i}`]),
      learnerNotes: p.notes[id]?.slice(0, 3000),
    }),
  });

  return (
    <div className="project" ref={ref} style={{ "--ph": `var(--ph-${level.phase})` } as React.CSSProperties}>
      {guide && stepIdx >= 0 && stepIdx < total ? (
        <GuideStepView id={id} guide={guide} i={stepIdx} />
      ) : guide && stepIdx === total ? (
        <ShipView id={id} guide={guide} />
      ) : (
        <>
          <header className="project-head">
            <nav className="crumbs">
              <Link to="/projects">Build</Link>
              <span>/</span>
              <Link to={`/level/${level.number}`}>Level {level.number} · {level.title}</Link>
            </nav>
            <h1>{proj.title}</h1>
            <p className="lead">{proj.summary}</p>
            {guide && (
              <dl className="facts">
                {guide.hours && <div><dt><Clock size={14} /> Time</dt><dd>About {guide.hours} hours</dd></div>}
                {guide.stack && <div><dt><Layers size={14} /> Stack</dt><dd>{guide.stack}</dd></div>}
                {guide.cost && <div><dt><Coins size={14} /> Cost</dt><dd>{guide.cost}</dd></div>}
              </dl>
            )}
            <div className="level-actions">
              {guide ? (
                <Link className="btn primary big" to={`/project/${id}/${Math.min(total, Math.max(1, firstOpen(p.steps, id, total) + 1))}`}>
                  {f > 0 ? (f >= 1 ? "Review the steps" : `Continue: step ${firstOpen(p.steps, id, total) + 1}`) : "Start building"} <ArrowRight size={17} />
                </Link>
              ) : null}
              <span className="muted small">{Math.round(f * 100)}% · {Math.round(f * total)} of {total} steps</span>
            </div>
          </header>

          {guide ? (
            <>
              {guide.intro && <Markdown>{guide.intro}</Markdown>}
              {guide.sections.map((s) => (
                <section key={s.title} className="guide-section">
                  <h2>{s.title}</h2>
                  <Markdown>{s.body}</Markdown>
                </section>
              ))}
              <section className="guide-section">
                <h2>The build, step by step</h2>
                <ol className="guide-steps">
                  {guide.steps.map((s, i) => {
                    const on = !!p.steps[`${id}:${i}`];
                    return (
                      <li key={i}>
                        <Link to={`/project/${id}/${i + 1}`} className={`guide-step-row${on ? " done" : ""}`}>
                          <span className="mod-num">{on ? <Check size={14} strokeWidth={3} /> : i + 1}</span>
                          <span className="mod-body">
                            <span className="mod-title">{s.title}</span>
                            {s.goal && <span className="mod-out">{s.goal}</span>}
                          </span>
                          <ArrowRight size={16} aria-hidden />
                        </Link>
                      </li>
                    );
                  })}
                  <li>
                    <Link to={`/project/${id}/ship`} className="guide-step-row ship">
                      <span className="mod-num"><Rocket size={14} /></span>
                      <span className="mod-body"><span className="mod-title">Ship it</span><span className="mod-out">Publish it, write it up, and put the numbers in your portfolio.</span></span>
                      <ArrowRight size={16} aria-hidden />
                    </Link>
                  </li>
                </ol>
              </section>
            </>
          ) : (
            <BriefSteps id={id} />
          )}
          <section className="panel accept">
            <h3>You end with</h3>
            <p>{proj.deliverable}</p>
          </section>
          <RepoLink id={id} />
        </>
      )}
    </div>
  );
}

const firstOpen = (steps: Record<string, true>, id: string, total: number) => {
  for (let i = 0; i < total; i++) if (!steps[`${id}:${i}`]) return i;
  return total - 1;
};

/** one step of a code-level guide, on its own screen */
function GuideStepView({ id, guide, i }: { id: string; guide: Guide; i: number }) {
  const p = useProgress();
  const navigate = useNavigate();
  const s = guide.steps[i];
  const total = guide.steps.length;
  const done = !!p.steps[`${id}:${i}`];
  const finish = () => {
    p.setStep(id, i, true);
    if (i < total - 1) navigate(`/project/${id}/${i + 2}`);
    else navigate(`/project/${id}/ship`);
  };
  return (
    <>
      <header className="step-head">
        <nav className="crumbs">
          <Link to={`/project/${id}`}>{guide.title}</Link>
          <span>/</span>
          <span>Step {i + 1} of {total}</span>
        </nav>
        <div className="step-progress" aria-hidden>
          {guide.steps.map((_, j) => (
            <Link key={j} to={`/project/${id}/${j + 1}`} className={`sp-seg${j === i ? " current" : ""}${p.steps[`${id}:${j}`] ? " done" : ""}`} title={guide.steps[j].title} />
          ))}
        </div>
        <h1>{s.title}</h1>
        {s.goal && <p className="step-goal"><b>Goal:</b> {s.goal}</p>}
      </header>
      <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
        <Markdown className="guide-prose">{s.body}</Markdown>
      </motion.div>
      <section className="panel ran-it">
        <label className={`check-row big${done ? " on" : ""}`}>
          <input type="checkbox" checked={done} onChange={() => p.setStep(id, i, !done)} />
          <span><b>I ran it and saw the expected output</b><span>Don't tick this until it actually works on your machine.</span></span>
        </label>
        <div className="row gap">
          <AskButton question="My output doesn't match the expected output for this step. Ask me what I see, then help me debug it." label="It doesn't work: help me debug" />
          <AskButton question="Explain the code in this step line by line, and why each decision was made." label="Explain this code" />
        </div>
      </section>
      <NotesBox id={`${id}:step${i}`} title="Notes for this step" placeholder="Errors you hit and how you fixed them, numbers you measured, things to revisit…" />
      <div className="flow-bar">
        <div className="flow-bar-inner">
          {i > 0 ? <Link className="btn ghost" to={`/project/${id}/${i}`}><ArrowLeft size={16} /> Step {i}</Link> : <Link className="btn ghost" to={`/project/${id}`}><ArrowLeft size={16} /> Overview</Link>}
          <span className="flow-bar-where">Step {i + 1} of {total} · {s.title}</span>
          <button className="btn primary" onClick={finish}>
            {done ? "Next" : "Done"}: {i < total - 1 ? `step ${i + 2}` : "ship it"} <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </>
  );
}

function ShipView({ id, guide }: { id: string; guide: Guide }) {
  const p = useProgress();
  const f = projectFraction(p, id);
  useEffect(() => {
    if (f >= 1 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) confetti({ particleCount: 120, spread: 80, origin: { y: 0.7 }, disableForReducedMotion: true });
  }, [f]);
  return (
    <>
      <header className="step-head">
        <nav className="crumbs">
          <Link to={`/project/${id}`}>{guide.title}</Link>
          <span>/</span>
          <span>Ship it</span>
        </nav>
        <h1>{f >= 1 ? "You built it. Now ship it." : "Ship it"}</h1>
        {f < 1 && <p className="level-warn">{Math.round(f * guide.steps.length)} of {guide.steps.length} steps are ticked. Finish those first, or go back and tick the ones you've done.</p>}
      </header>
      {guide.ship && <Markdown className="guide-prose">{guide.ship}</Markdown>}
      <RepoLink id={id} />
      {guide.further && (
        <section className="guide-section">
          <h2>Going further</h2>
          <Markdown>{guide.further}</Markdown>
        </section>
      )}
      <div className="row gap">
        <Link className="btn" to={`/project/${id}`}><ArrowLeft size={15} /> Overview</Link>
        <Link className="btn primary" to="/projects">All projects <ArrowRight size={15} /></Link>
      </div>
    </>
  );
}

function RepoLink({ id }: { id: string }) {
  const p = useProgress();
  const link = p.links[id] ?? "";
  const safe = /^https?:\/\//i.test(link) ? link : "";
  return (
    <section className="panel">
      <h3>Your repo or demo</h3>
      <div className="row gap nowrap">
        <input type="url" className="grow" placeholder="https://github.com/you/project" defaultValue={link} onBlur={(e) => p.setLink(id, e.target.value)} aria-label="Repository or demo link" />
        {safe && <a className="btn small" href={safe} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} /> Open</a>}
      </div>
    </section>
  );
}

/** projects without a written guide yet: the brief's steps as a checklist */
function BriefSteps({ id }: { id: string }) {
  const p = useProgress();
  const proj = projectById(id)!;
  return (
    <section className="panel">
      <h3>Steps</h3>
      <p className="muted small">The full code-level guide for this project is being written. Until then, work from the brief.</p>
      <ol className="checklist numbered">
        {proj.steps.map((s, i) => {
          const on = !!p.steps[`${id}:${i}`];
          return (
            <li key={i}>
              <label className={`check-row${on ? " on" : ""}`}>
                <input type="checkbox" checked={on} onChange={() => p.toggleStep(id, i)} />
                <span className="step-n">{i + 1}</span>
                <span><b>{s.title}</b><span>{s.detail}</span></span>
              </label>
            </li>
          );
        })}
      </ol>
      {proj.stretch?.length ? <p className="small muted"><b>Stretch:</b> {proj.stretch.join(" · ")}</p> : null}
    </section>
  );
}

export function ProjectsPage() {
  const p = useProgress();
  useChatSource("projects", {
    label: "Projects",
    suggestions: ["Which 3 projects make the strongest portfolio?", "Which project should I start with?"],
    build: () => ({ projects: PROJECTS.map((pr) => ({ level: pr.level, title: pr.title, summary: pr.summary, progress: `${Math.round(projectFraction(p, pr.id) * 100)}%` })) }),
  });
  return (
    <div className="page projects">
      <header className="learn-head">
        <div>
          <h1>Build</h1>
          <p className="lead">Every project on the path, in order. Each one is a step-by-step build with complete code to copy, an explanation of every important line, and the output you should see.</p>
        </div>
        <div className="learn-progress">
          <span className="muted small">{projectsShipped(p)} of {PROJECTS.length} shipped</span>
        </div>
      </header>
      {PHASES.map((ph) => {
        const list = PROJECTS.filter((pr) => levelByNumber(pr.level)?.phase === ph.id);
        if (!list.length) return null;
        return (
          <section key={ph.id} className="proj-group" style={{ "--ph": `var(--ph-${ph.id})` } as React.CSSProperties}>
            <h2 className="proj-group-title"><i />{ph.title}</h2>
            <ol className="proj-list">
              {list.map((pr) => {
                const lvl = LEVELS.find((l) => l.number === pr.level)!;
                const g = guideFor(pr.id);
                const f = projectFraction(p, pr.id);
                return (
                  <li key={pr.id}>
                    <Link to={`/project/${pr.id}`} className={`proj-row${f >= 1 ? " done" : ""}`}>
                      <span className="mod-num">{f >= 1 ? <Check size={14} strokeWidth={3} /> : <Hammer size={14} />}</span>
                      <span className="mod-body">
                        <span className="mod-title">{pr.title}</span>
                        <span className="mod-out">{pr.summary}</span>
                        <span className="mod-meta">
                          Level {lvl.number} · {lvl.title}
                          {g ? ` · ${g.steps.length} guided steps${g.hours ? ` · ~${g.hours} h` : ""}` : ` · ${pr.steps.length} steps`}
                        </span>
                      </span>
                      <span className="mod-state">
                        {f > 0 && f < 1 && <span className="meter small-meter"><span style={{ width: `${f * 100}%` }} /></span>}
                        <ArrowRight size={16} aria-hidden />
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ol>
          </section>
        );
      })}
    </div>
  );
}
