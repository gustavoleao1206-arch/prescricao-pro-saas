/**
 * Casos de teste FICTÍCIOS para demonstração e para
 * regressão do motor jurídico determinístico.
 *
 * ⚠️ Todos os dados são inventados, para desenvolvimento/demonstração. Não usar
 * dados reais de clientes/processos. O gabarito é conferido em
 * tests/casos-comparativos.test.ts.
 *
 * Este módulo NÃO importa Prisma (para poder ser usado nos testes sem gerar o
 * client). O seed e a documentação o reutilizam.
 */

export type Verd = "SIM" | "NÃO" | "INDETERMINADO";

export interface CasoTeste {
  slug: string;
  titulo: string;
  /** Narrativa fictícia dos autos — pode ser anexada (como PDF) na plataforma. */
  narrativa: string;
  /** Identificação (etapa 1 do assistente de nova análise). */
  identificacao: {
    type: string;
    processNumber: string;
    court: string;
    creditor: string;
    debtor: string;
    taxType: string;
    objective?: string;
  };
  /** Datas/fatos (etapa 2 do assistente) — alimentam o modo heurístico. */
  facts: Record<string, string | boolean>;
  /** Entradas canônicas para os cálculos determinísticos (precisas p/ o teste). */
  calc: {
    hoje: string;
    decadencia: {
      modalidade?: "lancamento_oficio" | "homologacao" | "declaracao" | "desconhecida";
      houvePagamentoAntecipado?: boolean;
      dataFatoGerador?: string;
      dataConstituicaoDefinitiva?: string;
    };
    ordinaria: {
      dataConstituicaoDefinitiva?: string;
      dataDespachoCitatorio?: string;
      dataAjuizamento?: string;
      dataCitacao?: string;
      houveParcelamento?: boolean;
    };
    intercorrente: {
      dataDespachoSuspensao?: string;
      dataCitacaoOuNaoLocalizacao?: string;
      houveCausaInterrupcaoAposArquivamento?: boolean;
    };
    redirecionamento?: {
      dataCitacaoPJ?: string;
      dataAtoIlicito?: string;
      dataPedidoRedirecionamento?: string;
      fazendaInerte?: boolean;
    };
  };
  /** Gabarito esperado (resultado da análise correta). */
  gabarito: {
    decadencia: Verd;
    ordinaria: Verd;
    intercorrente: Verd;
    redirecionamento?: Verd;
    tesePrincipal: string;
    cabimentoEPE: Verd;
    confianca: "ALTO" | "MEDIO" | "BAIXO" | "INDETERMINADO";
    // Ano esperado do prazo final da tese principal (para conferência aritmética).
    prazoFinalAnoTesePrincipal?: number;
    observacao: string;
  };
}

export const CASOS_TESTE: CasoTeste[] = [
  {
    slug: "caso-1-intercorrente",
    titulo: "Caso 1 — Prescrição intercorrente (IPTU, art. 40 LEF)",
    narrativa: [
      "Execução fiscal de IPTU movida pelo Município Fictício de Exemplo contra Empresa Alfa Ltda.",
      "- Exercício/fato gerador: 01/01/2009.",
      "- Constituição definitiva (envio do carnê — Súmula 397/STJ): 05/01/2010.",
      "- Inscrição em dívida ativa: 20/07/2010.",
      "- Ajuizamento da execução: 10/03/2011.",
      "- Despacho que ordenou a citação: 01/04/2011.",
      "- Citação da executada: 20/06/2012.",
      "- Certidão do oficial de justiça: não localizados bens penhoráveis; a Fazenda tomou ciência em 15/05/2013.",
      "- Após 15/05/2013: apenas pedidos de SISBAJUD com resultado NEGATIVO (2015 e 2017) e renovações de diligências infrutíferas. Nenhuma penhora/citação útil.",
      "- Situação em 2026: feito paralisado, sem constrição útil desde 2013.",
    ].join("\n"),
    identificacao: {
      type: "PRESCRICAO_INTERCORRENTE",
      processNumber: "0007654-32.2011.8.26.0100",
      court: "TJSP",
      creditor: "Município Fictício de Exemplo",
      debtor: "Empresa Alfa Ltda.",
      taxType: "IPTU",
      objective: "Verificar prescrição intercorrente (art. 40 LEF).",
    },
    facts: {
      dataFatoGerador: "2009-01-01",
      dataConstituicaoDefinitiva: "2010-01-05",
      dataInscricaoDividaAtiva: "2010-07-20",
      dataAjuizamento: "2011-03-10",
      dataDespachoCitatorio: "2011-04-01",
      dataCitacao: "2012-06-20",
      possuiArquivamento: true,
      movimentacoesRelevantes: "Ciência da Fazenda quanto à não localização de bens em 15/05/2013; SISBAJUD negativo em 2015 e 2017.",
    },
    calc: {
      hoje: "2026-07-15",
      decadencia: { modalidade: "lancamento_oficio", dataFatoGerador: "2009-01-01", dataConstituicaoDefinitiva: "2010-01-05" },
      ordinaria: { dataConstituicaoDefinitiva: "2010-01-05", dataDespachoCitatorio: "2011-04-01", dataAjuizamento: "2011-03-10", dataCitacao: "2012-06-20" },
      intercorrente: { dataDespachoSuspensao: "2013-05-15", houveCausaInterrupcaoAposArquivamento: false },
    },
    gabarito: {
      decadencia: "NÃO",
      ordinaria: "NÃO",
      intercorrente: "SIM",
      tesePrincipal: "Prescrição intercorrente",
      cabimentoEPE: "SIM",
      confianca: "ALTO",
      prazoFinalAnoTesePrincipal: 2019, // 15/05/2013 +1 ano +5 anos = 15/05/2019
      observacao:
        "Marco: ciência da Fazenda em 15/05/2013 → suspensão de 1 ano (15/05/2014) → quinquênio (15/05/2019). Diligências infrutíferas não interrompem (Tema 568). Súmula 314; Temas 566-571; Tema 390/STF.",
    },
  },
  {
    slug: "caso-2-decadencia",
    titulo: "Caso 2 — Decadência (ISS por homologação, sem declaração/pagamento)",
    narrativa: [
      "Execução fiscal de ISS movida pelo Município Fictício de Exemplo contra Beta Serviços Ltda.",
      "- Tributo sujeito a lançamento por homologação; o contribuinte NÃO declarou e NÃO pagou (sem dolo/fraude/simulação alegados).",
      "- Fato gerador: 10/03/2008.",
      "- Lançamento de ofício (auto de infração) notificado ao contribuinte em: 20/09/2014.",
      "- Inscrição em dívida ativa e ajuizamento posteriores.",
      "Questão central: o crédito foi constituído dentro do prazo decadencial?",
    ].join("\n"),
    identificacao: {
      type: "DECADENCIA",
      processNumber: "0001122-33.2015.8.26.0100",
      court: "TJSP",
      creditor: "Município Fictício de Exemplo",
      debtor: "Beta Serviços Ltda.",
      taxType: "ISS",
      objective: "Verificar decadência do direito de lançar (art. 173, I, CTN).",
    },
    facts: {
      dataFatoGerador: "2008-03-10",
      dataConstituicaoDefinitiva: "2014-09-20",
      movimentacoesRelevantes: "Sem declaração e sem pagamento antecipado. Auto de infração notificado em 20/09/2014.",
    },
    calc: {
      hoje: "2026-07-15",
      decadencia: { modalidade: "homologacao", houvePagamentoAntecipado: false, dataFatoGerador: "2008-03-10", dataConstituicaoDefinitiva: "2014-09-20" },
      ordinaria: { dataConstituicaoDefinitiva: "2014-09-20" },
      intercorrente: {},
    },
    gabarito: {
      decadencia: "SIM",
      ordinaria: "INDETERMINADO",
      intercorrente: "INDETERMINADO",
      tesePrincipal: "Decadência",
      cabimentoEPE: "SIM",
      confianca: "MEDIO",
      prazoFinalAnoTesePrincipal: 2014, // art. 173, I: 1º dia do exercício seguinte (2009) + 5 = 01/01/2014
      observacao:
        "Sem declaração/pagamento → art. 173, I, CTN (Súmula 555; Tema 163). Prazo: 01/01/2009 + 5 = 01/01/2014. Notificação em 20/09/2014 é POSTERIOR → decadência consumada; lançamento nulo (art. 156, V, CTN).",
    },
  },
  {
    slug: "caso-3-incompleto",
    titulo: "Caso 3 — Dados incompletos (EPE condicionada)",
    narrativa: [
      "Execução fiscal de ICMS movida pela Fazenda do Estado Fictício contra Gama Comércio Ltda.",
      "- Consta apenas o número do processo e a CDA, sem datas legíveis de constituição definitiva, ajuizamento, despacho citatório ou citação.",
      "- Não há certidões de diligência nem informação sobre localização de bens.",
      "Objetivo: verificar se há tese, apontando exatamente quais documentos/datas faltam.",
    ].join("\n"),
    identificacao: {
      type: "GERAL",
      processNumber: "0009988-77.2018.8.26.0100",
      court: "TJSP",
      creditor: "Fazenda do Estado Fictício",
      debtor: "Gama Comércio Ltda.",
      taxType: "ICMS",
      objective: "Triagem — identificar tese e documentos faltantes.",
    },
    facts: {
      movimentacoesRelevantes: "Autos sem datas legíveis de constituição, ajuizamento, despacho ou citação.",
    },
    calc: {
      hoje: "2026-07-15",
      decadencia: {},
      ordinaria: {},
      intercorrente: {},
    },
    gabarito: {
      decadencia: "INDETERMINADO",
      ordinaria: "INDETERMINADO",
      intercorrente: "INDETERMINADO",
      tesePrincipal: "Indeterminada — depende de confirmação documental",
      cabimentoEPE: "INDETERMINADO",
      confianca: "INDETERMINADO",
      observacao:
        "Sem datas essenciais, nenhum instituto se confirma. EPE deve sair CONDICIONADA, com lacunas [DATA NÃO LOCALIZADA — confirmar na CDA / decisão / certidão / intimação] e checklist de documentos.",
    },
  },
  {
    slug: "caso-4-redirecionamento",
    titulo: "Caso 4 — Prescrição do redirecionamento ao sócio (Tema 444)",
    narrativa: [
      "Execução fiscal — Fazenda do Estado Fictício × Delta Indústria Ltda. e sócio-gerente. Processo 0004455-66.2011.8.26.0100 (TJSP).",
      "- Crédito constituído e ajuizado tempestivamente contra a PJ (sem decadência/prescrição ordinária).",
      "- Constituição definitiva: 05/01/2011. Ajuizamento: 10/06/2011. Despacho citatório: 01/07/2011.",
      "- Citação da pessoa jurídica: 10/02/2013.",
      "- Dissolução irregular constatada (ato inequívoco): 01/06/2012 (ANTERIOR à citação da PJ).",
      "- Pedido de redirecionamento / citação do sócio: 15/08/2020.",
      "- Há prova de INÉRCIA da Fazenda entre a citação da PJ e o pedido de redirecionamento.",
    ].join("\n"),
    identificacao: {
      type: "EXECUCAO_FISCAL_COMPLETA",
      processNumber: "0004455-66.2011.8.26.0100",
      court: "TJSP",
      creditor: "Fazenda do Estado Fictício",
      debtor: "Delta Indústria Ltda. (e sócio-gerente)",
      taxType: "ICMS",
      objective: "Verificar prescrição do redirecionamento ao sócio (Tema 444).",
    },
    facts: {
      dataConstituicaoDefinitiva: "2011-01-05",
      dataAjuizamento: "2011-06-10",
      dataDespachoCitatorio: "2011-07-01",
      possuiRedirecionamento: true,
      dataCitacaoPJ: "2013-02-10",
      dataDissolucaoIrregular: "2012-06-01",
      dataPedidoRedirecionamento: "2020-08-15",
      fazendaInerteRedirecionamento: true,
    },
    calc: {
      hoje: "2026-07-15",
      decadencia: { modalidade: "lancamento_oficio", dataFatoGerador: "2010-01-01", dataConstituicaoDefinitiva: "2011-01-05" },
      ordinaria: { dataConstituicaoDefinitiva: "2011-01-05", dataDespachoCitatorio: "2011-07-01", dataAjuizamento: "2011-06-10" },
      intercorrente: {},
      redirecionamento: { dataCitacaoPJ: "2013-02-10", dataAtoIlicito: "2012-06-01", dataPedidoRedirecionamento: "2020-08-15", fazendaInerte: true },
    },
    gabarito: {
      decadencia: "NÃO",
      ordinaria: "NÃO",
      intercorrente: "INDETERMINADO",
      redirecionamento: "SIM",
      tesePrincipal: "Prescrição do redirecionamento",
      cabimentoEPE: "SIM",
      confianca: "MEDIO",
      prazoFinalAnoTesePrincipal: 2018, // ilícito (2012) anterior à citação da PJ (10/02/2013) → 5 anos = 10/02/2018
      observacao:
        "Ato ilícito anterior à citação da PJ → termo inicial na citação da PJ (10/02/2013); prazo de 5 anos = 10/02/2018. Pedido de redirecionamento em 15/08/2020 (posterior) + inércia da Fazenda → prescrição do redirecionamento (Tema 444). Súmulas 430/435; Temas 962/981.",
    },
  },
];
