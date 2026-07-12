/**
 * OpenRouter chat-completion client for the LLM screener. Model defaults to a free tier
 * (`openai/gpt-oss-20b:free`, same as the meridian reference); override with
 * RH_OPENROUTER_MODEL. Best-effort: returns null if no key or on any failure.
 */
import { env } from "../config.js";
import { logger } from "../util/log.js";

const log = logger("llm");
const URL = "https://openrouter.ai/api/v1/chat/completions";

export interface LlmVerdict {
  score: number; // 0..100 conviction
  action: "ape" | "watch" | "skip";
  summary: string;
}

export async function llmScore(system: string, user: string): Promise<LlmVerdict | null> {
  if (!env.openrouterKey) return null;
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.openrouterKey}`,
        "Content-Type": "application/json",
        "X-Title": "Robinhood LP Bot",
      },
      body: JSON.stringify({
        model: env.openrouterModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 1200, // reasoning models spend tokens thinking before the JSON
      }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) {
      log.warn(`openrouter HTTP ${res.status}`);
      return null;
    }
    const j: any = await res.json();
    const msg = j?.choices?.[0]?.message ?? {};
    // reasoning models sometimes leave content null and put the answer in `reasoning`
    const content: string = msg.content || msg.reasoning || "";
    return parseVerdict(content);
  } catch (e) {
    log.warn(`openrouter gagal: ${(e as Error).message}`);
    return null;
  }
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
