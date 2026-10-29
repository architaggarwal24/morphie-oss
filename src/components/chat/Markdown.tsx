"use client";
import { Check, Copy } from "lucide-react";
import { Children, isValidElement, memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = Children.toArray(children).find(isValidElement) as React.ReactElement<{ className?: string; children?: ReactNode }> | undefined;
  const lang = /language-([\w-]+)/.exec(code?.props.className ?? "")?.[1] ?? "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(textOf(code?.props.children).replace(/\n$/, "")); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  return (
    <div className="code-window group my-4 overflow-hidden rounded-xl">
      <div className="flex items-center gap-3 border-b border-line/80 bg-fg/[0.025] px-3 py-1.5">
        <span className="flex gap-1.5" aria-hidden><span className="size-2.5 rounded-full bg-[#ff5f57]/80" /><span className="size-2.5 rounded-full bg-[#febc2e]/80" /><span className="size-2.5 rounded-full bg-[#28c840]/80" /></span>
        <span className="rounded-md bg-accent/10 px-1.5 py-0.5 font-mono text-[10.5px] font-medium lowercase tracking-wide text-accent ring-1 ring-inset ring-accent/20">{lang || "text"}</span>
        <button onClick={copy} className={`ml-auto flex pointer-coarse:min-h-11 items-center gap-1.5 rounded-md px-2 py-1 pointer-coarse:px-3 pointer-coarse:-my-1.5 text-[11px] font-medium transition active:scale-95 ${copied ? "bg-ok/12 text-ok" : "text-muted opacity-70 hover:bg-fg/[0.07] hover:text-fg group-hover:opacity-100"}`} aria-label="Copy code">
          {copied ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Copy</>}
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">{children}</pre>
    </div>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
          // Remote images are blocked by the CSP (they're a tracking/exfiltration channel), so show them as links.
          img: ({ src, alt }) => (typeof src === "string" ? <a href={src} target="_blank" rel="noopener noreferrer nofollow">{alt || "image"}</a> : null),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
