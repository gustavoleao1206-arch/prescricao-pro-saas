import { prisma } from "../src/lib/db";
import { env } from "../src/lib/env";
import { asaasConfigured, reconciliarPagamentos } from "../src/lib/asaas";

/**
 * "O cliente pagou e não liberou" — resolvido AGORA, sem esperar o cron.
 *
 * ── Por que existe, além do cron ──────────────────────────────────────────────
 * A reconciliação roda na manutenção diária, e isso resolve o caso geral: nenhum
 * pagamento fica perdido para sempre. Só que "amanhã de manhã" é uma eternidade para
 * quem pagou agora e está olhando a tela de bloqueio — e é justamente nessa hora que o
 * cliente telefona. Este comando é a resposta para esse telefonema: pergunta ao Asaas o
 * que ele considera pago e libera na hora o que não tem registro aqui.
 *
 * É o mesmo código do cron, e o mesmo do webhook: nada aqui decide nada por conta
 * própria. Rodar duas vezes não causa dano — pagamento já registrado é reconhecido e
 * ignorado.
 *
 * ── Uso, no shell do serviço em produção ──────────────────────────────────────
 *   npm run pagamento:reconciliar
 *   npm run pagamento:reconciliar -- --dias 30
 *
 * A janela padrão é de 7 dias. Amplie quando a suspeita é antiga — cobrança de boleto
 * paga há três semanas, por exemplo, cujo evento se perdeu na época.
 */

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dias = Number(arg("--dias") ?? 7);
  if (!Number.isFinite(dias) || dias <= 0) {
    console.log("Uso: npm run pagamento:reconciliar -- --dias 30");
    process.exitCode = 2;
    return;
  }

  console.log("─".repeat(72));
  console.log("Reconciliação de pagamentos — Asaas → liberação de acesso");
  console.log("─".repeat(72));
  /**
   * O ambiente é impresso ANTES de agir. `sandbox` não cobra ninguém e tem outra base de
   * cobranças: rodar contra o ambiente errado devolve "nada a liberar" com toda a
   * aparência de sucesso, e é a confusão mais fácil de cometer aqui.
   */
  console.log(`  Ambiente do Asaas ....: ${env.asaas.ambiente}`);
  console.log(`  Credencial ...........: ${asaasConfigured() ? "presente" : "AUSENTE — nada será consultado"}`);
  console.log(`  Janela ...............: últimos ${dias} dia(s)`);

  const desde = new Date(Date.now() - dias * 86_400_000);
  const r = await reconciliarPagamentos({ desde });

  console.log("");
  if (r.falhou) {
    // Falha não é "nada a fazer": é "não sei o que há a fazer".
    console.log(`  ✗ A consulta ao Asaas FALHOU: ${r.motivo}`);
    console.log("    Nenhuma conclusão pode ser tirada deste resultado.");
    process.exitCode = 1;
    return;
  }

  console.log(`  Cobranças pagas no período .....: ${r.consultadas}`);
  console.log(`  Já registradas aqui ............: ${r.jaConhecidas}`);
  console.log(`  LIBERADAS agora ................: ${r.liberadas}`);
  console.log(`  Aplicadas sem liberar acesso ...: ${r.semLiberacao}`);
  if (r.truncada) {
    console.log("");
    console.log("  ⚠ O período NÃO foi varrido inteiro (teto de páginas). Rode de novo com");
    console.log("    uma janela menor, em pedaços, para cobrir tudo.");
  }

  console.log("");
  if (r.liberadas > 0) {
    console.log(`  → ${r.liberadas} cliente(s) estavam sem o que pagaram, e agora estão com acesso.`);
    console.log("    Isso também significa que o webhook não entregou esses eventos: confira a URL");
    console.log("    e o token no painel do Asaas, e se a fila de sincronização da conta travou.");
  } else if (r.semLiberacao > 0) {
    console.log("  → Nada a liberar, mas houve cobrança que não virou acesso (dinheiro sem dono,");
    console.log("    pedido de parada, cobrança avulsa). Veja /admin → Logs e auditoria.");
  } else {
    console.log("  → Nada a recuperar: todo pagamento confirmado no Asaas já tem registro aqui.");
  }
}

main()
  .catch((e) => {
    console.error("[reconciliar] erro:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
