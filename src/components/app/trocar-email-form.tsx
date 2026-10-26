"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Troca do e-mail da conta, pedida pelo próprio cliente.
 *
 * ── Por que a senha atual é pedida aqui ───────────────────────────────────────
 * Quem controla o e-mail de uma conta controla a conta, porque a recuperação de senha vai para
 * lá. Sem a senha, bastaria pegar uma tela logada e apontar a conta para outro endereço. O
 * campo é explicado ao cliente em vez de aparecer como burocracia — pedido de senha sem motivo
 * dito é o que faz gente desconfiar do formulário.
 *
 * ── A tela deixa claro que NADA muda ainda ────────────────────────────────────
 * A troca só vale depois do clique no link enviado ao endereço novo. Sem dizer isso, a pessoa
 * fecharia a tela achando que trocou, tentaria entrar com o endereço novo e concluiria que o
 * sistema quebrou.
 */
export function TrocarEmailForm({
  emailAtual,
  pendente,
  linkExpiraEm,
}: {
  emailAtual: string;
  pendente: string | null;
  /** Quando o link do pedido pendente expira. Nulo significa que NÃO há link vivo. */
  linkExpiraEm: string | null;
}) {
  const router = useRouter();
  const [novoEmail, setNovoEmail] = useState("");
  const [senha, setSenha] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [cancelando, setCancelando] = useState(false);
  /** O pedido pendente sai da tela na hora em que é cancelado, sem esperar o servidor re-renderizar. */
  const [pedidoCancelado, setPedidoCancelado] = useState(false);
  const [aviso, setAviso] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);

  /**
   * Os minutos que faltam são calculados NO NAVEGADOR, depois de montar.
   *
   * Renderizar o número no servidor faria o HTML entregue discordar do que o React calcula ao
   * hidratar (o tempo passa entre os dois) — e o React avisa isso como erro no console. A decisão que
   * importa, "existe link vivo?", já vem resolvida do servidor em `linkExpiraEm`; aqui só se mostra
   * quanto sobra, e a ausência do número no primeiro instante não muda o sentido de nada.
   */
  const [minutosRestantes, setMinutosRestantes] = useState<number | null>(null);
  /**
   * ⚠️ E o número é RECALCULADO, não congelado no primeiro render.
   *
   * A tela de Configurações fica aberta. Sem o intervalo, quem deixou a aba parada trinta minutos lia
   * "ainda vale por cerca de 40 minutos" quando já faltavam dez — e, pior, quando o prazo chegava a
   * zero o número desaparecia e o texto voltava a prometer o link sem prazo nenhum, que é exatamente o
   * defeito que este conserto existe para fechar.
   *
   * Ao vencer, `expirou` fica verdadeiro e a tela passa a mostrar o texto do link morto, com o botão de
   * cancelar — sem depender de recarregar a página.
   */
  const [expirou, setExpirou] = useState(false);
  useEffect(() => {
    if (!linkExpiraEm) {
      setMinutosRestantes(null);
      setExpirou(false);
      return;
    }
    const alvo = new Date(linkExpiraEm).getTime();
    const medir = () => {
      const faltam = Math.ceil((alvo - Date.now()) / 60_000);
      setMinutosRestantes(faltam > 0 ? faltam : null);
      setExpirou(faltam <= 0);
    };
    medir();
    const t = setInterval(medir, 30_000);
    return () => clearInterval(t);
  }, [linkExpiraEm]);

  /** O servidor decide se havia link; o relógio do navegador só pode PIORAR o veredito, nunca melhorá-lo. */
  const linkVivo = Boolean(linkExpiraEm) && !expirou;

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    setAviso(null);
    try {
      const res = await fetch("/api/conta/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ novoEmail, senha }),
      });
      const dados = await res.json();
      if (res.ok && dados.ok) {
        setAviso({ tipo: "ok", texto: dados.data?.message ?? "Pedido registrado." });
        // A senha sai da tela no sucesso; o endereço fica, para a pessoa conferir o que digitou.
        setSenha("");
        /**
         * Recarrega os dados do servidor para o aviso de pendência refletir o pedido que acabou de
         * ser feito — inclusive o novo prazo do link. Sem isso, a tela seguiria mostrando o endereço
         * anterior, que este pedido acabou de invalidar.
         */
        setPedidoCancelado(false);
        router.refresh();
      } else {
        setAviso({ tipo: "erro", texto: dados.error ?? "Não foi possível pedir a troca agora." });
      }
    } catch {
      setAviso({ tipo: "erro", texto: "Não foi possível pedir a troca agora. Tente novamente." });
    } finally {
      setEnviando(false);
    }
  }

  /**
   * Cancela o pedido pendente.
   *
   * ── Por que este botão precisou existir ───────────────────────────────────────
   * Sem ele, um endereço pendente digitado errado não tinha como sair da conta. Pedir de volta o
   * endereço ATUAL é recusado ("este já é o e-mail da sua conta"), então a única forma de limpar era
   * pedir a troca para um TERCEIRO endereço qualquer, ou trocar a senha — que cancela por efeito
   * colateral. Nenhuma das duas se deduz, muito menos por quem já está confuso.
   *
   * Não pede a senha: cancelar devolve a conta ao estado em que ela já estava. Ver a rota DELETE.
   */
  async function cancelar() {
    setCancelando(true);
    setAviso(null);
    try {
      const res = await fetch("/api/conta/email", { method: "DELETE" });
      const dados = await res.json();
      if (res.ok && dados.ok) {
        setPedidoCancelado(true);
        setAviso({ tipo: "ok", texto: dados.data?.message ?? "Pedido cancelado." });
        router.refresh();
      } else {
        setAviso({ tipo: "erro", texto: dados.error ?? "Não foi possível cancelar agora." });
      }
    } catch {
      setAviso({ tipo: "erro", texto: "Não foi possível cancelar agora. Tente novamente." });
    } finally {
      setCancelando(false);
    }
  }

  const mostrarPendencia = Boolean(pendente) && !pedidoCancelado;

  return (
    <form onSubmit={enviar} className="space-y-3">
      <p className="text-sm text-neutro-500">
        O e-mail da conta é o seu login e o endereço por onde chegam a recuperação de senha e os
        avisos de cobrança. Por isso a troca precisa da sua senha e de uma confirmação no endereço
        novo — nada muda até você clicar no link que enviamos para lá.
      </p>

      {mostrarPendencia && (
        /**
         * Pedido pendente é mostrado porque, sem isso, quem não recebeu o link acha que o pedido
         * não foi registrado e tenta de novo — gastando o limite de tentativas sem entender.
         *
         * ⚠️ E o texto muda conforme o link ainda estar VIVO. Antes prometia sempre "confirme pelo
         * link enviado a esse endereço", mesmo quando a hora já havia passado e o link estava morto.
         */
        <div className="space-y-2 rounded-xl border border-atencao-100 bg-atencao-50 p-3 text-sm text-atencao dark:border-atencao/40 dark:bg-atencao/10">
          {linkVivo ? (
            <p>
              Há uma troca pendente para <strong>{pendente}</strong>. Confirme pelo link enviado a
              esse endereço
              {minutosRestantes !== null ? (
                <>
                  , que ainda vale por cerca de {minutosRestantes}{" "}
                  {minutosRestantes === 1 ? "minuto" : "minutos"}
                </>
              ) : null}
              . Pedir de novo abaixo substitui este pedido.
            </p>
          ) : (
            <p>
              O pedido de troca para <strong>{pendente}</strong> não foi confirmado, e o link já
              expirou — ele vale 1 hora. Para trocar, peça de novo abaixo; para manter o e-mail atual,
              cancele o pedido.
            </p>
          )}
          <button
            type="button"
            onClick={() => void cancelar()}
            disabled={cancelando}
            className="btn-outline text-sm disabled:opacity-60"
          >
            {cancelando ? "Cancelando…" : "Cancelar este pedido"}
          </button>
        </div>
      )}

      <label className="block text-sm">
        <span className="text-neutro-600">Novo e-mail</span>
        <input
          type="email"
          required
          value={novoEmail}
          onChange={(e) => setNovoEmail(e.target.value)}
          placeholder={emailAtual}
          className="input mt-1 w-full"
          autoComplete="email"
        />
      </label>

      <label className="block text-sm">
        <span className="text-neutro-600">Sua senha atual</span>
        <input
          type="password"
          required
          value={senha}
          onChange={(e) => setSenha(e.target.value)}
          className="input mt-1 w-full"
          autoComplete="current-password"
        />
      </label>

      {aviso && (
        <p
          className={`rounded-xl p-3 text-sm ${
            aviso.tipo === "ok"
              ? "border border-sucesso-100 bg-sucesso-50 font-medium text-sucesso"
              : "border border-atencao-100 bg-atencao-50 text-atencao dark:border-atencao/40 dark:bg-atencao/10"
          }`}
        >
          {aviso.texto}
        </p>
      )}

      <button type="submit" disabled={enviando} className="btn-primary text-sm disabled:opacity-60">
        {enviando ? "Enviando…" : "Pedir a troca de e-mail"}
      </button>
    </form>
  );
}
