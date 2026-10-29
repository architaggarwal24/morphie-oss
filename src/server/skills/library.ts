/**
 * The skill library: well-known open-source skills, installed from their GitHub repositories on demand (nothing of
 * theirs ships with Morphie; each keeps its own license). Install counts are from skills.sh, October 2026.
 * `path` is where the skill usually lives; if a repository moves things around, the installer finds the folder by name.
 */
export interface LibraryEntry {
  name: string;
  repo: string;
  path: string;
  /** Our one-line summary (the skill's own description is used once installed). */
  summary: string;
  scope: "agent" | "design" | "both";
  license: string;
  category: "Engineering" | "Workflow" | "Design" | "Writing";
  /** Installs on skills.sh, when listed there. */
  installs?: string;
}

const A = (name: string, summary: string, scope: LibraryEntry["scope"], category: LibraryEntry["category"], installs?: string): LibraryEntry =>
  ({ name, repo: "anthropics/skills", path: `skills/${name}`, summary, scope, license: "Apache-2.0", category, installs });
const S = (name: string, summary: string, category: LibraryEntry["category"] = "Workflow"): LibraryEntry =>
  ({ name, repo: "obra/superpowers", path: `skills/${name}`, summary, scope: "agent", license: "MIT", category });
const M = (group: "engineering" | "productivity", name: string, summary: string, installs?: string): LibraryEntry =>
  ({ name, repo: "mattpocock/skills", path: `skills/${group}/${name}`, summary, scope: "agent", license: "See repository", category: group === "engineering" ? "Engineering" : "Workflow", installs });
const V = (name: string, summary: string, scope: LibraryEntry["scope"] = "agent", installs?: string): LibraryEntry =>
  ({ name, repo: "vercel-labs/agent-skills", path: `skills/${name}`, summary, scope, license: "MIT", category: scope === "agent" ? "Engineering" : "Design", installs });

export const LIBRARY: LibraryEntry[] = [
  // Anthropic's official examples
  A("frontend-design", "Distinctive, production-grade frontends that avoid the generic AI look.", "both", "Design", "1.0M"),
  A("webapp-testing", "Test local web apps with Playwright: screenshots, console logs, interactions.", "agent", "Engineering"),
  A("mcp-builder", "Build high-quality MCP servers that connect models to external services.", "agent", "Engineering"),
  A("skill-creator", "Create, test and improve skills.", "both", "Workflow"),
  A("web-artifacts-builder", "Multi-component HTML artifacts with React, Tailwind and shadcn/ui.", "agent", "Engineering"),
  A("canvas-design", "Posters, art and visual pieces with a strong design philosophy.", "design", "Design"),
  A("theme-factory", "Ready-made and custom themes (colours + fonts) to style any output.", "design", "Design"),
  A("brand-guidelines", "Apply a brand's colours and typography consistently.", "design", "Design"),
  A("algorithmic-art", "Generative art with p5.js: seeded randomness, flow fields, particles.", "design", "Design"),
  A("doc-coauthoring", "A structured workflow for writing docs, proposals and specs together.", "agent", "Writing"),
  // Superpowers (Jesse Vincent)
  S("brainstorming", "Turn a rough idea into a design through questions before any code."),
  S("writing-plans", "Write detailed, bite-sized implementation plans."),
  S("executing-plans", "Carry out a written plan in batches with checkpoints."),
  S("test-driven-development", "Strict red-green-refactor: no code without a failing test first.", "Engineering"),
  S("systematic-debugging", "Four-phase root-cause debugging before any fix.", "Engineering"),
  S("verification-before-completion", "Run the checks and show evidence before claiming work is done."),
  S("requesting-code-review", "Get work reviewed against the plan and requirements."),
  S("receiving-code-review", "Act on review feedback with technical rigour, not blind agreement."),
  S("dispatching-parallel-agents", "Split independent problems across parallel sub-agents."),
  S("writing-skills", "Write and test new skills, TDD-style."),
  // Matt Pocock
  M("productivity", "grill-me", "Get interviewed about a plan until every branch of the design is resolved.", "1.4M"),
  M("engineering", "tdd", "Red-green-refactor one vertical slice at a time.", "1.2M"),
  M("engineering", "improve-codebase-architecture", "Find opportunities to deepen modules and simplify a codebase.", "1.2M"),
  M("productivity", "handoff", "Compact a conversation into a document another agent can pick up.", "1.1M"),
  M("engineering", "prototype", "Build a throwaway prototype to answer a design question.", "1.0M"),
  M("engineering", "domain-modeling", "Build and sharpen the domain model, glossary and ADRs.", "897K"),
  M("engineering", "codebase-design", "Design deep modules with clean interfaces.", "869K"),
  M("engineering", "diagnosing-bugs", "A phased loop for hard bugs and performance regressions.", "854K"),
  M("engineering", "code-review", "Review a diff against coding standards and its spec."),
  M("engineering", "research", "Investigate a question and save cited findings as Markdown."),
  // Vercel
  V("react-best-practices", "Vercel's React and Next.js performance rules, ordered by impact.", "agent", "847K"),
  V("web-design-guidelines", "Check UI code against 100+ accessibility, performance and UX rules.", "both"),
  V("composition-patterns", "Compound components and composition instead of boolean prop sprawl."),
  V("react-view-transitions", "Native-feeling animations with React's View Transition API."),
  // Design
  { name: "ui-ux-pro-max", repo: "nextlevelbuilder/ui-ux-pro-max-skill", path: ".claude/skills/ui-ux-pro-max", summary: "Design intelligence: styles, palettes, font pairings, UX rules and a design-system generator.", scope: "design", license: "MIT", category: "Design" },
  { name: "design-mobile-apps", repo: "designed-by-ai/skills", path: "skills/design-mobile-apps", summary: "Design polished mobile app screens and flows.", scope: "design", license: "See repository", category: "Design", installs: "1.1M" },
];
