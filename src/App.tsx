import { BarChart3, BookOpen, Dumbbell, Hammer, Lock, Network, Sparkles } from "lucide-react";
import { Suspense, lazy, useEffect } from "react";
import { HashRouter, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { useAi, useAiActive } from "./ai/settings";
import { ChatWidget } from "./chat/ChatWidget";
import { AiSettingsPage } from "./pages/AiSettingsPage";
import { Home } from "./pages/Home";
import { LearnPage } from "./pages/LearnPage";
import { LevelPage } from "./pages/LevelPage";
import { ModulePage } from "./pages/ModulePage";
import { PracticePage, SimPage } from "./pages/PracticePage";
import { ProgressPage } from "./pages/ProgressPage";
import { ProjectPage, ProjectsPage } from "./pages/ProjectPage";
import { SprintPage } from "./pages/SprintPage";
import { dueCards, streak, useProgress } from "./state/progress";
import { ThemeToggle } from "./ui/bits";
import { Credit } from "./ui/Credit";
import { ErrorBoundary } from "./ui/ErrorBoundary";

const StudioPage = lazy(async () => ({ default: (await import("./studio/StudioPage")).StudioPage }));

const LINKS = [
  { to: "/learn", label: "Learn", icon: BookOpen, match: ["/learn", "/level"] },
  { to: "/projects", label: "Build", icon: Hammer, match: ["/projects", "/project"] },
  { to: "/studio", label: "Studio", icon: Network, match: ["/studio"] },
  { to: "/practice", label: "Practice", icon: Dumbbell, match: ["/practice", "/sim"] },
];

export function Logo() {
  return (
    <svg className="logo" width="26" height="26" viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M9 22.5 16 9l7 13.5" fill="none" stroke="var(--on-accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="16" cy="18.2" r="2.3" fill="var(--on-accent)" />
    </svg>
  );
}

function Nav() {
  const ai = useAiActive();
  const locked = useAi((s) => s.status === "locked");
  const { pathname } = useLocation();
  const p = useProgress();
  const due = dueCards(p).length;
  const st = streak(p.days);
  return (
    <header className="nav">
      <NavLink to="/" className="brand" aria-label="AI Engineer Path, home">
        <Logo /> <span>AI Engineer Path</span>
      </NavLink>
      <nav aria-label="Main">
        {LINKS.map(({ to, label, icon: Icon, match }) => (
          <NavLink key={to} to={to} className={() => (match.some((m) => pathname.startsWith(m)) ? "active" : "")}>
            <Icon size={16} aria-hidden /> <span className="nav-label">{label}</span>
            {to === "/practice" && due > 0 && <span className="nav-badge" aria-label={`${due} cards due`}>{due > 99 ? "99+" : due}</span>}
          </NavLink>
        ))}
      </nav>
      <span className="grow" />
      <NavLink to="/progress" className={({ isActive }) => `nav-progress${isActive ? " active" : ""}`} title="Your progress">
        <BarChart3 size={15} aria-hidden /> <span className="nav-label">{st > 0 ? `${st}-day streak` : "Progress"}</span>
      </NavLink>
      <ThemeToggle />
      <NavLink to="/ai" className={`ai-chip${ai ? " on" : ""}${locked ? " locked" : ""}`} title={locked ? "Your saved AI key is locked" : ai ? "The AI tutor is on" : "Add an AI key for the tutor"}>
        {locked ? <Lock size={14} /> : <Sparkles size={14} />} <span className="nav-label">{locked ? "Unlock tutor" : ai ? "Tutor on" : "AI tutor"}</span>
      </NavLink>
    </header>
  );
}

function TitleSync() {
  const { pathname } = useLocation();
  useEffect(() => {
    const seg = pathname.split("/").filter(Boolean);
    const names: Record<string, string> = { learn: seg[1] ? `Module ${seg[1]}` : "Learn", level: `Level ${seg[1]}`, projects: "Build", project: "Project", studio: "Agent Studio", practice: "Practice", sim: "Simulator", progress: "Progress", sprint: "100-day sprint", ai: "AI tutor" };
    document.title = seg.length ? `${names[seg[0]] ?? "AI Engineer Path"} · AI Engineer Path` : "AI Engineer Path";
  }, [pathname]);
  return null;
}

function Screens() {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary key={pathname.split("/").slice(0, 3).join("/")}>
      <Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/learn" element={<LearnPage />} />
          <Route path="/roadmap" element={<LearnPage />} />
          <Route path="/level/:n" element={<LevelPage />} />
          <Route path="/learn/:id" element={<ModulePage />} />
          <Route path="/learn/:id/:step" element={<ModulePage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/project/:id" element={<ProjectPage />} />
          <Route path="/project/:id/:step" element={<ProjectPage />} />
          <Route path="/studio" element={<StudioPage />} />
          <Route path="/studio/:preset" element={<StudioPage />} />
          <Route path="/studio/j/:journey/:stage" element={<StudioPage />} />
          <Route path="/practice" element={<PracticePage />} />
          <Route path="/practice/:tab" element={<PracticePage />} />
          <Route path="/sim/:id" element={<SimPage />} />
          <Route path="/sprint" element={<SprintPage />} />
          <Route path="/progress" element={<ProgressPage />} />
          <Route path="/ai" element={<AiSettingsPage />} />
          <Route path="*" element={<Home />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

export function App() {
  return (
    <HashRouter>
      <TitleSync />
      <div className="app">
        <Nav />
        <Screens />
        <Credit />
        <ChatWidget />
      </div>
    </HashRouter>
  );
}
