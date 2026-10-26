/**
 * Cálculos jurídicos determinísticos de apoio (prescrição/decadência).
 *
 * Objetivo: fornecer uma base AUDITÁVEL e reproduzível que complementa a análise
 * da IA. São funções puras (sem I/O), fáceis de testar.
 *
 * ⚠️ AVISO: são cálculos de APOIO, baseados nas regras gerais do CTN e da LEF.
 * Não consideram todas as particularidades do caso concreto (causas de suspensão,
 * interrupção, feriados forenses, teses específicas). NÃO substituem a análise e a
 * revisão por advogado(a) habilitado(a). Datas ausentes tornam o resultado
 * INDETERMINADO — nunca presuma datas.
 *
 * Referências gerais: CTN arts. 150 §4º, 173 e 174; Lei 6.830/80 (LEF) art. 40;
 * Súmula 314/STJ; LC 118/2005; Tema 566/STJ.
 */

export type Confianca = "ALTO" | "MEDIO" | "BAIXO" | "INDETERMINADO";

export interface ResultadoPrazo {
  aplicavel: boolean;
  ocorrido: boolean | null; // null = indeterminado
  prazoFinal: Date | null;
  fundamento: string;
  confianca: Confianca;
  observacoes: string[];
  faltando: string[]; // informações ausentes que impedem conclusão segura
}

const MS_DIA = 86_400_000;

/** Soma anos a uma data preservando o dia (regra civil aproximada). */
export function addYears(date: Date, years: number): Date {
  const d = new Date(date.getTime());
  d.setFullYear(d.getFullYear() + years);
  return d;
}

export function parseData(value?: string | Date | null): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  // Aceita ISO (YYYY-MM-DD) e BR (DD/MM/YYYY).
  const iso = /^\d{4}-\d{2}-\d{2}/;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/;
  if (iso.test(value)) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  const m = br.exec(value);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export function diffDias(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / MS_DIA);
}

export interface EntradaDecadencia {
  modalidade?: "lancamento_oficio" | "homologacao" | "declaracao" | "desconhecida";
  dataFatoGerador?: string | Date | null;
  dataConstituicaoDefinitiva?: string | Date | null;
  houvePagamentoAntecipado?: boolean;
  hoje?: Date;
}

/**
 * Decadência — prazo de 5 anos para o Fisco constituir o crédito.
 * - Lançamento de ofício / por declaração (art. 173, I, CTN): conta-se do 1º dia
 *   do exercício seguinte àquele em que o lançamento poderia ter sido efetuado.
 * - Lançamento por homologação com pagamento antecipado (art. 150, §4º, CTN):
 *   conta-se do fato gerador. Sem pagamento/dolo: aplica-se o art. 173, I.
 */
export function analisarDecadencia(e: EntradaDecadencia): ResultadoPrazo {
  const hoje = e.hoje ?? new Date();
  const faltando: string[] = [];
  const obs: string[] = [];
  const fg = parseData(e.dataFatoGerador);

  if (e.dataConstituicaoDefinitiva) {
    obs.push(
      "Há constituição definitiva informada — a decadência (prazo para constituir) tende a estar superada; a discussão principal passa a ser de prescrição.",
    );
  }

  if (!fg) {
    faltando.push("Data do fato gerador não localizada.");
    return {
      aplicavel: true,
      ocorrido: null,
      prazoFinal: null,
      fundamento: "CTN arts. 173, I e 150, §4º",
      confianca: "INDETERMINADO",
      observacoes: obs,
      faltando,
    };
  }

  let inicio: Date;
  let fundamento: string;
  const modalidade = e.modalidade ?? "desconhecida";

  if (modalidade === "homologacao" && e.houvePagamentoAntecipado) {
    inicio = fg;
    fundamento = "CTN art. 150, §4º (homologação com pagamento antecipado): 5 anos do fato gerador.";
  } else {
    // Art. 173, I: 1º dia do exercício seguinte.
    inicio = new Date(fg.getFullYear() + 1, 0, 1);
    fundamento = "CTN art. 173, I: 5 anos a partir do 1º dia do exercício seguinte.";
    if (modalidade === "desconhecida") {
      obs.push("Modalidade de lançamento não informada — adotado art. 173, I (regra geral). Confirmar a modalidade altera o marco inicial.");
    }
  }

  const prazoFinal = addYears(inicio, 5);
  const ocorrido = e.dataConstituicaoDefinitiva
    ? // Se há constituição, verifica se ocorreu dentro do prazo.
      (parseData(e.dataConstituicaoDefinitiva)!.getTime() > prazoFinal.getTime())
    : hoje.getTime() > prazoFinal.getTime();

  return {
    aplicavel: true,
    ocorrido,
    prazoFinal,
    fundamento,
    confianca: modalidade === "desconhecida" ? "BAIXO" : "MEDIO",
    observacoes: obs,
    faltando,
  };
}

export interface EntradaPrescricaoOrdinaria {
  dataConstituicaoDefinitiva?: string | Date | null;
  dataDespachoCitatorio?: string | Date | null;
  dataAjuizamento?: string | Date | null;
  dataCitacao?: string | Date | null;
  houveParcelamento?: boolean;
  dataInicioParcelamento?: string | Date | null;
  dataFimParcelamento?: string | Date | null;
  hoje?: Date;
}

/**
 * Prescrição ordinária — art. 174 CTN. Prazo de 5 anos da constituição definitiva
 * para a cobrança. Interrompe-se pelo despacho que ordena a citação (art. 174, § único,
 * I, CTN, redação da LC 118/2005), com retroação à data do ajuizamento (Súmula 106/STJ,
 * quando a demora não é imputável ao exequente). Parcelamento suspende/interrompe.
 */
export function analisarPrescricaoOrdinaria(e: EntradaPrescricaoOrdinaria): ResultadoPrazo {
  const hoje = e.hoje ?? new Date();
  const faltando: string[] = [];
  const obs: string[] = [];

  const constituicao = parseData(e.dataConstituicaoDefinitiva);
  if (!constituicao) {
    faltando.push("Data da constituição definitiva do crédito não localizada.");
    return {
      aplicavel: true,
      ocorrido: null,
      prazoFinal: null,
      fundamento: "CTN art. 174",
      confianca: "INDETERMINADO",
      observacoes: obs,
      faltando,
    };
  }

  const prazoFinal = addYears(constituicao, 5);

  // Marco interruptivo: despacho citatório (ou ajuizamento, com Súmula 106/STJ).
  const despacho = parseData(e.dataDespachoCitatorio);
  const ajuizamento = parseData(e.dataAjuizamento);
  const marcoInterruptivo = despacho ?? ajuizamento;

  if (e.houveParcelamento) {
    obs.push(
      "Há parcelamento informado: constitui causa de suspensão/interrupção (reconhecimento do débito). O período do parcelamento deve ser excluído da contagem — conferir datas de início/fim.",
    );
    if (!e.dataInicioParcelamento || !e.dataFimParcelamento) {
      faltando.push("Datas de início/fim do parcelamento não localizadas.");
    }
  }
  if (!despacho && !ajuizamento) {
    faltando.push("Data do despacho citatório e do ajuizamento não localizadas.");
  }
  if (despacho && ajuizamento && diffDias(despacho, ajuizamento) > 180) {
    obs.push(
      "Intervalo relevante entre ajuizamento e despacho — avaliar Súmula 106/STJ (demora imputável ao Judiciário retroage a interrupção à distribuição).",
    );
  }

  let ocorrido: boolean | null;
  let confianca: Confianca = "MEDIO";
  if (marcoInterruptivo) {
    // Prescrição consumada se o marco interruptivo ocorreu após o prazo de 5 anos.
    ocorrido = marcoInterruptivo.getTime() > prazoFinal.getTime();
    if (e.houveParcelamento) confianca = "BAIXO"; // suspensões alteram o cálculo
  } else {
    ocorrido = hoje.getTime() > prazoFinal.getTime() ? null : false;
    confianca = "BAIXO";
    obs.push("Sem marco interruptivo localizado — conclusão dependente de conferência documental.");
  }

  return {
    aplicavel: true,
    ocorrido,
    prazoFinal,
    fundamento: "CTN art. 174 e parágrafo único (LC 118/2005); Súmula 106/STJ quando aplicável.",
    confianca: faltando.length ? "BAIXO" : confianca,
    observacoes: obs,
    faltando,
  };
}

export interface EntradaIntercorrente {
  dataCitacaoOuNaoLocalizacao?: string | Date | null; // marco que dispara suspensão do art. 40
  dataDespachoSuspensao?: string | Date | null;
  dataArquivamento?: string | Date | null;
  houveCausaInterrupcaoAposArquivamento?: boolean;
  hoje?: Date;
}

/**
 * Prescrição intercorrente — art. 40 LEF + Súmula 314/STJ + Tema 566/STJ.
 * Rito: (1) não localizado o devedor ou bens, suspende-se o processo por 1 ano;
 * (2) findo o ano, inicia-se automaticamente o prazo de 5 anos (arquivamento);
 * (3) transcorridos os 5 anos sem causa interruptiva efetiva, consuma-se a
 * prescrição intercorrente. O termo inicial da suspensão é a ciência da Fazenda
 * da não localização (Tema 566/STJ).
 */
export function analisarPrescricaoIntercorrente(e: EntradaIntercorrente): ResultadoPrazo {
  const hoje = e.hoje ?? new Date();
  const faltando: string[] = [];
  const obs: string[] = [];

  const marco = parseData(e.dataDespachoSuspensao) ?? parseData(e.dataCitacaoOuNaoLocalizacao);
  if (!marco) {
    faltando.push(
      "Marco inicial (ciência da Fazenda quanto à não localização do devedor/bens, ou despacho de suspensão do art. 40) não localizado.",
    );
    return {
      aplicavel: true,
      ocorrido: null,
      prazoFinal: null,
      fundamento: "LEF art. 40; Súmula 314/STJ; Tema 566/STJ",
      confianca: "INDETERMINADO",
      observacoes: obs,
      faltando,
    };
  }

  const fimSuspensao1Ano = addYears(marco, 1); // suspensão de 1 ano
  const prazoFinal = addYears(fimSuspensao1Ano, 5); // + 5 anos

  if (e.houveCausaInterrupcaoAposArquivamento) {
    obs.push(
      "Há indicação de causa interruptiva efetiva após o arquivamento (ex.: penhora frutífera). Isso pode reiniciar/impedir a contagem — exige conferência.",
    );
  }

  const ocorrido = e.houveCausaInterrupcaoAposArquivamento
    ? null
    : hoje.getTime() > prazoFinal.getTime();

  obs.push(
    "Meras diligências infrutíferas não interrompem o prazo intercorrente (STJ). Conferir se houve efetiva constrição de bens.",
  );

  return {
    aplicavel: true,
    ocorrido,
    prazoFinal,
    fundamento: "LEF art. 40, §§ 1º a 4º; Súmula 314/STJ; Tema 566/STJ.",
    confianca: e.houveCausaInterrupcaoAposArquivamento ? "BAIXO" : "MEDIO",
    observacoes: obs,
    faltando,
  };
}

export interface EntradaRedirecionamento {
  dataCitacaoPJ?: string | Date | null;
  /** Ato ilícito / ato inequívoco da dissolução irregular. */
  dataAtoIlicito?: string | Date | null;
  /** Data do pedido de redirecionamento ou da citação do sócio (marco final). */
  dataPedidoRedirecionamento?: string | Date | null;
  /** Há prova/indicação de inércia da Fazenda? (exigida para a prescrição). */
  fazendaInerte?: boolean;
  hoje?: Date;
}

/**
 * Prescrição do redirecionamento ao sócio/administrador — STJ, Tema 444
 * (REsp 1.201.993/SP): prazo de 5 anos, cujo termo inicial é:
 *  - a CITAÇÃO DA PJ, quando o ato ilícito (dissolução irregular) é ANTERIOR a ela;
 *  - o ATO INEQUÍVOCO da dissolução/fraude, quando POSTERIOR à citação da PJ.
 * Em ambos, a decretação EXIGE prova da INÉRCIA da Fazenda (não basta o decurso do
 * tempo). Súmulas 430 (mero inadimplemento não basta) e 435 (dissolução irregular
 * presumida); Temas 962 (retirada regular anterior afasta) e 981 (responde quem
 * geria na dissolução).
 */
export function analisarPrescricaoRedirecionamento(e: EntradaRedirecionamento): ResultadoPrazo {
  const hoje = e.hoje ?? new Date();
  const faltando: string[] = [];
  const obs: string[] = [];

  const citPJ = parseData(e.dataCitacaoPJ);
  const ilicito = parseData(e.dataAtoIlicito);
  const marcoFinal = parseData(e.dataPedidoRedirecionamento);

  if (!citPJ && !ilicito) {
    faltando.push("Data da citação da PJ e do ato de dissolução irregular não localizadas.");
    return {
      aplicavel: true,
      ocorrido: null,
      prazoFinal: null,
      fundamento: "Tema 444/STJ (REsp 1.201.993)",
      confianca: "INDETERMINADO",
      observacoes: obs,
      faltando,
    };
  }

  let termoInicial: Date;
  let fundamento: string;
  if (ilicito && citPJ) {
    if (ilicito.getTime() <= citPJ.getTime()) {
      termoInicial = citPJ;
      fundamento = "Ilícito ANTERIOR à citação da PJ → 5 anos da citação da PJ (Tema 444/STJ).";
    } else {
      termoInicial = ilicito;
      fundamento = "Ilícito POSTERIOR à citação da PJ → 5 anos do ato inequívoco da dissolução (Tema 444/STJ).";
    }
  } else if (citPJ) {
    termoInicial = citPJ;
    fundamento = "5 anos contados da citação da PJ (Tema 444/STJ).";
  } else {
    termoInicial = ilicito!;
    fundamento = "5 anos contados do ato inequívoco da dissolução (Tema 444/STJ).";
  }

  const prazoFinal = addYears(termoInicial, 5);
  if (!marcoFinal) faltando.push("Data do pedido de redirecionamento / citação do sócio não localizada.");

  let ocorrido: boolean | null;
  if (marcoFinal) {
    ocorrido = marcoFinal.getTime() > prazoFinal.getTime();
  } else {
    ocorrido = hoje.getTime() > prazoFinal.getTime() ? null : false;
  }

  if (ocorrido === true && !e.fazendaInerte) {
    obs.push("A prescrição do redirecionamento EXIGE comprovação da inércia da Fazenda (Tema 444) — não basta o decurso do tempo. Confirmar a diligência (ou inércia) da exequente.");
  }
  obs.push("Conferir quem geria a empresa na data da dissolução irregular (Temas 981/962) e a prova da dissolução (Súmula 435); mero inadimplemento não basta (Súmula 430).");

  return {
    aplicavel: true,
    ocorrido,
    prazoFinal,
    fundamento,
    confianca: faltando.length ? "BAIXO" : e.fazendaInerte ? "MEDIO" : "BAIXO",
    observacoes: obs,
    faltando,
  };
}

/** Formata uma data para exibição BR, ou marcador quando ausente. */
export function fmt(d: Date | null): string {
  if (!d) return "— (não localizada)";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}
