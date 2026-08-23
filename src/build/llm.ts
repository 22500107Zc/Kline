import { BUILD_SHAPES, BuildPlan, validatePlan } from './plan';

/**
 * Optional model backends for the build prompt.
 *
 * On cost, plainly: **Ollama is the only option that is free forever** — it
 * runs on your own machine, needs no account and makes no network calls. The
 * OpenAI-compatible provider works with anything that speaks that API, which
 * includes free tiers (Groq, OpenRouter's free models) and other local servers
 * (LM Studio, llama.cpp, vLLM). Free tiers are free today, rate-limited, and
 * not promises — so nothing here is on by default and the built-in interpreter
 * always answers first.
 *
 * Small models are unreliable at freeform 3D. They are reasonably good at
 * filling in a flat JSON array of boxes and cylinders, which is exactly what
 * the schema below asks for, and everything they return is validated and
 * repaired before it reaches the scene.
 */

export type ProviderKind = 'ollama' | 'openai';

export interface LLMConfig {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  /** Only sent to an OpenAI-compatible endpoint; never needed for Ollama. */
  apiKey: string;
}

export const PROVIDER_DEFAULTS: Record<ProviderKind, Omit<LLMConfig, 'provider'>> = {
  ollama: { baseUrl: 'http://127.0.0.1:11434', model: 'llama3.2', apiKey: '' },
  openai: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: '' },
};

const STORAGE_KEY = 'kiln.build.llm';

export function loadConfig(): LLMConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LLMConfig>;
      const provider: ProviderKind = parsed.provider === 'openai' ? 'openai' : 'ollama';
      // Stored values win, but a missing field falls back to the provider default.
      return { ...PROVIDER_DEFAULTS[provider], ...parsed, provider };
    }
  } catch {
    /* Unreadable or unavailable storage; fall through to defaults. */
  }
  return { provider: 'ollama', ...PROVIDER_DEFAULTS.ollama };
}

export function saveConfig(config: LLMConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* Nothing to do; the settings just will not persist. */
  }
}

const trimUrl = (url: string): string => url.replace(/\/+$/, '');

export const SYSTEM_PROMPT = `You turn a description of an object into a 3D build plan.

Reply with JSON only. No prose, no markdown fences. The shape is:
{"name":"short name","parts":[{"shape":"cube","name":"Leg","position":[x,y,z],"size":[w,d,h],"color":"#rrggbb"}]}

Rules:
- "shape" is one of: ${BUILD_SHAPES.join(', ')}.
- Units are metres. Z is up. The ground is z = 0.
- "position" is the CENTRE of the part, so a 1m tall box on the floor is z = 0.5.
- "size" is the bounding box [width, depth, height] in metres. Never 0.
- Keep everything at or above the ground and roughly life-sized: a chair seat is
  about 0.45m up, a door is about 2m tall, a car is about 4m long.
- Use 3 to 40 parts. Build the object out of simple primitives.
- "color" is a hex string. Optional "rotation" is degrees [x,y,z].
- Centre the object on x = 0, y = 0.

Example for "a wooden stool":
{"name":"Stool","parts":[
{"shape":"cylinder","name":"Seat","position":[0,0,0.6],"size":[0.34,0.34,0.05],"color":"#8b5e34"},
{"shape":"cylinder","name":"Leg","position":[0.12,0,0.29],"size":[0.04,0.04,0.58],"color":"#8b5e34"},
{"shape":"cylinder","name":"Leg","position":[-0.06,0.1,0.29],"size":[0.04,0.04,0.58],"color":"#8b5e34"},
{"shape":"cylinder","name":"Leg","position":[-0.06,-0.1,0.29],"size":[0.04,0.04,0.58],"color":"#8b5e34"}]}`;

export interface ProbeResult {
  ok: boolean;
  /** Model names the endpoint reports, when it can. */
  models: string[];
  detail: string;
}

/** Is anything listening, and what can it run? Never throws. */
export async function probeProvider(config: LLMConfig, timeoutMs = 3000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const base = trimUrl(config.baseUrl);
  try {
    const url = config.provider === 'ollama' ? `${base}/api/tags` : `${base}/models`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (config.provider === 'openai' && config.apiKey) {
      headers.authorization = `Bearer ${config.apiKey}`;
    }
    const response = await fetch(url, { signal: controller.signal, headers });
    if (!response.ok) {
      return {
        ok: false,
        models: [],
        detail: response.status === 401 || response.status === 403
          ? 'The endpoint rejected the key.'
          : `The endpoint answered ${response.status}.`,
      };
    }
    const body = (await response.json()) as Record<string, unknown>;
    const list = config.provider === 'ollama'
      ? (body.models as { name?: string }[] | undefined)?.map((m) => m.name ?? '') ?? []
      : (body.data as { id?: string }[] | undefined)?.map((m) => m.id ?? '') ?? [];
    const models = list.filter(Boolean).sort();
    return {
      ok: true,
      models,
      detail: models.length ? `${models.length} model(s) available.` : 'Connected, but no models are installed.',
    };
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError';
    return {
      ok: false,
      models: [],
      detail: aborted
        ? 'No answer before the timeout.'
        : config.provider === 'ollama'
          ? 'Nothing listening. Install Ollama and run `ollama serve`.'
          : 'Could not reach that endpoint.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the first JSON object out of a reply, tolerating fences and stray prose. */
export function extractJSON(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // Trailing commas are the single most common thing small models get wrong.
    try {
      return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}

async function chat(
  config: LLMConfig, messages: { role: string; content: string }[], signal?: AbortSignal,
): Promise<string> {
  const base = trimUrl(config.baseUrl);
  if (config.provider === 'ollama') {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: false,
        format: 'json',
        options: { temperature: 0.3 },
      }),
    });
    if (!response.ok) throw new Error(`Ollama answered ${response.status}. Is "${config.model}" pulled?`);
    const body = (await response.json()) as { message?: { content?: string } };
    return body.message?.content ?? '';
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`The endpoint answered ${response.status}. ${text.slice(0, 160)}`.trim());
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? '';
}

export interface GenerateResult {
  plan: BuildPlan;
  warnings: string[];
  seconds: number;
}

/**
 * Ask the model for a plan. One repair round-trip is allowed, because small
 * models routinely get the JSON right on the second try when told what broke.
 */
export async function generatePlan(
  config: LLMConfig, prompt: string, signal?: AbortSignal,
): Promise<GenerateResult> {
  const started = Date.now();
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  let reply = await chat(config, messages, signal);
  let parsed = extractJSON(reply);
  let result = validatePlan(parsed, prompt.slice(0, 30));

  if (!result.plan) {
    messages.push({ role: 'assistant', content: reply.slice(0, 2000) });
    messages.push({
      role: 'user',
      content: 'That was not a usable plan. Reply with JSON only, matching the schema exactly, with a non-empty "parts" array.',
    });
    reply = await chat(config, messages, signal);
    parsed = extractJSON(reply);
    result = validatePlan(parsed, prompt.slice(0, 30));
  }

  if (!result.plan) {
    throw new Error(`${config.model} did not return a usable plan. Try a larger model, or a simpler description.`);
  }
  return {
    plan: { ...result.plan, source: `${config.provider}:${config.model}` },
    warnings: result.warnings,
    seconds: (Date.now() - started) / 1000,
  };
}
