import { z } from "zod";

/** Schemas de validação (Zod) reaproveitados por rotas de API e formulários. */

export const registerSchema = z.object({
  name: z.string().min(3, "Informe o nome completo.").max(160),
  email: z.string().email("E-mail inválido.").max(200),
  phone: z.string().max(30).optional(),
  organizationName: z.string().max(160).optional(),
  document: z.string().max(20).optional(), // CPF/CNPJ (validação leve; formatação no client)
  password: z.string().min(10, "A senha deve ter ao menos 10 caracteres.").max(200),
  acceptTerms: z.literal(true, { error: "É necessário aceitar os Termos de Uso." }),
  acceptPrivacy: z.literal(true, { error: "É necessário aceitar a Política de Privacidade." }),
  acceptAi: z.literal(true, { error: "É necessário aceitar o uso de IA." }),
  acceptSubscription: z.literal(true, { error: "É necessário aceitar as condições da assinatura." }),
});

export const loginSchema = z.object({
  email: z.string().email("E-mail inválido."),
  password: z.string().min(1, "Informe a senha."),
  totp: z.string().optional(),
});

export const forgotSchema = z.object({
  email: z.string().email("E-mail inválido."),
});

export const resetSchema = z.object({
  token: z.string().min(10),
  password: z.string().min(10, "A senha deve ter ao menos 10 caracteres."),
  // Aceite de termos/condições ao criar a senha (fluxo de quem paga antes de ter conta).
  acceptTerms: z.boolean().optional(),
});

/** Etapa 1 do formulário de análise — identificação. */
export const analysisIdentificationSchema = z.object({
  title: z.string().min(3, "Informe um título.").max(200),
  type: z.enum([
    "PRESCRICAO",
    "DECADENCIA",
    "PRESCRICAO_INTERCORRENTE",
    "EXECUCAO_FISCAL_COMPLETA",
    "NULIDADES",
    "GERAL",
  ]),
  objective: z.string().max(2000).optional(),
  processNumber: z.string().max(60).optional(),
  court: z.string().max(160).optional(),
  jurisdiction: z.string().max(160).optional(),
  courtDivision: z.string().max(160).optional(),
  creditor: z.string().max(200).optional(),
  debtor: z.string().max(200).optional(),
  debtorDocument: z.string().max(20).optional(),
  taxType: z.string().max(120).optional(),
  publicEntity: z.string().max(160).optional(),
  cdaNumber: z.string().max(120).optional(),
  dividaAtivaNumber: z.string().max(120).optional(),
  approxValue: z.number().nonnegative().optional(),
});

/** Etapa 2 — datas e informações processuais (todas opcionais; extraíveis dos docs). */
export const analysisFactsSchema = z.object({
  dataFatoGerador: z.string().optional(),
  dataConstituicaoDefinitiva: z.string().optional(),
  dataNotificacao: z.string().optional(),
  dataInscricaoDividaAtiva: z.string().optional(),
  dataAjuizamento: z.string().optional(),
  dataDespachoCitatorio: z.string().optional(),
  dataCitacao: z.string().optional(),
  modalidadeCitacao: z.string().optional(),
  possuiParcelamento: z.boolean().optional(),
  periodoParcelamento: z.string().optional(),
  possuiDeposito: z.boolean().optional(),
  possuiGarantia: z.boolean().optional(),
  possuiPenhora: z.boolean().optional(),
  possuiSuspensao: z.boolean().optional(),
  possuiArquivamento: z.boolean().optional(),
  // Redirecionamento ao sócio/administrador (4º instituto)
  possuiRedirecionamento: z.boolean().optional(),
  dataCitacaoPJ: z.string().optional(),
  dataDissolucaoIrregular: z.string().optional(),
  dataPedidoRedirecionamento: z.string().optional(),
  fazendaInerteRedirecionamento: z.boolean().optional(),
  movimentacoesRelevantes: z.string().max(4000).optional(),
  outrasInformacoes: z.string().max(4000).optional(),
});

export const supportTicketSchema = z.object({
  subject: z.string().min(3).max(200),
  category: z.string().max(80).optional(),
  priority: z.enum(["BAIXA", "MEDIA", "ALTA", "URGENTE"]).default("MEDIA"),
  message: z.string().min(3).max(5000),
});

/** Resposta em chamado existente — da equipe ou do próprio cliente. */
export const supportReplySchema = z.object({
  message: z.string().min(1, "Escreva a resposta.").max(5000),
});

/**
 * Mudança de status pela equipe. AGUARDANDO_CLIENTE não entra aqui porque é
 * consequência automática de responder, não uma escolha manual.
 */
export const supportStatusSchema = z.object({
  status: z.enum(["ABERTO", "EM_ATENDIMENTO", "RESOLVIDO", "ENCERRADO"]),
});

export const contactSchema = z.object({
  name: z.string().min(2).max(160),
  email: z.string().email(),
  phone: z.string().max(30).optional(),
  message: z.string().min(5).max(4000),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type AnalysisIdentificationInput = z.infer<typeof analysisIdentificationSchema>;
export type AnalysisFactsInput = z.infer<typeof analysisFactsSchema>;
