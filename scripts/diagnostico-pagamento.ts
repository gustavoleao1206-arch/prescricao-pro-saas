import { env } from "../src/lib/env";
import { prisma } from "../src/lib/db";
import { criarCheckout } from "../src/lib/asaas";

/**
 * Descobre por que PIX ou boleto não estão funcionando — falando com o Asaas.
 *
 * ── Por que um script, e não tentativa no site ─────────────────────────────────
 * Quando o Asaas recusa uma cobrança, o cliente vê "Não foi possível abrir o
 * pagamento agora" e o motivo real fica no log do servidor. Este script pergunta
 * direto e imprime a resposta CRUA do provedor, que é o único jeito de distinguir
 * "falta cadastrar chave PIX na conta" de "o código monta o pedido errado" — dois
 * problemas com a mesma tela de erro e consertos completamente diferentes.
 *
 * ── O que ele faz, e o que NÃO faz ────────────────────────────────────────────
 * As verificações de conta são de leitura. A tentativa de PIX cria uma SESSÃO DE
 * CHECKOUT, que não cobra ninguém e expira em 60 minutos. A tentativa de boleto
 * (--boleto) cria cliente e assinatura de verdade e, por isso, APAGA a assinatura
 * em seguida — um boleto aberto no nome de alguém não pode sobrar de um teste.
 *
 * Uso, no shell do serviço em produção:
 *   npx tsx scripts/diagnostico-pagamento.ts
 *   npx tsx scripts/diagnostico-pagamento.ts --boleto
 *   npx tsx scripts/diagnostico-pagamento.ts --fluxo
 *
 * `--fluxo` é o que os outros itens NÃO provam: ele chama `criarCheckout`, a mesma
 * função que o botão do site chama, e confere que a sessão ficou gravada em
 * `AsaasCheckout`. "O Asaas aceita PIX" e "o botão de PIX do site funciona" são
 * afirmações diferentes: o vínculo gravado na criação é o que permite identificar o
 * comprador quando o pagamento chega, e foi a ausência dele que fez o primeiro
 * pagamento real entrar sem liberar nada.
 */

type Json = Record<string, unknown>;

const CPF_DE_TESTE = "52998224725"; // dígitos verificadores válidos, não pertence a ninguém

async function chamar(
  path: string,
  init: RequestInit = { method: "GET" },
): Promise<{ ok: boolean; status: number; corpo: Json }> {
  const res = await fetch(`${env.asaas.apiBaseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "PrescricaoPro/1.0 (Node.js)",
      access_token: env.asaas.apiKey,
      ...(init.headers ?? {}),
    },
  });
  const texto = await res.text();
  let corpo: Json = {};
  try {
    corpo = texto ? (JSON.parse(texto) as Json) : {};
  } catch {
    corpo = { raw: texto.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, corpo };
}

function erroDe(corpo: Json): string {
  const erros = (corpo as { errors?: Array<{ code?: string; description?: string }> }).errors;
  if (!erros?.length) return JSON.stringify(corpo).slice(0, 400);
  return erros.map((e) => `${e.code ?? "?"}: ${e.description ?? "?"}`).join(" | ");
}

function titulo(t: string) {
  console.log(`\n${"─".repeat(70)}\n${t}\n${"─".repeat(70)}`);
}

async function main() {
  if (!env.asaas.apiKey) {
    console.error("ASAAS_API_KEY não configurada neste ambiente. Rode no shell do serviço em produção.");
    process.exit(1);
  }
  console.log(`Ambiente Asaas: ${env.asaas.ambiente}  (${env.asaas.apiBaseUrl})`);

  // ── 1. A conta está apta a cobrar? ─────────────────────────────────────────
  titulo("1. SITUAÇÃO DA CONTA");
  const status = await chamar("/myAccount/status");
  if (!status.ok) {
    console.log(`  ✗ não foi possível ler a situação (HTTP ${status.status}): ${erroDe(status.corpo)}`);
  } else {
    for (const [campo, valor] of Object.entries(status.corpo)) {
      console.log(`  ${campo.padEnd(24)} ${typeof valor === "object" ? JSON.stringify(valor) : String(valor)}`);
    }
  }

  /**
   * ── 2. Chave PIX ───────────────────────────────────────────────────────────
   * É a causa nº 1 de PIX que não funciona: a API recusa a cobrança quando a
   * conta não tem NENHUMA chave PIX ativa, e a mensagem não diz isso com clareza.
   * Só o TIPO e a situação de cada chave são impressos — o valor da chave é dado
   * pessoal (CPF, e-mail, telefone) e não precisa aparecer num log.
   */
  titulo("2. CHAVES PIX DA CONTA");
  const chaves = await chamar("/pix/addressKeys?limit=20");
  if (!chaves.ok) {
    console.log(`  ✗ HTTP ${chaves.status}: ${erroDe(chaves.corpo)}`);
  } else {
    const lista = (chaves.corpo as { data?: Array<Json> }).data ?? [];
    if (lista.length === 0) {
      console.log("  ✗ NENHUMA chave PIX cadastrada.");
      console.log("    É provavelmente a causa do PIX não funcionar: sem chave ativa, o Asaas");
      console.log("    recusa a cobrança em PIX. Cadastre em Asaas → PIX → Minhas chaves.");
    } else {
      for (const c of lista) {
        console.log(`  ${String(c.type).padEnd(12)} situação: ${c.status}`);
      }
      const ativa = lista.some((c) => String(c.status).toUpperCase() === "ACTIVE");
      console.log(ativa ? "  ✓ há chave ATIVA" : "  ✗ nenhuma chave está ATIVA — o PIX vai falhar");
    }
  }

  // ── 3. Tentativa real de checkout em PIX (não cobra ninguém) ───────────────
  titulo("3. TENTATIVA DE CHECKOUT EM PIX");
  const pix = await chamar("/checkouts", {
    method: "POST",
    body: JSON.stringify({
      billingTypes: ["PIX"],
      chargeTypes: ["DETACHED"],
      minutesToExpire: 60,
      externalReference: "diagnostico:pix",
      callback: {
        successUrl: `${env.appUrl}/assinatura?status=sucesso`,
        cancelUrl: `${env.appUrl}/assinatura?status=cancelado`,
        expiredUrl: `${env.appUrl}/assinatura?status=expirado`,
      },
      items: [{ name: "Diagnóstico", description: "Diagnóstico", quantity: 1, value: 5 }],
    }),
  });
  if (pix.ok) {
    console.log(`  ✓ PIX aceito pelo Asaas. Link: ${(pix.corpo as { link?: string }).link}`);
    console.log("    (sessão de teste; expira em 60 minutos e não cobra ninguém)");
  } else {
    console.log(`  ✗ RECUSADO (HTTP ${pix.status}): ${erroDe(pix.corpo)}`);
  }

  // ── 4. Cartão, para comparar ───────────────────────────────────────────────
  titulo("4. TENTATIVA DE CHECKOUT EM CARTÃO (recorrente) — para comparação");
  const cartao = await chamar("/checkouts", {
    method: "POST",
    body: JSON.stringify({
      billingTypes: ["CREDIT_CARD"],
      chargeTypes: ["RECURRENT"],
      minutesToExpire: 60,
      externalReference: "diagnostico:cartao",
      callback: {
        successUrl: `${env.appUrl}/assinatura?status=sucesso`,
        cancelUrl: `${env.appUrl}/assinatura?status=cancelado`,
        expiredUrl: `${env.appUrl}/assinatura?status=expirado`,
      },
      subscription: { cycle: "MONTHLY", nextDueDate: new Date().toISOString().slice(0, 10) },
      items: [{ name: "Diagnóstico", description: "Diagnóstico", quantity: 1, value: 5 }],
    }),
  });
  console.log(cartao.ok ? "  ✓ cartão aceito" : `  ✗ RECUSADO (HTTP ${cartao.status}): ${erroDe(cartao.corpo)}`);

  // ── 5. Boleto: só com --boleto, porque cria cobrança de verdade ────────────
  if (process.argv.includes("--boleto")) {
    titulo("5. TENTATIVA DE BOLETO (cria e apaga em seguida)");
    const cliente = await chamar("/customers", {
      method: "POST",
      body: JSON.stringify({
        name: "Diagnóstico Prescrição Pro",
        email: "diagnostico@prescricaopro.com.br",
        cpfCnpj: CPF_DE_TESTE,
        externalReference: "diagnostico:cliente",
        notificationDisabled: true, // não avisa ninguém sobre um boleto de teste
      }),
    });
    if (!cliente.ok) {
      console.log(`  ✗ criação do CLIENTE recusada (HTTP ${cliente.status}): ${erroDe(cliente.corpo)}`);
    } else {
      const clienteId = String((cliente.corpo as { id?: string }).id);
      console.log(`  ✓ cliente criado: ${clienteId}`);

      const assinatura = await chamar("/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          customer: clienteId,
          billingType: "BOLETO",
          value: 5,
          nextDueDate: new Date().toISOString().slice(0, 10),
          cycle: "MONTHLY",
          description: "Diagnóstico de boleto",
          externalReference: "diagnostico:boleto",
        }),
      });
      if (!assinatura.ok) {
        console.log(`  ✗ ASSINATURA EM BOLETO recusada (HTTP ${assinatura.status}): ${erroDe(assinatura.corpo)}`);
      } else {
        const assinaturaId = String((assinatura.corpo as { id?: string }).id);
        console.log(`  ✓ assinatura em boleto criada: ${assinaturaId}`);

        const cobrancas = await chamar(`/subscriptions/${assinaturaId}/payments`);
        const primeira = ((cobrancas.corpo as { data?: Array<Json> }).data ?? [])[0];
        console.log(
          primeira
            ? `  ✓ boleto emitido: ${primeira.bankSlipUrl ?? primeira.invoiceUrl} (venc. ${primeira.dueDate})`
            : `  ⚠ assinatura criada, mas nenhuma cobrança listada: ${erroDe(cobrancas.corpo)}`,
        );

        // Limpeza obrigatória: boleto de teste não pode ficar aberto.
        const apagar = await chamar(`/subscriptions/${assinaturaId}`, { method: "DELETE" });
        console.log(apagar.ok ? "  ✓ assinatura de teste apagada" : `  ⚠ NÃO consegui apagar ${assinaturaId} — apague no painel`);
      }
    }
  } else {
    titulo("5. BOLETO");
    console.log("  (não testado — repita com --boleto. Ele cria cobrança de verdade e apaga em seguida.)");
  }

  // ── 5b. O caminho REAL do site, ponta a ponta ──────────────────────────────
  if (process.argv.includes("--fluxo")) {
    titulo("5b. FLUXO DO SITE: criarCheckout em PIX (mesma função do botão)");
    const plano = await prisma.plan.findFirst({
      where: { active: true, publicPlan: true, contactOnly: false },
      orderBy: { sortOrder: "asc" },
    });
    const dono = await prisma.user.findFirst({ where: { role: "ADMIN" }, select: { id: true, email: true } });
    if (!plano || !dono) {
      console.log("  ✗ sem plano público ou sem usuário ADMIN para testar.");
    } else {
      console.log(`  plano: ${plano.slug} (${(plano.priceCents / 100).toFixed(2)})  conta: ${dono.email}`);
      try {
        const { url } = await criarCheckout({
          tipo: "plano",
          slug: plano.slug,
          nome: plano.name,
          valorCents: plano.priceCents,
          userId: dono.id,
          cycle: plano.period === "ANUAL" ? "YEARLY" : "MONTHLY",
          metodo: "pix",
        });
        console.log(`  ✓ link gerado: ${url}`);
        /**
         * A sessão gravada é o que amarra o pagamento à conta. Sem ela, o dinheiro
         * entra e ninguém sabe de quem é — foi exatamente o que aconteceu no primeiro
         * pagamento real, e o motivo de esta verificação existir.
         */
        const idDaSessao = url.split("/").pop() ?? "";
        const vinculo = idDaSessao
          ? await prisma.asaasCheckout.findUnique({ where: { id: idDaSessao } })
          : null;
        console.log(
          vinculo
            ? `  ✓ vínculo gravado: sessão ${idDaSessao} → ${vinculo.tipo}:${vinculo.slug} do usuário ${vinculo.userId}`
            : `  ✗ VÍNCULO NÃO GRAVADO para a sessão ${idDaSessao} — o pagamento entraria sem dono`,
        );
        console.log("    (sessão de teste; expira em 60 minutos e não cobra ninguém)");
      } catch (err) {
        console.log(`  ✗ criarCheckout falhou: ${(err as Error).message}`);
      }
    }
  }

  // ── 6. Nosso lado: o webhook está recebendo? ───────────────────────────────
  titulo("6. O QUE O NOSSO BANCO REGISTROU");
  const [pagamentos, sessoes] = await Promise.all([
    prisma.payment.findMany({
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { externalId: true, status: true, method: true, amountCents: true, createdAt: true, provider: true },
    }),
    prisma.asaasCheckout.count(),
  ]);
  console.log(`  sessões de checkout gravadas: ${sessoes}`);
  console.log(`  últimos pagamentos (${pagamentos.length}):`);
  for (const p of pagamentos) {
    /**
     * O PROVIDER é a coluna que evita a leitura errada mais fácil desta lista:
     * a liberação manual do painel grava um pagamento com a forma escolhida no
     * seletor — "pix", por exemplo — e sem `externalId`. Sem esta coluna, dois
     * acessos liberados à mão parecem duas vendas em PIX.
     */
    console.log(
      `    ${p.createdAt.toISOString().slice(0, 16)}  ${p.provider.padEnd(8)} ${String(p.method ?? "-").padEnd(12)} ` +
        `${p.status.padEnd(10)} ${(p.amountCents / 100).toFixed(2).padStart(8)}  ${p.externalId ?? "(sem id no provedor)"}`,
    );
  }
  if (pagamentos.length === 0) {
    console.log("    (nenhum — se você pagou e nada apareceu aqui, o problema é o webhook, não o checkout)");
  }

  titulo("RESUMO");
  console.log(`  PIX no Asaas:     ${pix.ok ? "OK" : "RECUSADO — ver item 3"}`);
  console.log(`  Cartão no Asaas:  ${cartao.ok ? "OK" : "RECUSADO — ver item 4"}`);
  console.log("  Boleto:           " + (process.argv.includes("--boleto") ? "ver item 5" : "não testado"));
  console.log("  Fluxo do site:    " + (process.argv.includes("--fluxo") ? "ver item 5b" : "não testado (use --fluxo)"));
}

main()
  .catch((e) => {
    console.error("erro:", (e as Error).message);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
