import { ArrowRight, BookOpen, CalendarDays, Check, Hammer, Play, Square } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { levelOfModule } from "../curriculum";
import { SPRINT_DAYS, SPRINT_STAGES, sprintPlan, type SprintDay } from "../curriculum/sprint";
import { useChatSource } from "../chat/store";
import { today, useProgress } from "../state/progress";
import { phaseStyle } from "../ui/bits";

const dayDiff = (from: string, to: string) => Math.round((Date.parse(to + "T00:00:00") - Date.parse(from + "T00:00:00")) / 86_400_000);

export function SprintPage() {
  const p = useProgress();
  const plan = useMemo(sprintPlan, []);
  const currentDay = p.sprintStart ? Math.min(SPRINT_DAYS, Math.max(1, dayDiff(p.sprintStart, today()) + 1)) : 1;
  const [selected, setSelected] = useState(currentDay);
  const [startDate, setStartDate] = useState(today());
  const dayDone = (d: SprintDay) => d.modules.length > 0 && d.modules.every((m) => p.modules[m.id]);
  const doneDays = plan.filter(dayDone).length;
  const firstOpen = plan.find((d) => !dayDone(d));
  const sel = plan[selected - 1];

  useChatSource("sprint", {
    label: p.sprintStart ? `100-day sprint · day ${currentDay}` : "100-day sprint",
    suggestions: ["I'm behind schedule. How do I catch up without skipping the important parts?", "What should I focus on today?", "Is 100 days realistic with a full-time job?"],
    build: () => ({
      started: p.sprintStart ?? null,
      calendarDay: p.sprintStart ? currentDay : null,
      daysFullyDone: doneDays,
      firstUnfinishedDay: firstOpen?.day,
      stages: SPRINT_STAGES.map((s) => `${s.title} (${s.days} days): ${s.blurb}`),
      todaysModules: sel?.modules.map((m) => `${m.id} ${m.title}${p.modules[m.id] ? " (done)" : ""}`),
    }),
  });

  let base = 0;
  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">Accelerated track</p>
        <h1>The {SPRINT_DAYS}-day sprint.</h1>
        <p className="lead">
          The core of the path on a calendar: build with LLM APIs, prompt well, ship RAG and agents, then evaluate, secure and deploy them. Plan on about two focused hours a
          day. Levels 0, 9, 11, 12 and 13–16 (system design, platforms, inference, multimodal, fine-tuning, portfolio and interviews) stay in the full path for when you want depth.
        </p>
      </header>

      <div className="card sprint-control">
        {p.sprintStart ? (
          <>
            <div className="grow">
              <b>Day {currentDay} of {SPRINT_DAYS}</b>
              <span className="muted small"> · started {p.sprintStart} · {doneDays} days fully done</span>
              <span className="meter big"><span style={{ width: `${(doneDays / SPRINT_DAYS) * 100}%` }} /></span>
              {firstOpen && firstOpen.day < currentDay && <p className="hint warm">You're {currentDay - firstOpen.day} day(s) behind. Catch up on day {firstOpen.day} first; the calendar waits for you.</p>}
            </div>
            <button className="btn small ghost" onClick={() => confirm("Stop the sprint? Your module progress is kept.") && p.stopSprint()}><Square size={13} /> Stop</button>
          </>
        ) : (
          <>
            <CalendarDays size={22} className="rule-icon" />
            <div className="grow">
              <b>Not started</b>
              <span className="muted small"> · pick a start date and the plan turns into a calendar</span>
            </div>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} aria-label="Start date" />
            <button className="btn primary" onClick={() => (p.startSprint(startDate || today()), setSelected(Math.max(1, dayDiff(startDate || today(), today()) + 1)))}><Play size={15} /> Start the sprint</button>
          </>
        )}
      </div>

      <div className="sprint-layout">
        <div>
          {SPRINT_STAGES.map((s, si) => {
            const days = plan.filter((d) => d.stage === si);
            const from = base + 1;
            base += s.days;
            const lvl = levelOfModule(days.find((d) => d.modules.length)?.modules[0].id ?? "1.1");
            return (
              <section key={s.title} className="sprint-stage" style={phaseStyle(lvl.phase)}>
                <div className="sprint-stage-head">
                  <span className="stage-num">{si + 1}</span>
                  <div className="grow">
                    <b>{s.title}</b>
                    <span className="muted small"> · days {from}–{from + s.days - 1} · {s.blurb}</span>
                  </div>
                </div>
                <div className="day-grid">
                  {days.map((d) => (
                    <button
                      key={d.day}
                      className={`day${dayDone(d) ? " done" : ""}${p.sprintStart && d.day === currentDay ? " today" : ""}${d.day === selected ? " sel" : ""}`}
                      onClick={() => setSelected(d.day)}
                      title={`Day ${d.day}: ${d.modules.map((m) => m.title).join(", ")}`}
                    >
                      {dayDone(d) ? <Check size={12} strokeWidth={3} /> : d.day}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>

        {sel && (
          <aside className="card day-card" style={phaseStyle(levelOfModule(sel.modules[0]?.id ?? "1.1").phase)}>
            <span className="tag">{SPRINT_STAGES[sel.stage].title}</span>
            <h2>Day {sel.day}{p.sprintStart && sel.day === currentDay ? " · today" : ""}</h2>
            <ul className="day-mods">
              {sel.modules.map((m) => {
                const l = levelOfModule(m.id);
                return (
                  <li key={m.id} className={p.modules[m.id] ? "done" : ""}>
                    <Link to={m.projectId ? `/project/${m.projectId}` : `/learn/${m.id}`}>
                      <span className="side-dot">{p.modules[m.id] ? <Check size={10} strokeWidth={3} /> : null}</span>
                      <span className="grow">
                        <b>{m.title}</b>
                        <span className="muted small">L{l.number} · {m.id} · {m.projectId ? <><Hammer size={11} /> project</> : <><BookOpen size={11} /> lesson</>}</span>
                      </span>
                      <ArrowRight size={14} />
                    </Link>
                  </li>
                );
              })}
            </ul>
            <p className="help">A module spread over several days shows on each of them. Finish it on the last one.</p>
            <div className="row gap">
              <button className="btn small" disabled={sel.day <= 1} onClick={() => setSelected(sel.day - 1)}>Previous day</button>
              <button className="btn small" disabled={sel.day >= SPRINT_DAYS} onClick={() => setSelected(sel.day + 1)}>Next day</button>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
