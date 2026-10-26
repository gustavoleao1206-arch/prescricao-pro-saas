import { ok, route } from "@/lib/api";
import { registrarAtividadeDaSessao } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Ping de atividade — o que mantém a sessão viva enquanto há alguém usando.
 *
 * ── Por que uma rota só para isso ─────────────────────────────────────────────
 * `lastSeenAt` avança quando o servidor atende uma requisição autenticada. Isso cobre
 * navegação e ação, e NÃO cobre o uso que não gera requisição: ler um relatório longo,
 * conferir uma linha do tempo, redigir na tela. Sem esta rota, quem passa meia hora lendo
 * seria desconectado no meio da leitura — e o encerramento por inatividade viraria um
 * estorvo em vez de uma proteção, que é como esse tipo de regra acaba desligada.
 *
 * Quem chama é `EncerrarPorInatividade`, e só depois de interação REAL (clique, tecla,
 * rolagem, toque), no máximo uma vez por minuto. Tráfego de fundo não chega aqui de
 * propósito: a tela de análise faz `router.refresh()` a cada 4 segundos enquanto processa,
 * e se isso contasse como uso, deixar uma análise processando manteria a sessão viva sem
 * ninguém na frente — exatamente o caso que a regra existe para pegar.
 *
 * ── Este é o ÚNICO caminho que empurra o relógio ──────────────────────────────
 * `registrarAtividadeDaSessao` é a única leitura de sessão do sistema que regrava
 * `lastSeenAt`. Todas as outras (render de página, rotas de API) leem sem renovar — inclusive
 * o `router.refresh()` de 4 segundos da tela de análise, que antes mantinha a sessão viva para
 * sempre sem ninguém na frente.
 *
 * Ela responde 401 quando a sessão já morreu, e é assim que a tela descobre que precisa sair.
 *
 * ── O que esta rota NÃO consegue garantir, e vale dito ────────────────────────
 * Ela não tem como provar que houve uma PESSOA interagindo: quem tem o cookie pode chamá-la.
 * O encerramento por inatividade protege a tela esquecida aberta, não o cookie roubado — para
 * cookie roubado o que vale é o prazo absoluto, a revogação e a troca de senha. Dizer o
 * contrário seria vender uma garantia que não existe.
 */
export const POST = route(async () => {
  const user = await registrarAtividadeDaSessao();
  if (!user) return ok({ ativo: false }, { status: 401 });
  return ok({ ativo: true });
});
