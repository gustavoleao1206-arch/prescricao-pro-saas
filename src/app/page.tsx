import Link from "next/link";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/marketing/site-header";
import { SiteFooter } from "@/components/marketing/site-footer";
import { HeroInterativo } from "@/components/marketing/hero-interativo";
import { FAIXAS_CUSTO } from "@/lib/credits";
import {
  AVISO_REVISAO,
  BENEFICIOS_SISTEMA,
  CREDITOS_MENSAIS,
  PLANOS,
  VALIDADE_CREDITO_ADICIONAL_DIAS,
  VALOR_UNITARIO_CREDITO_CENTS,
  precoBR,
  type DefinicaoPlano,
} from "@/lib/planos";

export const metadata: Metadata = {
  // `absolute` evita o template do layout raiz duplicar o nome do produto.
  title: { absolute: "Prescrição Pro: prescrição, decadência e prescrição intercorrente" },
  description:
    "Inteligência artificial para análise de prescrição, decadência e prescrição intercorrente em processos tributários.",
  robots: { index: true, follow: true },
};

/**
 * Menor mensalidade vigente para a chamada "a partir de". Sai do catálogo
 * comercial, nunca escrita no JSX: preço divergente entre a página de vendas e
 * a cobrança já foi um problema neste projeto.
 */
const MENOR_MENSAL = PLANOS.reduce<DefinicaoPlano | null>((menor, plano) => {
  if (plano.contactOnly || plano.period !== "MENSAL" || plano.priceCents <= 0) return menor;
  return !menor || plano.priceCents < menor.priceCents ? plano : menor;
}, null);

/**
 * Páginas cobertas por 1 crédito — primeira faixa de FAIXAS_CUSTO.
 *
 * É o número que torna "{CREDITOS_MENSAIS} análises por mês" verdadeiro em vez de
 * aproximado: a cota é contada em CRÉDITOS, e um processo acima desta faixa consome
 * mais de um. Sem dizer isto, a chamada comercial prometeria mais análises do que a
 * cota entrega para quem manda processo grande (arts. 30 e 37 do CDC).
 */
const PAGINAS_POR_CREDITO = FAIXAS_CUSTO[0].atePaginas;

const num = (n: number) => n.toLocaleString("pt-BR");

export default function HomePage() {
  return (
    // Mesma casca das demais páginas públicas. A home fica fora do grupo
    // (marketing), então o cabeçalho e o rodapé são compostos aqui.
    <div className="veu-claro-forte flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        {/*
          Hero no layout da referência hero05, aprovado pelo dono: página cheia,
          tipografia gigante, um CTA dominante e régua lateral. NENHUM texto foi
          alterado — é a cópia anterior, reorganizada. O hero é sempre escuro
          (identidade da marca), por isso as cores aqui são explícitas em vez da
          escala reativa ao tema.
        */}
        <HeroInterativo
          aside={
            <ol className="flex flex-row flex-wrap gap-8 lg:flex-col lg:gap-9">
              {/* As três matérias, com os títulos EXATOS da seção de benefícios. */}
              {BENEFICIOS_SISTEMA.slice(0, 3).map((beneficio, i) => (
                <li key={beneficio.titulo}>
                  <span
                    aria-hidden
                    className="font-display text-3xl font-bold text-transparent"
                    // Clip de texto precisa do par com prefixo: sem o -webkit- o
                    // gradiente vira um bloco sólido no lugar do número.
                    style={{
                      background: "linear-gradient(120deg,#4F7CFF,#26D5EE)",
                      WebkitBackgroundClip: "text",
                      backgroundClip: "text",
                    }}
                  >
                    0{i + 1}
                  </span>
                  <span className="mt-1 block text-xs font-medium uppercase tracking-[0.16em] text-white/70">
                    {beneficio.titulo}
                  </span>
                </li>
              ))}
            </ol>
          }
        >
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-ciano-300">
            Apoio jurídico com inteligência artificial
          </p>

          <h1 className="mt-5 font-display text-6xl font-bold tracking-tight text-white sm:text-7xl lg:text-8xl">
            Prescrição Pro
          </h1>

          <p className="mt-6 max-w-2xl text-lg text-white/90 sm:text-xl">
            Inteligência artificial para análise de prescrição, decadência e prescrição intercorrente em processos
            tributários.
          </p>

          <p className="mt-5 max-w-2xl hyphens-auto text-justify leading-relaxed text-white/65">
            O Prescrição Pro analisa documentos e processos judiciais, identifica possíveis teses de prescrição e
            decadência, organiza a linha do tempo processual, apresenta fundamentação jurídica e, quando houver
            viabilidade, gera uma sugestão de petição.
          </p>

          {/*
            Dois caminhos, não três. "Conheça os planos" saiu a pedido do dono, e
            era mesmo redundante: apontava para /planos, o mesmo destino de
            "Assinar agora", com o mesmo peso visual do terceiro botão. Sobram os
            dois caminhos que de fato se excluem — comprar ou entrar na conta —
            e o terceiro ganhou o contorno que faltava para não parecer um link
            solto ao lado de um botão.
          */}
          <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <Link
              href="/planos"
              className="btn-primary w-full px-7 py-3.5 text-base sm:w-auto"
            >
              Assinar agora
            </Link>
            <Link
              href="/login"
              className="inline-flex w-full items-center justify-center rounded-xl border border-white/25 px-6 py-3.5 text-sm font-semibold text-white transition hover:bg-white/10 sm:w-auto"
            >
              Acessar minha conta
            </Link>
          </div>

          {/*
            "Sem fidelidade, cancele quando quiser" ficou, porque é verdade — não há
            prazo mínimo e o cancelamento é imediato. O que faltava era a ressalva do
            efeito: cancelar interrompe as renovações e o acesso vale até o fim do
            período já pago; não devolve o que foi pago, salvo no arrependimento de 7
            dias. Sem isso, quem paga o ano à vista lê a frase como promessa de
            devolução proporcional (arts. 30 e 31 do CDC).
          */}
          {MENOR_MENSAL && (
            <p className="mt-6 hyphens-auto text-justify text-sm text-white/60">
              Planos a partir de <strong className="text-white">{precoBR(MENOR_MENSAL.priceCents)}</strong> por
              mês. Sem prazo mínimo: cancele quando quiser, com acesso até o fim do período já pago.{" "}
              <Link href="/cancelamento" className="underline hover:text-white">
                Regras de cancelamento e devolução
              </Link>
              .
            </p>
          )}
        </HeroInterativo>

        <section className="container-page border-t border-neutro-200 py-16 lg:py-20">
          <div className="max-w-2xl">
            <h2 className="text-3xl font-bold">O que o sistema entrega</h2>
            <p className="mt-3 hyphens-auto text-justify text-neutro-600">
              Cada análise percorre a cronologia dos autos e devolve uma resposta fundamentada, pronta para conferência
              do advogado responsável.
            </p>
          </div>

          <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {BENEFICIOS_SISTEMA.map((beneficio) => (
              <li key={beneficio.titulo} className="card flex h-full flex-col p-6">
                <span aria-hidden className="h-1 w-10 rounded-full grad-marca" />
                <h3 className="mt-4 text-base">{beneficio.titulo}</h3>
                <p className="mt-2 hyphens-auto text-justify text-sm leading-relaxed text-neutro-600">
                  {beneficio.texto}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="container-page border-t border-neutro-200 py-16 lg:py-20">
          <div className="grid gap-8 lg:grid-cols-2 lg:items-center">
            <div>
              {/*
                Título curto, a pedido do dono. O número da cota saiu do título e
                continua no parágrafo logo abaixo, que é lido junto — não se perde
                a informação, muda só onde ela é dita.
              */}
              <h2 className="text-3xl font-bold">Assinatura</h2>
              <p className="mt-4 hyphens-auto text-justify text-neutro-600">
                A assinatura libera {CREDITOS_MENSAIS} créditos por ciclo mensal, e 1 crédito analisa um processo de
                até {num(PAGINAS_POR_CREDITO)} páginas — processo maior consome mais de um crédito. Se a cota acabar
                antes do fim do mês, você compra crédito avulso por {precoBR(VALOR_UNITARIO_CREDITO_CENTS)} cada, a
                qualquer momento e sem alterar a assinatura. A escolha é só entre pagar por mês ou pagar o ano de uma
                vez, com desconto.
              </p>
              {/*
                Duas ressalvas que precisam andar juntas com o anúncio da cota:

                1) A cota é teto de QUANTIDADE, mas não é o único limite — tamanho do
                   arquivo, páginas por processo e ritmo de uso existem no código e
                   eram aplicados sem que nenhum texto avisasse (art. 37 do CDC).
                2) A validade assimétrica. Cota mensal não acumula; crédito avulso dura
                   VALIDADE_CREDITO_ADICIONAL_DIAS e atravessa a virada do ciclo. Omitir
                   isso é o que faz o cliente comprar avulso no dia 28 achando que soma
                   com a cota nova — ou perder o avulso que na verdade continua valendo.
              */}
              <p className="mt-3 hyphens-auto text-justify text-sm text-neutro-500">
                A cota mensal não é cumulativa: o que sobrar expira na virada do ciclo. O crédito avulso é diferente —
                vale {VALIDADE_CREDITO_ADICIONAL_DIAS} dias e continua valendo depois da virada. O consumo por faixa de
                páginas está na{" "}
                <Link href="/politica-de-creditos" className="underline">
                  Política de Créditos
                </Link>
                . Continuam valendo os limites técnicos de cada envio — tamanho do arquivo, número de páginas por
                processo e ritmo de uso —, descritos na{" "}
                <Link href="/uso-aceitavel" className="underline">
                  Política de Uso Aceitável
                </Link>
                . A conta é individual: o acesso não é compartilhado entre pessoas.
              </p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link href="/planos" className="btn-primary w-full sm:w-auto">
                  Ver planos e assinar
                </Link>
                <Link href="/como-funciona" className="btn-outline w-full sm:w-auto">
                  Como funciona
                </Link>
              </div>
            </div>

            {/*
              Aviso obrigatório em toda apresentação comercial. Card da marca
              com filete azul, no lugar do quadro âmbar vetado pelo dono: o
              card já garante o contraste nos dois temas.
            */}
            <div className="card border-l-4 p-7" style={{ borderLeftColor: "#4f7cff" }}>
              <h2 className="text-lg">Aviso de responsabilidade</h2>
              <p className="mt-3 hyphens-auto text-justify text-sm leading-relaxed text-neutro-800">{AVISO_REVISAO}</p>
              <Link
                href="/responsabilidade"
                className="mt-4 inline-block text-sm font-semibold text-marca-700 underline underline-offset-4 hover:text-marca-600 dark:text-marca-300"
              >
                Ler o aviso completo
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
