import { ArrowRight, BookOpen, Bot, Brain, Check, Database, Dumbbell, Hammer, Lightbulb, ListChecks, Network, Split, Smartphone, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { LEVELS, MODULES, PHASES, PROJECTS, TOTAL_SESSIONS, levelByNumber, levelOfModule, levelsInPhase } from "../curriculum";
import { useChatSource } from "../chat/store";
import { SIMS } from "../sims/sims-list";
import { FLOW, currentStep, dueCards, levelFraction, nextModule, projectFraction, projectStepCount, sessionsDone, streak, useProgress } from "../state/progress";
import { moduleHref } from "../ui/CourseLayout";

const STEP_LABEL = { read: "Read", relate: "Relate", build: "Build", check: "Check" } as const;

/** A tiny animated pipeline: the product in one picture (a request, routed, retrieved, answered). */
function HeroDiagram() {
  const wires = [
    "M86,130 C120,130 120,130 150,130",
    "M206,130 C236,130 236,70 270,70",
    "M206,130 C236,130 236,190 270,190",
    "M326,70 C356,70 356,100 390,112",
    "M326,190 C356,190 356,160 390,148",
  ];
  const nodes: { x: number; y: number; icon: LucideIcon; label: string; kind: string; util?: number }[] = [
    { x: 30, y: 104, icon: Smartphone, label: "User", kind: "var(--muted)" },
    { x: 150, y: 104, icon: Split, label: "Router", kind: "var(--ai)" },
    { x: 270, y: 44, icon: Database, label: "Retriever", kind: "var(--info)", util: 0.46 },
    { x: 270, y: 164, icon: Bot, label: "Agent", kind: "var(--accent)", util: 0.52 },
    { x: 390, y: 104, icon: Brain, label: "LLM", kind: "var(--hot)", util: 0.81 },
  ];
  return (
    <div className="hero-visual" aria-hidden>
      <svg viewBox="0 0 470 260" className="hero-svg">
        {wires.map((d, i) => (
          <g key={i}>
            <path d={d} className="hero-wire" />
            {[0, 1, 2].map((k) => (
              <circle key={k} r="3" className="hero-dot">
                <animateMotion dur="1.8s" repeatCount="indefinite" begin={`${-k * 0.6 - i * 0.2}s`} path={d} />
              </circle>
            ))}
          </g>
        ))}
      </svg>
      {nodes.map((n, i) => (
        <div key={i} className="hero-node" style={{ left: `${(n.x / 470) * 100}%`, top: `${(n.y / 340) * 100}%` }}>
          <span className="kind-icon" style={{ "--kind": n.kind } as React.CSSProperties}>
            <n.icon size={14} />
          </span>
          <span>{n.label}</span>
          {n.util !== undefined && (
            <i className="hero-util">
              <b style={{ width: `${n.util * 100}%`, background: n.util > 0.8 ? "var(--warm)" : "var(--good)" }} />
            </i>
          )}
        </div>
      ))}
      <div className="hero-metrics">
        <span><small>Grounded</small><b className="good">96.4%</b></span>
        <span><small>p95</small><b>1.8 s</b></span>
        <span><small>Cost</small><b>$0.012/req</b></span>
      </div>
    </div>
  );
}

const ENTRIES = [
  { to: "/learn", icon: BookOpen, title: "Follow the path", text: "Seventeen levels in the order a working AI engineer needs them." },
  { to: "/projects", icon: Hammer, title: "Build a project", text: "Guided builds with complete code and every important line explained." },
  { to: "/studio", icon: Network, title: "Open the Studio", text: "Drag agents, retrievers and GPUs onto a canvas, then simulate real traffic." },
  { to: "/practice", icon: Dumbbell, title: "Practise", text: "Flashcards, interview questions and simulators for what you just learned." },
];

const HOW = [
  { icon: BookOpen, title: "Read", text: "A short lesson with worked examples." },
  { icon: Lightbulb, title: "Relate", text: "The same idea in an everyday situation." },
  { icon: Hammer, title: "Build", text: "Implement it step by step, with starter code." },
  { icon: ListChecks, title: "Check", text: "Answer without notes. Misses come back later." },
];

export function Home() {
  const p = useProgress();
  const started = p.onboarded || Object.keys(p.modules).length > 0 || Object.keys(p.flow).length > 0;
  const next = nextModule(p);
  const level = next ? levelOfModule(next.id) : undefined;
  const step = next ? currentStep(p, next) : "read";
  const due = dueCards(p).length;
  const st = streak(p.days);
  const active = PROJECTS.find((pr) => {
    const f = projectFraction(p, pr.id);
    return f > 0 && f < 1;
  });
  useChatSource("home", {
    label: "Home",
    suggestions: ["I'm a backend developer. Where should I start?", "What does an AI engineer do day to day?", "How long will this path take at an hour a day?"],
    build: () => ({ page: "Home", startLevel: p.startLevel, sessionsDone: sessionsDone(p), totalSessions: TOTAL_SESSIONS, next: nextModule(p)?.id }),
  });

  return (
    <div className="page home">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Open source · runs in your browser · no account</p>
          <h1>
            Learn AI engineering by <em>building</em> it.
          </h1>
          <p className="lead">From writing software to shipping AI systems in production. Seventeen levels, and every module ends with something you build yourself.</p>
          <div className="row gap">
            <Link className="btn primary big" to={started && next ? (next.projectId ? moduleHref(next) : `/learn/${next.id}/${step}`) : "/learn"} onClick={() => { if (!started) p.finishOnboarding(0); }}>
              {started ? "Continue learning" : "Start learning"} <ArrowRight size={18} />
            </Link>
            <Link className="btn big" to="/studio">Open the Studio</Link>
          </div>
          <p className="hero-stats">
            <span><b>{LEVELS.length}</b> levels</span>
            <span><b>{MODULES.length}</b> modules</span>
            <span><b>{PROJECTS.length}</b> projects</span>
            <span><b>{SIMS.length}</b> simulations</span>
          </p>
        </div>
        <HeroDiagram />
      </section>

      {started && (
        <section className="resume">
          <h2 className="section-title">Pick up where you left off{st > 0 ? ` · ${st}-day streak` : ""}</h2>
          <div className="resume-row">
            {next && level && (
              <Link to={next.projectId ? moduleHref(next) : `/learn/${next.id}/${step}`} className="resume-card">
                <span className="resume-icon"><BookOpen size={18} /></span>
                <span className="grow">
                  <small>Level {level.number} · Module {next.id} · {STEP_LABEL[step]}</small>
                  <b>{next.title}</b>
                  <ol className="mini-steps" aria-label="Steps in this module">
                    {FLOW.map((f) => (
                      <li key={f} className={`${p.flow[`${next.id}:${f}`] ? "done" : ""}${f === step ? " current" : ""}`}>
                        <span>{p.flow[`${next.id}:${f}`] ? <Check size={10} strokeWidth={3} /> : null}</span>
                        {STEP_LABEL[f]}
                      </li>
                    ))}
                  </ol>
                </span>
                <ArrowRight size={18} className="muted" />
              </Link>
            )}
            <Link to="/practice" className="resume-card">
              <span className="resume-icon"><Dumbbell size={18} /></span>
              <span className="grow">
                <small>Review</small>
                <b>{due > 0 ? `${due} card${due === 1 ? "" : "s"} to review` : "Review is clear"}</b>
                <small>{due > 0 ? "Five minutes of recall beats an hour of re-reading." : "New cards appear as you finish levels."}</small>
              </span>
              <ArrowRight size={18} className="muted" />
            </Link>
            {active && (
              <Link to={`/project/${active.id}`} className="resume-card">
                <span className="resume-icon"><Hammer size={18} /></span>
                <span className="grow">
                  <small>Project · step {Math.round(projectFraction(p, active.id) * projectStepCount(active.id)) + 1} of {projectStepCount(active.id)}</small>
                  <b>{active.title}</b>
                  <span className="meter"><span style={{ width: `${projectFraction(p, active.id) * 100}%` }} /></span>
                </span>
                <ArrowRight size={18} className="muted" />
              </Link>
            )}
          </div>
        </section>
      )}

      <section>
        <h2 className="section-title">Four ways in</h2>
        <div className="entry-grid">
          {ENTRIES.map(({ to, icon: Icon, title, text }) => (
            <Link key={to} to={to} className="card entry">
              <span className="entry-icon"><Icon size={20} /></span>
              <h3>{title}</h3>
              <p>{text}</p>
              <span className="entry-go">Open <ArrowRight size={14} /></span>
            </Link>
          ))}
        </div>
      </section>

      <section className="how">
        <h2 className="section-title">How every module works</h2>
        <div className="how-grid">
          {HOW.map(({ icon: Icon, title, text }, i) => (
            <div key={title} className="how-step">
              <span className="how-num">{i + 1}</span>
              <Icon size={18} className="how-icon" />
              <b>{title}</b>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      {started ? <PathOverview /> : <Finder />}
    </div>
  );
}

/* ---------- first visit: where should you start? ---------- */
const QUESTIONS = [
  { q: "Have you built and deployed a web API or backend service?", yes: 1 },
  { q: "Have you called an LLM API (OpenAI, Anthropic, Gemini…) from your own code?", yes: 3 },
  { q: "Have you built a RAG system that answers from your own documents?", yes: 5 },
];

function Finder() {
  const p = useProgress();
  const [answers, setAnswers] = useState<(boolean | null)[]>([null, null, null]);
  const answered = answers.every((a) => a !== null);
  // the furthest "yes" in order decides the start; a "no" stops the climb
  let start = 0;
  for (let i = 0; i < QUESTIONS.length; i++) {
    if (answers[i]) start = QUESTIONS[i].yes;
    else break;
  }
  const lvl = levelByNumber(start)!;
  return (
    <section className="finder">
      <h2 className="section-title">Where should you start?</h2>
      <p className="muted small">Three questions. You can change this any time.</p>
      <ol className="finder-qs">
        {QUESTIONS.map((q, i) => (
          <li key={i} className={i > 0 && answers[i - 1] === false ? "dim" : ""}>
            <span>{q.q}</span>
            <div className="yesno" role="group" aria-label={q.q}>
              <button className={answers[i] === true ? "on" : ""} onClick={() => setAnswers(answers.map((a, j) => (j === i ? true : a)))}>Yes</button>
              <button className={answers[i] === false ? "on" : ""} onClick={() => setAnswers(answers.map((a, j) => (j === i ? false : j > i ? false : a)))}>Not yet</button>
            </div>
          </li>
        ))}
      </ol>
      {(answered || answers.includes(false)) && (
        <div className="finder-result">
          <div>
            <span className="muted small">Start at</span>
            <b>Level {start} · {lvl.title}</b>
            <span className="muted small">{lvl.summary}</span>
          </div>
          <Link className="btn primary big" to={moduleHref(lvl.modules[0])} onClick={() => p.finishOnboarding(start)}>
            Start Level {start} <ArrowRight size={17} />
          </Link>
        </div>
      )}
      <p className="finder-skip">
        <Link to="/learn" onClick={() => p.finishOnboarding(0)}>Just show me the whole path</Link>
      </p>
    </section>
  );
}

/* ---------- returning learner: progress by phase ---------- */
function PathOverview() {
  const p = useProgress();
  return (
    <section className="path-overview">
      <div className="row between">
        <h2 className="section-title" style={{ margin: 0 }}>Your path</h2>
        <Link to="/learn" className="small">Open the full path <ArrowRight size={13} /></Link>
      </div>
      <div className="phase-bars">
        {PHASES.map((ph) => {
          const ls = levelsInPhase(ph.id);
          const f = ls.reduce((s, l) => s + levelFraction(p, l), 0) / ls.length;
          return (
            <Link key={ph.id} to={`/level/${ls[0].number}`} className="phase-bar" style={{ "--ph": `var(--ph-${ph.id})` } as React.CSSProperties}>
              <span className="phase-bar-name"><i />{ph.title}</span>
              <span className="phase-bar-track"><span style={{ width: `${f * 100}%` }} /></span>
              <span className="phase-bar-levels">L{ls[0].number}{ls.length > 1 ? `–${ls[ls.length - 1].number}` : ""}</span>
            </Link>
          );
        })}
      </div>
      <p className="muted small">
        {sessionsDone(p)} of {TOTAL_SESSIONS} sessions · {LEVELS.length} levels · starting from Level {p.startLevel}. <Link to="/progress">Change</Link>
      </p>
    </section>
  );
}
