import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock";

const text = (n: ReactNode): string => (typeof n === "string" ? n : Array.isArray(n) ? n.map(text).join("") : n && typeof n === "object" && "props" in n ? text((n as { props: { children?: ReactNode } }).props.children) : "");

/** Lesson and guide markdown: highlighted, copyable code; external links in a new tab. */
export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`prose ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw]}
        components={{
          a: ({ href, children, ...rest }) => {
            const external = !!href && /^https?:\/\//i.test(href);
            return (
              <a href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})} {...rest}>
                {children}
              </a>
            );
          },
          pre: ({ children, node }) => {
            const child = Array.isArray(children) ? children[0] : children;
            const props = (child as { props?: { className?: string; children?: ReactNode } })?.props ?? {};
            const lang = props.className?.match(/language-([\w-]+)/)?.[1];
            const code = text(props.children).replace(/\n$/, "");
            const codeNode = node?.children?.[0] as { data?: { meta?: string } } | undefined;
            return <CodeBlock code={code} lang={lang} meta={codeNode?.data?.meta ?? undefined} />;
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
