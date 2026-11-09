import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check, Eye, FlaskConical, MessagesSquare, RotateCcw, Shuffle } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { FLASHCARDS, QUESTIONS, levelByNumber, type InterviewCluster } from "../curriculum";
import { useChatSource } from "../chat/store";
import { SIMS, SimEmbed, simById } from "../sims";
import { BOX_DAYS, dueCards, useProgress } from "../state/progress";
import { AskButton } from "../ui/bits";

type Tab = "review" | "interview" | "sims";
const TABS: { id: Tab; label: string }[] = [
  { id: "review", label: "Review" },
  { id: "interview", label: "Interview" },
  { id: "sims", label: "Simulators" },
];

export function PracticePage() {
  const { tab: t } = useParams();
  const tab: Tab = t === "interview" || t === "sims" ? t : "review";
  const navigate = useNavigate();
  const p = useProgress();
  const due = dueCards(p).length;
  return (
    <div className="page practice">
      <header className="learn-head">
        <div>
          <h1>Practice</h1>
          <p className="lead">Learning sticks when you pull it back out of memory. Review a few cards most days, rehearse interview answers out loud, and play with the simulators until the numbers feel obvious.</p>
        </div>
      </header>
      <div className="tabs" role="tablist" aria-label="Practice">
        {TABS.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={tab === x.id ? "on" : ""} onClick={() => navigate(x.id === "review" ? "/practice" : `/practice/${x.id}`)}>
            {x.label}
            {x.id === "review" && due > 0 && <span className="nav-badge">{due}</span>}
            {tab === x.id && <motion.span layoutId="tab-bar" className="tab-bar" />}
          </button>
        ))}
      </div>
      {tab === "review" && <Review />}
      {tab === "interview" && <Interview />}
      {tab === "sims" && <SimGrid />}
    </div>
  );
}

/* ---------- spaced repetition ---------- */
function Review() {
  const p = useProgress();
  const queue = useMemo(() => dueCards(p).sort((a, b) => (p.cards[a.id]?.box ?? -1) - (p.cards[b.id]?.box ?? -1) || a.level - b.level).slice(0, 30), [p.cards, p.modules, p.startLevel]); // eslint-disable-line react-hooks/exhaustive-deps
  const [flipped, setFlipped] = useState(false);
  const [done, setDone] = useState(0);
  const card = queue[0];
  useChatSource("review", {
    label: "Flashcard review",
    suggestions: ["Explain this card with an example", "Ask me a harder question about this"],
    build: () => ({ card: card ? { front: card.front, back: flipped ? card.back : "(hidden until the learner flips it)" } : null }),
  });
  const grade = (g: "again" | "good" | "easy") => {
    p.gradeCard(card.id, g);
    setFlipped(false);
    setDone(done + 1);
  };
  const learned = Object.values(p.cards).filter((c) => c.box >= 3).length;
  if (!card)
    return (
      <div className="review-empty">
        <Check size={28} aria-hidden />
        <h2>{done ? `Done: ${done} card${done === 1 ? "" : "s"} reviewed.` : "Nothing to review right now."}</h2>
        <p className="muted">Cards for a level show up once you reach it, and come back on a schedule: tomorrow, in 3 days, a week, two weeks, a month. {learned} of {FLASHCARDS.length} cards are well learned.</p>
        <Link className="btn" to="/learn">Back to the path</Link>
      </div>
    );
  const lvl = levelByNumber(card.level);
  const box = p.cards[card.id]?.box ?? 0;
  return (
    <div className="review">
      <div className="review-meta">
        <span>{queue.length} due{done ? ` · ${done} done this session` : ""}</span>
        <span>Level {card.level}{lvl ? ` · ${lvl.short}` : ""}</span>
      </div>
      <motion.button
        key={card.id + String(flipped)}
        className={`flashcard${flipped ? " back" : ""}`}
        onClick={() => setFlipped(!flipped)}
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.16 }}
        aria-label={flipped ? "Answer. Click to see the question" : "Question. Click to reveal the answer"}
      >
        <span className="fc-side">{flipped ? "Answer" : "Question"}</span>
        <span className="fc-text">{flipped ? card.back : card.front}</span>
        {!flipped && <span className="fc-hint"><Eye size={14} /> Answer in your head, then reveal</span>}
      </motion.button>
      {flipped ? (
        <div className="grade" role="group" aria-label="How well did you know it?">
          <button className="btn" onClick={() => grade("again")}><RotateCcw size={14} /> Again <small>today</small></button>
          <button className="btn" onClick={() => grade("good")}><Check size={14} /> Good <small>{BOX_DAYS[Math.min(5, box + 1)]}d</small></button>
          <button className="btn primary" onClick={() => grade("easy")}>Easy <small>{BOX_DAYS[Math.min(5, box + 2)]}d</small></button>
        </div>
      ) : (
        <div className="grade"><button className="btn primary" onClick={() => setFlipped(true)}><Eye size={14} /> Reveal</button></div>
      )}
    </div>
  );
}

/* ---------- interview bank ---------- */
const CLUSTER_LABEL: Record<InterviewCluster, string> = {
  fundamentals: "LLM fundamentals",
  prompting: "Prompting",
  rag: "RAG",
  agents: "Agents",
  evals: "Evals",
  security: "Security",
  "system-design": "System design",
  production: "Production",
  inference: "Inference",
  "fine-tuning": "Fine-tuning",
  multimodal: "Multimodal",
  behavioral: "Behavioural",
};

function Interview() {
  const p = useProgress();
  const [cluster, setCluster] = useState<InterviewCluster | "all">("all");
  const [diff, setDiff] = useState<0 | 1 | 2 | 3>(0);
  const [open, setOpen] = useState<string | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const clusters = [...new Set(QUESTIONS.map((q) => q.cluster))];
  let list = QUESTIONS.filter((q) => (cluster === "all" || q.cluster === cluster) && (!diff || q.difficulty === diff));
  if (order) list = [...list].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const practiced = QUESTIONS.filter((q) => p.practiced[q.id]).length;
  const sel = QUESTIONS.find((q) => q.id === open);
  useChatSource("interview", {
    label: "Interview practice",
    suggestions: sel ? ["Interview me on this question: ask it, wait for my answer, then score it against the strong answer", "Give me a model answer in 2 minutes of speech"] : ["Run a 20-minute mock round on RAG", "Which questions should I prioritise for a mid-level role?"],
    build: () => ({ question: sel ? { q: sel.q, strong: sel.strong, redFlags: sel.redFlags, followUps: sel.followUps } : null }),
  });
  return (
    <div className="interview">
      <p className="muted">
        Say your answer out loud (or write it) before opening what a strong answer covers. {practiced} of {QUESTIONS.length} practised.
      </p>
      <div className="filters">
        <div className="chips-row" role="group" aria-label="Topic">
          <button className={cluster === "all" ? "on" : ""} onClick={() => setCluster("all")}>All</button>
          {clusters.map((c) => <button key={c} className={cluster === c ? "on" : ""} onClick={() => setCluster(c)}>{CLUSTER_LABEL[c]}</button>)}
        </div>
        <div className="row gap">
          <div className="segmented small" role="group" aria-label="Difficulty">
            {(["Any", "Warm-up", "Core", "Senior"] as const).map((l, i) => <button key={l} className={diff === i ? "on" : ""} onClick={() => setDiff(i as 0 | 1 | 2 | 3)}>{l}</button>)}
          </div>
          <button className="btn small ghost" onClick={() => setOrder(QUESTIONS.map((q) => q.id).sort(() => Math.random() - 0.5))}><Shuffle size={14} /> Shuffle</button>
        </div>
      </div>
      <ol className="q-list">
        {list.map((q) => {
          const isOpen = open === q.id;
          return (
            <li key={q.id} className={`q-item${isOpen ? " open" : ""}${p.practiced[q.id] ? " done" : ""}`}>
              <button className="q-head" onClick={() => setOpen(isOpen ? null : q.id)} aria-expanded={isOpen}>
                <span className="q-dot" aria-hidden>{p.practiced[q.id] ? <Check size={11} strokeWidth={3} /> : null}</span>
                <span className="q-text">{q.q}</span>
                <span className="q-meta">{CLUSTER_LABEL[q.cluster]} · {["", "warm-up", "core", "senior"][q.difficulty]}</span>
              </button>
              {isOpen && (
                <motion.div className="q-body" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}>
                  <h4>A strong answer covers</h4>
                  <ul>{q.strong.map((s) => <li key={s}>{s}</li>)}</ul>
                  <h4>Answers that lose the room</h4>
                  <ul className="red">{q.redFlags.map((s) => <li key={s}>{s}</li>)}</ul>
                  <h4>Likely follow-ups</h4>
                  <ul>{q.followUps.map((s) => <li key={s}>{s}</li>)}</ul>
                  <div className="row gap">
                    <button className={`btn small${p.practiced[q.id] ? " done" : ""}`} onClick={() => p.togglePracticed(q.id)}><Check size={14} /> {p.practiced[q.id] ? "Practised" : "Mark practised"}</button>
                    <Link className="btn small ghost" to={`/level/${q.level}`}>Study it: Level {q.level}</Link>
                    <AskButton question="Interview me on this question. Ask it, wait for my answer, then score it against the strong-answer points and ask one follow-up." label="Mock it with the tutor" />
                  </div>
                </motion.div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ---------- simulators ---------- */
function SimGrid() {
  return (
    <div className="practice-sims">
      {SIMS.map((s) => (
        <Link key={s.id} to={`/sim/${s.id}`} className="sim-tile">
          <FlaskConical size={18} aria-hidden />
          <b>{s.title}</b>
          <span>{s.blurb}</span>
          <small className="muted">Level {s.levels.join(", ")}</small>
        </Link>
      ))}
      <Link to="/studio" className="sim-tile studio">
        <MessagesSquare size={18} aria-hidden />
        <b>Agent Studio</b>
        <span>Design whole AI systems on a canvas: agents, RAG, routers, guardrails, GPU pools. Simulate them or run them live.</span>
        <small className="muted">All levels</small>
      </Link>
    </div>
  );
}

export function SimPage() {
  const { id = "" } = useParams();
  const sim = simById(id);
  const idx = SIMS.findIndex((s) => s.id === id);
  useChatSource("sim", sim ? { label: `Simulator · ${sim.title}`, suggestions: ["What should I try first in this simulator?", "Explain what the chart is showing", "How does this show up in a real production system?"], build: () => ({ simulator: sim.title, blurb: sim.blurb, realLife: sim.realLife }) } : null);
  if (!sim)
    return (
      <div className="page narrow">
        <div className="empty-state"><h1>Simulator not found</h1><Link className="btn" to="/practice/sims"><ArrowLeft size={16} /> All simulators</Link></div>
      </div>
    );
  const prev = SIMS[idx - 1];
  const next = SIMS[idx + 1];
  return (
    <div className="page sim-page">
      <nav className="crumbs"><Link to="/practice/sims">Simulators</Link><span>/</span><span>{sim.title}</span></nav>
      <SimEmbed id={sim.id} />
      <div className="pager">
        {prev ? <Link className="pager-card" to={`/sim/${prev.id}`}><small><ArrowLeft size={12} /> Previous</small><b>{prev.title}</b></Link> : <span />}
        {next ? <Link className="pager-card next" to={`/sim/${next.id}`}><small>Next <ArrowRight size={12} /></small><b>{next.title}</b></Link> : <span />}
      </div>
    </div>
  );
}
