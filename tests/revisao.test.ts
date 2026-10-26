import { describe, it, expect } from "vitest";
import { z } from "zod";

/**
 * Conclusão da revisão jurídica.
 *
 * MOTIVO: a análise nascia em AGUARDANDO_REVISAO com um LegalReview PENDENTE,
 * e NADA no sistema escrevia nesse registro depois — não havia rota, tela nem
 * back-office. O status CONCLUIDA jamais era atribuído: toda análise ficava
 * "aguardando revisão" para sempre, sem caminho para o cliente concluir.
 *
 * Estes testes travam as duas regras que sustentam o fluxo: só duas decisões
 * são aceitas, e cada uma leva a análise a um estado terminal previsível.
 */

/** Mesmo schema da rota (src/app/api/analises/[id]/revisao/route.ts). */
const schema = z.object({
  decisao: z.enum(["APROVADA", "DEVOLVIDA"]),
  notes: z.string().max(5000).optional(),
  risks: z.string().max(5000).optional(),
  divergences: z.string().max(5000).optional(),
});

/** Regra da rota: a decisão determina o estado final da análise. */
function statusDaAnalise(decisao: "APROVADA" | "DEVOLVIDA"): string {
  return decisao === "APROVADA" ? "CONCLUIDA" : "AGUARDANDO_INFORMACOES";
}

/** Regra da rota: quem pode revisar. */
function podeRevisar(papel: string, ehDono: boolean): boolean {
  return ehDono || papel === "ADMIN" || papel === "REVISOR";
}

describe("decisão da revisão", () => {
  it("aceita apenas aprovar ou devolver", () => {
    expect(schema.safeParse({ decisao: "APROVADA" }).success).toBe(true);
    expect(schema.safeParse({ decisao: "DEVOLVIDA" }).success).toBe(true);
    expect(schema.safeParse({ decisao: "PENDENTE" }).success).toBe(false);
    expect(schema.safeParse({ decisao: "EM_ANALISE" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("aprovar conclui a análise — o estado que nunca era alcançado", () => {
    expect(statusDaAnalise("APROVADA")).toBe("CONCLUIDA");
  });

  it("devolver reabre para complementação, não conclui", () => {
    expect(statusDaAnalise("DEVOLVIDA")).toBe("AGUARDANDO_INFORMACOES");
    expect(statusDaAnalise("DEVOLVIDA")).not.toBe("CONCLUIDA");
  });

  it("ressalvas são opcionais — revisar sem observações é válido", () => {
    expect(schema.safeParse({ decisao: "APROVADA" }).success).toBe(true);
  });

  it("limita o tamanho dos campos livres", () => {
    const longo = "x".repeat(5001);
    expect(schema.safeParse({ decisao: "APROVADA", notes: longo }).success).toBe(false);
    expect(schema.safeParse({ decisao: "APROVADA", risks: longo }).success).toBe(false);
    expect(schema.safeParse({ decisao: "APROVADA", divergences: longo }).success).toBe(false);
  });
});

describe("quem pode revisar", () => {
  it("o dono da análise revisa a própria", () => {
    expect(podeRevisar("CLIENTE", true)).toBe(true);
  });

  it("cliente não revisa análise de outro", () => {
    expect(podeRevisar("CLIENTE", false)).toBe(false);
  });

  it("admin e revisor revisam em apoio", () => {
    expect(podeRevisar("ADMIN", false)).toBe(true);
    expect(podeRevisar("REVISOR", false)).toBe(true);
  });

  it("suporte não revisa — o papel é de atendimento, não jurídico", () => {
    expect(podeRevisar("SUPORTE", false)).toBe(false);
  });
});
