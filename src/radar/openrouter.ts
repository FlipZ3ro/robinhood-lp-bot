/**
 * LLM screener client — any OpenAI-compatible chat-completions endpoint (OpenRouter by
 * default; RH_OPENROUTER_URL points it at a custom gateway). stream:false so we always get
 * one JSON body. Best-effort: returns null if no key or on any failure.
 */
import { env } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("llm");

export interface LlmVerdict {
  score: number; // 0..100 conviction
  action: "ape" | "watch" | "skip";
  summary: string;
}

export async function llmScore(system: string, user: string): Promise<LlmVerdict | null> {
  if (!env.openrouterKey) return null;
  const body = JSON.stringify({
    model: env.openrouterModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    stream: false, // some gateways stream by default; we want one JSON body
    temperature: 0.2,
    max_tokens: 1200,
  });
  // Free models throttle upstream (HTTP 429 with Retry-After) — retry once, briefly.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(env.openrouterUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.openrouterKey}`, "Content-Type": "application/json", "X-Title": "Robinhood LP Bot" },
        body,
        signal: AbortSignal.timeout(40_000),
      });
      if (res.status === 429 && attempt === 0) {
        const wait = Math.min(8000, (Number(res.headers.get("retry-after")) || 5) * 1000);
        log.warn(`openrouter 429 (free throttle) — retry in ${wait}ms`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      if (!res.ok) {
        log.warn(`openrouter HTTP ${res.status}`);
        return null;
      }
      const j: any = await res.json();
      const msg = j?.choices?.[0]?.message ?? {};
      // reasoning models sometimes leave content null and put the answer in `reasoning`
      return parseVerdict(msg.content || msg.reasoning || "");
    } catch (e) {
      log.warn(`openrouter gagal: ${(e as Error).message}`);
      return null;
    }
  }
  return null;
}

function parseVerdict(content: string): LlmVerdict | null {
  let obj: any;
  try {
    obj = JSON.parse(content);
  } catch {
    const m = content.match(/\{[\s\S]*\}/); // some models wrap JSON in prose
    if (!m) return null;
    try {
      obj = JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  const score = Math.max(0, Math.min(100, Number(obj.score) || 0));
  const action = ["ape", "watch", "skip"].includes(obj.action) ? obj.action : score >= 70 ? "ape" : score >= 40 ? "watch" : "skip";
  return { score, action, summary: String(obj.summary ?? "").slice(0, 240) };
}
