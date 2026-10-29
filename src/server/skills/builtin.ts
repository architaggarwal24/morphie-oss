/**
 * Morphie's own skills, written for it and shipped with it (MIT, like the rest of Morphie). They work offline and can
 * be turned off or pinned like any other. Each is a complete SKILL.md: YAML front-matter (name, description, scope)
 * and the instructions the agent loads when a task matches.
 */
export interface BuiltinSkill { markdown: string }

const md = (s: string) => ({ markdown: s.trim() + "\n" });

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  md(`---
name: clarify-first
description: Before a big or vague build (an app, a site, a redesign, a multi-part feature), ask the user 2-4 quick multiple-choice questions with ask_user, then work without stopping. Skip it for small, clear tasks.
scope: agent
---
# Clarify first, then run

A wrong guess on a big task wastes the whole run. A good question costs the user ten seconds.

## When to use
- The request leaves open choices that change the result: audience, tech stack, pages/sections, style, data source, must-have features.
- The task will take many steps (a whole site or app, a migration, a redesign).

Don't use it for small or precise requests ("fix the typo in the footer", "add a test for parseDate"): just do them.

## How
1. Read the request and anything you can inspect cheaply first (the project's files, MORPHIE.md). Never ask what you can find out yourself.
2. Call **ask_user once** with 2-4 questions. Each question:
   - is about one decision, phrased as a question;
   - has 2-4 concrete options, each with a one-line description of what it means for the result;
   - puts your recommended option first and adds "(Recommended)" to its label.
   Use multiSelect only when choices combine (e.g. which sections to include).
3. Turn the answers into the plan (update_plan) and carry on to the end without stopping to check in again. Anything still unanswered: pick the sensible default and say so in the final summary.
`),
  md(`---
name: plan-and-track
description: For any task with more than three steps, write a concrete checklist with update_plan and keep it current until every item is done. Use it for builds, refactors and multi-file changes.
scope: agent
---
# Plan and track

The plan is how the user follows along. A plan stuck on step 1 looks like an agent that stopped working.

1. Before acting, write 4-8 items with update_plan. Each item is an outcome you can check ("Hero section with headline, sub-copy and CTA"), not an activity ("work on hero").
2. Exactly one item is "active" at a time. The moment it's finished, send update_plan again with it "done" and the next one "active". Always send the full list.
3. If you discover new work, add it to the list instead of silently doing it.
4. The last item is always verification ("Build passes, pages load, tests green").
5. Don't finish while any item is unfinished, unless you explain exactly why it can't be done.
`),
  md(`---
name: scaffold-web-app
description: Starting a new website or web app from an empty project - choosing the stack and scaffolding it non-interactively so nothing hangs waiting for input. Use it before creating files in an empty project.
scope: agent
---
# Scaffold a web app without getting stuck

## Choose the smallest stack that does the job
- A landing page or brochure site with no data: **plain HTML + CSS + a little JS**. No build step, nothing to break.
- Interactive UI, several views, components: **Vite + React + TypeScript**.
- Server rendering, routes, API endpoints, SEO-heavy: **Next.js (App Router) + TypeScript**.
- Only add Tailwind, animation or UI libraries when the design calls for them.

## Scaffold non-interactively (commands must never wait for input)
- Vite in an empty folder: \`npm create vite@latest . -- --template react-ts\` then \`npm install\`. If the folder isn't empty, scaffold into a subfolder (\`npm create vite@latest app -- --template react-ts\`) and move the files up, or write the files yourself.
- Next.js: \`npx create-next-app@latest . --ts --eslint --app --src-dir --tailwind --import-alias "@/*" --use-npm --yes\`.
- Always pass the flags that skip prompts (\`--yes\`, \`--template\`, \`--use-npm\`). If a command still prompts it will time out: write the files by hand instead.
- Never start \`npm run dev\` with bash: it never returns. verify_project starts and stops the app.

## Then
- Write real content, not lorem ipsum. Every section the user asked for, complete.
- Keep \`package.json\` scripts standard: \`dev\`, \`build\`, \`start\`/\`preview\`, \`test\`.
- Add a test runner early (\`npm i -D vitest\`, script \`"test": "vitest run"\`) and one test for real logic.
- Large files: write the first part with write_file, then append with edit_file, so a reply is never cut off.
`),
  md(`---
name: tdd-loop
description: Test-driven development - write a failing test, make it pass with the simplest code, then refactor, one small behaviour at a time. Use it when adding logic, fixing a bug with a clear reproduction, or when the user asks for tests.
scope: agent
---
# Red, green, refactor

1. **Red.** Write one test for the next small behaviour. Run it and watch it fail, for the reason you expect. A test that passes before the code exists proves nothing.
2. **Green.** Write the least code that makes it pass. No extra features.
3. **Refactor.** Clean up names and duplication with the tests green. Run them again.
4. Repeat with the next behaviour. Cover the edge cases that matter: empty input, bad input, boundaries, errors.

Rules:
- Test behaviour through the public interface, not private details.
- One assertion idea per test; names describe the behaviour ("rejects an expired token").
- For a bug: first a test that reproduces it, then the fix.
- Never change a test just to make it pass. If the test is wrong, say so and why.
- Run the whole suite before you finish.
`),
  md(`---
name: debug-systematically
description: Find the root cause of a bug, crash, failing test or build error before changing code - reproduce, read the actual error, form one hypothesis at a time, prove it, then fix. Use it whenever something fails and the cause isn't obvious.
scope: agent
---
# Debug systematically

Guessing at fixes makes bugs worse. Find the cause first.

1. **Reproduce.** Run the failing command and capture the exact error. If you can't reproduce it, say so before changing anything.
2. **Read the error properly.** The first error is usually the real one; later ones are fallout. Note the file and line.
3. **Look at what changed** recently (git diff, the files you just wrote).
4. **One hypothesis at a time.** State it ("the import path is wrong because the file moved"), then test it with the smallest check: read the file, add a log, run one test.
5. **Fix the cause, not the symptom.** No catch-all try/catch, no disabling the check, no deleting the failing test.
6. **Prove it.** Re-run the original failing command, then the full build/tests.
7. After three failed hypotheses, step back: re-read the error and the code path from the start, or try a minimal reproduction.
`),
  md(`---
name: verify-before-done
description: Never say a task is finished without evidence - run the build, the tests and the app (verify_project in code projects) and report what was actually checked. Use it at the end of every task that changed code.
scope: agent
---
# Verify before you say "done"

"It should work" is not a result. Before the final answer:

1. Run **verify_project** (code projects): install, type-check, build, tests, the app starting and its pages loading, screenshots.
2. Fix everything it reports and run it again. Repeat until it passes.
3. Look at the screenshots when you get them: blank pages, broken layout, missing sections and error text count as failures.
4. If something truly can't pass here (a missing secret, an external service), say exactly what and why.
5. In the final answer list what was verified, briefly, and how the user runs it.

Never claim tests pass without running them in this session.
`),
  md(`---
name: review-changes
description: Review code changes (a diff, a branch or your own work) for bugs, security problems, edge cases and convention mismatches, and report findings by severity with file:line and a concrete fix. Use it when asked for a review or before a pull request.
scope: agent
---
# Review changes

1. Get the full picture: \`git status\`, \`git diff HEAD\` (or the branch diff), and read the changed files around the edits.
2. Check, in this order:
   - **Correctness:** wrong logic, off-by-one, unhandled null/empty, async mistakes, race conditions.
   - **Security:** injection, secrets in code, missing auth checks, unsafe HTML, path traversal.
   - **Data:** migrations, backwards compatibility, data loss.
   - **Tests:** is the change covered? Do the tests actually assert the behaviour?
   - **Conventions:** naming, structure and libraries match the rest of the codebase.
3. Report findings most severe first: \`file:line\`, what's wrong, why it matters, the fix. No style nitpicks unless asked.
4. Say clearly when you found nothing serious. Don't edit files during a review unless asked.
`),
  md(`---
name: write-a-skill
description: Create or improve a skill (a SKILL.md playbook) - when the user wants to teach Morphie a repeatable way of doing something. Use it to draft the name, trigger description and instructions.
scope: both
---
# Write a skill

A skill is a Markdown file the agent loads when a task matches it.

\`\`\`markdown
---
name: kebab-case-name
description: What it does AND when to use it, in one or two sentences. This line decides when the skill is picked, so name the situations and keywords.
scope: agent | design | both
---
# Title

Instructions in the imperative: the steps, the rules, the checks.
\`\`\`

Good skills:
- Do one job. Split broad ones.
- Have a description that names *when* to use it ("Use when...").
- Are concrete: commands, file names, checklists, examples of good and bad output.
- Stay short (under ~300 lines). Put long reference material in extra files next to SKILL.md and point to them.
- Can bundle scripts (e.g. \`scripts/check.py\`); say exactly how to run them.
`),
  md(`---
name: frontend-aesthetics
description: Make interfaces look intentional and premium instead of generic - a clear visual direction, characterful type, a disciplined palette, real hierarchy, spacing rhythm and purposeful motion. Use it for any landing page, website, UI or visual design.
scope: both
---
# Frontend aesthetics

Generic output looks like every template: centred hero, purple gradient, three identical cards, system font. Choose a direction and commit to it.

## Pick a direction first
Decide one: editorial, technical/precise, warm/organic, playful, luxurious/minimal, bold/brutalist. Every choice below follows from it.

## Typography
- One display face with character for headings, one quiet face for body. Never more than two families (plus a mono for code).
- A real scale: big headings (clamp(2.5rem, 6vw, 4.5rem)), tight letter-spacing on large text, 1.5-1.7 line height on body, 60-75 characters per line.

## Colour
- A dominant neutral background, one strong accent used sparingly (buttons, key words, focus), one supporting tone. Avoid rainbow palettes.
- Text contrast at least 4.5:1 (7:1 for body text is better). Dark themes: off-black backgrounds, not pure #000, and softened white text.

## Layout and hierarchy
- One focal point per section. Vary layouts (split, asymmetric, bento grid, full-bleed) instead of repeating the same three-card row.
- A spacing scale (4/8/12/16/24/32/48/64/96) used consistently; generous whitespace around headings.
- Real content: specific headlines, believable numbers, named features. No lorem ipsum.

## Detail and motion
- Subtle depth: borders at low opacity, soft layered shadows, a light grain or gradient mesh only if it fits the direction.
- Motion with purpose: staggered reveal on load, smooth hover states (150-250 ms), nothing that loops forever. Respect prefers-reduced-motion.
- Finish the details: favicon, focus styles, hover/active states, empty and error states, a footer that isn't an afterthought.
`),
  md(`---
name: accessible-ui
description: Check and fix accessibility in web UI - semantic HTML, keyboard use, focus, labels, contrast, motion and screen readers (WCAG 2.2 AA). Use it when building or reviewing any page or component.
scope: both
---
# Accessible UI

- **Semantics:** one h1 per page, headings in order, landmarks (header, nav, main, footer), real buttons for actions and links for navigation, lists for lists.
- **Keyboard:** everything reachable and usable with Tab/Shift+Tab/Enter/Space/Escape; visible focus outline (never remove it without a replacement); logical order; no keyboard traps; dialogs trap focus and return it on close.
- **Labels:** every input has a visible label; icon-only buttons have aria-label; images have meaningful alt text (empty alt for decoration).
- **Contrast:** text 4.5:1 (3:1 for large text and UI borders/icons). Don't rely on colour alone to convey state.
- **Motion:** honour prefers-reduced-motion; no flashing.
- **Touch:** targets at least 44x44 px on mobile; don't depend on hover.
- **Forms:** errors announced and tied to the field (aria-describedby), clear required markers, no placeholder-only labels.
- **Check:** tab through the whole page once; zoom to 200%; read the page with styles off to see the order.
`),
  md(`---
name: landing-page-copy
description: Write landing page copy that converts - a specific headline, benefit-led sections, proof, objection handling and a clear call to action. Use it when a page needs words, not just layout.
scope: both
---
# Landing page copy

1. **Headline:** the outcome for the reader in under 10 words ("Your week, planned before Monday"), not the product category ("AI-powered planning platform").
2. **Sub-headline:** who it's for and how it works, one sentence.
3. **Primary CTA:** a verb + the value ("Start planning free"), repeated at the end.
4. **Benefits before features:** each section answers "so what?" for the reader. Features support benefits.
5. **Proof:** specific numbers, named customers or quotes (only real ones the user provided; otherwise leave a clearly marked spot), screenshots.
6. **Objections:** a short FAQ covering price, privacy, setup time, switching cost.
7. **Voice:** plain words, short sentences, active voice, no buzzwords ("revolutionary", "seamless", "leverage").
`),
];
