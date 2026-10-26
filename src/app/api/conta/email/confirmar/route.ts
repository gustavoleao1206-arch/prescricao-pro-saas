import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, route } from "@/lib/api";
import { rateLimit, clientIp, tempoDeEspera } from "@/lib/rate-limit";
import { confirmarTrocaDeEmail, type MotivoDaRecusa } from "@/lib/troca-de-email";

export const runtime = "nodejs";

const corpo = z.object({ token: z.string().min(10, "Link inválido.") });

/**
 * Confirmação da troca de e-mail, a partir do link enviado ao endereço NOVO.
 *
 * ── Não exige sessão ──────────────────────────────────────────────────────────
 * O link chega na caixa do endereço novo, que a pessoa pode abrir no celular sem estar logada.
 * Exigir sessão empurraria o cliente a um login que ele talvez não consiga fazer, e não
 * acrescentaria segurança: o pedido já exigiu a senha atual, e o link já prova o controle do
 * destino. São duas provas antes desta tela.
 */
export const POST = route(async (req: NextRequest) => {
  /**
   * Limite por IP, porque aqui não há conta identificada antes de validar o link. Protege contra
   * varredura de tokens — o token tem 32 bytes, então adivinhar é inviável, mas rota pública que
   * consulta o banco por tentativa não deve ficar sem teto.
   */
  const limite = rateLimit(`confirmar-troca-email:${clientIp(req)}`, 20, 600);
  if (!limite.allowed) {
    return fail(`Muitas tentativas. Aguarde ${tempoDeEspera(limite.resetAt)} e abra o link novamente.`, 429);
  }

  const dados = corpo.safeParse(await req.json().catch(() => null));
  if (!dados.success) return fail("Link de troca de e-mail inválido.", 400);

  const r = await confirmarTrocaDeEmail(dados.data.token);

  /**
   * ⚠️ LINK JÁ USADO QUE JÁ DEU CERTO RESPONDE 200, NÃO ERRO.
   *
   * Era o defeito mais caro deste arquivo: quem confirmava e voltava ao link — recarregando a aba,
   * clicando de novo no e-mail, ou com um cliente de e-mail que pré-abre links para gerar a
   * pré-visualização — lia "este link é inválido ou expirou. Peça a troca novamente". Anunciar
   * falha depois do sucesso faz a pessoa pedir outra troca, o que gasta o limite de cinco em quinze
   * minutos e, pior, deixa um `pendingEmail` novo numa conta que já estava certa.
   *
   * O endereço mostrado vem da AUDITORIA (o que ESTE link aplicou), não de `user.email`: se a conta
   * trocou de endereço mais uma vez depois, o atual seria um terceiro endereço e a tela o revelaria
   * a quem só teve acesso ao segundo.
   */
  if (!r.ok) {
    if (r.motivo === "ja_confirmado") {
      return ok({
        jaEstavaFeita: true,
        para: r.aplicado ?? null,
        message: r.aplicado
          ? `Este link já havia sido usado — e deu certo. O e-mail da sua conta é ${r.aplicado}.`
          : "Este link já havia sido usado, e a troca foi aplicada. Nada ficou pendente.",
      });
    }

    /**
     * Cada recusa pede uma ação DIFERENTE, e é por isso que não viram uma mensagem só. A versão
     * anterior juntava "inválido" e "expirado" na mesma frase, e jogava todo link já usado ali
     * dentro — inclusive os que haviam funcionado.
     */
    const mensagens: Record<Exclude<MotivoDaRecusa, "ja_confirmado">, string> = {
      link_invalido: "Este link de confirmação não é válido. Peça a troca novamente em Configurações.",
      link_expirado:
        "Este link expirou — ele vale 1 hora, de propósito, porque link de troca de e-mail parado numa" +
        " caixa de entrada é um risco. Entre na sua conta e peça a troca de novo em Configurações.",
      /**
       * ⚠️ NÃO NOMEIA O ENDEREÇO PENDENTE, e a primeira versão nomeava.
       *
       * Esta rota é PÚBLICA. Quem clica um link antigo pode não ser o titular: é exatamente o que
       * acontece quando o endereço novo foi digitado errado e o link caiu na caixa de um estranho.
       * Dizer a ele "agora para joao@exemplo.com.br" entregava o endereço real do cliente — que vira o
       * login da conta assim que o titular confirmar — a quem não devia. Ver o bloco sobre o
       * vazamento em `src/lib/troca-de-email.ts`.
       */
      link_substituido:
        "Você pediu a troca de novo depois deste link, e só o último pedido vale. Abra o e-mail de" +
        " confirmação mais recente, ou peça a troca outra vez em Configurações.",
      /**
       * As TRÊS hipóteses, e "já deu certo" vem PRIMEIRO de propósito.
       *
       * Este é o caminho que sobra quando nem a auditoria nem o estado da conta identificam este
       * link — e isso inclui uma troca que FUNCIONOU cuja auditoria não foi gravada (`logAudit` é
       * best-effort e engole o próprio erro). Começar por "foi cancelado" seria anunciar fracasso na
       * hipótese errada, que é justamente o defeito que este conserto existe para fechar.
       */
      link_encerrado:
        "Este link não vale mais. A troca pode já ter sido aplicada — confira entrando na conta —, o" +
        " pedido pode ter sido cancelado (trocar a senha cancela, por segurança) ou substituído por um" +
        " pedido mais novo. Se o e-mail da conta ainda não é o que você quer, peça a troca de novo em" +
        " Configurações.",
      sem_pedido: "Não há troca de e-mail pendente para esta conta. Ela já pode ter sido confirmada.",
      email_em_uso:
        "Enquanto você confirmava, este e-mail passou a ser usado por outra conta. Peça a troca de novo com outro endereço.",
    };
    return fail(mensagens[r.motivo], 400, { reason: r.motivo });
  }

  return ok({
    de: r.de,
    para: r.para,
    message: `Pronto. O e-mail da sua conta agora é ${r.para}, e ele já está confirmado.`,
  });
});
