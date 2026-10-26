import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { registerSchema } from "@/lib/validation";
import { hashPassword, validatePasswordStrength } from "@/lib/password";
import { encryptField } from "@/lib/crypto";
import { rateLimit, clientIp, tempoDeEspera } from "@/lib/rate-limit";
import { garantirOrganizacao } from "@/lib/tenant";
import { emitirVerificacaoDeEmail } from "@/lib/verificacao-email";
import { logAudit } from "@/lib/audit";
import { VERSAO_DOCUMENTOS } from "@/lib/fornecedor";

export const POST = route(async (req: NextRequest) => {
  const ip = clientIp(req);
  const limite = rateLimit(`cadastro:${ip}`, 10, 3600);
  if (!limite.allowed) {
    /**
     * ⚠️ A janela aqui é de uma HORA, e a recusa dizia "tente mais tarde" — a mais vaga de todas
     * justamente onde a espera é a mais longa, e na porta de entrada de um cliente novo. Quem cai
     * neste limite quase sempre é um escritório inteiro atrás do mesmo IP cadastrando gente.
     */
    return fail(
      `Muitas tentativas de cadastro a partir desta conexão. Aguarde ${tempoDeEspera(limite.resetAt)}` +
        " e tente de novo. Se você já tem conta, entre em vez de se cadastrar.",
      429,
    );
  }

  const data = registerSchema.parse(await req.json());

  const strength = validatePasswordStrength(data.password);
  if (strength.length) return fail(strength.join(" "), 422);

  const email = data.email.toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return fail("Já existe uma conta com este e-mail.", 409);

  const documentType = data.document ? (data.document.replace(/\D/g, "").length > 11 ? "CNPJ" : "CPF") : null;

  const user = await prisma.user.create({
    data: {
      email,
      name: data.name,
      phone: data.phone,
      documentEnc: data.document ? encryptField(data.document) : null,
      documentType,
      passwordHash: await hashPassword(data.password),
      role: "CLIENTE",
      status: "PENDENTE_VERIFICACAO",
    },
  });

  // Organização própria + papel de OWNER — mesma regra do webhook e da liberação manual.
  const org = await garantirOrganizacao(user.id, data.organizationName ?? data.name);

  /**
   * Consentimentos (LGPD) com a versão REAL do documento aceito.
   *
   * A versão estava escrita "1.0" à mão, e ficou para trás quando os documentos
   * legais foram reescritos: todo mundo que se cadastrasse a partir dali teria
   * registrado o aceite de uma versão que já não era a publicada. Isso destrói
   * justamente o valor do registro — a prova do consentimento (art. 8º, §1º, da
   * LGPD) serve para saber o que a pessoa aceitou, e o número precisa apontar para
   * o texto que ela viu. Lendo de `VERSAO_DOCUMENTOS`, subir a versão dos documentos
   * passa a bastar.
   */
  await prisma.consent.createMany({
    data: [
      { userId: user.id, type: "TERMOS_USO", version: VERSAO_DOCUMENTOS, ip },
      { userId: user.id, type: "POLITICA_PRIVACIDADE", version: VERSAO_DOCUMENTOS, ip },
      { userId: user.id, type: "USO_IA", version: VERSAO_DOCUMENTOS, ip },
      { userId: user.id, type: "CONDICOES_ASSINATURA", version: VERSAO_DOCUMENTOS, ip },
    ],
  });

  /**
   * O link de verificação sai de `emitirVerificacaoDeEmail`, e não daqui.
   *
   * A regra (validade do link, texto, endereço de confirmação, invalidação dos links
   * anteriores) passou a ter um segundo cliente — o reenvio pedido pelo cliente — e duas
   * cópias dela é como as duas divergem. Bastaria mudar a validade num lado para a pessoa
   * receber um link que expira antes do que a tela promete.
   *
   * O envio não pode derrubar o cadastro: a conta já está criada neste ponto, e responder erro
   * faria o cliente tentar de novo e receber "e-mail já existe". Mas também não se promete um
   * e-mail que não saiu — a função devolve o desfecho e a mensagem abaixo diz a verdade.
   */
  const emissao = await emitirVerificacaoDeEmail({ id: user.id, email, name: data.name });
  const emailEnviado = emissao.enviado;

  await logAudit({
    actorId: user.id,
    action: "auth.register",
    entityType: "User",
    entityId: user.id,
    ip,
    metadata: { emailVerificacaoEnviado: emailEnviado },
  });
  return ok(
    {
      userId: user.id,
      emailEnviado,
      message: emailEnviado
        ? "Cadastro criado. Verifique seu e-mail para ativar a conta."
        : "Cadastro criado, mas não conseguimos enviar o e-mail de confirmação agora. Você já pode entrar com o e-mail e a senha que acabou de cadastrar; se precisar, use 'Esqueci minha senha' ou fale com o suporte.",
    },
    { status: 201 },
  );
});
