import { prisma } from "../src/lib/db";

/**
 * Liga uma sessão de checkout do Asaas à conta que comprou.
 *
 * ── Para que serve ────────────────────────────────────────────────────────────
 * O Asaas não devolve o nosso `externalReference` nos eventos de cobrança
 * recorrente (verificado na API: nulo no pagamento e nulo na assinatura). O que a
 * assinatura traz é `checkoutSession`, e é por esse id que o sistema descobre de
 * quem é o pagamento — o vínculo é gravado por `criarCheckout` em `AsaasCheckout`.
 *
 * Este script existe para os casos em que o vínculo NÃO existe:
 *  - pagamento feito por um checkout aberto ANTES desta gravação passar a existir
 *    (foi o caso do primeiro pagamento real do produto);
 *  - falha ao gravar o vínculo na abertura do checkout (o log avisa quando ocorre).
 *
 * Depois de vincular, use "Reenviar" no log do webhook, no painel do Asaas: o
 * evento volta a ser processado pelo caminho normal do código, com a idempotência
 * de sempre — não credita em dobro.
 *
 * ── Uso (Shell do Render) ─────────────────────────────────────────────────────
 *   npx tsx scripts/vincular-checkout-asaas.ts \
 *     --sessao=<id da sessão> --email=<conta> --slug=<plano ou pacote> [--tipo=plano]
 *
 * Sem `--confirmar`, apenas mostra o que faria. O primeiro comando que a pessoa
 * digita não pode ser o que escreve no banco.
 *
 * Onde achar o id da sessão: painel do Asaas › Cobranças › Assinaturas › a
 * assinatura › campo `checkoutSession`. Ou é o último trecho da URL de pagamento
 * (`.../checkoutSession/show/<id>`).
 */

function arg(nome: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${nome}=`));
  return p?.slice(nome.length + 3);
}
const tem = (nome: string) => process.argv.includes(`--${nome}`);

const TIPOS = ["plano", "pacote", "upgrade"] as const;
type Tipo = (typeof TIPOS)[number];

async function main() {
  const sessao = arg("sessao")?.trim();
  const email = arg("email")?.trim().toLowerCase();
  const slug = arg("slug")?.trim();
  const tipo = (arg("tipo")?.trim() ?? "plano") as Tipo;

  if (!sessao || !email || !slug) {
    console.error("Uso: --sessao=<id> --email=<conta> --slug=<plano/pacote> [--tipo=plano|pacote|upgrade]");
    console.error("Sem --confirmar, o script apenas mostra o que faria.");
    process.exit(2);
  }
  if (!TIPOS.includes(tipo)) {
    console.error(`Tipo inválido: "${tipo}". Use plano, pacote ou upgrade.`);
    process.exit(2);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`Nenhuma conta com o e-mail ${email}.`);
    process.exit(1);
  }

  // O destino tem de existir, senão o webhook vai falhar depois — melhor recusar
  // agora, com a mensagem clara, do que gravar um vínculo que não resolve nada.
  if (tipo === "pacote") {
    const pacote = await prisma.creditPack.findUnique({ where: { slug } });
    if (!pacote) {
      console.error(`Pacote "${slug}" não existe. Pacotes disponíveis:`);
      const todos = await prisma.creditPack.findMany({ select: { slug: true, name: true } });
      todos.forEach((p) => console.error(`  ${p.slug}  (${p.name})`));
      process.exit(1);
    }
  } else {
    const plano = await prisma.plan.findUnique({ where: { slug } });
    if (!plano) {
      console.error(`Plano "${slug}" não existe. Planos disponíveis:`);
      const todos = await prisma.plan.findMany({ select: { slug: true, name: true, priceCents: true } });
      todos.forEach((p) => console.error(`  ${p.slug}  (${p.name}, ${(p.priceCents / 100).toFixed(2)})`));
      process.exit(1);
    }
  }

  const existente = await prisma.asaasCheckout.findUnique({ where: { id: sessao } });

  console.log("");
  console.log("Vínculo a gravar");
  console.log(`  sessão de checkout .. ${sessao}`);
  console.log(`  conta ............... ${user.email}  (${user.name})`);
  console.log(`  userId .............. ${user.id}`);
  console.log(`  tipo / slug ......... ${tipo} / ${slug}`);
  if (existente) {
    console.log("");
    console.log("JÁ EXISTE um vínculo para esta sessão:");
    console.log(`  tipo / slug ......... ${existente.tipo} / ${existente.slug}`);
    console.log(`  userId .............. ${existente.userId}`);
    console.log("  (será substituído)");
  }
  console.log("");

  if (!tem("confirmar")) {
    console.log("Nada foi gravado (faltou --confirmar).");
    console.log(
      `Para gravar:  npx tsx scripts/vincular-checkout-asaas.ts --sessao=${sessao} --email=${email} --slug=${slug} --tipo=${tipo} --confirmar`,
    );
    return;
  }

  await prisma.asaasCheckout.upsert({
    where: { id: sessao },
    update: { tipo, slug, userId: user.id },
    create: { id: sessao, tipo, slug, userId: user.id },
  });

  const gravado = await prisma.asaasCheckout.findUniqueOrThrow({ where: { id: sessao } });
  console.log("GRAVADO:", JSON.stringify(gravado));
  console.log("");
  console.log("Agora, no painel do Asaas: Integrações › Logs de Webhooks › o log da");
  console.log("cobrança › Reenviar. O evento será processado pelo caminho normal.");
}

main()
  .catch((e) => {
    console.error("[vincular-checkout-asaas] erro:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
