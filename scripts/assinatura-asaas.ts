import { env } from "../src/lib/env";
import { prisma } from "../src/lib/db";

/**
 * Inspeciona e cancela recorrências no Asaas, pelo terminal.
 *
 * ── Por que pelo terminal, e não pelo painel do Asaas ─────────────────────────
 * Cancelar no painel encerra a cobrança no provedor e deixa o NOSSO banco dizendo
 * que a assinatura segue ativa — o cliente continua com acesso liberado por uma
 * recorrência que não existe mais, e o painel administrativo passa a contar receita
 * recorrente inexistente. Este script faz os dois lados na mesma passada.
 *
 * ── Cuidado com o que é dinheiro ──────────────────────────────────────────────
 * Cancelar recorrência interrompe cobranças FUTURAS. Não estorna nada, não devolve
 * valor pago e não mexe em cobrança já paga: estorno é ato financeiro e continua
 * sendo feito por você, no painel do Asaas. O script mostra as cobranças pendentes
 * justamente para você decidir isso com informação na mão.
 *
 * Uso:
 *   npx tsx scripts/assinatura-asaas.ts --listar
 *   npx tsx scripts/assinatura-asaas.ts --ver sub_xxxxxxxx
 *   npx tsx scripts/assinatura-asaas.ts --cancelar sub_xxxxxxxx --confirmar
 */

type Json = Record<string, unknown>;

async function asaas(path: string, method: "GET" | "DELETE" = "GET"): Promise<Json> {
  if (!env.asaas.apiKey) {
    throw new Error("ASAAS_API_KEY não configurada neste ambiente. Rode no shell do serviço em produção.");
  }
  const res = await fetch(`${env.asaas.apiBaseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "PrescricaoPro/1.0 (Node.js)",
      access_token: env.asaas.apiKey,
    },
  });
  const texto = await res.text();
  const json = texto ? (JSON.parse(texto) as Json) : {};
  if (!res.ok) {
    const erros = (json as { errors?: Array<{ description?: string }> }).errors;
    throw new Error(erros?.[0]?.description || `Asaas respondeu ${res.status}: ${texto.slice(0, 300)}`);
  }
  return json;
}

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(nome);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function real(valor: unknown): string {
  return typeof valor === "number"
    ? valor.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    : String(valor ?? "-");
}

/** Mostra o que existe no NOSSO banco para esta recorrência. */
async function local(assinaturaId: string) {
  const sub = await prisma.subscription.findFirst({
    where: { externalRef: assinaturaId },
    include: { plan: { select: { name: true } }, organization: { select: { name: true, owner: { select: { email: true } } } } },
  });
  if (!sub) {
    console.log("  (nenhuma assinatura nossa aponta para esta recorrência)");
    return null;
  }
  console.log(`  nossa assinatura: ${sub.id}`);
  console.log(`  conta:            ${sub.organization?.owner?.email ?? "?"} (${sub.organization?.name ?? "?"})`);
  console.log(`  plano/status:     ${sub.plan?.name ?? "?"} / ${sub.status}`);
  console.log(`  período até:      ${sub.currentPeriodEnd?.toISOString().slice(0, 10) ?? "-"}`);
  return sub;
}

async function ver(assinaturaId: string) {
  const s = await asaas(`/subscriptions/${encodeURIComponent(assinaturaId)}`);
  console.log(`\nRECORRÊNCIA ${assinaturaId} (${env.asaas.ambiente})`);
  console.log(`  status:      ${s.status}`);
  console.log(`  valor:       ${real(s.value)}  ciclo: ${s.cycle}`);
  console.log(`  forma:       ${s.billingType}`);
  console.log(`  próxima:     ${s.nextDueDate}`);
  console.log(`  cliente:     ${s.customer}`);
  console.log(`  referência:  ${s.externalReference ?? "(nula)"}`);
  console.log(`  checkout:    ${(s as { checkoutSession?: string }).checkoutSession ?? "-"}`);

  const cobrancas = (await asaas(`/subscriptions/${encodeURIComponent(assinaturaId)}/payments`)) as {
    data?: Array<Json>;
  };
  const lista = cobrancas.data ?? [];
  console.log(`\n  COBRANÇAS (${lista.length}):`);
  for (const c of lista) {
    console.log(
      `    ${String(c.id).padEnd(22)} ${String(c.status).padEnd(12)} ${real(c.value).padStart(11)}  venc ${c.dueDate}`,
    );
  }
  /**
   * Cobrança em PENDING/AWAITING é dinheiro que AINDA VAI SAIR do cliente. É a
   * informação que decide se basta cancelar ou se também é preciso estornar.
   */
  const pendentes = lista.filter((c) => ["PENDING", "AWAITING_RISK_ANALYSIS", "OVERDUE"].includes(String(c.status)));
  if (pendentes.length > 0) {
    console.log(`\n  ⚠ ${pendentes.length} cobrança(s) ainda por vencer/pagar. Cancelar a recorrência as cancela.`);
  }
  const pagas = lista.filter((c) => ["RECEIVED", "CONFIRMED", "RECEIVED_IN_CASH"].includes(String(c.status)));
  if (pagas.length > 0) {
    console.log(
      `  ⚠ ${pagas.length} cobrança(s) JÁ PAGA(S). Cancelar NÃO devolve esse valor — estorno é feito por você no painel.`,
    );
  }

  console.log("\n  NO NOSSO BANCO:");
  await local(assinaturaId);
}

async function cancelar(assinaturaId: string, confirmar: boolean) {
  await ver(assinaturaId);

  if (!confirmar) {
    console.log("\nSIMULAÇÃO. Para cancelar de verdade, repita com --confirmar.");
    return;
  }

  console.log("\n→ cancelando no Asaas…");
  const r = await asaas(`/subscriptions/${encodeURIComponent(assinaturaId)}`, "DELETE");
  console.log(`  resposta: ${JSON.stringify(r)}`);

  const sub = await prisma.subscription.findFirst({ where: { externalRef: assinaturaId } });
  if (sub && sub.status !== "CANCELADA") {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: "CANCELADA",
        canceledAt: new Date(),
        canceledReason: "Cancelamento administrativo (assinatura de teste)",
      },
    });
    console.log(`  nossa assinatura ${sub.id} marcada como CANCELADA.`);
  } else if (sub) {
    console.log("  nossa assinatura já estava CANCELADA.");
  }

  await prisma.auditLog.create({
    data: {
      action: "subscription.canceled_admin_script",
      entityType: "Subscription",
      entityId: sub?.id ?? assinaturaId,
      metadata: { assinaturaAsaas: assinaturaId, ambiente: env.asaas.ambiente },
    },
  });
  console.log("→ concluído.");
}

async function listar() {
  const r = (await asaas("/subscriptions?status=ACTIVE&limit=100")) as { data?: Array<Json>; totalCount?: number };
  const lista = r.data ?? [];
  console.log(`\nRECORRÊNCIAS ATIVAS NO ASAAS (${env.asaas.ambiente}): ${lista.length}`);
  for (const s of lista) {
    console.log(
      `  ${String(s.id).padEnd(22)} ${real(s.value).padStart(11)} ${String(s.billingType).padEnd(12)} ` +
        `próxima ${s.nextDueDate}  ref ${s.externalReference ?? "(nula)"}`,
    );
  }
  if (lista.length === 0) return;
  console.log("\nConferindo cada uma contra o nosso banco:");
  for (const s of lista) {
    console.log(`\n  ${s.id}:`);
    await local(String(s.id));
  }
}

async function main() {
  const confirmar = process.argv.includes("--confirmar");
  const paraVer = arg("--ver");
  const paraCancelar = arg("--cancelar");

  if (process.argv.includes("--listar")) return listar();
  if (paraVer) return ver(paraVer);
  if (paraCancelar) return cancelar(paraCancelar, confirmar);

  console.log(
    [
      "Uso:",
      "  npx tsx scripts/assinatura-asaas.ts --listar",
      "  npx tsx scripts/assinatura-asaas.ts --ver sub_xxxxxxxx",
      "  npx tsx scripts/assinatura-asaas.ts --cancelar sub_xxxxxxxx --confirmar",
    ].join("\n"),
  );
  process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("erro:", (e as Error).message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
