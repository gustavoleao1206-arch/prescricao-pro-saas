import { prisma } from "../src/lib/db";
import { inventarioDaConta, apagarConta } from "../src/lib/apagar-conta";

/**
 * Apaga uma conta de teste, duplicada ou criada por engano.
 *
 * A lógica e as travas ficam em src/lib/apagar-conta.ts (com testes); aqui é só a
 * linha de comando.
 *
 * ── Uso (Shell do Render, onde DATABASE_URL é o de produção) ──────────────────
 *   npx tsx scripts/apagar-conta.ts --email=alguem@exemplo.com
 *      → só mostra o inventário. NADA é apagado.
 *
 *   npx tsx scripts/apagar-conta.ts --email=alguem@exemplo.com --confirmar
 *      → apaga.
 *
 * O primeiro comando que a pessoa digita não pode ser o destrutivo: sem
 * `--confirmar` o script apenas relata.
 *
 * ⚠️ Isto NÃO atende pedido de exclusão da LGPD — ver o cabeçalho da biblioteca.
 */

function arg(nome: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return p?.slice(nome.length + 3);
}
const tem = (nome: string) => process.argv.includes(`--${nome}`);

function relatar(inv: NonNullable<Awaited<ReturnType<typeof inventarioDaConta>>>) {
  console.log("");
  console.log("Conta encontrada");
  console.log(`  e-mail .................. ${inv.email}`);
  console.log(`  nome .................... ${inv.nome}`);
  console.log(`  perfil / estado ......... ${inv.perfil} / ${inv.estado}`);
  console.log(`  criada em ............... ${inv.criadaEm.toISOString()}`);
  console.log(`  id ...................... ${inv.userId}`);
  console.log("");
  console.log("Seria apagado junto (cascata das chaves estrangeiras)");
  console.log(
    `  organizações ............ ${inv.organizacoes.length}` +
      (inv.organizacoes.length ? ` (${inv.organizacoes.map((o) => o.nome).join(", ")})` : ""),
  );
  console.log(
    `  assinaturas ............. ${inv.assinaturas.length}` +
      (inv.assinaturas.length ? ` (${inv.assinaturas.map((s) => s.status).join(", ")})` : ""),
  );
  console.log(
    `  pagamentos .............. ${inv.pagamentos}  — aprovados: ${inv.pagamentosAprovados}` +
      (inv.pagamentosADevolver > 0 ? `  — A DEVOLVER: ${inv.pagamentosADevolver}` : ""),
  );
  console.log(`  lançamentos de crédito .. ${inv.lancamentosDeCredito}`);
  console.log(`  análises ................ ${inv.analises}`);
  console.log(`  documentos .............. ${inv.documentos}`);
  console.log(`  consentimentos LGPD ..... ${inv.consentimentos}`);
  console.log(`  tokens / sessões ........ ${inv.tokens} / ${inv.sessoes}`);
  console.log(`  notificações ............ ${inv.notificacoes}`);
  console.log("");
  console.log(`Preservado: ${inv.auditoriaPreservada} registro(s) de auditoria — a linha fica, o vínculo sai.`);
  console.log("");
}

async function main() {
  const email = arg("email")?.trim().toLowerCase();
  if (!email) {
    console.error("Informe a conta:  --email=alguem@exemplo.com");
    console.error("Sem --confirmar, o script apenas mostra o que seria apagado.");
    process.exit(2);
  }

  const inv = await inventarioDaConta(email);
  if (!inv) {
    console.error(`Nenhuma conta com o e-mail ${email}.`);
    process.exit(1);
  }
  relatar(inv);

  if (!tem("confirmar")) {
    console.log("Nada foi apagado (faltou --confirmar).");
    console.log(
      `Para apagar:  npx tsx scripts/apagar-conta.ts --email=${email} --confirmar` +
        (inv.pagamentosAprovados > 0 ? " --forcar" : ""),
    );
    return;
  }

  const r = await apagarConta(email, { forcar: tem("forcar") });

  if (r.recusa === "e_admin") {
    console.error(`RECUSADO: ${email} é ADMIN. Rebaixe o perfil antes, se for realmente a intenção.`);
    process.exit(3);
  }
  if (r.recusa === "tem_pagamento_aprovado") {
    console.error(
      `RECUSADO: esta conta tem ${inv.pagamentosAprovados} pagamento(s) APROVADO(S) — é um cliente que pagou.\n` +
        `Apagar destrói o histórico da venda, que você precisa guardar.\n` +
        `Se ainda assim for a intenção (cobrança de teste, por exemplo), repita com --forcar.`,
    );
    process.exit(4);
  }
  if (r.recusa === "tem_pagamento_a_devolver") {
    console.error(
      `RECUSADO: esta conta tem ${inv.pagamentosADevolver} quantia(s) a DEVOLVER.\n` +
        `Apagar não apaga o valor, mas apaga quem é o credor: a devolução fica sem destinatário.\n` +
        `Devolva no painel do Asaas (ou encerre o caso em Registros → Dinheiro sem destino) e repita.`,
    );
    process.exit(6);
  }
  if (!r.apagado) {
    console.error("Nada foi apagado.");
    process.exit(5);
  }

  console.log(`APAGADO: ${email}`);
  const restou = await inventarioDaConta(email);
  console.log(restou ? "ATENÇÃO: a conta ainda aparece na consulta." : "Confirmado: a conta não existe mais.");
}

main()
  .catch((e) => {
    console.error("[apagar-conta] erro:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
