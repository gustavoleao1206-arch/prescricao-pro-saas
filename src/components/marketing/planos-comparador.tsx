"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  economiaAnual,
  precoBR,
  VALIDADE_CREDITO_ADICIONAL_DIAS,
  VALOR_UNITARIO_CREDITO_CENTS,
  type FamiliaPlano,
  type Periodicidade,
} from "@/lib/planos";

/**
 * Grade comercial de planos com alternância Mensal / Anual.
 *
 * O componente recebe os planos já normalizados pelo servidor (banco ou catálogo
 * de recuo) e só cuida da apresentação: agrupar as variantes da mesma família,
 * trocar o card conforme a periodicidade escolhida e destacar o plano marcado
 * como `highlight`.
 */

/** Plano na forma que a tela consome, igual venha do banco ou do catálogo. */
export interface PlanoPublico {
  slug: string;
  /** Agrupa a variante mensal e a anual do MESMO plano comercial. */
  family: string;
  name: string;
  description: string;
  priceCents: number;
  period: Periodicidade;
  /** Créditos liberados por ciclo MENSAL, inclusive no plano anual. */
  monthlyCredits: number;
  maxUsers: number;
  highlight: boolean;
  contactOnly: boolean;
  benefits: string[];
  sortOrder: number;
}

const FAMILIAS_CATALOGO: readonly FamiliaPlano[] = ["prescricao-pro"];

/** A família do banco é texto livre; só o catálogo conhece a economia anual. */
function ehFamiliaDoCatalogo(family: string): family is FamiliaPlano {
  return (FAMILIAS_CATALOGO as readonly string[]).includes(family);
}

/**
 * Economia do anual frente a 12 meses do mensal.
 *
 * O cálculo prioriza os preços que estão NA TELA porque o administrador pode
 * alterar valores no banco sem tocar no código, e usar sempre o catálogo faria a
 * porcentagem divergir do preço exibido. `economiaAnual` entra apenas quando a
 * variante mensal não é pública e, portanto, não há par para comparar.
 */
function economiaDoPar(anual: PlanoPublico, mensal: PlanoPublico | undefined): number | null {
  if (mensal && mensal.priceCents > 0) {
    const cheio = mensal.priceCents * 12;
    return Math.round(((cheio - anual.priceCents) / cheio) * 100);
  }
  return ehFamiliaDoCatalogo(anual.family) ? economiaAnual(anual.family) : null;
}

/** Família comercial com as duas variantes de cobrança que existirem. */
interface Familia {
  chave: string;
  sortOrder: number;
  mensal?: PlanoPublico;
  anual?: PlanoPublico;
}

function agruparPorFamilia(planos: PlanoPublico[]): Familia[] {
  const mapa = new Map<string, Familia>();
  for (const plano of planos) {
    const atual = mapa.get(plano.family) ?? { chave: plano.family, sortOrder: plano.sortOrder };
    if (plano.period === "ANUAL") atual.anual = plano;
    else atual.mensal = plano;
    // A família herda a menor ordem entre as variantes para não depender de qual
    // delas foi lida primeiro.
    atual.sortOrder = Math.min(atual.sortOrder, plano.sortOrder);
    mapa.set(plano.family, atual);
  }
  return [...mapa.values()].sort((a, b) => a.sortOrder - b.sortOrder);
}

export function PlanosComparador({
  planos,
  whatsappComercial,
  autenticado = false,
}: {
  planos: PlanoPublico[];
  whatsappComercial: string;
  /** Quem já entrou vai direto ao pagamento; visitante passa pelo cadastro. */
  autenticado?: boolean;
}) {
  const [periodo, setPeriodo] = useState<Periodicidade>("MENSAL");

  // Assinaturas recorrentes e "sob consulta" ocupam blocos diferentes da página:
  // o Empresarial não tem preço nem periodicidade para alternar.
  const recorrentes = useMemo(() => agruparPorFamilia(planos.filter((p) => !p.contactOnly)), [planos]);
  const sobConsulta = useMemo(() => planos.filter((p) => p.contactOnly), [planos]);

  const temAnual = recorrentes.some((f) => f.anual);

  return (
    <>
      {temAnual && (
        <div className="mt-10 flex justify-center">
          <div
            role="group"
            aria-label="Periodicidade da assinatura"
            className="inline-flex rounded-full border border-neutro-200 bg-superficie p-1 shadow-card"
          >
            <BotaoPeriodo atual={periodo} valor="MENSAL" onSelect={setPeriodo}>
              Mensal
            </BotaoPeriodo>
            <BotaoPeriodo atual={periodo} valor="ANUAL" onSelect={setPeriodo}>
              Anual
            </BotaoPeriodo>
          </div>
        </div>
      )}

      {periodo === "ANUAL" && (
        <p className="mx-auto mt-4 max-w-2xl text-center text-sm text-neutro-600">
          No plano anual o pagamento é feito de uma vez, mas os créditos continuam sendo liberados{" "}
          <strong>mensalmente</strong>, a cada ciclo, e nunca todos de uma só vez.
        </p>
      )}

      {/*
        Centralizado, e não em grade de colunas fixas: hoje existe UMA família de
        plano, e numa grade de três colunas o cartão único encostava na margem
        esquerda com dois vãos vazios à direita. O flex centralizado serve tanto a
        um cartão quanto a vários, sem depender de quantos planos existem.
      */}
      <div className="mt-10 flex flex-wrap items-stretch justify-center gap-6">
        {recorrentes.map((familia) => {
          // Nem toda família tem as duas variantes; quando falta a escolhida,
          // mostramos a que existe em vez de sumir com a oferta da tela.
          const escolhido = (periodo === "ANUAL" ? familia.anual : familia.mensal) ?? familia.mensal ?? familia.anual;
          if (!escolhido) return null;
          const economia = escolhido.period === "ANUAL" ? economiaDoPar(escolhido, familia.mensal) : null;
          return (
            <div key={familia.chave} className="w-full max-w-[24rem]">
              <CardPlano plano={escolhido} economia={economia} autenticado={autenticado} />
            </div>
          );
        })}
      </div>

      {sobConsulta.length > 0 && (
        <div className="mt-8 grid gap-6">
          {sobConsulta.map((plano) => (
            <CardSobConsulta key={plano.slug} plano={plano} whatsappComercial={whatsappComercial} />
          ))}
        </div>
      )}
    </>
  );
}

function BotaoPeriodo({
  atual,
  valor,
  onSelect,
  children,
}: {
  atual: Periodicidade;
  valor: Periodicidade;
  onSelect: (v: Periodicidade) => void;
  children: React.ReactNode;
}) {
  const ativo = atual === valor;
  return (
    <button
      type="button"
      aria-pressed={ativo}
      onClick={() => onSelect(valor)}
      className={`rounded-full px-6 py-2 font-display text-sm font-semibold transition ${
        ativo ? "grad-marca text-[#04122e] shadow-card" : "text-neutro-600 hover:text-marinho-700"
      }`}
    >
      {children}
    </button>
  );
}

function CardPlano({
  plano,
  economia,
  autenticado,
}: {
  plano: PlanoPublico;
  economia: number | null;
  autenticado: boolean;
}) {
  const anual = plano.period === "ANUAL";
  return (
    <div
      className={`card relative flex h-full flex-col p-7 ${
        plano.highlight ? "border-2 border-marca-400 shadow-elevada lg:-mt-4 lg:pb-10 lg:pt-11" : ""
      }`}
    >
      {plano.highlight && (
        <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full grad-marca px-4 py-1 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-[#04122e] shadow-card">
          Mais escolhido
        </span>
      )}

      <h3 className="text-xl">{plano.name}</h3>
      {plano.description && <p className="mt-1 min-h-[2.75rem] text-sm text-neutro-500">{plano.description}</p>}

      <div className="mt-5 flex items-end gap-1">
        <span className="font-display text-4xl font-bold text-marinho-700">{precoBR(plano.priceCents)}</span>
        <span className="mb-1.5 text-sm text-neutro-500">{anual ? "/ano" : "/mês"}</span>
      </div>

      {anual && economia !== null && economia > 0 && (
        <span className="badge mt-3 self-start bg-sucesso-50 text-sucesso dark:bg-sucesso/15 dark:text-emerald-300">
          Economia de {economia}% frente a 12 meses do mensal
        </span>
      )}

      {/*
        Cota 0 não é "zero análises": em todo o sistema cota 0 significa SEM LIMITE
        (`saldoDe` devolve ilimitado e `consumirCreditos` registra o uso sem debitar).
        Nenhum plano vigente usa esse modo, mas o ramo continua de pé porque plano
        legado ainda pode ter cota 0 — e ali exibir o número cru diria "0 créditos por
        mês", o oposto do que aquele plano entrega.

        No ramo com cota, o crédito avulso é anunciado junto com o teto de propósito:
        dizer só o limite faria a cota parecer uma parede, quando ela é o que mantém o
        preço baixo para quem usa o normal.
      */}
      <p className="mt-3 hyphens-auto text-justify text-sm text-neutro-600">
        {plano.monthlyCredits === 0 ? (
          <>
            <strong>Análises sem limite</strong>, sem cota mensal.
          </>
        ) : (
          <>
            <strong>{plano.monthlyCredits}</strong>{" "}
            {plano.monthlyCredits === 1 ? "crédito" : "créditos"} por mês
            {anual ? ", liberados a cada ciclo mensal da assinatura" : ""}. Passada a cota, o crédito
            avulso custa {precoBR(VALOR_UNITARIO_CREDITO_CENTS)} e pode ser comprado a qualquer
            momento, sem alterar a assinatura.
          </>
        )}
      </p>

      {plano.monthlyCredits > 0 && (
        <p className="mt-2 hyphens-auto text-justify text-[11px] leading-snug text-neutro-500">
          1 crédito equivale a 1 análise de processo no tamanho padrão; processo maior consome mais
          de um crédito. A cota mensal não é cumulativa: o saldo não utilizado expira na virada do
          ciclo. O crédito avulso, ao contrário, atravessa a virada e vale por{" "}
          {VALIDADE_CREDITO_ADICIONAL_DIAS} dias. Regras completas na{" "}
          <Link href="/politica-de-creditos" className="underline">
            Política de Créditos
          </Link>
          .
        </p>
      )}

      {/*
        Os itens NÃO são justificados: cada um tem uma ou duas linhas, e justificar
        aí estica a primeira linha em vez de alinhar um bloco. Justificação serve a
        parágrafo, não a rótulo de lista.
      */}
      <ul className="mt-5 flex-1 space-y-2 text-sm text-neutro-600">
        {plano.benefits.map((b) => (
          <li key={b} className="flex gap-2">
            <span aria-hidden className="mt-[0.35rem] h-1.5 w-1.5 shrink-0 rounded-full grad-marca" />
            {b}
          </li>
        ))}
      </ul>

      {/*
        Três formas de pagar, e a diferença NÃO é cosmética:
          - cartão: o Asaas cria assinatura e cobra sozinho a cada ciclo;
          - boleto: também renova, mas o acesso só entra quando o banco confirma
            (1 a 3 dias úteis), e boleto vencido cancela a assinatura;
          - PIX: cobrança única, SEM renovação — o acesso vale um ciclo e encerra.
        Anunciar "assine" para as três sem dizer isso seria vender renovação que o
        PIX não tem, e liberação imediata que o boleto não dá.

        O destino depende de quem clica: quem já entrou vai direto contratar; o
        visitante passa pelo cadastro levando o plano, para a escolha sobreviver ao
        login.
      */}
      {/*
        Um botão só, a pedido do dono: aqui a decisão é o PLANO, e a forma de pagar
        vem no passo seguinte (`EscolherMetodo`). As três formas competindo dentro
        do cartão de venda tiravam espaço do que faz alguém assinar e obrigavam a
        decidir duas coisas no mesmo clique — sendo que só ali não cabia explicar
        que o PIX não renova e o boleto demora a liberar.
      */}
      <div className="mt-7">
        <Link
          href={
            autenticado
              ? `/assinatura/contratar?plano=${encodeURIComponent(plano.slug)}`
              : `/cadastro?plano=${encodeURIComponent(plano.slug)}`
          }
          prefetch={false}
          className="btn-primary w-full py-3.5 text-base"
        >
          Assinar
        </Link>
        <p className="mt-3 text-center text-[11px] leading-snug text-neutro-500">
          Cartão, boleto ou PIX: você escolhe a forma de pagamento no passo seguinte.
        </p>
      </div>
    </div>
  );
}

function CardSobConsulta({ plano, whatsappComercial }: { plano: PlanoPublico; whatsappComercial: string }) {
  return (
    <div className="card flex flex-col gap-6 p-7 md:flex-row md:items-center md:justify-between">
      <div className="md:max-w-md">
        <span className="badge bg-marinho-50 text-marinho-700 dark:bg-marca-500/20 dark:text-marca-200">
          Sob consulta
        </span>
        <h3 className="mt-3 text-xl">{plano.name}</h3>
        {plano.description && <p className="mt-1 text-sm text-neutro-500">{plano.description}</p>}
      </div>

      <ul className="grid flex-1 gap-2 text-sm text-neutro-600 sm:grid-cols-2">
        {plano.benefits.map((b) => (
          <li key={b} className="flex gap-2">
            <span aria-hidden className="mt-[0.35rem] h-1.5 w-1.5 shrink-0 rounded-full grad-marca" />
            {b}
          </li>
        ))}
      </ul>

      <a
        href={whatsappComercial}
        target="_blank"
        rel="noopener noreferrer"
        className="btn-outline shrink-0 md:self-center"
      >
        Falar com o comercial
      </a>
    </div>
  );
}
