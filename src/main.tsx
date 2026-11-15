import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./design/roadmaps.js"; // the Learn in Public family: <kr-roadmaps> and <kr-next-roadmap>
import { App } from "./App";
import { initTheme } from "./ui/bits";
import "./styles.css";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
