import { NextRequest } from "next/server";
import { z } from "zod";
import { ok, fail, route } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { rateLimit, clientIp, tempoDeEspera } from "@/lib/rate-limit";
import { pedirTrocaDeEmail, cancelarTrocaDeEmailPendente, type RecusaDaTroca } from "@/lib/troca-de-email";

export const runtime = "nodejs";

const corpo = z.object({
  novoEmail: z.string().min(3, "Informe o novo e-mail."),
  senha: z.string().min(1, "Informe sua senha atual."),
});

/**
 * Pedido de troca do e-mail da conta, pelo próprio cliente.
 *
 * Nada é aplicado aqui: o endereço novo fica pendente até o link enviado a ele ser clicado.
 * As decisões de segurança (senha atual obrigatória, aviso ao endereço antigo, link curto)
 * vivem em `src/lib/troca-de-email.ts`, junto da explicação de cada uma.
 */
export const POST = route(async (req: NextRequest) => {
  const user = await requireUser();
  const ip = clientIp(req);

  /**
   * ⚠️ Limite por CONTA, e ele é de segurança, não de cortesia.
   *
   * A rota confere a senha atual, então ela é um oráculo de senha para quem tem uma sessão
   * roubada: sem limite, daria para tentar senhas em série. Cinco em quinze minutos permite o
   * erro de digitação honesto e inviabiliza a tentativa em série.
   */
  const limite = rateLimit(`troca-email:${user.id}`, 5, 900);
  if (!limite.allowed) {
    /**
     * Diz o prazo — e NÃO manda mais usar "esqueci minha senha".
     *
     * Essa recomendação era um beco sem saída para o público exato desta tela: quem está aqui muitas
     * vezes está aqui porque o endereço da conta está errado, e a recuperação de senha manda o link
     * justamente para aquele endereço inalcançável. Recomendar isso gasta o tempo da pessoa e a faz
     * concluir que não há saída. Para quem não recebe e-mail no endereço atual, a saída é o suporte.
     */
    return fail(
      `Muitas tentativas. Aguarde ${tempoDeEspera(limite.resetAt)} antes de tentar de novo. Se você não` +
        " recebe e-mail no endereço atual da conta, fale com o suporte em vez de esperar.",
      429,
    );
  }

  const dados = corpo.safeParse(await req.json().catch(() => null));
  if (!dados.success) return fail(dados.error.issues[0]?.message ?? "Dados inválidos.", 422);

  const r = await pedirTrocaDeEmail(user.id, dados.data.novoEmail, dados.data.senha, { ip });

  if (!r.aceito) {
    /**
     * Cada recusa diz o que fazer. "Dados inválidos" mandaria a pessoa adivinhar entre o
     * endereço e a senha — e num formulário de dois campos isso é adivinhação de 50%.
     */
    const mensagens: Record<RecusaDaTroca, string> = {
      senha_incorreta: "Senha atual incorreta. Confira e tente novamente.",
      conta_travada:
        "Sua conta está temporariamente bloqueada por tentativas de senha erradas. Aguarde alguns" +
        " minutos e tente de novo.",
      email_invalido: "O e-mail informado não parece válido. Confira o endereço.",
      email_igual: "Este já é o e-mail da sua conta.",
      /**
       * ⚠️ ESTA MENSAGEM REVELA QUE EXISTE CONTA NAQUELE ENDEREÇO, E ISSO É DECISÃO DO DONO.
       *
       * Não é descuido, e não deve ser "consertada" por quem passar por aqui achando que é brecha —
       * a revisão de segurança da autenticação levantou o item, ele foi apresentado ao dono do produto
       * em 10/08/2026 com as duas opções, e a escolha foi MANTER a mensagem clara.
       *
       * A razão: a recuperação de senha responde igual para e-mail existente e inexistente porque é
       * rota PÚBLICA — qualquer um sonda qualquer endereço. Aqui não: exige sessão da própria conta e
       * a senha atual, e está limitada a cinco tentativas por quinze minutos por conta. Quem lê esta
       * frase já provou ser o titular, então o que ela entrega é sobre a conta dele.
       *
       * Do outro lado da balança, a versão genérica ("não foi possível usar este endereço") deixaria
       * o cliente sem entender por que a troca não vai — no exato momento em que ele está com
       * dificuldade e precisa confirmar o e-mail para poder contratar. Atrito ali custa venda.
       *
       * Se um dia esta rota deixar de exigir a senha atual, ou o limite por conta cair, a conta desta
       * decisão muda e a mensagem precisa ser revista.
       */
      email_em_uso: "Já existe uma conta com este e-mail. Use outro endereço ou fale com o suporte.",
      sem_senha:
        "Sua conta ainda não tem senha definida. Crie sua senha primeiro (use \"esqueci minha senha\") e depois troque o e-mail.",
    };
    // 423 para conta travada, o mesmo código que o login usa — estado, não erro do pedido.
    const status = r.recusa === "conta_travada" ? 423 : r.recusa === "senha_incorreta" ? 403 : 422;
    return fail(mensagens[r.recusa!], status, { reason: r.recusa });
  }

  /**
   * Falha no envio não é 500: o pedido está registrado e o endereço antigo já foi avisado. O
   * que a pessoa precisa saber é que o link não saiu, para poder pedir de novo em vez de ficar
   * esperando um e-mail que não vem.
   */
  if (!r.enviado) {
    return ok({
      pendente: true,
      enviado: false,
      message:
        "Registramos o pedido, mas não conseguimos enviar o e-mail de confirmação agora. Tente novamente" +
        " em alguns minutos — a troca só vale depois de você confirmar no endereço novo.",
    });
  }

  const destino = dados.data.novoEmail.trim().toLowerCase();
  /**
   * ⚠️ Só avisa da substituição quando o endereço é OUTRO.
   *
   * Pedir duas vezes para o MESMO endereço é o caminho normal de quem não recebeu o primeiro e-mail —
   * e a primeira versão respondia "Enviamos um link para joao@x.com. O pedido anterior, para
   * joao@x.com, foi cancelado", que se contradiz na mesma frase e faz a pessoa concluir que acabou de
   * desfazer o que pediu. Quando o endereço repete, a substituição não é informação: é ruído que
   * assusta.
   */
  const substituiuOutroEndereco = Boolean(r.substituiu && r.substituiu !== destino);

  return ok({
    pendente: true,
    enviado: true,
    substituiu: r.substituiu ?? null,
    message:
      `Enviamos um link de confirmação para ${destino}. A troca só vale depois de você clicar nele, e o` +
      " link expira em 1 hora." +
      /**
       * Diz que o pedido anterior morreu, e para onde ele ia.
       *
       * O aviso na tela já diz que pedir de novo substitui — mas ele é renderizado pelo servidor e
       * fica desatualizado depois do envio. Quem pediu para DOIS endereços diferentes precisa ler no
       * RESULTADO qual dos dois links vale, senão abre o primeiro e recebe recusa.
       */
      (substituiuOutroEndereco
        ? ` O pedido anterior, para ${r.substituiu}, foi cancelado — aquele link não vale mais.`
        : "") +
      " Avisamos também o endereço atual, por segurança.",
  });
});

/**
 * Cancela o pedido de troca pendente, a pedido do próprio titular.
 *
 * ── Por que precisou existir ──────────────────────────────────────────────────
 * `pendingEmail` ficava PRESO. Passada a hora do link, a conta continuava com um endereço pendente
 * que nunca mais poderia ser confirmado, e a tela seguia dizendo "confirme pelo link enviado a esse
 * endereço" — prometendo um link morto. O único jeito de limpar era pedir a troca para um TERCEIRO
 * endereço (pedir de volta o atual é recusado por "email_igual") ou trocar a senha, que cancela por
 * efeito colateral. Nenhuma das duas se deduz sob pressão.
 *
 * ── Por que NÃO pede a senha, ao contrário do pedido ──────────────────────────
 * O pedido de troca exige a senha porque APONTA a conta para outro lugar. Cancelar faz o contrário:
 * devolve a conta ao estado em que já estava. Sessão roubada que cancela um pedido legítimo é
 * incômodo, não tomada de conta — e quem tem a sessão tem alavancas muito maiores.
 *
 * Exigir a senha aqui teria um custo real e assimétrico: quem acabou de travar a conta errando a
 * senha cinco vezes é exatamente quem mais precisa desfazer o pedido, e ficaria sem saída nenhuma.
 * A porta de emergência não pode depender da chave que a pessoa perdeu.
 *
 * ── Requisição forjada de outro site (CSRF) ───────────────────────────────────
 * Protegida pelo mesmo mecanismo de todas as rotas de estado deste projeto: o cookie de sessão é
 * `sameSite: "lax"` (ver `src/lib/auth.ts`), e Lax não envia o cookie em requisição disparada por
 * outro site fora de navegação de topo com método seguro. Sem cookie, `requireUser` recusa. Vale
 * notar que DELETE é ainda mais difícil de forjar que os POST já existentes: formulário HTML só
 * emite GET e POST, então não há como disparar isto sem `fetch` — que a política do cookie barra.
 */
export const DELETE = route(async (req: NextRequest) => {
  const user = await requireUser();

  const limite = rateLimit(`cancelar-troca-email:${user.id}`, 10, 900);
  if (!limite.allowed) {
    return fail(`Muitas tentativas. Aguarde ${tempoDeEspera(limite.resetAt)} antes de tentar de novo.`, 429);
  }

  const r = await cancelarTrocaDeEmailPendente(user.id, "cancelado pelo titular", { ip: clientIp(req) });

  /**
   * Não havia nada para cancelar responde a verdade em vez de fingir sucesso. Fingir esconderia o
   * caso em que a tela está desatualizada — e é justamente aí que a pessoa precisa recarregar.
   */
  if (!r.cancelou) {
    return ok({ cancelou: false, message: "Não havia pedido de troca pendente nesta conta." });
  }

  /**
   * ⚠️ `r.endereco` PODE SER NULO com `cancelou: true`, e a primeira versão escrevia "o link enviado
   * para null não vale mais".
   *
   * O estado existe: `cancelarTrocaDeEmailPendente` devolve `cancelou: true` também quando não havia
   * endereço pendente mas HAVIA token vivo — situação incoerente que a função conserta de propósito.
   * Interpolar sem conferir punha a palavra "null" na cara do cliente, no exato momento em que ele
   * está tentando entender o que aconteceu com a conta dele.
   */
  return ok({
    cancelou: true,
    message: r.endereco
      ? `Pedido cancelado. O e-mail da sua conta continua ${user.email}, e o link enviado para` +
        ` ${r.endereco} não vale mais.`
      : `Pedido cancelado. O e-mail da sua conta continua ${user.email}, e qualquer link de troca` +
        " enviado antes não vale mais.",
  });
});
