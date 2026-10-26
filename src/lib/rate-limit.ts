import { env } from "./env";

/**
 * Rate limiting simples em memória (janela deslizante por chave).
 *
 * ⚠️ Produção com múltiplas instâncias: substituir por store compartilhado
 * (Redis/Upstash). A interface é mantida para facilitar a troca.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export interface RateResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function rateLimit(
  key: string,
  max: number = env.security.rateLimitMax,
  windowSeconds: number = env.security.rateLimitWindow,
): RateResult {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: max - 1, resetAt };
  }

  existing.count += 1;
  const allowed = existing.count <= max;
  return { allowed, remaining: Math.max(0, max - existing.count), resetAt: existing.resetAt };
}

/**
 * Quanto falta para o balde virar, em texto para o cliente.
 *
 * ── Por que a recusa TEM de dizer o prazo ─────────────────────────────────────
 * "Aguarde alguns minutos" não é informação: o limite do reenvio de confirmação é de 15 minutos
 * e o do cadastro é de uma HORA, e as duas recusas diziam a mesma frase. Quem lê "alguns
 * minutos" tenta de novo em dois, falha, tenta em cinco, falha — e cada tentativa recusada NÃO
 * consome cota (o balde só conta até o teto), mas consome a paciência de quem está justamente
 * tentando consertar o próprio acesso para poder pagar. Sem o prazo, a saída é fechar a aba.
 *
 * O número já existia: `rateLimit` devolve `resetAt` desde sempre, e nenhuma rota o usava.
 *
 * ── Arredonda para CIMA, sempre ───────────────────────────────────────────────
 * Prometer menos espera do que a real faz a pessoa voltar cedo e ser recusada de novo — a
 * segunda recusa é a que ensina a não confiar no que a tela diz. Errar para mais custa uma
 * espera desnecessária; errar para menos custa a confiança.
 */
export function tempoDeEspera(resetAt: number, agora: number = Date.now()): string {
  const segundos = Math.max(0, Math.ceil((resetAt - agora) / 1000));
  if (segundos <= 60) return "cerca de 1 minuto";
  const minutos = Math.ceil(segundos / 60);
  if (minutos < 60) return `cerca de ${minutos} minutos`;
  const horas = Math.ceil(minutos / 60);
  return horas === 1 ? "cerca de 1 hora" : `cerca de ${horas} horas`;
}

/**
 * Uso justo por usuário nas operações do agente (processar, upload, downloads).
 * Generoso para uso humano; barra automação/flood. Retorna false se exceder.
 */
export function agentRateAllowed(userId: string, action: string): boolean {
  return rateLimit(`agent:${action}:${userId}`, env.security.agentRateMax, env.security.agentRateWindow).allowed;
}

/**
 * IP de origem, preferindo o cabeçalho que o PROXY escreve.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * A versão anterior lia o PRIMEIRO item de `x-forwarded-for` — e esse item é escolhido por quem
 * faz a requisição. `X-Forwarded-For: 1.2.3.4` num cliente qualquer fazia o sistema acreditar
 * que o IP era 1.2.3.4. Isso valia para tudo que depende de IP aqui:
 *
 *  - limite por IP virava decorativo: basta um valor diferente a cada tentativa;
 *  - e dava para NEGAR serviço a um IP escolhido, esgotando o balde dele de propósito;
 *  - o IP gravado nos eventos de segurança e nos consentimentos era o que o visitante quisesse,
 *    o que estraga justamente o registro que existe para investigar abuso.
 *
 * `x-real-ip` é escrito pelo proxy e sobrescreve o que o cliente mandar, então vem primeiro. Sem
 * ele, usa-se o ÚLTIMO item de `x-forwarded-for`: numa cadeia `cliente, proxy1, proxy2`, os itens
 * da esquerda podem ser inventados pelo cliente, e o da direita foi acrescentado pelo proxy mais
 * próximo — o único que não é forjável.
 *
 * ⚠️ Cuidado a manter em mente: se um dia houver CDN em modo proxy na frente (Cloudflare, por
 * exemplo), o valor visto aqui passa a ser o da borda da CDN, e limites por IP ficariam por NÓ da
 * CDN em vez de por cliente — mais restritivos do que se quer. O sinal disso é limite por IP
 * disparando para gente legítima; a correção então é usar o cabeçalho específico da CDN.
 */
export function clientIp(req: Request): string {
  /**
   * ⚠️ `CF-Connecting-IP` PRIMEIRO — a produção está atrás da Cloudflare, e isto não era considerado.
   *
   * O comentário abaixo já previa o cenário ("se um dia houver CDN em modo proxy na frente"); a auditoria
   * confirmou que esse dia é hoje: a resposta de `https://prescricaopro.com.br` traz `Server: cloudflare`
   * e `CF-RAY`. Nessa arquitetura, `x-real-ip` e o fim do `x-forwarded-for` passam a ser endereços da
   * borda da CDN, não do visitante.
   *
   * Duas consequências, e a segunda é jurídica: o limite por IP passava a contar por NÓ DA CLOUDFLARE em
   * vez de por pessoa, e o IP gravado nos eventos de segurança e nos CONSENTIMENTOS de LGPD podia não ser
   * o do titular — estragando justamente o registro que existe para investigar abuso e para provar
   * consentimento.
   *
   * `CF-Connecting-IP` é escrito pela Cloudflare e sobrescreve o que o cliente mandar. Se um dia a CDN
   * sair da frente, o cabeçalho deixa de existir e a função cai naturalmente para os seguintes.
   */
  const cloudflare = req.headers.get("cf-connecting-ip")?.trim();
  if (cloudflare) return cloudflare;

  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const itens = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (itens.length) return itens[itens.length - 1]!;
  }
  return "0.0.0.0";
}

// Limpeza periódica para não vazar memória (executa no processo Node).
if (typeof setInterval !== "undefined") {
  setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, 60_000).unref?.();
}
