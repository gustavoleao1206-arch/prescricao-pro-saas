import { expirarCreditosAdicionais } from "../src/lib/credits";
import { encerrarAssinaturasVencidas } from "../src/lib/mudanca-plano";
import { encerrarBoletosVencidos, reconciliarPagamentos } from "../src/lib/asaas";
import { restabelecerRevisoesSemDecisao } from "../src/lib/revisao-contestacao";
import { liberarCiclosAnuais } from "../src/lib/ciclo-anual";
import { destravarAnalisesAbandonadas } from "../src/lib/analise-travada";
import { vigiarPrazosDoTitular } from "../src/lib/pedido-do-titular";
import { executarRetencao } from "../src/lib/retencao";
import { prisma } from "../src/lib/db";

/**
 * Manutenção diária.
 *
 * Duas tarefas, ambas idempotentes — rodar de novo no mesmo dia não causa dano:
 *
 * 1. Expirar créditos adicionais vencidos (validade de 90 dias). Cada entrada de
 *    pacote só é expirada uma vez, pela chave da razão.
 *
 * 2. Encerrar assinaturas de CICLO ÚNICO cujo período acabou — é o caso do PIX,
 *    que não tem renovação possível. O acesso já parava sozinho pela comparação de
 *    datas, mas o STATUS continuava `ATIVA` para sempre e mentia em tudo que soma
 *    pelo status: o MRR do painel contava como receita recorrente quem nunca vai
 *    pagar de novo. Assinatura de cartão não é tocada aqui: quem decide o fim dela
 *    é o gateway, pelos eventos de atraso e cancelamento.
 *
 * Agende no servidor, uma vez por dia:
 *   0 3 * * *  cd /caminho/do/projeto && npm run creditos:manutencao
 *
 * A renovação mensal de créditos do plano MENSAL não acontece aqui: ela é disparada
 * pelo webhook de pagamento do Asaas, que é a fonte de verdade de quando o ciclo
 * virou. O plano ANUAL é o oposto e por isso entrou nesta rotina: a recorrência dele
 * é anual, chega UM evento por ano (nenhum, no anual pago por PIX), e sem esta
 * varredura o cliente recebia 20 créditos e ficava sem serviço a partir do segundo
 * mês — pagando por "20 análises por mês". Ver src/lib/ciclo-anual.ts.
 */
async function main() {
  const inicio = Date.now();

  /**
   * PRIMEIRA tarefa, e a ordem é deliberada.
   *
   * Ela entrega acesso a quem pagou e não recebeu; todas as outras encerram, expiram ou
   * cancelam alguma coisa. Rodando antes, o cliente cujo pagamento se perdeu já está com a
   * assinatura em dia quando as varreduras de encerramento olham para ela — em particular a
   * de boleto vencido, que sem isto poderia encerrar por vencimento uma assinatura cujo
   * pagamento estava listado no Asaas desde ontem.
   */
  const reconciliacao = await reconciliarPagamentos();
  console.log(
    `[manutencao] reconciliação de pagamentos: ${reconciliacao.liberadas} liberado(s) de ` +
      `${reconciliacao.consultadas} cobrança(s) paga(s) no período ` +
      `(${reconciliacao.jaConhecidas} já registrada(s))` +
      /**
       * Falha é IMPRESSA como falha. "0 liberados" porque não havia nada e "0 liberados"
       * porque não deu para perguntar são a mesma linha de log e situações opostas — e a
       * segunda significa que ninguém está sendo liberado automaticamente.
       */
      (reconciliacao.falhou ? ` — ATENÇÃO: a consulta ao Asaas FALHOU: ${reconciliacao.motivo}` : "") +
      (reconciliacao.truncada ? " — ATENÇÃO: o período não foi varrido inteiro (teto de páginas)" : ""),
  );

  const expirados = await expirarCreditosAdicionais();
  console.log(`[manutencao] créditos adicionais expirados: ${expirados}`);

  const { encerradas } = await encerrarAssinaturasVencidas();
  console.log(`[manutencao] assinaturas de ciclo único encerradas: ${encerradas}`);

  const boletos = await encerrarBoletosVencidos();
  console.log(
    `[manutencao] assinaturas encerradas por boleto vencido: ${boletos.encerradas}` +
      /**
       * Adiadas aparecem no log porque cada uma é um encerramento que NÃO aconteceu por
       * boa razão — cobrança paga no provedor, ou consulta que falhou. Silenciar isso
       * faria a linha de cima parecer o quadro completo.
       */
      (boletos.adiadas > 0 ? `, ${boletos.adiadas} adiada(s) após conferir no Asaas` : "") +
      (boletos.recorrenciasNaoCanceladas > 0
        ? ` (ATENÇÃO: ${boletos.recorrenciasNaoCanceladas} recorrência(s) seguem ativas no Asaas — ver /admin)`
        : ""),
  );

  /**
   * Revisões de estorno vencidas SEM decisão: o acesso volta.
   *
   * Não é generosidade — é a cláusula que impede a suspensão indefinida (art. 51,
   * IV, do CDC) e que os Termos e a Política de Cancelamento publicam. Cada linha
   * aqui também é falha de operação: alguém deixou o prazo correr, e o estorno ficou
   * sem contrapartida. Por isso o total é impresso mesmo quando é zero.
   */
  /**
   * Cota do mês dos planos ANUAIS. Vem antes da revisão de estorno de propósito: é a
   * tarefa que entrega o que o cliente pagou, e a mais barata de conferir no log.
   */
  const anuais = await liberarCiclosAnuais();
  console.log(
    `[manutencao] planos anuais: ${anuais.liberadas} cota(s) do mês liberada(s)` +
      (anuais.aguardando > 0 ? `, ${anuais.aguardando} aguardando o dia do contrato` : ""),
  );

  /**
   * Análises presas em processamento: devolve o crédito e libera a nova tentativa.
   *
   * Vem junto com as tarefas de crédito porque é disso que se trata: cada linha aqui é
   * um cliente que pagou, não recebeu nada e não tinha como tentar de novo. A rota de
   * processar já destrava sob demanda; esta varredura cuida de quem não voltou à tela.
   */
  const travadas = await destravarAnalisesAbandonadas();
  console.log(
    `[manutencao] análises com processamento interrompido: ${travadas.destravadas}` +
      (travadas.destravadas > 0 ? ` (${travadas.creditosEstornados} crédito(s) devolvido(s))` : ""),
  );

  /**
   * Prazo do pedido de exclusão do titular (art. 19, II, da LGPD).
   *
   * Fica junto das outras varreduras de prazo por ser a mesma espécie de dever: a Política
   * publica um prazo, e sem alguém medindo ele vence em silêncio. A diferença é que esta
   * varredura NÃO executa nada — apagar ou anonimizar exige separar o que a lei obriga a
   * conservar do que deve sair, e isso é juízo de pessoa. Ela cobra, e cobra a tempo.
   */
  // Retenção de dados pessoais (LGPD): apaga sessão morta há mais de 6 meses e
  // aplica o teto de 5 anos da auditoria — os prazos que a Política publica e
  // que, até set/2026, nenhum código executava. O que segue manual (conteúdo,
  // cadastro) está documentado em src/lib/retencao.ts.
  const retencao = await executarRetencao();
  console.log(
    `[manutencao] retenção LGPD: ${retencao.sessoesApagadas} sessão(ões) morta(s), ` +
    `${retencao.auditoriaApagada + retencao.segurancaApagada} registro(s) além do teto de auditoria`
  );

  const titular = await vigiarPrazosDoTitular();
  console.log(
    `[manutencao] pedidos de exclusão (LGPD) em aberto: ${titular.abertos}` +
      (titular.avisadosProximos > 0 ? `, ${titular.avisadosProximos} com prazo próximo (avisado)` : "") +
      (titular.avisadosVencidos > 0 ? `, ${titular.avisadosVencidos} com prazo VENCIDO (avisado)` : ""),
  );

  const revisoes = await restabelecerRevisoesSemDecisao();
  console.log(
    `[manutencao] revisões de estorno restabelecidas por decurso de prazo: ${revisoes.restabelecidas}` +
      (revisoes.restabelecidas > 0 ? ` (assinaturas: ${revisoes.ids.join(", ")})` : ""),
  );

  console.log(`[manutencao] concluído em ${Date.now() - inicio}ms`);
}

main()
  .catch((e) => {
    console.error("[manutencao] erro:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
