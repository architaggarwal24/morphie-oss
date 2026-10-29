"use client";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { common, createLowlight } from "lowlight";
import { useMemo } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

const lowlight = createLowlight(common);
const BY_EXT: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp",
  php: "php", sh: "bash", bash: "bash", zsh: "bash", json: "json", jsonc: "json", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", md: "markdown",
  html: "xml", xml: "xml", svg: "xml", vue: "xml", css: "css", scss: "scss", less: "less", sql: "sql", graphql: "graphql", lua: "lua", r: "r", pl: "perl", diff: "diff",
};
const BY_NAME: Record<string, string> = { Dockerfile: "dockerfile", Makefile: "makefile", ".gitignore": "bash", ".env": "bash" };
const MAX_HIGHLIGHT = 200_000;

export function languageOf(path: string): string | undefined {
  const name = path.split("/").pop() ?? "";
  if (BY_NAME[name]) return BY_NAME[name];
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const lang = BY_EXT[ext];
  return lang && lowlight.registered(lang) ? lang : undefined;
}

/** A read-only source view: line numbers in a gutter, syntax colours from the app's hljs theme. */
export function CodeView({ path, code }: { path: string; code: string }) {
  const lang = languageOf(path);
  const body = useMemo(() => {
    if (!lang || code.length > MAX_HIGHLIGHT) return code;
    try { return toJsxRuntime(lowlight.highlight(lang, code), { Fragment, jsx, jsxs }); } catch { return code; }
  }, [lang, code]);
  const lines = useMemo(() => code.split("\n").length - (code.endsWith("\n") ? 1 : 0), [code]);
  return (
    <div className="flex min-h-0 overflow-auto rounded-xl border border-line bg-sunken/70 font-mono text-[12px] leading-[1.6]">
      <pre aria-hidden className="sticky left-0 z-[1] shrink-0 select-none border-r border-line/60 bg-sunken px-2.5 py-3 text-right text-faint tabular-nums">{Array.from({ length: Math.max(1, lines) }, (_, i) => i + 1).join("\n")}</pre>
      <pre className="hljs min-w-0 flex-1 px-3 py-3"><code>{body}</code></pre>
    </div>
  );
}
