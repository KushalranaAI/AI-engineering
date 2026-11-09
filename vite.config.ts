import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createAiServerHandler, serverKeys } from "./server/ai-relay";

/**
 * Dev-only relay for AI calls the browser can't make directly (CORS - mainly Azure OpenAI).
 * It forwards only to known AI provider hosts, never stores or logs the key, and runs on your own machine.
 */
function aiProxy(): Plugin {
  const allowed = (host: string) =>
    host === "api.openai.com" || host === "api.anthropic.com" || /\.openai\.azure\.com$/.test(host) || /\.cognitiveservices\.azure\.com$/.test(host) || /\.services\.ai\.azure\.com$/.test(host);
  return {
    name: "ai-path-ai-proxy",
    configureServer(server) {
      server.middlewares.use("/api/ai-proxy", (req, res) => {
        if (req.method === "GET") {
          // lets the AI settings page detect the relay; static hosts (GitHub Pages) don't have it
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ available: true }));
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let raw = "";
        req.on("data", (c) => (raw += c));
        req.on("end", async () => {
          try {
            const { url, headers, body } = JSON.parse(raw);
            const target = new URL(url);
            if (target.protocol !== "https:" || !allowed(target.hostname)) {
              res.statusCode = 400;
              res.end(JSON.stringify({ error: { message: `Refusing to relay to ${target.hostname} - only AI provider hosts are allowed.` } }));
              return;
            }
            const upstream = await fetch(target, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
            res.statusCode = upstream.status;
            res.setHeader("content-type", "application/json");
            res.end(await upstream.text());
          } catch (e) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: { message: String(e) } }));
          }
        });
      });
    },
  };
}

/**
 * Dev-only: AI keys kept in a `.env` file on this computer. The relay attaches them to provider requests here, so they never
 * reach the browser. They are read with loadEnv and are deliberately NOT put in `define` or a VITE_ variable, which would
 * bake them into the public bundle.
 */
function aiServerKeys(): Plugin {
  return {
    name: "ai-path-ai-server-keys",
    configureServer(server) {
      const env = loadEnv(server.config.mode, server.config.envDir || server.config.root, "");
      server.middlewares.use("/api/ai-server", createAiServerHandler(env));
      server.httpServer?.once("listening", () => {
        const found = Object.entries(serverKeys(env)).filter(([, ok]) => ok).map(([k]) => k);
        console.log(found.length ? `  AI keys from .env: ${found.join(", ")} (kept on this computer, never sent to the browser)` : "  No AI keys in .env (optional: copy .env.example to .env)");
      });
    },
  };
}

/**
 * Production-only Content-Security-Policy. The saved AI key is encrypted, but script running inside the page could still
 * ask the browser to use it, so the page may only run this app's own scripts and only talk to the AI providers.
 * (Dev mode is exempt: Vite's hot reload needs inline scripts.)
 */
function contentSecurityPolicy(): Plugin {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // React sets inline style attributes
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.openai.com https://api.anthropic.com https://*.openai.azure.com https://*.cognitiveservices.azure.com https://*.services.ai.azure.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join("; ");
  return {
    name: "ai-path-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: csp }, injectTo: "head-prepend" }],
  };
}

// `base: "./"` keeps the build portable (GitHub Pages, any static host, or a local folder).
export default defineConfig({
  base: "./",
  plugins: [react(), aiProxy(), aiServerKeys(), contentSecurityPolicy()],
  server: { port: 5174 },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        // split third-party code into separately cached chunks so a content edit doesn't invalidate React, the SDKs, etc.
        manualChunks(id: string) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|react-router|react-router-dom|scheduler)\//.test(id)) return "react";
          if (id.includes("@anthropic-ai")) return "anthropic";
          if (id.includes("highlight.js")) return "highlight";
          if (/node_modules\/(react-markdown|remark-|rehype-|unified|micromark|mdast-|hast-|unist-|vfile|property-information|space-separated-tokens|comma-separated-tokens|decode-named-character-reference|character-entities|trim-lines|html-url-attributes|devlop|bail|trough|is-plain-obj|zwitch|ccount|longest-streak|markdown-table|estree-)/.test(id)) return "markdown";
          if (id.includes("motion") || id.includes("framer-motion")) return "motion";
          if (id.includes("lucide-react")) return "icons";
          return undefined;
        },
      },
    },
  },
  test: { environment: "node", include: ["src/**/*.test.ts", "server/**/*.test.ts"] },
} as never);
