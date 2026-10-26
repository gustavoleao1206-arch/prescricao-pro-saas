import { prisma } from "./db";
import { custoEmCreditos, jaCobradoNaAnalise, saldoDe, MSG_SEM_SALDO, type CustoAnalise } from "./credits";
import type { Subscription } from "@prisma/client";

/**
 * Orçamento de uma análise: quanto vai custar, quanto o cliente tem, e com
 * quanto fica depois.
 *
 * A especificação é clara em que o cliente confirma ANTES de gastar. Isso
 * também evita a reclamação mais previsível de um sistema por crédito — "gastou
 * meus créditos sem avisar" —, porque a tela mostra o número antes da cobrança.
 */

export interface Orcamento {
  paginas: number;
  bytes: number;
  arquivos: number;
  custo: CustoAnalise;
  saldoAtual: number;
  saldoApos: number;
  ilimitado: boolean;
  /** Falso quando falta saldo ou o processo excede o limite automático. */
  podeIniciar: boolean;
  mensagem: string;
  /** Créditos que esta análise JÁ pagou e não teve devolvido. */
  jaCobrados: number;
  /**
   * Quanto sai do saldo se o processamento for confirmado AGORA. Igual ao custo na
   * primeira vez; zero ao reprocessar o mesmo material; a diferença de faixa quando
   * documentos acrescentados levaram o processo para uma faixa mais cara.
   */
  aCobrar: number;
}

/** Soma páginas e bytes dos documentos vivos de uma análise. */
export async function medirDocumentos(analysisId: string): Promise<{ paginas: number; bytes: number; arquivos: number }> {
  const docs = await prisma.document.findMany({
    where: { analysisId, deletedAt: null },
    select: { pageCount: true, sizeBytes: true, _count: { select: { pages: true } } },
  });
  return {
    // pageCount é o total do PDF; se a extração ainda não rodou, cai para o
    // número de páginas já persistidas, para nunca orçar zero página.
    paginas: docs.reduce((s, d) => s + (d.pageCount ?? d._count.pages), 0),
    bytes: docs.reduce((s, d) => s + d.sizeBytes, 0),
    arquivos: docs.length,
  };
}

/** Plural correto para uma quantidade de créditos. */
function creditos(n: number): string {
  return n === 1 ? "1 crédito" : `${n} créditos`;
}

export function montarOrcamento(
  medida: { paginas: number; bytes: number; arquivos: number },
  sub: Subscription | null,
  /**
   * Créditos que esta análise já pagou. Diferente de zero, o orçamento passa a ser da
   * REEXECUÇÃO: o cliente não pode ser cobrado outra vez pelo que já pagou, e também
   * não pode receber de graça a faixa mais cara que os documentos novos criaram.
   */
  jaCobrados = 0,
): Orcamento {
  const custo = custoEmCreditos(medida.paginas, medida.bytes);
  const saldo = saldoDe(sub);
  const saldoAtual = saldo.ilimitado ? Number.POSITIVE_INFINITY : saldo.total;

  const aCobrar = Math.max(0, custo.creditos - jaCobrados);
  const temSaldoSuficiente = saldo.ilimitado || saldo.total >= aCobrar;
  const podeIniciar = !custo.bloqueado && temSaldoSuficiente;

  let mensagem: string;
  if (custo.bloqueado) {
    mensagem = custo.motivo ?? "Este processo não pode ser analisado automaticamente.";
  } else if (!temSaldoSuficiente) {
    mensagem = MSG_SEM_SALDO;
  } else if (saldo.ilimitado) {
    mensagem = "Seu plano não tem limite de créditos.";
  } else if (jaCobrados > 0 && aCobrar === 0) {
    // A promessa do produto: reprocessar o mesmo material não custa de novo.
    mensagem = `Esta análise já consumiu ${creditos(jaCobrados)}. Reexecutar não consome créditos.`;
  } else if (jaCobrados > 0) {
    /**
     * O caso que saía de graça: documentos acrescentados levaram o processo para uma
     * faixa mais cara. Cobra-se só a diferença, e o cliente lê isso antes de confirmar.
     */
    const restantes = saldo.total - aCobrar;
    mensagem =
      `Esta análise já consumiu ${creditos(jaCobrados)}. Com os documentos acrescentados ela passou a ` +
      `custar ${creditos(custo.creditos)} (${custo.faixa ?? "faixa maior"}): serão debitados mais ` +
      `${creditos(aCobrar)}. Após a confirmação, ${restantes === 1 ? "restará 1 crédito" : `restarão ${restantes} créditos`}.`;
  } else {
    const restantes = saldo.total - aCobrar;
    const restantesTexto = restantes === 1 ? "restará 1 crédito" : `restarão ${restantes} créditos`;
    mensagem = `Esta análise utilizará ${creditos(custo.creditos)}. Após a confirmação, ${restantesTexto}.`;
  }

  return {
    paginas: medida.paginas,
    bytes: medida.bytes,
    arquivos: medida.arquivos,
    custo,
    saldoAtual,
    saldoApos: saldo.ilimitado ? Number.POSITIVE_INFINITY : Math.max(0, saldo.total - aCobrar),
    ilimitado: saldo.ilimitado,
    podeIniciar,
    mensagem,
    jaCobrados,
    aCobrar,
  };
}

export async function orcamentoDaAnalise(analysisId: string, sub: Subscription | null): Promise<Orcamento> {
  /**
   * O que já foi pago vem da RAZÃO, não de `Analysis.creditsCharged`.
   *
   * O campo é denormalizado e o extrato é a fonte da verdade — e mais: é a razão que
   * `consumirCreditos` consulta para decidir o débito. Se o orçamento (o que o cliente
   * LÊ antes de confirmar) e o consumo (o que ACONTECE com o saldo dele) olhassem
   * fontes diferentes, voltaríamos ao defeito que este conserto resolve: cobrança que
   * a tela não anunciou.
   */
  const jaCobrados = sub ? await jaCobradoNaAnalise(sub.id, analysisId) : 0;
  return montarOrcamento(await medirDocumentos(analysisId), sub, jaCobrados);
}

/** Formata bytes em MB para exibição. */
export function mbDe(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Versão serializável do orçamento. `Infinity` não sobrevive ao JSON — vira
 * `null` — e o cliente ilimitado veria "saldo indisponível" em vez de "sem
 * limite".
 */
export function orcamentoParaJson(o: Orcamento) {
  return {
    paginas: o.paginas,
    bytes: o.bytes,
    megabytes: mbDe(o.bytes),
    arquivos: o.arquivos,
    creditos: o.custo.creditos,
    // O que o cliente PAGA se confirmar agora — é este número que a tela destaca.
    aCobrar: o.aCobrar,
    jaCobrados: o.jaCobrados,
    bloqueado: o.custo.bloqueado,
    motivoBloqueio: o.custo.motivo ?? null,
    faixa: o.custo.faixa ?? null,
    ilimitado: o.ilimitado,
    saldoAtual: o.ilimitado ? null : o.saldoAtual,
    saldoApos: o.ilimitado ? null : o.saldoApos,
    podeIniciar: o.podeIniciar,
    mensagem: o.mensagem,
  };
}
