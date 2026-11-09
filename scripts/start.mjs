#!/usr/bin/env node
// One command for everything: `npm start`
//   1. installs dependencies if needed
//   2. starts the app and opens it in your browser
// Flags: --check (run tests first)
import { spawnSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: root, stdio: "inherit", shell: process.platform === "win32", ...opts });
const step = (n, msg) => console.log(`\n\x1b[32m[${n}/2]\x1b[0m ${msg}`);

const [major] = process.versions.node.split(".").map(Number);
if (major < 20) {
  console.error(`AI Engineer Path needs Node.js 20 or newer (you have ${process.version}). Install it from https://nodejs.org and try again.`);
  process.exit(1);
}

step(1, "Checking dependencies…");
const nm = path.join(root, "node_modules");
const lock = path.join(root, "package-lock.json");
const stale = !fs.existsSync(nm) || (fs.existsSync(lock) && fs.statSync(lock).mtimeMs > fs.statSync(nm).mtimeMs + 1000);
if (stale) {
  if (run(npm, ["install", "--no-audit", "--no-fund"]).status !== 0) process.exit(1);
} else console.log("  up to date");

if (args.has("--check")) {
  console.log("  running tests…");
  if (run(npm, ["test", "--silent"]).status !== 0) process.exit(1);
}

step(2, "Starting AI Engineer Path → http://localhost:5174");
const vite = spawn(process.execPath, [path.join(root, "node_modules", "vite", "bin", "vite.js"), "--open"], { cwd: root, stdio: "inherit" });
vite.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => vite.kill(sig));
