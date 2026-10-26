import type { Metadata } from "next";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { ATENDIMENTO, linkWhatsApp } from "@/lib/contato";
import { FAIXAS_CUSTO } from "@/lib/credits";
import {
  AVISO_REVISAO,
  PACOTES,
  PLANOS,
  VALIDADE_CREDITO_ADICIONAL_DIAS,
  VALOR_UNITARIO_CREDITO_CENTS,
  precoBR,
} from "@/lib/planos";
import { PlanosComparador, type PlanoPublico } from "@/components/marketing/planos-comparador";

export const metadata: Metadata = {
  title: "Planos e assinatura",
  description:
    "Planos mensais e anuais do Prescrição Pro para análise de prescrição, decadência e prescrição intercorrente em processos tributários.",
};
export const dynamic = "force-dynamic";

/**
 * O banco é a autoridade em tempo de execução (o admin altera preço e cota sem
 * publicar código). O catálogo de src/lib/planos.ts só entra como recuo quando o
 * banco está indisponível ou vazio (em build/preview, por exemplo), para a
 * página nunca aparecer sem oferta.
 */
async function carregarPlanos(): Promise<PlanoPublico[]> {
  try {
    const doBanco = await prisma.plan.findMany({
      where: { publicPlan: true, active: true },
      orderBy: { sortOrder: "asc" },
    });
    if (doBanco.length > 0) {
      return doBanco.map((p) => ({
        slug: p.slug,
        // Plano sem família cadastrada vira família própria: melhor exibir um
        // card sozinho do que agrupá-lo por engano com outra oferta.
        family: p.family ?? p.slug,
        name: p.name,
        description: p.description ?? "",
        priceCents: p.priceCents,
        // PACOTE e UNICO não são assinatura; na grade eles se comportam como mensal.
        period: p.period === "ANUAL" ? "ANUAL" : "MENSAL",
        // `monthlyAnalyses` é a cota de CRÉDITOS por ciclo (ver schema.prisma).
        monthlyCredits: p.monthlyAnalyses,
        maxUsers: p.maxUsers,
        highlight: p.highlight,
        contactOnly: p.contactOnly,
        benefits: p.benefits,
        sortOrder: p.sortOrder,
      }));
    }
  } catch {
    // Banco fora do ar: segue para o catálogo estático abaixo.
  }

  return PLANOS.map((p) => ({
    slug: p.slug,
    family: p.family,
    name: p.name,
    description: p.description,
    priceCents: p.priceCents,
    period: p.period,
    monthlyCredits: p.monthlyCredits,
    maxUsers: p.maxUsers,
    highlight: p.highlight,
    contactOnly: p.contactOnly,
    benefits: p.benefits,
    sortOrder: p.sortOrder,
  }));
}

export default async function PlanosPage() {
  const planos = await carregarPlanos();
  // O primeiro canal é o número comercial; os demais são plantão de fim de semana.
  const comercial = ATENDIMENTO[0];
  const whatsappComercial = comercial ? linkWhatsApp(comercial) : "/contato";
  /**
   * Quem já entrou não pode ser mandado para o cadastro ao clicar em "Assinar".
   * Esta página é pública, então a sessão é opcional: `getSessionUser` devolve
   * nulo para visitante, sem erro.
   */
  const autenticado = Boolean(await getSessionUser());
  // Cota 0 significa SEM LIMITE. Plano sem limite não tem "acima da cota".
  const algumPlanoComCota = planos.some((p) => !p.contactOnly && p.monthlyCredits > 0);
  /**
   * Cota anunciada na chamada da página.
   *
   * Sai do plano que está NA TELA, e não do catálogo, porque o admin altera a cota
   * no banco sem publicar código: número fixo na chamada passaria a divergir dos
   * cards logo abaixo, e chamada é publicidade que vincula (art. 30 do CDC).
   *
   * E NÃO há recuo no catálogo de propósito. Havia — `?? CREDITOS_MENSAIS` — e isso
   * criava o pior estado possível na janela entre publicar o código e rodar
   * `sincronizar-catalogo`: o banco ainda com cota 0 (sem limite), os cards escrevendo
   * "Sem limite" e o título logo acima anunciando "20 análises por mês", na mesma
   * tela. Nulo faz a chamada calar sobre o número quando os planos exibidos não têm
   * cota, o que mantém a página coerente nos dois estados.
   */
  const cotaAnunciada = planos.find((p) => !p.contactOnly && p.monthlyCredits > 0)?.monthlyCredits ?? null;

  return (
    <div className="container-page py-16">
      <div className="text-center">
        {/*
          "Planos e assinatura" virou o h1 da página. A chamada grande que ficava
          logo abaixo ("Um plano, N análises por mês") saiu a pedido do dono, e
          era ela que carregava o h1 — sem essa troca, a página de vendas ficaria
          sem título principal, que é o que buscador e leitor de tela usam para
          saber do que ela trata.

          Se a chamada voltar um dia, a regra que ela precisava respeitar continua
          valendo: o texto acompanha a oferta vigente. Já disse "escolha o plano do
          seu volume de processos" (quando havia quatro planos) e "análises sem
          limite" (quando não havia teto). Hoje é UM plano com cota mensal, e
          anunciar "sem limite" prometeria o que a assinatura não entrega — a
          página é publicidade, e publicidade vincula (art. 30 do CDC).
        */}
        <h1 className="badge bg-marca-50 text-marca-700 dark:bg-marca-500/20 dark:text-marca-200">
          Planos e assinatura
        </h1>
        <p className="mx-auto mt-4 max-w-2xl text-neutro-600">
          O plano dá acesso às três modalidades de análise (prescrição ordinária, prescrição intercorrente e
          decadência), à linha do tempo processual, ao relatório fundamentado e à sugestão de petição quando houver
          tese favorável
          {cotaAnunciada !== null ? (
            <>
              {" "}
              — com uma <strong>cota de {cotaAnunciada} créditos por ciclo mensal</strong>
            </>
          ) : null}
          . A escolha é apenas entre pagar por mês ou por ano, com desconto no anual.
        </p>
        {/*
          A cota só é informação honesta com as duas regras que a acompanham: quanto
          vale um crédito (processo grande consome mais de um) e que existe avulso acima
          dela. Anunciar o teto sem o avulso faria o limite parecer uma parede.
        */}
        {cotaAnunciada !== null && (
        <p className="mx-auto mt-3 max-w-2xl text-sm text-neutro-500">
          Um crédito equivale a uma análise de processo de até {FAIXAS_CUSTO[0].atePaginas} páginas; processo maior
          consome mais de um crédito. A cota não é cumulativa: o saldo não utilizado expira na virada do ciclo.
          Precisando de mais análises no mês, o crédito avulso custa {precoBR(VALOR_UNITARIO_CREDITO_CENTS)} e pode
          ser comprado a qualquer momento, sem alterar a assinatura. Regras completas na{" "}
          <Link href="/politica-de-creditos" className="underline">
            Política de Créditos
          </Link>
          .
        </p>
        )}
      </div>

      <PlanosComparador planos={planos} whatsappComercial={whatsappComercial} autenticado={autenticado} />

      {/*
        Crédito avulso só é oferecido se existir plano COM COTA.

        A condição nasceu no período sem teto, quando o avulso não comprava nada: com
        cota 0, `temSaldo` libera sempre e `consumirCreditos` registra o uso sem
        debitar, então vender crédito seria cobrar por função inexistente. Com a cota
        de volta nos planos vigentes ela é verdadeira, e a seção volta a aparecer
        sozinha — era exatamente para isso que a condição foi calculada em vez de o
        bloco ser apagado. Fica no lugar porque plano sem limite continua existindo no
        banco como legado, e porque a cota pública pode ser zerada pelo admin.
      */}
      {algumPlanoComCota && (
      <section className="mt-20">
        <div className="text-center">
          <h2 className="text-2xl font-bold">Créditos avulsos</h2>
          <p className="mx-auto mt-3 max-w-2xl text-neutro-600">
            Para quem precisa de mais análises do que a cota do mês. Podem ser comprados a qualquer momento, sem
            alterar a assinatura. Os créditos avulsos são complementares à assinatura e não a substituem.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-6">
          {[...PACOTES]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((pacote) => (
              <div key={pacote.slug} className="card flex w-full max-w-sm flex-col p-6 text-center">
                <h3 className="text-lg">{pacote.name}</h3>
                <span className="mt-3 font-display text-3xl font-bold text-marinho-700">
                  {precoBR(pacote.priceCents)}
                </span>
                <p className="mt-2 text-sm text-neutro-500">
                  {pacote.credits === 1 ? "1 crédito" : `${pacote.credits} créditos`} · validade de{" "}
                  {pacote.validityDays} dias
                </p>
                <p className="mt-1 text-sm text-neutro-500">Compre a quantidade que precisar.</p>
                {/*
                  O botão levava ao WhatsApp — e agora que a cota existe, o avulso
                  deixou de ser detalhe: é a saída de quem esgotou o mês. Mandar quem
                  já é cliente conversar com um humano para comprar R$ 5,00 é perder a
                  venda no momento em que ela está madura. Logado vai ao pagamento;
                  visitante passa pelo cadastro, porque crédito avulso só é creditado
                  em conta com assinatura ativa (ver `creditarPacote`).
                */}
                <Link
                  href={
                    autenticado
                      ? `/assinatura/contratar?pacote=${encodeURIComponent(pacote.slug)}`
                      : `/cadastro?pacote=${encodeURIComponent(pacote.slug)}`
                  }
                  prefetch={false}
                  className="btn-outline mt-6 w-full justify-center"
                >
                  {autenticado ? "Comprar crédito" : "Criar conta para comprar"}
                </Link>
              </div>
            ))}
        </div>

        {/*
          A frase dizia que o avulso "não é cumulativo com a cota mensal do plano após
          esse prazo" — o oposto do que a Política de Créditos garante: o crédito
          adicional ATRAVESSA a virada do ciclo enquanto estiver dentro da validade. É
          justamente a vantagem que se está vendendo.
        */}
        <p className="mt-6 text-center text-sm text-neutro-500">
          O crédito avulso atravessa a virada do ciclo e vale por{" "}
          {VALIDADE_CREDITO_ADICIONAL_DIAS} dias contados da liberação; passado esse prazo, expira. Regras completas na{" "}
          <Link href="/politica-de-creditos" className="underline">
            Política de Créditos
          </Link>
          .
        </p>
      </section>
      )}

      <section className="mt-20 grid gap-6 md:grid-cols-2">
        <div className="card p-7">
          <h2 className="text-lg">Como funciona a cobrança</h2>
          <ul className="mt-4 space-y-2 text-sm text-neutro-600 [&>li]:hyphens-auto [&>li]:text-justify">
            <li>Pagamento processado em ambiente seguro.</li>
            <li>O acesso é liberado automaticamente após a confirmação do pagamento.</li>
            {/*
              Com cota de volta, "pagamento único por doze meses" sozinho sugeriria a
              cota do ano toda liberada de uma vez. `liberarCreditosDoCiclo` libera mês
              a mês também no anual, e o que sobra expira na virada.
            */}
            <li>
              No plano anual o pagamento é único, o acesso vale os doze meses contratados e os créditos continuam
              sendo liberados a cada ciclo mensal, nunca o ano inteiro de uma vez.
            </li>
            <li>Cancelamento a qualquer tempo, observadas as condições do período já contratado.</li>
          </ul>
        </div>

        {/*
          Aviso obrigatório em toda apresentação comercial. Card da marca com
          filete azul, no lugar do quadro âmbar vetado pelo dono: o card já
          garante o contraste nos dois temas.
        */}
        <div className="card border-l-4 p-7" style={{ borderLeftColor: "#4f7cff" }}>
          <h2 className="text-lg">Aviso de responsabilidade</h2>
          <p className="mt-3 hyphens-auto text-justify text-sm leading-relaxed text-neutro-800">{AVISO_REVISAO}</p>
        </div>
      </section>
    </div>
  );
}
