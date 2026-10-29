import { specFor } from "./providers/catalog";
import { assertProviderHostAllowed, createProvider, type ResolvedProfile } from "./providers/factory";
import { ProviderError } from "./providers/types";
import { SecurityError } from "./security";

export interface TestReport {
  ok: boolean;
  message: string;
  latencyMs?: number;
  reply?: string;
  tools?: "supported" | "not_detected" | "prompted" | "skipped";
  hint?: string;
}

/** Connectivity + (optionally) tool-calling probe. Never throws; failures are reported in the result. */
export async function testProvider(profile: ResolvedProfile, signal?: AbortSignal): Promise<TestReport> {
  try {
    await assertProviderHostAllowed(profile);
    const provider = createProvider(profile);
    const started = Date.now();
    const out = await provider.chat({
      messages: [{ role: "system", content: "Reply as briefly as possible." }, { role: "user", content: "Reply with the single word: pong" }],
      maxTokens: 256, signal,
    });
    const latencyMs = Date.now() - started;
    const reply = out.content.trim().slice(0, 80);
    const report: TestReport = {
      ok: true, latencyMs, reply,
      message: reply ? `Connected in ${latencyMs} ms.` : `Connected in ${latencyMs} ms, but the reply was empty (normal for some reasoning models).`,
      tools: "skipped",
    };

    const spec = specFor(profile.kind);
    const native = !!spec?.nativeTools && profile.options.nativeTools !== false;
    if (!native) { report.tools = "prompted"; report.hint = "Tool calling is emulated with prompts for this provider."; return report; }
    try {
      const probe = await provider.chat({
        messages: [{ role: "user", content: "What time is it in UTC? You must call the get_current_time tool to find out; do not answer directly." }],
        tools: [{ name: "get_current_time", description: "Get the current time in a timezone.", parameters: { type: "object", properties: { location: { type: "string" } } } }],
        maxTokens: 256, signal,
      });
      report.tools = probe.toolCalls.length ? "supported" : "not_detected";
      if (!probe.toolCalls.length) report.hint = "The model didn't call a tool. If agent mode misbehaves, turn off “Native tool calling” for this provider to use prompt-based tools instead.";
    } catch (e) {
      report.tools = "not_detected";
      report.hint = e instanceof ProviderError ? `Tool probe failed: ${e.message}` : "Tool probe failed.";
    }
    return report;
  } catch (e) {
    if (e instanceof ProviderError || e instanceof SecurityError) return { ok: false, message: e.message };
    console.error("[provider-test]", e);
    return { ok: false, message: "The test failed unexpectedly." };
  }
}
