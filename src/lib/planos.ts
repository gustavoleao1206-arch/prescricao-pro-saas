/**
 * Catálogo comercial — fonte única dos planos e pacotes.
 *
 * O banco continua sendo a autoridade em tempo de execução (o admin pode mudar
 * preço e cota sem tocar em código); este arquivo é o que o seed grava e o que
 * a página de planos usa como recuo se o banco estiver vazio. Manter os dois
 * lados em arquivos diferentes já causou preço divergente entre a página de
 * vendas e a cobrança, então aqui é o único lugar onde os números são escritos.
 */

/**
 * Uma única família comercial.
 *
 * O catálogo tinha quatro (essencial, profissional, escritório, empresarial),
 * escalonadas por quantidade de créditos. A oferta passou a ser uma só, em duas
 * periodicidades — então a "família" existe apenas para agrupar o mensal e o anual do
 * MESMO plano na grade.
 *
 * A cota já foi retirada (oferta sem limite) e voltou, porque sem teto o custo por
 * análise não fechava. O histórico fica registrado porque explica por que o modo
 * "sem limite" (cota 0) continua existindo no código: é plano legado, não oferta.
 */
export type FamiliaPlano = "prescricao-pro";
export type Periodicidade = "MENSAL" | "ANUAL";

export interface DefinicaoPlano {
  slug: string;
  family: FamiliaPlano;
  name: string;
  description: string;
  priceCents: number;
  period: Periodicidade;
  /** Créditos liberados por CICLO MENSAL — inclusive nos planos anuais. */
  monthlyCredits: number;
  maxUsers: number;
  highlight: boolean;
  contactOnly: boolean;
  priorityProcessing: boolean;
  sortOrder: number;
  benefits: string[];
}

/**
 * O checkout NÃO é link fixo por oferta.
 *
 * Cada compra gera uma sessão de checkout no Asaas, criada em tempo de execução
 * por `criarCheckout` (src/lib/asaas.ts) e amarrada à conta pelo
 * `externalReference`. É esse vínculo que permite creditar a pessoa certa quando o
 * webhook chega — link fixo compartilhado não carrega essa informação.
 */

/**
 * Desconto do plano anual frente a 12 meses do mensal.
 *
 * Os preços anuais foram calculados a partir daqui e ARREDONDADOS PARA BAIXO,
 * nunca para cima: assim o desconto real fica sempre igual ou maior que o
 * anunciado. Prometer 30% e entregar 29,8% seria publicidade enganosa
 * (art. 37 do CDC). Há teste travando essa regra.
 */
export const DESCONTO_ANUAL = 0.3;

const BENEFICIOS_COMUNS = [
  "Análise de prescrição ordinária",
  "Análise de prescrição intercorrente",
  "Análise de decadência tributária",
  "Relatório jurídico",
  "Fundamentação legal",
  "Sugestão de petição quando houver tese favorável",
  "Histórico das análises",
];

/**
 * Cota mensal de créditos dos planos vigentes.
 *
 * ── De onde vem o número ──────────────────────────────────────────────────────
 * Do custo medido: R$ 1,07 por análise. Vinte análises consomem R$ 21,40 de um
 * plano de R$ 49,90, o que deixa margem para a taxa da processadora e para o
 * processo grande, que custa mais de um crédito. A oferta foi ILIMITADA por um
 * período e voltou a ter cota por isso: sem teto, uma única conta de uso intenso
 * consome mais do que paga, e o preço teria de subir para todos.
 *
 * Passado o limite, o cliente compra crédito avulso a
 * `VALOR_UNITARIO_CREDITO_CENTS` — que é o que torna o teto uma escolha do cliente
 * e não uma parede.
 *
 * ATENÇÃO ao plano ANUAL: a mesma cota de 20 por mês sobre R$ 419,00 no ano dá
 * margem menor que a do mensal (o desconto de 30% sai da margem, não do custo).
 * Mudar a cota exige refazer essa conta para os dois planos.
 */
export const CREDITOS_MENSAIS = 20;

export const PLANOS: DefinicaoPlano[] = [
  {
    slug: "prescricao-pro-mensal",
    family: "prescricao-pro",
    name: "Prescrição Pro",
    description: `${CREDITOS_MENSAIS} análises por mês, cobrança mensal.`,
    priceCents: 4990,
    period: "MENSAL",
    /**
     * Cota em créditos por ciclo mensal.
     *
     * ZERO teria outro significado: em todo o sistema, cota 0 quer dizer SEM
     * LIMITE — `saldoDe` devolve `ilimitado: true`, `temSaldo` libera sempre e
     * `consumirCreditos` registra o uso sem debitar. Os planos vigentes têm cota,
     * então o número aqui é o teto de verdade; o modo ilimitado continua existindo
     * no código apenas para plano legado.
     */
    monthlyCredits: CREDITOS_MENSAIS,
    maxUsers: 1,
    highlight: false,
    contactOnly: false,
    priorityProcessing: true,
    sortOrder: 10,
    benefits: [`${CREDITOS_MENSAIS} análises por mês`, "Créditos avulsos quando precisar de mais", "1 usuário", ...BENEFICIOS_COMUNS],
  },
  {
    slug: "prescricao-pro-anual",
    family: "prescricao-pro",
    name: "Prescrição Pro Anual",
    description: `${CREDITOS_MENSAIS} análises por mês, com 30% de desconto no pagamento anual.`,
    /**
     * R$ 419,00 = 12 × R$ 49,90 (R$ 598,80) menos 30%, ARREDONDADO PARA BAIXO.
     *
     * O exato seria R$ 419,16. Arredondar para baixo faz o desconto real ficar em
     * 30,03% — igual ou maior que o anunciado, nunca menor. Anunciar 30% e entregar
     * 29,9% seria publicidade enganosa (art. 37 do CDC), e há teste travando isso.
     */
    priceCents: 41900,
    period: "ANUAL",
    monthlyCredits: CREDITOS_MENSAIS,
    maxUsers: 1,
    highlight: true,
    contactOnly: false,
    priorityProcessing: true,
    sortOrder: 20,
    benefits: [
      `${CREDITOS_MENSAIS} análises por mês`,
      "Créditos avulsos quando precisar de mais",
      "1 usuário",
      "Economia de 30% frente ao mensal",
      ...BENEFICIOS_COMUNS,
    ],
  },
];

export interface DefinicaoPacote {
  slug: string;
  name: string;
  credits: number;
  priceCents: number;
  validityDays: number;
  sortOrder: number;
}

/**
 * Dias de tolerância após um pagamento atrasado. Dentro desse prazo o cliente
 * mantém o acesso: cartão recusado por limite momentâneo é comum, e cortar no
 * mesmo dia castiga quem regulariza em 48 horas. É o número aplicado pelo gate
 * de acesso (graceUntil) e citado na Política de Assinatura — mora aqui para que
 * texto e código nunca digam prazos diferentes.
 */
export const DIAS_TOLERANCIA_INADIMPLENCIA = 5;

/**
 * Dias entre o vencimento do boleto e o encerramento da assinatura.
 *
 * A regra do negócio é "boleto vencido, assinatura cancelada". Este prazo curto
 * existe por um motivo mecânico, não por generosidade: **boleto pago no dia do
 * vencimento é compensado em 1 a 3 dias úteis**. O Asaas manda `PAYMENT_OVERDUE`
 * no dia seguinte ao vencimento e o `PAYMENT_RECEIVED` só chega depois da
 * compensação. Cancelar no primeiro evento cortaria justamente quem pagou em dia,
 * e o dinheiro entraria numa assinatura já encerrada.
 *
 * Colocar 0 aqui produz o cancelamento literal e imediato, se essa for a decisão
 * comercial.
 */
export const DIAS_COMPENSACAO_BOLETO = 3;

/**
 * Tamanho máximo, em MB, de um arquivo enviado para análise.
 *
 * Vive aqui porque é dado COMERCIAL publicado: a Política de Créditos anunciava
 * 30, 60 e 120 MB por faixa de páginas — números de `FAIXAS_CUSTO` —, enquanto a
 * tela de envio recusava qualquer arquivo acima de 25 MB com o limite escrito à mão
 * dentro do componente. Um processo de 300 páginas com 40 MB era aceito pelo
 * documento e recusado pelo sistema, que é o pior tipo de divergência: o cliente
 * confere a política antes de reclamar.
 *
 * Alterar este número muda a tela de envio E o que a política publica. O padrão de
 * `UPLOAD_MAX_FILE_MB` acompanha o mesmo valor.
 */
export const LIMITE_MB_ARQUIVO = 25;

/** Validade padrão, em dias, de um crédito adicional comprado em pacote. */
export const VALIDADE_CREDITO_ADICIONAL_DIAS = 90;

/**
 * Preço do crédito avulso, em centavos. Definido pelo dono: R$ 5,00 por
 * crédito, o que cobre o custo medido por análise (R$ 3,22) mais a taxa da
 * plataforma de pagamento, com folga. O avulso é complemento pontual de quem
 * já assina (creditarPacote exige uma assinatura ativa para creditar), então
 * o crédito unitário substitui os antigos pacotes fechados de 3/5/10 — o
 * cliente compra exatamente quantos precisar.
 */
export const VALOR_UNITARIO_CREDITO_CENTS = 500;

/** Créditos avulsos. Validade de 90 dias, contada a partir da liberação. */
export const PACOTES: DefinicaoPacote[] = [
  { slug: "credito-avulso", name: "Crédito avulso", credits: 1, priceCents: VALOR_UNITARIO_CREDITO_CENTS, validityDays: 90, sortOrder: 10 },
];

/** Benefícios exibidos na home. */
export const BENEFICIOS_SISTEMA = [
  { titulo: "Prescrição ordinária", texto: "Verificação do prazo do art. 174 do CTN a partir da constituição definitiva do crédito." },
  { titulo: "Prescrição intercorrente", texto: "Aplicação do rito do art. 40 da LEF e dos Temas 566-571 do STJ à cronologia dos autos." },
  { titulo: "Decadência tributária", texto: "Distinção entre o art. 150, §4º e o art. 173, I do CTN conforme a modalidade de lançamento." },
  { titulo: "Linha do tempo automática", texto: "Os atos do processo são organizados em ordem, com a folha em que cada um foi localizado." },
  { titulo: "Marcos interruptivos e suspensivos", texto: "Identificação de citação, parcelamento, penhora e arquivamento, com o efeito de cada um." },
  { titulo: "Fundamentação legal", texto: "Dispositivo, súmula e tema vinculante em cada afirmação, sem fundamento genérico." },
  { titulo: "Conclusão objetiva", texto: "A resposta diz se a tese existe, não existe ou não pôde ser apurada com os documentos enviados." },
  { titulo: "Relatório jurídico", texto: "Documento estruturado para leitura e conferência, exportável." },
  { titulo: "Sugestão de petição", texto: "Exceção de pré-executividade completa, gerada apenas quando há tese favorável." },
  { titulo: "Histórico das análises", texto: "Todas as análises da conta ficam disponíveis para consulta posterior." },
  { titulo: "Economia de tempo", texto: "A leitura da cronologia de um processo extenso deixa de ser feita página a página." },
];

/** Aviso obrigatório em toda apresentação comercial do sistema. */
export const AVISO_REVISAO =
  "O Prescrição Pro é uma ferramenta de apoio à análise jurídica. A análise é automatizada e pode " +
  "conter falhas: todo resultado deve ser revisado por advogado(a) habilitado(a) antes de qualquer " +
  "utilização. O sistema não substitui a atuação profissional, e a indicação favorável não representa " +
  "garantia de êxito.";

/** Preço formatado em real. */
export function precoBR(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Economia do plano anual frente a 12 meses do mensal, em porcentagem. */
export function economiaAnual(family: FamiliaPlano): number | null {
  const mensal = PLANOS.find((p) => p.family === family && p.period === "MENSAL");
  const anual = PLANOS.find((p) => p.family === family && p.period === "ANUAL");
  if (!mensal || !anual || mensal.priceCents === 0) return null;
  const cheio = mensal.priceCents * 12;
  return Math.round(((cheio - anual.priceCents) / cheio) * 100);
}
