import type { ProviderKind, ProviderOptions, ProviderSpecView } from "@/lib/types";

export type Protocol = "openai" | "anthropic" | "gemini" | "ollama";

export interface ProviderSpec extends ProviderSpecView {
  protocol: Protocol;
  defaults?: Partial<ProviderOptions>;
  staticModels?: string[];
  headers?: Record<string, string>;
}

const openai = (s: Omit<ProviderSpec, "protocol" | "canListModels" | "editableBaseUrl" | "nativeTools"> & Partial<ProviderSpec>): ProviderSpec => ({
  protocol: "openai", canListModels: true, editableBaseUrl: false, nativeTools: true, ...s,
});

export const CATALOG: ProviderSpec[] = [
  openai({
    kind: "openai", label: "OpenAI", group: "hosted", blurb: "GPT models from OpenAI.",
    baseUrl: "https://api.openai.com/v1", requiresKey: true, defaultModel: "gpt-4o-mini",
    exampleModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1"], keyUrl: "https://platform.openai.com/api-keys",
    defaults: { tokenParam: "max_completion_tokens" },
  }),
  {
    kind: "anthropic", label: "Anthropic Claude", group: "hosted", blurb: "Claude models, with native tool use.",
    protocol: "anthropic", baseUrl: "https://api.anthropic.com", requiresKey: true, defaultModel: "claude-sonnet-5-5",
    exampleModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001"], nativeTools: true,
    canListModels: true, editableBaseUrl: false, keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    kind: "gemini", label: "Google Gemini", group: "hosted", blurb: "Gemini models from Google AI Studio.",
    protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com", requiresKey: true, defaultModel: "gemini-flash-latest",
    exampleModels: ["gemini-flash-latest", "gemini-pro-latest"], nativeTools: true, canListModels: true,
    editableBaseUrl: false, keyUrl: "https://aistudio.google.com/apikey",
  },
  openai({
    kind: "mistral", label: "Mistral", group: "hosted", blurb: "Mistral and Codestral models.",
    baseUrl: "https://api.mistral.ai/v1", requiresKey: true, defaultModel: "mistral-large-latest",
    exampleModels: ["mistral-large-latest", "mistral-small-latest", "codestral-latest"], keyUrl: "https://console.mistral.ai/api-keys",
  }),
  openai({
    kind: "deepseek", label: "DeepSeek", group: "hosted", blurb: "DeepSeek chat and reasoning models.",
    baseUrl: "https://api.deepseek.com", requiresKey: true, defaultModel: "deepseek-chat",
    exampleModels: ["deepseek-chat", "deepseek-reasoner"], keyUrl: "https://platform.deepseek.com/api_keys",
  }),
  openai({
    kind: "xai", label: "xAI Grok", group: "hosted", blurb: "Grok models from xAI.",
    baseUrl: "https://api.x.ai/v1", requiresKey: true, defaultModel: "grok-4",
    exampleModels: ["grok-4", "grok-3-mini"], keyUrl: "https://console.x.ai",
  }),
  openai({
    kind: "perplexity", label: "Perplexity", group: "hosted", blurb: "Search-grounded Sonar models (no tool calling).",
    baseUrl: "https://api.perplexity.ai", requiresKey: true, defaultModel: "sonar",
    exampleModels: ["sonar", "sonar-pro", "sonar-reasoning"], canListModels: false, nativeTools: false,
    staticModels: ["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro"], defaults: { nativeTools: false },
    keyUrl: "https://www.perplexity.ai/settings/api",
  }),
  openai({
    kind: "openrouter", label: "OpenRouter", group: "gateway", blurb: "One key for hundreds of models from many vendors.",
    baseUrl: "https://openrouter.ai/api/v1", requiresKey: true, defaultModel: "openai/gpt-4o-mini",
    exampleModels: ["openai/gpt-4o-mini", "anthropic/claude-sonnet-4.5", "meta-llama/llama-3.3-70b-instruct"],
    keyUrl: "https://openrouter.ai/keys", headers: { "x-title": "Morphie" },
  }),
  openai({
    kind: "groq", label: "Groq", group: "hosted", blurb: "Very fast open-model inference.",
    baseUrl: "https://api.groq.com/openai/v1", requiresKey: true, defaultModel: "llama-3.3-70b-versatile",
    exampleModels: ["llama-3.3-70b-versatile", "openai/gpt-oss-120b"], keyUrl: "https://console.groq.com/keys",
  }),
  openai({
    kind: "together", label: "Together AI", group: "hosted", blurb: "Open models on Together's cloud.",
    baseUrl: "https://api.together.xyz/v1", requiresKey: true, defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    exampleModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo", "Qwen/Qwen2.5-72B-Instruct-Turbo"], keyUrl: "https://api.together.ai/settings/api-keys",
  }),
  openai({
    kind: "fireworks", label: "Fireworks AI", group: "hosted", blurb: "Fast open-model inference.",
    baseUrl: "https://api.fireworks.ai/inference/v1", requiresKey: true, defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    exampleModels: ["accounts/fireworks/models/llama-v3p3-70b-instruct"], keyUrl: "https://fireworks.ai/account/api-keys",
  }),
  openai({
    kind: "cerebras", label: "Cerebras", group: "hosted", blurb: "Extremely fast inference on wafer-scale chips.",
    baseUrl: "https://api.cerebras.ai/v1", requiresKey: true, defaultModel: "llama-3.3-70b",
    exampleModels: ["llama-3.3-70b", "qwen-3-32b"], keyUrl: "https://cloud.cerebras.ai",
  }),
  openai({
    kind: "apmixai", label: "APMIX.AI", group: "gateway", blurb: "GPT, Claude and Gemini behind one key.",
    baseUrl: "https://api.apmix.ai/v1", requiresKey: true, defaultModel: "claude-opus-5-free",
    exampleModels: ["claude-opus-5-free", "claude-sonnet-4-6-free", "gpt-5.6-free", "gemini-3-flash-preview-free"], keyUrl: "https://apmix.ai/docs",
  }),
  {
    kind: "ollama", label: "Ollama", group: "local", blurb: "Run models locally, or use Ollama Cloud with a key.",
    protocol: "ollama", baseUrl: "http://localhost:11434", requiresKey: false, defaultModel: "llama3.1",
    exampleModels: ["llama3.1", "qwen2.5", "gemma3"], nativeTools: true, canListModels: true, editableBaseUrl: true,
    keyUrl: "https://ollama.com/download",
  },
  openai({
    kind: "lmstudio", label: "LM Studio", group: "local", blurb: "Local server from LM Studio (OpenAI-compatible).",
    baseUrl: "http://localhost:1234/v1", requiresKey: false, defaultModel: "local-model",
    exampleModels: [], editableBaseUrl: true, keyUrl: "https://lmstudio.ai",
  }),
  openai({
    kind: "custom", label: "OpenAI-compatible (custom)", group: "custom",
    blurb: "Any endpoint that speaks the OpenAI chat API: you set the base URL, key, headers and more.",
    baseUrl: "", requiresKey: false, defaultModel: "", exampleModels: [], editableBaseUrl: true,
  }),
];

const BY_KIND = new Map(CATALOG.map((s) => [s.kind, s]));

export function specFor(kind: string): ProviderSpec | undefined {
  return BY_KIND.get(kind as ProviderKind);
}

/** Client-safe view of the catalog. */
export function publicCatalog(): ProviderSpecView[] {
  return CATALOG.map(({ protocol: _p, defaults: _d, staticModels: _s, headers: _h, ...view }) => view);
}

/** Presets shown in the custom-provider form. */
export const CUSTOM_PRESETS: Array<{ id: string; label: string; baseUrl: string; note: string; options?: ProviderOptions }> = [
  { id: "codecraft", label: "CodeCraft API", baseUrl: "https://codecraftapi.com/v1", note: "Coding-agent gateway. Uses your CodeCraft key as a Bearer token." },
  { id: "litellm", label: "LiteLLM proxy", baseUrl: "http://localhost:4000/v1", note: "Self-hosted proxy in front of many providers." },
  { id: "vllm", label: "vLLM server", baseUrl: "http://localhost:8000/v1", note: "Local vLLM OpenAI server." },
  { id: "llamacpp", label: "llama.cpp server", baseUrl: "http://localhost:8080/v1", note: "llama-server's OpenAI endpoint." },
  { id: "azure", label: "Azure OpenAI", baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT", note: "Uses an api-key header and an api-version query parameter.",
    options: { authStyle: "api-key", queryParams: { "api-version": "2024-10-21" } } },
  { id: "blank", label: "Something else", baseUrl: "", note: "Start from scratch." },
];
