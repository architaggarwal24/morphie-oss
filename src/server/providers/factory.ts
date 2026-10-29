import type { ProviderOptions } from "@/lib/types";
import { config } from "../config";
import { SecurityError, assertPublicHost, validateBaseUrl } from "../security";
import { AnthropicProvider } from "./anthropic";
import { specFor } from "./catalog";
import { GeminiProvider } from "./gemini";
import { OllamaProvider } from "./ollama";
import { OpenAICompatProvider } from "./openaiCompat";
import { PromptedToolsProvider } from "./promptedTools";
import type { Provider } from "./types";

/** Everything needed to build a provider, decrypted. Never sent to the browser. */
export interface ResolvedProfile {
  id: string;
  kind: string;
  label: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  options: ProviderOptions;
}

export function createProvider(p: ResolvedProfile): Provider {
  const spec = specFor(p.kind);
  if (!spec) throw new SecurityError(`Unknown provider "${p.kind}".`);
  if (!p.model.trim()) throw new SecurityError("Choose a model first.");
  if (spec.requiresKey && !p.apiKey) throw new SecurityError(`${spec.label} needs an API key.`);

  const baseUrl = spec.editableBaseUrl
    ? validateBaseUrl(p.baseUrl || spec.baseUrl, { allowPrivate: config.allowPrivateUrls })
    : spec.baseUrl;
  const options = { ...p.options };
  if (spec.headers) options.extraHeaders = { ...spec.headers, ...options.extraHeaders };

  let provider: Provider;
  switch (spec.protocol) {
    case "anthropic":
      provider = new AnthropicProvider({ apiKey: p.apiKey!, model: p.model, maxTokens: options.maxTokens, vision: options.vision, contextWindow: options.contextWindow });
      break;
    case "gemini":
      provider = new GeminiProvider({ apiKey: p.apiKey!, model: p.model, contextWindow: options.contextWindow });
      break;
    case "ollama":
      provider = new OllamaProvider({ baseUrl, model: p.model, apiKey: p.apiKey, vision: options.vision ?? guessVision(p.model), contextWindow: options.contextWindow });
      break;
    default:
      provider = new OpenAICompatProvider({
        kind: p.kind, label: p.kind === "custom" ? p.label || "Custom provider" : spec.label, baseUrl, apiKey: p.apiKey,
        model: p.model, options: { ...options, vision: options.vision ?? guessVision(p.model) }, defaults: spec.defaults, staticModels: spec.staticModels,
      });
  }
  return provider.nativeTools ? provider : new PromptedToolsProvider(provider);
}

/** Well-known multimodal model families (a profile's own "vision" switch always wins). */
export function guessVision(model: string): boolean {
  return /gpt-4o|gpt-4\.1|gpt-5|o3|o4|claude|gemini|llava|vision|-vl|qwen2\.5-vl|qwen3-vl|pixtral|gemma3|llama-?4|grok-4|grok-2-vision|minicpm-v|moondream/i.test(model);
}

/** When the server forbids private networks, also resolve DNS so a public-looking name can't point inward. */
export async function assertProviderHostAllowed(p: ResolvedProfile): Promise<void> {
  const spec = specFor(p.kind);
  if (!spec?.editableBaseUrl || config.allowPrivateUrls) return;
  const url = validateBaseUrl(p.baseUrl || spec.baseUrl, { allowPrivate: false });
  await assertPublicHost(new URL(url).hostname);
}
