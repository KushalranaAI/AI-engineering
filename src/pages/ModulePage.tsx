import confetti from "canvas-confetti";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, ArrowRight, BookOpen, Check, Clock, Eye, FlaskConical, Hammer, Lightbulb, ListChecks, Network, NotebookPen, RotateCcw, Sparkles, Target, X } from "lucide-react";
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { MODULES, levelOfModule, moduleById, practiceFor, type Module, type Practice } from "../curriculum";
import { lessonFor, splitChecks } from "../curriculum/lessons";
import { useChatSource } from "../chat/store";
import { simById } from "../sims";
import { stagesForModule } from "../studio/journeys";
import { FLOW, currentStep, useProgress, type FlowStep } from "../state/progress";
import { AskButton } from "../ui/bits";
import { CodeBlock } from "../ui/CodeBlock";
import { CourseLayout, moduleHref } from "../ui/CourseLayout";
import { Markdown } from "../ui/Markdown";

const STEP_META: Record<FlowStep, { label: string; verb: string; icon: typeof BookOpen; hint: string }> = {
  read: { label: "Read", verb: "Read the lesson", icon: BookOpen, hint: "Understand the idea" },
  relate: { label: "Relate", verb: "See it in real life", icon: Lightbulb, hint: "Connect it to something you know" },
  build: { label: "Build", verb: "Build it", icon: Hammer, hint: "Implement it yourself" },
  check: { label: "Check", verb: "Check yourself", icon: ListChecks, hint: "Prove you've got it" },
};

export function ModulePage() {
  const { id = "", step } = useParams();
  const m = moduleById(id);
  if (!m)
    return (
      <div className="page narrow">
        <div className="empty-state">
          <h1>Module not found</h1>
          <Link className="btn" to="/learn"><ArrowLeft size={16} /> Back to the path</Link>
        </div>
      </div>
    );
  if (m.projectId) return <Navigate to={`/project/${m.projectId}`} replace />;
  const level = levelOfModule(m.id);
  return (
    <CourseLayout level={level.number} moduleId={m.id}>
      <ModuleFlow key={m.id} m={m} step={(FLOW as readonly string[]).includes(step ?? "") ? (step as FlowStep) : undefined} />
    </CourseLayout>
  );
}

function ModuleFlow({ m, step: urlStep }: { m: Module; step?: FlowStep }) {
  const p = useProgress();
  const navigate = useNavigate();
  const level = levelOfModule(m.id);
  const lesson = lessonFor(m.id);
  const practice = practiceFor(m.id);
  const { main, checks } = lesson ? splitChecks(lesson.body) : { main: "", checks: [] };
  const step = urlStep ?? currentStep(p, m);
  const idx = FLOW.indexOf(step);
  const done = !!p.modules[m.id];
  const mIdx = MODULES.indexOf(m);
  const nextMod = MODULES[mIdx + 1];
  const scroller = useRef<HTMLDivElement>(null);
  const [celebrate, setCelebrate] = useState(false);

  useEffect(() => {
    scroller.current?.closest(".course-main")?.scrollTo({ top: 0 });
  }, [step, m.id]);

  const go = (s: FlowStep) => navigate(`/learn/${m.id}/${s}`);
  const advance = () => {
    p.setFlow(m.id, step, true);
    if (idx < FLOW.length - 1) go(FLOW[idx + 1]);
    else finish();
  };
  const finish = () => {
    p.setFlow(m.id, "check", true);
    p.setModuleDone(m.id, true);
    setCelebrate(true);
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) confetti({ particleCount: 90, spread: 70, origin: { y: 0.8 }, disableForReducedMotion: true, colors: ["#2457f5", "#16a34a", "#f59e0b", "#e11d48"] });
  };

  useChatSource("lesson", {
    label: `Module ${m.id} · ${m.title} · ${STEP_META[step].label}`,
    suggestions:
      step === "build"
        ? ["Give me a hint for the step I'm stuck on (don't solve it)", "Explain the starter code line by line", "Review my approach before I start"]
        : step === "relate"
          ? ["Give me another everyday example of this", "Where does this analogy break down?", "Explain it like I'm a backend engineer"]
          : step === "check"
            ? ["Quiz me with 3 harder questions, one at a time", "What's the most common mistake with this in production?"]
            : ["Explain the hardest idea here with a different example", "Show me a minimal Python example", "Summarise this in 5 bullets"],
    build: () => ({
      level: `L${level.number} ${level.title}`,
      module: `${m.id} ${m.title}`,
      currentStep: step,
      outcome: m.outcome,
      topics: m.topics.map((t) => t.title),
      lessonText: main.slice(0, 12000),
      realLife: practice?.realLife,
      buildTask: practice?.build && { ...practice.build, stepsDone: practice.build.steps.map((_, i) => !!p.builds[`${m.id}:${i}`]) },
      learnerNotes: p.notes[m.id]?.slice(0, 3000),
    }),
  });

  return (
    <div className="flow" ref={scroller}>
      <header className="flow-head">
        <nav className="crumbs">
          <Link to={`/level/${level.number}`}>Level {level.number} · {level.title}</Link>
          <span>/</span>
          <span>Module {m.id}</span>
        </nav>
        <h1>{m.title}</h1>
        <p className="flow-outcome"><Target size={15} aria-hidden /> {m.outcome}</p>
        <ol className="stepper" aria-label="Module steps">
          {FLOW.map((s, i) => {
            const Icon = STEP_META[s].icon;
            const isDone = !!p.flow[`${m.id}:${s}`];
            return (
              <li key={s}>
                <button className={`stepper-item${s === step ? " current" : ""}${isDone ? " done" : ""}`} onClick={() => go(s)} aria-current={s === step ? "step" : undefined}>
                  <span className="stepper-num">{isDone ? <Check size={13} strokeWidth={3} /> : <Icon size={14} />}</span>
                  <span className="stepper-text">
                    <b>{i + 1}. {STEP_META[s].label}</b>
                    <small>{STEP_META[s].hint}</small>
                  </span>
                  {s === step && <motion.span layoutId="stepper-bar" className="stepper-bar" />}
                </button>
              </li>
            );
          })}
        </ol>
      </header>

      {/* keyed so each step fades in; no exit animation, so a step can never get stuck invisible waiting for one to finish */}
      <motion.section key={step} className="flow-body" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }}>
        {step === "read" && <ReadStep m={m} lessonBody={main} minutes={lesson?.minutes} />}
        {step === "relate" && <RelateStep m={m} practice={practice} />}
        {step === "build" && <BuildStep m={m} practice={practice} />}
        {step === "check" && <CheckStep m={m} checks={checks} />}
      </motion.section>

      <div className="flow-bar">
        <div className="flow-bar-inner">
          {idx > 0 ? (
            <button className="btn ghost" onClick={() => go(FLOW[idx - 1])}><ArrowLeft size={16} /> {STEP_META[FLOW[idx - 1]].label}</button>
          ) : (
            <span />
          )}
          <span className="flow-bar-where">Step {idx + 1} of 4 · {STEP_META[step].verb}</span>
          {idx < FLOW.length - 1 ? (
            <button className="btn primary" onClick={advance}>
              Next: {STEP_META[FLOW[idx + 1]].label} <ArrowRight size={16} />
            </button>
          ) : done ? (
            nextMod ? <Link className="btn primary" to={moduleHref(nextMod)}>Next module <ArrowRight size={16} /></Link> : <Link className="btn primary" to="/progress">See your progress</Link>
          ) : (
            <button className="btn primary" onClick={advance}><Check size={16} /> Complete module</button>
          )}
        </div>
      </div>

      <AnimatePresence>
        {celebrate && (
          <motion.div className="done-sheet" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setCelebrate(false)}>
            <motion.div className="done-card" initial={{ y: 20, scale: 0.97 }} animate={{ y: 0, scale: 1 }} transition={{ type: "spring", stiffness: 320, damping: 26 }} onClick={(e) => e.stopPropagation()}>
              <span className="done-icon"><Check size={26} strokeWidth={3} /></span>
              <h2>Module {m.id} complete</h2>
              <p className="muted">{m.outcome}</p>
              {nextMod && (
                <div className="done-next">
                  <span className="muted small">Up next</span>
                  <b>{nextMod.title}</b>
                </div>
              )}
              <div className="row gap center">
                <button className="btn ghost" onClick={() => setCelebrate(false)}>Stay here</button>
                {nextMod && <Link className="btn primary" to={moduleHref(nextMod)}>Continue <ArrowRight size={16} /></Link>}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- 1. Read ---------- */
function ReadStep({ m, lessonBody, minutes }: { m: Module; lessonBody: string; minutes?: number }) {
  const p = useProgress();
  return (
    <>
      <div className="step-intro">
        <BookOpen size={18} aria-hidden />
        <div>
          <b>Read the lesson</b>
          <span>{minutes ? `About ${minutes} minutes. ` : ""}Do the "Try it" before opening its answer. Then tick what you can explain.</span>
        </div>
      </div>
      {lessonBody ? <Markdown className="lesson-prose">{lessonBody.replace(/^# .+\n+/, "")}</Markdown> : <p className="muted">The written lesson for this module isn't in yet. Use the topics below and ask the tutor to teach them.</p>}
      <section className="panel">
        <h3>Can you explain these without your notes?</h3>
        <ul className="checklist">
          {m.topics.map((t, i) => {
            const on = !!p.topics[`${m.id}:${i}`];
            return (
              <li key={i}>
                <label className={`check-row${on ? " on" : ""}`}>
                  <input type="checkbox" checked={on} onChange={() => p.toggleTopic(m.id, i)} />
                  <span><b>{t.title}</b><span>{t.detail}</span></span>
                </label>
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

/* ---------- 2. Relate ---------- */
function RelateStep({ m, practice }: { m: Module; practice?: Practice }) {
  if (!practice)
    return (
      <div className="step-intro">
        <Lightbulb size={18} aria-hidden />
        <div>
          <b>No everyday example written for this module yet</b>
          <span>Ask the tutor for one, then write it in your own words below.</span>
        </div>
      </div>
    );
  const rl = practice.realLife;
  return (
    <>
      <div className="step-intro">
        <Lightbulb size={18} aria-hidden />
        <div>
          <b>See it in real life</b>
          <span>The same mechanism, somewhere you already know it. Read the story, then check each line of the mapping.</span>
        </div>
      </div>
      <article className="story">
        <h2>{rl.title}</h2>
        <p>{rl.story}</p>
      </article>
      <div className="mapping" role="table" aria-label="How the story maps to the concept">
        <div className="mapping-head" role="row">
          <span role="columnheader">In everyday life</span>
          <span aria-hidden />
          <span role="columnheader">In {m.title.toLowerCase()}</span>
        </div>
        {rl.mapping.map((r, i) => (
          <motion.div key={i} className="mapping-row" role="row" initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.05 * i }}>
            <span role="cell">{r.everyday}</span>
            <ArrowRight size={14} aria-hidden />
            <span role="cell">{r.concept}</span>
          </motion.div>
        ))}
      </div>
      <NotesBox id={m.id} title="Explain it back" placeholder="In two or three sentences, explain the concept to a colleague using your own example. If you can't, re-read the part of the lesson that's fuzzy." />
      <AskButton question={`Here's my explanation of ${m.title}. Is it accurate? What's missing?`} label="Check my explanation with the tutor" />
    </>
  );
}

/* ---------- 3. Build ---------- */
const SimInline = lazy(async () => ({ default: (await import("../sims")).SimEmbed }));

function BuildStep({ m, practice }: { m: Module; practice?: Practice }) {
  const p = useProgress();
  const [showSim, setShowSim] = useState(true);
  if (!practice)
    return (
      <div className="step-intro">
        <Hammer size={18} aria-hidden />
        <div>
          <b>No build task written for this module yet</b>
          <span>Ask the tutor to design a 60-minute build that exercises the topics, then do it.</span>
        </div>
      </div>
    );
  const b = practice.build;
  const doneCount = b.steps.filter((_, i) => p.builds[`${m.id}:${i}`]).length;
  const sim = b.sim ? simById(b.sim) : undefined;
  return (
    <>
      <div className="step-intro">
        <Hammer size={18} aria-hidden />
        <div>
          <b>Build it</b>
          <span>Reading isn't learning. Implement this on your own machine, tick each step as you go, and check the result against the acceptance list.</span>
        </div>
      </div>
      <section className="build-card">
        <h2>{b.title}</h2>
        <p className="build-goal">{b.goal}</p>
        <dl className="facts">
          <div><dt><Clock size={14} /> Time</dt><dd>{b.minutes} min</dd></div>
          <div><dt>Stack</dt><dd>{b.stack.join(" · ")}</dd></div>
          <div><dt>Progress</dt><dd>{doneCount} of {b.steps.length} steps</dd></div>
        </dl>
      </section>

      <section className="panel">
        <h3>Steps</h3>
        <ol className="checklist numbered">
          {b.steps.map((s, i) => {
            const on = !!p.builds[`${m.id}:${i}`];
            return (
              <li key={i}>
                <label className={`check-row${on ? " on" : ""}`}>
                  <input type="checkbox" checked={on} onChange={() => p.toggleBuild(m.id, i)} />
                  <span className="step-n">{i + 1}</span>
                  <span><span>{s}</span></span>
                </label>
              </li>
            );
          })}
        </ol>
      </section>

      {b.starter && (
        <section>
          <h3 className="sub">Starter code</h3>
          <p className="muted small">A skeleton, not a solution. Fill in each TODO.</p>
          <CodeBlock code={b.starter} lang={/^\s*(\$|pip |npm |docker |curl |export )/m.test(b.starter) && !/def |import /.test(b.starter) ? "bash" : "python"} meta={`title="${b.stack.includes("Python") || /def |import /.test(b.starter) ? "starter.py" : "starter"}"`} />
        </section>
      )}

      {sim && (
        <section className="sim-slot">
          <div className="row between">
            <h3 className="sub"><FlaskConical size={16} /> Explore it before you code</h3>
            <button className="btn small ghost" onClick={() => setShowSim(!showSim)}>{showSim ? "Hide simulator" : "Show simulator"}</button>
          </div>
          {showSim && (
            <Suspense fallback={<div className="panel muted">Loading simulator…</div>}>
              <SimInline id={sim.id} />
            </Suspense>
          )}
        </section>
      )}
      {stagesForModule(m.id).slice(0, 2).map(({ journey, index, stage }) => (
        <Link key={journey.id + index} className="studio-link" to={`/studio/j/${journey.id}/${index + 1}`}>
          <Network size={18} aria-hidden />
          <span>
            <b>See it in the system: {stage.title}</b>
            <span>{journey.title}, stage {index + 1}. {stage.change}</span>
          </span>
          <ArrowRight size={16} />
        </Link>
      ))}
      {b.studio && !stagesForModule(m.id).length && (
        <Link className="studio-link" to={`/studio/${b.studio}`}>
          <Network size={18} aria-hidden />
          <span>
            <b>Sketch it in Agent Studio first</b>
            <span>Open a ready-made design of this system, change it, and simulate latency, cost and failures before you code.</span>
          </span>
          <ArrowRight size={16} />
        </Link>
      )}

      <section className="panel accept">
        <h3>You're done when</h3>
        <ul className="plain-checks">{b.checks.map((c) => <li key={c}><Check size={14} aria-hidden /> {c}</li>)}</ul>
        {b.stretch && <p className="small muted"><b>Stretch:</b> {b.stretch}</p>}
      </section>
      <NotesBox id={`${m.id}:build`} title="Build log" placeholder="What you built, what broke, numbers you measured, a link to your repo…" />
      <div className="row gap">
        <AskButton question="Give me a hint for the next unfinished build step. Don't solve it for me." label="Hint for my next step" />
        <AskButton question="Here's what I built (see my build log). Review it against the acceptance checks." label="Review my build" />
      </div>
    </>
  );
}

/* ---------- 4. Check ---------- */
function CheckStep({ m, checks }: { m: Module; checks: { q: string; a: string }[] }) {
  const p = useProgress();
  const [shown, setShown] = useState<Record<number, boolean>>({});
  const got = checks.filter((_, i) => p.checks[`${m.id}:${i}`] === true).length;
  return (
    <>
      <div className="step-intro">
        <ListChecks size={18} aria-hidden />
        <div>
          <b>Check yourself</b>
          <span>Answer each one out loud or on paper first, then reveal and grade yourself honestly. Misses go to your review list.</span>
        </div>
      </div>
      {checks.length === 0 && <p className="muted">No questions for this module yet. Ask the tutor to quiz you.</p>}
      <div className="quiz">
        {checks.map((c, i) => {
          const k = `${m.id}:${i}`;
          const grade = p.checks[k];
          const open = shown[i] || grade !== undefined;
          return (
            <div key={i} className={`quiz-q${grade === true ? " got" : grade === false ? " miss" : ""}`}>
              <div className="quiz-top">
                <span className="quiz-num">{i + 1}</span>
                <Markdown className="quiz-text">{c.q}</Markdown>
              </div>
              {open ? (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="quiz-a">
                  <Markdown>{c.a}</Markdown>
                  <div className="row gap">
                    <button className={`btn small${grade === true ? " done" : ""}`} onClick={() => p.gradeCheck(m.id, i, true)}><Check size={14} /> I had it</button>
                    <button className={`btn small${grade === false ? " warn" : ""}`} onClick={() => p.gradeCheck(m.id, i, false)}><X size={14} /> Review later</button>
                    {grade !== undefined && <button className="btn small ghost" onClick={() => (p.gradeCheck(m.id, i, null), setShown({ ...shown, [i]: false }))}><RotateCcw size={13} /> Reset</button>}
                  </div>
                </motion.div>
              ) : (
                <button className="btn small" onClick={() => setShown({ ...shown, [i]: true })}><Eye size={14} /> Reveal answer</button>
              )}
            </div>
          );
        })}
      </div>
      {checks.length > 0 && <p className="muted small">{got} of {checks.length} solid.</p>}
      <AskButton question={`Quiz me on module ${m.id} (${m.title}) with 3 harder, scenario-style questions. One at a time; wait for my answer.`} label="Harder questions from the tutor" className="btn" />
    </>
  );
}

/** notes saved per id, debounced */
export function NotesBox({ id, title = "Your notes", placeholder }: { id: string; title?: string; placeholder?: string }) {
  const saved = useProgress((s) => s.notes[id] ?? "");
  const setNote = useProgress((s) => s.setNote);
  const [text, setText] = useState(saved);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  useEffect(() => {
    if (text === saved) return;
    setState("saving");
    const t = setTimeout(() => (setNote(id, text), setState("saved")), 500);
    return () => clearTimeout(t);
  }, [text, saved, id, setNote]);
  return (
    <section className="notes">
      <label htmlFor={`note-${id}`} className="notes-label">
        <NotebookPen size={15} aria-hidden /> {title}
        <span className="notes-state">{state === "saving" ? "Saving…" : state === "saved" ? "Saved" : ""}</span>
      </label>
      <textarea id={`note-${id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} rows={4} />
    </section>
  );
}

export const SparklesIcon = Sparkles;
