import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import ini from "highlight.js/lib/languages/ini";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import { Check, Copy, FileCode2, Terminal } from "lucide-react";
import { useMemo, useState } from "react";

hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("sh", bash);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);
hljs.registerLanguage("json", json);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("toml", ini);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("sql", sql);

/** A code block with its file name, syntax colours and a copy button. `meta` is the text after the language, e.g. title="app/main.py". */
export function CodeBlock({ code, lang, meta }: { code: string; lang?: string; meta?: string }) {
  const [copied, setCopied] = useState(false);
  const title = meta?.match(/title="([^"]+)"/)?.[1] ?? meta?.match(/title=(\S+)/)?.[1];
  const isTerm = lang === "bash" || lang === "sh" || lang === "shell" || title === "terminal";
  const plain = lang === "text" || lang === "txt" || !lang;
  const html = useMemo(() => {
    if (plain || !hljs.getLanguage(lang!)) return null;
    try {
      return hljs.highlight(code, { language: lang!, ignoreIllegals: true }).value;
    } catch {
      return null;
    }
  }, [code, lang, plain]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard blocked */
    }
  };
  const label = title ?? (isTerm ? "terminal" : plain ? (lang === "text" ? "output" : "") : lang);
  return (
    <figure className={`codeblock${isTerm ? " term" : ""}${lang === "text" ? " output" : ""}`}>
      {(label || !plain) && (
        <figcaption>
          {isTerm ? <Terminal size={13} aria-hidden /> : <FileCode2 size={13} aria-hidden />}
          <span className="cb-title">{label}</span>
          <button className="cb-copy" onClick={copy} aria-label={copied ? "Copied" : "Copy code"}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy"}
          </button>
        </figcaption>
      )}
      <pre>{html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}</pre>
      {!label && plain && (
        <button className="cb-copy floating" onClick={copy} aria-label="Copy">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      )}
    </figure>
  );
}
