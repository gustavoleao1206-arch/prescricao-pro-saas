import { alertarOperacao, destinoDoAlerta } from "../src/lib/alerta-operacional";
import { env } from "../src/lib/env";
import { prisma } from "../src/lib/db";

/**
 * Dispara UM alerta operacional de teste e diz se ele saiu.
 *
 * ── Por que isto existe ───────────────────────────────────────────────────────
 * Os alertas operacionais avisam sobre dinheiro que precisa de decisão humana: pagamento
 * que entrou sem conta identificada, cobrança recebida depois do cancelamento, boleto pago
 * sem liberação, análise interrompida, evento de pagamento dispensado. Todos dependem de
 * uma coisa que o código não consegue provar sozinho: que o e-mail CHEGA a uma caixa que
 * alguém abre.
 *
 * E o modo de falhar é silencioso. Endereço com erro de digitação, caixa que não existe,
 * domínio não verificado no provedor de envio — em qualquer desses casos o alerta é
 * gravado no banco, o sistema segue funcionando, e ninguém nunca é avisado. Seria o mesmo
 * defeito que os alertas vieram consertar, um andar acima.
 *
 * Este script fecha essa dúvida em um comando: mostra para onde o alerta vai, tenta enviar,
 * e diz se o provedor aceitou. O que ele NÃO prova é que a mensagem não caiu em spam —
 * isso só a caixa de entrada responde, e é por isso que o teste manda um e-mail de verdade
 * em vez de simular.
 *
 * Uso:
 *   npm run alerta:testar
 *
 * Em produção (Render → Shell do serviço), roda com as variáveis reais do ambiente, que é
 * o único lugar onde o resultado vale como evidência.
 */
async function main() {
  const destino = destinoDoAlerta();
  const configurado = env.email.operacao.trim();

  console.log("── Canal de alertas operacionais ───────────────────────────");
  console.log(`  destino ................. ${destino}`);
  console.log(
    `  origem do endereço ...... ${configurado ? "variável OPERACAO_EMAIL" : "contato do fornecedor (OPERACAO_EMAIL vazia)"}`,
  );
  console.log(`  remetente (EMAIL_FROM) .. ${env.email.from}`);
  console.log(`  driver de e-mail ........ ${env.email.driver}`);

  if (env.email.driver === "console") {
    console.log(
      "\n  ATENÇÃO: driver 'console' NÃO envia e-mail — apenas imprime abaixo.\n" +
        "  Em produção o driver tem de ser 'resend'. Rodar este teste na sua máquina com\n" +
        "  driver console prova apenas que o texto é gerado, não que o alerta chega.",
    );
  }

  const r = await alertarOperacao({
    tipo: "teste_do_canal_de_alertas",
    assunto: "Teste do canal de alertas — nenhuma ação necessária",
    linhas: [
      "Este é um teste do canal de alertas operacionais do Prescrição Pro.",
      "Se você está lendo isto na caixa de entrada, o canal funciona.",
      `Destino configurado: ${destino}.`,
      "Nenhum pagamento, assinatura ou crédito foi afetado por este teste.",
    ],
    acao: "Nada. Se este e-mail NÃO chegar, os alertas de dinheiro também não chegariam.",
    metadata: { teste: true },
  });

  console.log("\n── Resultado ───────────────────────────────────────────────");
  if (r.avisado) {
    console.log(`  ✓ o provedor aceitou o envio para ${r.destino}`);
    console.log("    Confira a caixa de entrada (e o spam). Chegando, o canal está pronto.");
  } else {
    console.log(`  ✗ o envio para ${r.destino} FALHOU: ${r.erro}`);
    console.log(
      "    Enquanto isso não for resolvido, todo alerta de dinheiro fica só no banco\n" +
        "    (painel → Registros) e ninguém é avisado por e-mail.",
    );
  }
  console.log("\n  O registro do teste fica em Registros → Eventos de segurança,");
  console.log("  com o tipo 'teste_do_canal_de_alertas'.");
}

main()
  .catch((e) => {
    console.error("[teste-alerta] erro:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
