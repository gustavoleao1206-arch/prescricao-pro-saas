import { prisma } from "../src/lib/db";
import { saldoDe } from "../src/lib/credits";
import { subscriptionAccess, subscriptionGrantsAccess } from "../src/lib/consumption";

/**
 * "O cliente pagou. Liberou?" — em um comando.
 *
 * ── Por que existe ────────────────────────────────────────────────────────────
 * Essa pergunta já custou horas neste projeto. No primeiro pagamento real o
 * dinheiro entrou, nada foi liberado, e descobrir o motivo exigiu ler o painel do
 * Asaas, a tabela de pagamentos, a de assinaturas, o extrato de créditos e a
 * auditoria — em telas diferentes, comparando à mão. O diagnóstico de pagamento
 * responde se o PROVEDOR aceita cobrar; este responde se a nossa ponta entregou.
 *
 * Ele percorre a cadeia inteira na ordem em que ela acontece e para no primeiro elo
 * roto, dizendo qual é. Serve para o teste de estreia de cada forma de pagamento e,
 * depois, para todo atendimento de "paguei e não liberou".
 *
 * Uso, no shell do serviço em produção:
 *   npx tsx scripts/verificar-liberacao.ts --email cliente@exemplo.com
 *   npx tsx scripts/verificar-liberacao.ts --ultimo        (a conta que pagou mais recentemente)
 */

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const quando = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : "—");

function titulo(t: string) {
  console.log(`\n${"─".repeat(72)}\n${t}\n${"─".repeat(72)}`);
}

/** Símbolo de elo: ✓ inteiro, ✗ roto, · não se aplica. */
function elo(ok: boolean | null, texto: string) {
  console.log(`  ${ok === null ? "·" : ok ? "✓" : "✗"} ${texto}`);
}

async function main() {
  const email = arg("--email");
  const ultimo = process.argv.includes("--ultimo");
  if (!email && !ultimo) {
    console.log("Uso: npx tsx scripts/verificar-liberacao.ts --email cliente@exemplo.com");
    console.log("     npx tsx scripts/verificar-liberacao.ts --ultimo");
    process.exitCode = 1;
    return;
  }

  /**
   * `--ultimo` busca pelo PAGAMENTO mais recente, não pelo cadastro mais recente:
   * a pergunta é sobre quem pagou. Cadastro sem pagamento não interessa aqui.
   */
  let alvo = email?.trim().toLowerCase();
  if (!alvo) {
    /**
     * ⚠️ O diagnóstico ficava CEGO no caso que ele existe para investigar.
     *
     * `--ultimo` pegava o pagamento mais recente e seguia para o dono. Quando esse
     * pagamento é justamente o que NÃO tem dono — dinheiro que entrou sem conta
     * identificável, hoje gravado como PENDENTE sem assinatura —, a cadeia terminava em
     * "nenhum pagamento vinculado a uma conta" e a ferramenta se calava. Era o pior
     * momento possível para se calar: a pergunta de quem roda `--ultimo` é "o último
     * pagamento liberou acesso?", e a resposta interessante é exatamente esta.
     *
     * Agora as pendências são mostradas primeiro, com o que se precisa para agir, e o
     * diagnóstico segue no último pagamento que TEM conta.
     */
    const pendentes = await prisma.payment.findMany({
      where: { status: "PENDENTE" },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { subscription: { include: { organization: { include: { owner: true } } } } },
    });
    if (pendentes.length) {
      titulo("DINHEIRO SEM DESTINO — exige decisão");
      for (const p of pendentes) {
        const dono = p.subscription?.organization?.owner?.email ?? "PAGADOR NÃO IDENTIFICADO";
        elo(false, `R$ ${(p.amountCents / 100).toFixed(2)} — ${dono}`);
        console.log(`    cobrança no Asaas: ${p.externalId ?? "-"}   forma: ${p.method ?? "-"}   em ${quando(p.createdAt)}`);
      }
      console.log("    Encerre cada caso no painel: Registros → Dinheiro sem destino.");
    }

    const pago = await prisma.payment.findFirst({
      where: { subscriptionId: { not: null } },
      orderBy: { createdAt: "desc" },
      include: { subscription: { include: { organization: { include: { owner: true } } } } },
    });
    alvo = pago?.subscription?.organization?.owner?.email?.toLowerCase();
    if (!alvo) {
      console.log("\nNenhum pagamento vinculado a uma conta foi encontrado.");
      return;
    }
    console.log(`\n(--ultimo) conta do pagamento mais recente COM conta: ${alvo}`);
  }

  const user = await prisma.user.findUnique({ where: { email: alvo } });
  if (!user) {
    titulo("CONTA");
    elo(false, `nenhuma conta com o e-mail ${alvo}`);
    console.log("    Confira o e-mail. Se o cadastro não terminou, o pagamento não tem a quem ser vinculado.");
    return;
  }

  titulo(`CONTA — ${user.email}`);
  console.log(`  nome:    ${user.name}`);
  console.log(`  perfil:  ${user.role}   estado: ${user.status}`);
  console.log(`  criada:  ${quando(user.createdAt)}`);
  elo(user.emailVerifiedAt !== null, `e-mail verificado${user.emailVerifiedAt ? ` em ${quando(user.emailVerifiedAt)}` : " — NÃO"}`);

  const org = await prisma.organization.findFirst({ where: { ownerId: user.id } });
  elo(Boolean(org), org ? `organização: ${org.name}` : "SEM organização — a assinatura não tem onde ser gravada");
  if (!org) return;

  // ── Elo 1: a sessão de checkout foi gravada? ───────────────────────────────
  titulo("1. SESSÃO DE CHECKOUT (o vínculo entre o pagamento e a conta)");
  const sessoes = await prisma.asaasCheckout.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  if (sessoes.length === 0) {
    elo(null, "nenhuma sessão gravada para esta conta");
    console.log("    Normal no BOLETO, que não passa por checkout, e na liberação manual.");
    console.log("    No cartão e no PIX, a ausência aqui é o defeito que faz o pagamento entrar sem dono.");
  } else {
    for (const s of sessoes) {
      console.log(`  ${quando(s.createdAt)}  ${s.tipo}:${s.slug}  sessão ${s.id}`);
    }
  }

  // ── Elo 2: o pagamento chegou? ─────────────────────────────────────────────
  titulo("2. PAGAMENTO (o webhook chegou e foi registrado?)");
  const subs = await prisma.subscription.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: "desc" },
    include: { plan: true },
  });
  const pagamentos = await prisma.payment.findMany({
    where: { subscriptionId: { in: subs.map((s) => s.id) } },
    orderBy: { createdAt: "desc" },
  });
  if (pagamentos.length === 0) {
    elo(false, "NENHUM pagamento registrado para esta conta");
    console.log("    Se o cliente pagou, o elo roto é o WEBHOOK. Confira no Asaas:");
    console.log("      Integrações → Webhooks → fila e histórico de entregas (procure erro ou 'penalizado').");
    console.log("    Reenviar o evento por lá refaz a liberação — o processamento é idempotente.");
  } else {
    for (const p of pagamentos) {
      console.log(
        `  ${quando(p.createdAt)}  ${p.provider.padEnd(8)} ${String(p.method ?? "-").padEnd(12)} ` +
          `${p.status.padEnd(10)} ${brl(p.amountCents).padStart(11)}  ${p.externalId ?? "(sem id no provedor)"}`,
      );
    }
    const aprovado = pagamentos.find((p) => p.status === "APROVADO");
    elo(Boolean(aprovado), aprovado ? "há pagamento APROVADO" : "nenhum pagamento chegou a APROVADO");
  }

  // ── Elo 3: a assinatura ficou ativa, com a cota certa? ─────────────────────
  titulo("3. ASSINATURA E COTA");
  const sub = subs[0] ?? null;
  if (!sub) {
    elo(false, "nenhuma assinatura — o pagamento não virou acesso");
    return;
  }
  console.log(`  plano:            ${sub.plan.name} (${sub.plan.slug})`);
  console.log(`  situação:         ${sub.status}   origem: ${sub.provider}`);
  console.log(`  período até:      ${quando(sub.currentPeriodEnd)}`);
  console.log(`  próxima cobrança: ${quando(sub.nextRenewalAt)}${sub.nextRenewalAt ? "" : "  (cobrança única — PIX ou liberação manual)"}`);
  console.log(`  ref no provedor:  ${sub.externalRef ?? "—"}`);

  const acesso = subscriptionAccess(sub);
  elo(subscriptionGrantsAccess(sub), `acesso liberado agora? ${subscriptionGrantsAccess(sub) ? "SIM" : `NÃO — ${acesso.message}`}`);

  /**
   * A cota da ASSINATURA é um retrato do plano no momento da contratação, não um
   * espelho dele. Divergir do plano é legítimo — plano legado, cortesia, ou uma
   * assinatura criada antes de o plano mudar —, mas é a diferença que explica por que
   * um cliente vê um número e a página de planos anuncia outro. Cota 0 significa SEM
   * LIMITE, e é a divergência que custa dinheiro.
   */
  const saldo = saldoDe(sub);
  console.log(`  cota da assinatura: ${saldo.ilimitado ? "SEM LIMITE (0)" : saldo.cotaMensal} · plano hoje: ${sub.plan.monthlyAnalyses}`);
  if (saldo.ilimitado && sub.plan.monthlyAnalyses > 0) {
    elo(false, "assinatura SEM LIMITE num plano com cota — acesso ilimitado até a próxima renovação");
    console.log("    Corrige-se sozinho na renovação (liberarCreditosDoCiclo regrava a cota do plano).");
    console.log("    Para corrigir agora: painel → Assinaturas → Créditos → 'Renovar ciclo do plano'.");
  } else if (!saldo.ilimitado && saldo.cotaMensal !== sub.plan.monthlyAnalyses) {
    elo(null, `cota diferente do plano (${saldo.cotaMensal} × ${sub.plan.monthlyAnalyses}) — legítimo em plano legado`);
  } else {
    elo(true, "cota da assinatura igual à do plano");
  }
  console.log(
    `  saldo: ${saldo.ilimitado ? "sem limite" : `${saldo.total} (${saldo.saldoMensal} do ciclo + ${saldo.saldoAdicional} avulsos)`}` +
      `  usados no ciclo: ${saldo.usadosNoCiclo}`,
  );

  // ── Elo 4: os créditos entraram no extrato? ────────────────────────────────
  titulo("4. EXTRATO DE CRÉDITOS");
  const razao = await prisma.creditLedger.findMany({
    where: { subscriptionId: sub.id },
    orderBy: { createdAt: "asc" },
  });
  if (razao.length === 0) {
    elo(false, "extrato VAZIO — nenhum crédito foi liberado");
    console.log("    Com pagamento APROVADO e extrato vazio, a liberação falhou depois de registrar o pagamento.");
  } else {
    for (const r of razao) {
      const sinal = r.quantity > 0 ? `+${r.quantity}` : String(r.quantity);
      console.log(`  ${quando(r.createdAt)}  ${sinal.padStart(4)} ${String(r.bucket ?? "-").padEnd(10)} ${r.description}`);
    }
    elo(
      razao.some((r) => r.kind === "ASSINATURA" && r.quantity > 0),
      "houve liberação de créditos pela assinatura",
    );
  }

  // ── Elo 5: o cliente foi avisado? ──────────────────────────────────────────
  titulo("5. AVISOS E RASTRO");
  const logs = await prisma.auditLog.findMany({
    where: { OR: [{ actorId: user.id }, { entityId: user.id }, { entityId: sub.id }] },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { createdAt: true, action: true, metadata: true },
  });
  for (const l of logs) console.log(`  ${quando(l.createdAt)}  ${l.action}`);
  const notificacoes = await prisma.notification.count({ where: { userId: user.id } });
  console.log(`  notificações na conta: ${notificacoes}`);

  // ── Veredito ───────────────────────────────────────────────────────────────
  titulo("VEREDITO");
  const pagou = pagamentos.some((p) => p.status === "APROVADO");
  const liberou = subscriptionGrantsAccess(sub);
  const temCredito = saldo.ilimitado || saldo.total > 0;
  if (pagou && liberou && temCredito) {
    console.log("  ✓ CADEIA COMPLETA: pagamento aprovado, acesso liberado e crédito disponível.");
  } else if (!pagou) {
    console.log("  ✗ O pagamento não chegou (ou não foi aprovado). O elo roto está no provedor ou no webhook — ver item 2.");
  } else if (!liberou) {
    console.log("  ✗ Pagamento aprovado, mas o acesso NÃO está liberado — ver item 3.");
  } else {
    console.log("  ✗ Acesso liberado, mas sem crédito para usar — ver item 4.");
  }
}

main()
  .catch((e) => {
    console.error("erro:", (e as Error).message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
