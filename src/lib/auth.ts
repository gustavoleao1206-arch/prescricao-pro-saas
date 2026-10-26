import { cookies } from "next/headers";
import { prisma } from "./db";
import { env } from "./env";
import { randomToken, sha256 } from "./crypto";
import { logSecurityEvent } from "./audit";
import type { Role, User } from "@prisma/client";

/**
 * Sessões baseadas em tokens opacos armazenados como hash (sha-256) na tabela
 * Session. Vantagens: revogação individual/global, expiração e ausência de
 * dados sensíveis no cookie. O cookie guarda apenas o token opaco.
 */

const COOKIE_NAME = "ptp_session";

/**
 * Exportado para os layouts poderem distinguir "nunca entrou" de "a sessão acabou".
 *
 * Cookie presente com sessão inválida só acontece de um jeito: a sessão existiu e deixou de
 * valer. É o que permite a tela de login dizer o motivo em vez de aparecer limpa — logout sem
 * explicação é lido como sistema quebrado.
 */
export const NOME_DO_COOKIE_DE_SESSAO = COOKIE_NAME;

export type SessionUser = Pick<
  User,
  /**
   * `emailVerifiedAt` entra aqui porque o layout da área logada decide por ele se mostra o aviso
   * de "confirme seu e-mail" — e é o MESMO fato que o gate de contratação usa. Antes o aviso
   * olhava `status`, e os dois divergem: a rota administrativa e a redefinição de senha gravam
   * ATIVO sem tocar na data. Conta nesse estado ficava barrada ao contratar e sem o aviso que
   * oferece o reenvio, ou seja, com a recusa apontando para um botão inexistente.
   */
  "id" | "email" | "name" | "role" | "status" | "organizationId" | "orgRole" | "emailVerifiedAt"
>;

export async function createSession(userId: string, meta?: { ip?: string; userAgent?: string }) {
  const token = randomToken(48);
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + env.sessionMaxAge * 1000);

  await prisma.session.create({
    data: { userId, tokenHash, expiresAt, ip: meta?.ip, userAgent: meta?.userAgent },
  });

  (await cookies()).set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: env.isProd,
    sameSite: "lax",
    path: "/",
    maxAge: env.sessionMaxAge,
  });

  return token;
}

/**
 * Encerramento por INATIVIDADE.
 *
 * ── Por que existe, e o que é diferente do prazo absoluto ─────────────────────
 * `Session.expiresAt` é o prazo absoluto: a sessão morre nele, tenha sido usada ou não —
 * hoje 7 dias. Ele não cobre o risco que mais importa aqui, que é a TELA LOGADA DEIXADA
 * ABERTA: o computador do escritório, com autos de execução fiscal e dados de terceiros sob
 * sigilo profissional na frente de quem passar. Prazo absoluto não sabe se tem alguém ali.
 *
 * `lastSeenAt` mede a outra coisa, e é ela que encerra.
 *
 * ── A sessão é REVOGADA, não só recusada ──────────────────────────────────────
 * Recusar e deixar a linha válida no banco faria o token continuar servindo caso a conta do
 * relógio mudasse (fuso, correção de hora, ajuste do prazo para mais). Revogar é o que
 * torna o encerramento definitivo: `revokedAt` é o mesmo campo que a saída manual usa, e
 * daí em diante nenhum caminho aceita aquele token.
 */
/**
 * Quem é da EQUIPE tem o prazo curto de inatividade. Só o CLIENTE tem o comum.
 *
 * ── O critério, e por que a formulação é "não é cliente" ──────────────────────
 * Decisão do dono: ADMIN, REVISOR e SUPORTE encerram no prazo curto. O que separa os dois
 * grupos é de quem são os dados na tela. O cliente vê os PRÓPRIOS processos; a equipe vê os
 * processos de OUTRAS pessoas — o revisor lê os autos inteiros, o suporte lê o chamado, e do
 * painel de administração se apaga conta, se libera acesso à mão, se ajusta crédito e se
 * encerra caso de dinheiro. Tela de equipe esquecida aberta expõe dado de terceiro coberto
 * por sigilo profissional, e é isso que justifica o prazo mais curto.
 *
 * A regra é escrita pela NEGATIVA de propósito. Com uma lista de papéis internos, um papel
 * novo criado no futuro ficaria fora dela por omissão e receberia o prazo LONGO — o lado
 * inseguro, e em silêncio. Assim, papel novo nasce no prazo curto, e afrouxar passa a exigir
 * um ato explícito aqui. Erro de esquecimento cai para o lado seguro.
 */
const PAPEL_DE_PRAZO_COMUM: Role = "CLIENTE";

/** Esta sessão é de alguém da equipe (vê dado de terceiro)? */
function ehDaEquipe(role: Role): boolean {
  return role !== PAPEL_DE_PRAZO_COMUM;
}

/** Padrões do código, usados quando a variável de ambiente não é um número utilizável. */
const PADRAO_MINUTOS = { cliente: 30, equipe: 10 } as const;

let avisouSobreValorInvalido = false;

/**
 * Minutos configurados, ou o padrão do código quando o valor não serve.
 *
 * ⚠️ FALHA PARA O LADO SEGURO, e isto conserta um jeito silencioso de desligar a proteção.
 *
 * `env` lê estes valores com `Number(...)`, e `Number("abc")` é `NaN`. `NaN` perde TODA
 * comparação: `NaN <= 0` é falso, então a saída de "regra desligada" não pegava, e
 * `decorrido > NaN` também é falso — ou seja, nenhuma sessão era considerada inativa. Um erro
 * de digitação em `SESSION_IDLE_MINUTES` desligava o encerramento por inatividade inteiro sem
 * uma linha de erro em lugar nenhum, e a tela continuaria dizendo que a regra vale.
 *
 * Valor negativo tinha o mesmo efeito por outro caminho. Aqui os dois voltam para o padrão do
 * código, com aviso no log: desligar a regra precisa ser escolha (zero explícito), nunca
 * consequência de um dedo torto.
 */
function minutosConfigurados(valor: number, padrao: number, variavel: string): number {
  if (Number.isFinite(valor) && valor >= 0) return valor;
  if (!avisouSobreValorInvalido) {
    avisouSobreValorInvalido = true;
    console.error(
      `[auth] ${variavel} não é um número de minutos utilizável; usando o padrão ${padrao}.` +
        " Para desligar o encerramento por inatividade, use exatamente 0.",
    );
  }
  return padrao;
}

/**
 * Minutos de inatividade que valem para este papel.
 *
 * ⚠️ O papel é OBRIGATÓRIO, e isso é proposital. A versão anterior não recebia nada e devolvia
 * um número só; ao passar a existir dois prazos, um parâmetro opcional deixaria o caminho mais
 * perigoso ser também o mais fácil de escrever — quem esquecesse de informar o papel daria à
 * conta da equipe o prazo longo, sem erro nenhum aparecendo. Exigir o papel faz o compilador
 * cobrar a decisão em todo lugar que pergunta.
 */
export function INATIVIDADE_MINUTOS(role: Role): number {
  const doCliente = minutosConfigurados(
    env.sessionIdleMinutes,
    PADRAO_MINUTOS.cliente,
    "SESSION_IDLE_MINUTES",
  );
  if (!ehDaEquipe(role)) return doCliente;

  /**
   * O prazo da equipe NUNCA é maior que o do cliente.
   *
   * Sem esta trava, `SESSION_IDLE_MINUTES_EQUIPE=60` com o do cliente em 30 faria a sessão de
   * quem vê dado de terceiro durar o DOBRO da de quem vê só o próprio — o inverso exato da
   * intenção, e em silêncio. Duas variáveis independentes é como uma contradiz a outra; o
   * mínimo torna a intenção estrutural em vez de confiada a quem digita.
   *
   * Zero é a exceção: nos dois lugares ele significa "regra desligada", e o mínimo entre 0 e
   * 30 daria 0 — desligaria para a equipe por causa da configuração do cliente. Então o
   * desligamento é respeitado como escolha de cada lado, não como número a comparar.
   */
  const daEquipe = minutosConfigurados(
    env.sessionIdleMinutesEquipe,
    PADRAO_MINUTOS.equipe,
    "SESSION_IDLE_MINUTES_EQUIPE",
  );
  if (daEquipe <= 0 || doCliente <= 0) return daEquipe;
  return Math.min(daEquipe, doCliente);
}

/** A sessão ficou tempo demais sem uso? Zero minutos desliga a regra. */
export function sessaoInativa(
  session: { lastSeenAt: Date; role: Role },
  agora: Date = new Date(),
): boolean {
  const limite = INATIVIDADE_MINUTOS(session.role);
  if (limite <= 0) return false;
  return agora.getTime() - session.lastSeenAt.getTime() > limite * 60_000;
}

/**
 * De quanto em quanto tempo o uso é regravado.
 *
 * Sem esta folga, TODA requisição autenticada faria um UPDATE — e uma página do Next chama
 * a sessão várias vezes por navegação. O banco é o plano mais barato do Render; escrever a
 * cada leitura trocaria segurança por um gargalo. Um minuto de granularidade é irrelevante
 * diante de um limite de trinta.
 */
const REGRAVAR_USO_APOS_SEGUNDOS = 60;

/**
 * O usuário desta sessão, a partir do token — ou nulo.
 *
 * Separado de `getSessionUser` de propósito: aqui não se lê cookie, então a regra inteira
 * (revogação, prazo absoluto, inatividade, estado da conta) pode ser exercitada em teste
 * contra o banco de verdade. Regra de sessão validada só por mock é regra não validada.
 */
export async function usuarioDaSessao(
  token: string | undefined,
  agora: Date = new Date(),
  /**
   * ⚠️ Esta requisição conta como USO? Falso por padrão, e a inversão é um conserto.
   *
   * A primeira versão renovava `lastSeenAt` em TODA requisição autenticada. Parecia razoável
   * e desmontava a regra justamente na tela que motivou o desenho: a tela de análise faz
   * `router.refresh()` a cada 4 segundos enquanto o processamento corre, cada refresh lê a
   * sessão, e a leitura renovava o relógio. Ou seja, deixar uma análise processando mantinha
   * a sessão viva PARA SEMPRE, sem ninguém na frente — exatamente o caso que a regra existe
   * para pegar. O comentário do componente dizia que o desenho evitava isso; evitava só no
   * relógio da tela — o comentário afirmava mais do que o código fazia.
   *
   * Agora quem renova é UM caminho só: o ping de atividade, que sai depois de interação real
   * (clique, tecla, rolagem, toque). Tráfego de fundo passa a ser o que é — tráfego.
   *
   * O custo é explícito: se o componente de atividade não estiver montado numa área
   * autenticada nova, a sessão de lá expira mesmo em uso. Área nova precisa montá-lo, e o
   * padrão `false` é o que faz o esquecimento cair para o lado seguro.
   */
  contaComoUso = false,
): Promise<SessionUser | null> {
  if (!token) return null;

  const session = await prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          organizationId: true,
          orgRole: true,
          emailVerifiedAt: true,
        },
      },
    },
  });

  if (!session || session.revokedAt || session.expiresAt < agora) return null;

  if (sessaoInativa({ lastSeenAt: session.lastSeenAt, role: session.user.role }, agora)) {
    await prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: agora },
    });
    /**
     * Registro de segurança, e não auditoria: é evento de autenticação, e é o que permite
     * distinguir "o cliente saiu" de "a sessão caiu sozinha" quando alguém reclamar de ter
     * sido desconectado no meio do trabalho.
     */
    await logSecurityEvent({
      type: "sessao_encerrada_por_inatividade",
      email: session.user.email,
      ip: session.ip ?? undefined,
      metadata: {
        // O papel entra no registro porque os prazos são diferentes: sem ele, não há como
        // conferir depois se o encerramento respeitou o prazo daquela conta.
        papel: session.user.role,
        minutos: INATIVIDADE_MINUTOS(session.user.role),
        ultimoUso: session.lastSeenAt,
      },
    });
    return null;
  }

  if (session.user.status === "BLOQUEADO" || session.user.status === "SUSPENSO") return null;

  // Marca o uso — só quando a requisição representa interação, e com a folga acima.
  if (contaComoUso && agora.getTime() - session.lastSeenAt.getTime() > REGRAVAR_USO_APOS_SEGUNDOS * 1000) {
    await prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: agora } });
  }

  return session.user;
}

/** Leitura da sessão para render de página e rota: NÃO conta como uso. */
export async function getSessionUser(): Promise<SessionUser | null> {
  return usuarioDaSessao((await cookies()).get(COOKIE_NAME)?.value);
}

/**
 * Leitura que CONTA como uso — exclusiva do ping de atividade.
 *
 * Vive aqui, e não na rota, para que exista um lugar só no sistema capaz de empurrar o relógio
 * de inatividade. Espalhar essa capacidade seria voltar ao defeito: qualquer caminho novo
 * renovando a sessão sem interação de gente.
 */
export async function registrarAtividadeDaSessao(): Promise<SessionUser | null> {
  return usuarioDaSessao((await cookies()).get(COOKIE_NAME)?.value, new Date(), true);
}

export async function destroySession() {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (token) {
    await prisma.session.updateMany({
      where: { tokenHash: sha256(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  (await cookies()).delete(COOKIE_NAME);
}

/** Revoga todas as sessões de um usuário (ex.: troca de senha, bloqueio). */
export async function revokeAllSessions(userId: string) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Lança se não autenticado — usado em Server Components e rotas. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new AuthError("Não autenticado", 401);
  return user;
}

/** Exige um dos papéis informados. */
export async function requireRole(...roles: Role[]): Promise<SessionUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) throw new AuthError("Acesso negado", 403);
  return user;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}
