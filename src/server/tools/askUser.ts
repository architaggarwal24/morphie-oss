import type { AskQuestion } from "@/lib/types";
import { ToolError, type ToolDef } from "./types";

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Validate the model's questions into the shape the question card shows. */
export function parseQuestions(raw: unknown): AskQuestion[] {
  if (!Array.isArray(raw) || !raw.length) throw new ToolError('"questions" must be a list of 1–4 questions.');
  if (raw.length > 4) throw new ToolError("Ask at most 4 questions at once.");
  const seen = new Set<string>();
  return raw.map((q, i) => {
    const o = (q && typeof q === "object" ? q : {}) as Record<string, unknown>;
    const question = clean(o.question, 300);
    if (!question) throw new ToolError(`Question ${i + 1} has no "question" text.`);
    if (seen.has(question)) throw new ToolError(`Question ${i + 1} repeats an earlier one.`);
    seen.add(question);
    const opts = Array.isArray(o.options) ? o.options : [];
    const options = opts.slice(0, 4).map((x) => {
      const ob = (x && typeof x === "object" ? x : { label: x }) as Record<string, unknown>;
      return { label: clean(ob.label, 80), description: clean(ob.description, 200) || undefined };
    }).filter((x) => x.label);
    if (options.length < 2) throw new ToolError(`Question ${i + 1} needs 2–4 options (the user can always type their own answer).`);
    return { question, header: clean(o.header, 16) || undefined, multiSelect: o.multiSelect === true || undefined, options };
  });
}

/** The answers, as the model reads them. */
export function formatAnswers(questions: AskQuestion[], answers: Record<string, string> | null): string {
  if (!answers || !Object.values(answers).some((a) => a?.trim())) {
    return "The user skipped these questions. Use sensible defaults, say which ones you chose in your final answer, and carry on.";
  }
  const lines = questions.map((q) => `- ${q.question}\n  → ${answers[q.question]?.trim() || "(no answer: use your best judgment)"}`);
  return `The user answered:\n${lines.join("\n")}\n\nFollow these answers. Don't ask about the same things again.`;
}

export const askUserTool: ToolDef = {
  name: "ask_user",
  label: "Question",
  description:
    "Ask the user 1–4 multiple-choice questions and wait for the answers. Use it before starting a big or open-ended task when a choice would change the result " +
    "(scope, audience, style, stack, which of several readings they mean) and you can't tell from the request. Ask once, up front, with everything you need; " +
    "don't use it for things you can find out yourself or for permission to continue. Each question has 2–4 short options (the user can also type their own).",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1, maxItems: 4,
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The full question, ending with a question mark." },
            header: { type: "string", description: "A 1–2 word label for it, e.g. Audience." },
            multiSelect: { type: "boolean", description: "True when several options can be picked together." },
            options: {
              type: "array", minItems: 2, maxItems: 4,
              items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] },
            },
          },
          required: ["question", "options"],
        },
      },
    },
    required: ["questions"],
  },
  risk: "safe", modes: ["agent"], readOnly: true,
  describeCall: (a) => {
    const n = Array.isArray(a.questions) ? a.questions.length : 0;
    return n === 1 ? "Ask you a question" : `Ask you ${n || "some"} questions`;
  },
  async run(args, ctx) {
    const questions = parseQuestions(args.questions);
    if (!ctx.ask) return { text: "Nobody can answer questions in this run. Use sensible defaults and say which you chose.", summary: "No one to ask" };
    const answers = await ctx.ask(questions);
    const answered = answers ? Object.values(answers).filter((a) => a?.trim()).length : 0;
    return { text: formatAnswers(questions, answers), summary: answered ? `${answered} answered` : "Skipped" };
  },
};
