import type { LlmProvider, LlmRequest, LlmResponse } from "@loom/llm";

const DEFAULT_MODEL = "gemini-2.0-flash";

/**
 * A real Gemini provider in ~25 lines. loom's `LlmProvider` is a single
 * `complete()` method, so any model backend drops in without touching the flow —
 * this is loom's provider-agnosticism (P8) made concrete. Talk track: "swapping
 * Anthropic → Gemini touched exactly this one file."
 */
export class GeminiProvider implements LlmProvider {
  constructor(
    private readonly model: string = DEFAULT_MODEL,
    private readonly apiKey: string = "",
  ) {}

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: req.signal ?? null,
      body: JSON.stringify({
        systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
        contents: req.messages.map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          temperature: req.temperature ?? 0,
          maxOutputTokens: req.maxTokens ?? 512,
          // Server-enforced JSON so the flow's JSON.parse never trips on prose.
          responseMimeType: "application/json",
        },
      }),
    });
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const content = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    return { content, stopReason: "end_turn" };
  }
}

/**
 * Deterministic offline fallback — same interface, same JSON shape — so the demo
 * (especially the browser) still works with no network or key. It mirrors what a
 * real reviewer would say for the seeded scenarios.
 */
export class ScriptedLlmProvider implements LlmProvider {
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const text = req.messages.map((m) => m.content).join(" ");
    const lock = text.match(/lock (\d+)s/i);
    const lockSeconds = lock ? Number(lock[1]) : 0;
    const risky = /add-index|drop-column|backfill/i.test(text) || lockSeconds > 30;
    const body = risky
      ? {
          risk: "high",
          rationale: "Long table lock on a large table risks downtime — needs a human sign-off.",
        }
      : { risk: "low", rationale: "Metadata-only change with negligible lock time." };
    return { content: JSON.stringify(body), stopReason: "end_turn" };
  }
}

function resolveKey(): string {
  if (typeof process !== "undefined" && process.env?.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }
  // In the browser the presenter can paste a key (App.tsx sets this global).
  const g = globalThis as { __GEMINI_API_KEY__?: string };
  return g.__GEMINI_API_KEY__ ?? "";
}

/**
 * The one provider the flow imports. Resolved per call so it picks the real
 * Gemini call whenever a key is present (headless: `GEMINI_API_KEY`; browser:
 * `window.__GEMINI_API_KEY__`) and falls back to the offline provider otherwise.
 */
export const llm: LlmProvider = {
  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = resolveKey();
    const provider: LlmProvider = key
      ? new GeminiProvider(DEFAULT_MODEL, key)
      : new ScriptedLlmProvider();
    return provider.complete(req);
  },
};
