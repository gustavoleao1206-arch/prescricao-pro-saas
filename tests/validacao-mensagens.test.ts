import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { registerSchema, loginSchema } from "@/lib/validation";
import { route } from "@/lib/api";

/**
 * Mensagens de validação em português e a conversão de erro em 422.
 *
 * ── Por que existe ────────────────────────────────────────────────────────────
 * Na passagem do Zod 3 para o 4, a forma de personalizar a mensagem mudou (`errorMap` deixou de existir e
 * virou `error`). Escrito do jeito antigo, o Zod 4 ignora a personalização em silêncio e devolve a mensagem
 * padrão em inglês — o cadastro continuaria recusando quem não aceitou os termos, só que dizendo outra coisa.
 * Nenhum teste de rota olha o texto da mensagem, então a troca passaria despercebida.
 *
 * O último caso confere que `route()` continua reconhecendo o erro do Zod: se o `instanceof ZodError` deixar
 * de casar (pacote duplicado, classe nova), todo dado inválido viraria 500 em vez de 422.
 */

const cadastroValido = {
  name: "Pessoa de Teste",
  email: "pessoa@exemplo.local",
  password: "senha-longa-de-teste",
  acceptTerms: true,
  acceptPrivacy: true,
  acceptAi: true,
  acceptSubscription: true,
};

const errosDeCampo = (resultado: { success: boolean; error?: ZodError }) =>
  resultado.success ? {} : resultado.error!.flatten().fieldErrors;

describe("mensagens dos aceites do cadastro", () => {
  it("cadastro completo passa", () => {
    expect(registerSchema.safeParse(cadastroValido).success).toBe(true);
  });

  it.each([
    ["acceptTerms", "É necessário aceitar os Termos de Uso."],
    ["acceptPrivacy", "É necessário aceitar a Política de Privacidade."],
    ["acceptAi", "É necessário aceitar o uso de IA."],
    ["acceptSubscription", "É necessário aceitar as condições da assinatura."],
  ] as const)("%s recusado ou ausente devolve a mensagem em português", (campo, mensagem) => {
    expect(errosDeCampo(registerSchema.safeParse({ ...cadastroValido, [campo]: false }))).toEqual({ [campo]: [mensagem] });
    const { [campo]: _omitido, ...semCampo } = cadastroValido;
    expect(errosDeCampo(registerSchema.safeParse(semCampo))).toEqual({ [campo]: [mensagem] });
  });

  it("e-mail inválido mantém a mensagem própria", () => {
    expect(errosDeCampo(loginSchema.safeParse({ email: "sem-arroba", password: "x" }))).toEqual({ email: ["E-mail inválido."] });
  });
});

describe("route() converte erro do Zod em 422", () => {
  it("parse que falha dentro da rota vira 422 com os campos", async () => {
    const handler = route(async () => {
      loginSchema.parse({ email: "sem-arroba", password: "" });
      return new Response("não devia chegar aqui");
    });
    const res = await handler();
    expect(res.status).toBe(422);
    const corpo = await res.json();
    expect(corpo.issues.email).toEqual(["E-mail inválido."]);
    expect(corpo.issues.password).toEqual(["Informe a senha."]);
  });
});
