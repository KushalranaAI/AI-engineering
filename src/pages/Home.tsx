import { motion } from "motion/react";
import { ArrowRight, BookOpen, Check, Dumbbell, Hammer, Lightbulb, ListChecks, Network } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { LEVELS, PHASES, PROJECTS, TOTAL_SESSIONS, levelByNumber, levelOfModule, levelsInPhase, practiceFor } from "../curriculum";
import { guideFor } from "../curriculum/guides";
import { lessonFor } from "../curriculum/lessons";
import { useChatSource } from "../chat/store";
import { JOURNEYS } from "../studio/journeys";
import { FLOW, currentStep, dueCards, levelFraction, nextModule, projectFraction, projectStepCount, sessionsDone, streak, today, useProgress } from "../state/progress";
import { moduleHref } from "../ui/CourseLayout";

const STEP_LABEL = { read: "Read", relate: "Relate", build: "Build", check: "Check" } as const;

export function Home() {
  const p = useProgress();
  const started = p.onboarded || Object.keys(p.modules).length > 0 || Object.keys(p.flow).length > 0;
  useChatSource("home", {
    label: "Home",
    suggestions: ["I'm a backend developer. Where should I start?", "What does an AI engineer do day to day?", "How long will this path take at an hour a day?"],
    build: () => ({ page: "Home", startLevel: p.startLevel, sessionsDone: sessionsDone(p), totalSessions: TOTAL_SESSIONS, next: nextModule(p)?.id }),
  });
  return started ? <Today /> : <Welcome />;
}

/* ---------- first visit ---------- */
const QUESTIONS = [
  { q: "Have you built and deployed a web API or backend service?", yes: 1 },
  { q: "Have you called an LLM API (OpenAI, Anthropic, Gemini…) from your own code?", yes: 3 },
  { q: "Have you built a RAG system that answers from your own documents?", yes: 5 },
];

function Welcome() {
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
    <div className="page welcome">
      <section className="welcome-hero">
        <h1>Learn AI engineering by building it.</h1>
        <p className="lead">A self-paced path from writing software to shipping AI systems in production. Seventeen levels, each a few short modules. Every module ends with something you build yourself.</p>
      </section>

      <section className="loop" aria-label="How every module works">
        {[
          { icon: BookOpen, t: "Read", d: "A short lesson with worked examples." },
          { icon: Lightbulb, t: "Relate", d: "The same idea in an everyday situation." },
          { icon: Hammer, t: "Build", d: "Implement it, step by step, with starter code." },
          { icon: ListChecks, t: "Check", d: "Answer questions without notes. Misses come back later." },
        ].map((s, i) => (
          <div key={s.t} className="loop-step">
            <span className="loop-num">{i + 1}</span>
            <s.icon size={18} aria-hidden />
            <b>{s.t}</b>
            <span>{s.d}</span>
          </div>
        ))}
      </section>

      <section className="finder">
        <h2>Where should you start?</h2>
        <p className="muted">Three questions. You can change this any time.</p>
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
          <motion.div className="finder-result" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
            <div>
              <span className="muted small">Start at</span>
              <b>Level {start} · {lvl.title}</b>
              <span className="muted small">{lvl.summary}</span>
            </div>
            <Link className="btn primary big" to={moduleHref(lvl.modules[0])} onClick={() => p.finishOnboarding(start)}>
              Start Level {start} <ArrowRight size={17} />
            </Link>
          </motion.div>
        )}
        <p className="finder-skip">
          <Link to="/learn" onClick={() => p.finishOnboarding(0)}>Just show me the whole path</Link>
        </p>
      </section>
    </div>
  );
}

/* ---------- returning learner ---------- */
function Today() {
  const p = useProgress();
  const next = nextModule(p);
  const level = next ? levelOfModule(next.id) : undefined;
  const step = next ? currentStep(p, next) : "read";
  const due = dueCards(p).length;
  const st = streak(p.days);
  const doneToday = p.days[today()] ?? 0;
  const active = PROJECTS.find((pr) => {
    const f = projectFraction(p, pr.id);
    return f > 0 && f < 1;
  });
  const lesson = next ? lessonFor(next.id) : undefined;
  const practice = next ? practiceFor(next.id) : undefined;
  const journey = level && level.number >= 4 && level.number <= 6 ? JOURNEYS[level.number === 4 ? 0 : 1] : level && level.number >= 9 && level.number <= 12 ? JOURNEYS[level.number === 12 ? 2 : 0] : undefined;
  const hour = new Date().getHours();

  return (
    <div className="page today">
      <header className="today-head">
        <h1>{hour < 12 ? "Good morning." : hour < 18 ? "Good afternoon." : "Good evening."}</h1>
        <p className="muted">
          {st > 0 ? `${st}-day streak. ` : ""}
          {doneToday > 0 ? "You've already studied today: keep going or come back tomorrow." : "One focused session today keeps the streak alive."}
        </p>
      </header>

      {next && level ? (
        <section className="continue">
          <div className="continue-main">
            <span className="continue-where">Level {level.number} · {level.title} · Module {next.id}</span>
            <h2>{next.title}</h2>
            <p>{next.outcome}</p>
            <ol className="mini-steps" aria-label="Steps in this module">
              {FLOW.map((f) => (
                <li key={f} className={`${p.flow[`${next.id}:${f}`] ? "done" : ""}${f === step ? " current" : ""}`}>
                  <span>{p.flow[`${next.id}:${f}`] ? <Check size={11} strokeWidth={3} /> : null}</span>
                  {STEP_LABEL[f]}
                </li>
              ))}
            </ol>
            <Link className="btn primary big" to={next.projectId ? moduleHref(next) : `/learn/${next.id}/${step}`}>
              {next.projectId ? "Continue the project" : `${step === "read" && !p.flow[`${next.id}:read`] ? "Start" : "Continue"}: ${STEP_LABEL[step]}`} <ArrowRight size={17} />
            </Link>
          </div>
          <dl className="continue-facts">
            {lesson && <div><dt>Lesson</dt><dd>{lesson.minutes} min read</dd></div>}
            {practice && <div><dt>Build</dt><dd>{practice.build.title} · {practice.build.minutes} min</dd></div>}
            <div><dt>This level</dt><dd>{Math.round(levelFraction(p, level) * 100)}% done</dd></div>
          </dl>
        </section>
      ) : (
        <section className="continue"><div className="continue-main"><h2>You finished every module.</h2><p>Now ship your projects and run mock interviews.</p></div></section>
      )}

      <section className="today-grid">
        <Link to="/practice" className="tile">
          <Dumbbell size={18} aria-hidden />
          <b>{due > 0 ? `${due} card${due === 1 ? "" : "s"} to review` : "Review is clear"}</b>
          <span>{due > 0 ? "Five minutes of recall beats an hour of re-reading." : "New cards appear as you finish levels."}</span>
        </Link>
        {active ? (
          <Link to={`/project/${active.id}`} className="tile">
            <Hammer size={18} aria-hidden />
            <b>{active.title}</b>
            <span>Step {Math.round(projectFraction(p, active.id) * projectStepCount(active.id)) + 1} of {projectStepCount(active.id)}{guideFor(active.id) ? " · full build guide" : ""}</span>
          </Link>
        ) : (
          <Link to="/projects" className="tile">
            <Hammer size={18} aria-hidden />
            <b>Pick a project</b>
            <span>{PROJECTS.length} guided builds with code you can copy and run.</span>
          </Link>
        )}
        <Link to={journey ? `/studio/j/${journey.id}/1` : "/studio"} className="tile">
          <Network size={18} aria-hidden />
          <b>{journey ? journey.title : "Agent Studio"}</b>
          <span>Design it on a canvas, then simulate cost, latency, failures and GPUs.</span>
        </Link>
      </section>

      <section className="path-overview">
        <div className="row between">
          <h2>Your path</h2>
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
          {sessionsDone(p)} of {TOTAL_SESSIONS} sessions · {LEVELS.length} levels · starting from Level {p.startLevel}.{" "}
          <Link to="/progress">Change</Link>
        </p>
      </section>
    </div>
  );
}
