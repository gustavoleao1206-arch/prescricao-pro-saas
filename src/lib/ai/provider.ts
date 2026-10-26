import { env } from "../env";

/**
 * Abstração do provedor de IA. Executa SEMPRE no servidor — as chaves nunca são
 * expostas ao navegador. Suporta Anthropic (Claude, recomendado) e OpenAI.
 *
 * Se nenhuma chave estiver configurada, `isConfigured` retorna false e o motor de
 * análise usa um modo heurístico local (claramente rotulado), para que a
 * aplicação seja demonstrável sem credenciais — sem inventar conteúdo jurídico.
 */

export interface LLMRequest {
  system: string;
  user: string;
  json?: boolean;
  maxTokens?: number;
}

export interface LLMResponse {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens lidos do cache de prompt (custam ~10% do preço normal). */
  cacheReadTokens?: number;
  /** Tokens gravados no cache (custam ~1,25x). Só compensa se houver leitura depois. */
  cacheWriteTokens?: number;
}

/**
 * Uma chave só conta como configurada se tiver o prefixo do provedor. Sem esta
 * checagem, um placeholder deixado no .env (ex.: "COLE_A_CHAVE_AQUI") passa por
 * "configurado", a chamada volta 401 e a análise inteira falha — quando o certo
 * é cair no modo heurístico e entregar algo auditável.
 */
function chaveUtilizavel(valor: string | undefined, prefixo: string): boolean {
  const v = valor?.trim() ?? "";
  return v.length > 20 && v.startsWith(prefixo);
}

export function isAiConfigured(): boolean {
  if (env.ai.provider === "anthropic") return chaveUtilizavel(env.ai.anthropicKey, "sk-ant-");
  return chaveUtilizavel(env.ai.openaiKey, "sk-");
}

export function activeModel(): string {
  return env.ai.provider === "anthropic" ? env.ai.anthropicModel : env.ai.openaiModel;
}

/** O erro é de limite de uso (429) e não de conteúdo? */
function eLimiteDeUso(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  return err?.status === 429 || /rate.?limit|too large|tokens per min|TPM/i.test(err?.message ?? "");
}

/**
 * O limite de tokens por minuto (TPM) é um orçamento que se renova. Uma análise
 * que estoura o teto passa na tentativa seguinte, quando a janela vira — então
 * desistir na primeira recusa entrega ao cliente um resultado pior sem motivo.
 * Só o 429 é repetido; erro de chave, de crédito ou de conteúdo falha na hora.
 */
export async function callLLM(req: LLMRequest): Promise<LLMResponse> {
  const maxTokens = req.maxTokens ?? env.ai.maxOutputTokens;
  const chamar = () =>
    env.ai.provider === "anthropic" ? callAnthropic(req, maxTokens) : callOpenAI(req, maxTokens);

  const esperas = [20_000, 40_000]; // duas novas tentativas; a janela do TPM é de 1 min
  for (let i = 0; ; i++) {
    try {
      return await chamar();
    } catch (e) {
      if (i >= esperas.length || !eLimiteDeUso(e)) throw e;
      const espera = esperas[i] ?? 20_000;
      console.warn(`[ia] limite de uso do provedor; nova tentativa em ${espera / 1000}s`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
}

async function callAnthropic(req: LLMRequest, maxTokens: number): Promise<LLMResponse> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: env.ai.anthropicKey });
  const system = req.json
    ? `${req.system}\n\nResponda EXCLUSIVAMENTE com um JSON válido, sem texto fora do JSON.`
    : req.system;

  // O prompt de sistema (metodologia + base de conhecimento) é estável entre
  // análises, então é elegível a cache. Ver env.ai.promptCache para quando ligar.
  const systemParam = env.ai.promptCache
    ? [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const } }]
    : system;

  const msg = await client.messages.create({
    model: env.ai.anthropicModel,
    max_tokens: maxTokens,
    system: systemParam,
    messages: [{ role: "user", content: req.user }],
  });

  const text = msg.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");

  const usage = msg.usage as typeof msg.usage & {
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };

  return {
    text,
    model: env.ai.anthropicModel,
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    cacheReadTokens: usage?.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? undefined,
  };
}

async function callOpenAI(req: LLMRequest, maxTokens: number): Promise<LLMResponse> {
  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: env.ai.openaiKey });

  const res = await client.chat.completions.create({
    model: env.ai.openaiModel,
    max_tokens: maxTokens,
    ...(req.json ? { response_format: { type: "json_object" as const } } : {}),
    messages: [
      { role: "system", content: req.system },
      { role: "user", content: req.user },
    ],
  });

  return {
    text: res.choices[0]?.message?.content ?? "",
    model: env.ai.openaiModel,
    inputTokens: res.usage?.prompt_tokens,
    outputTokens: res.usage?.completion_tokens,
  };
}

/** Extrai o primeiro objeto JSON de um texto (tolerante a cercas de código). */
export function extractJson<T = unknown>(text: string): T | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence?.[1] ?? text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
