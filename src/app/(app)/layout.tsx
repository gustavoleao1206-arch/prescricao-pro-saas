import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSessionUser, INATIVIDADE_MINUTOS, NOME_DO_COOKIE_DE_SESSAO } from "@/lib/auth";
import { AppShell } from "@/components/app/app-shell";
import { EncerrarPorInatividade } from "@/components/app/encerrar-por-inatividade";
import { AvisoVerificarEmail } from "@/components/app/aviso-verificar-email";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) {
    /**
     * Distingue "nunca entrou" de "a sessão acabou", e a diferença é o que a pessoa lê.
     *
     * Cookie presente com sessão inválida só acontece de um jeito: a sessão existiu e deixou de
     * valer — por inatividade, por revogação (troca de papel) ou por bloqueio da conta. Sem
     * esta distinção, quem era desconectado no meio do trabalho chegava numa tela de login
     * limpa, sem explicação, e a leitura natural disso é "o sistema quebrou".
     *
     * O motivo é NEUTRO de propósito. Aqui não se sabe qual dos três casos foi, e escrever
     * "inatividade" quando o administrador acabou de revogar a sessão seria informação errada.
     * A tela só afirma o que é verdade nos três: a sessão foi encerrada.
     */
    const sessaoExistia = (await cookies()).has(NOME_DO_COOKIE_DE_SESSAO);
    redirect(sessaoExistia ? "/login?motivo=sessao-encerrada&next=/painel" : "/login?next=/painel");
  }

  return (
    <AppShell user={{ name: user.name, email: user.email, role: user.role }}>
      {/**
       * Fica no layout, e não em cada página: o encerramento por inatividade tem de valer em
       * toda a área logada. Posto numa página só, ele deixaria de valer justamente onde a
       * pessoa fica mais tempo parada — a leitura de um relatório.
       *
       * O limite vem do servidor, e com o PAPEL desta sessão: administrador tem prazo mais
       * curto. Escrever o número aqui faria a tela e o servidor discordarem — e o sintoma
       * seria o pior de todos: a sessão recusada no servidor com a tela ainda aberta e os
       * dados à mostra, que é exatamente o risco que a regra existe para tratar.
       */}
      <EncerrarPorInatividade minutos={INATIVIDADE_MINUTOS(user.role)} />
      {/**
       * Conta pendente de confirmação: o aviso acompanha a pessoa pela área logada.
       *
       * Fica no layout, e não numa página, porque conta não confirmada não é impedida de entrar —
       * quem não confirmou usa o produto normalmente. Posto só no painel, bastaria a pessoa cair
       * direto numa análise para nunca ver que há algo pendente.
       *
       * ⚠️ A CONDIÇÃO É `emailVerifiedAt`, A MESMA DO GATE DE CONTRATAÇÃO — e era `status`.
       *
       * Os dois fatos divergem: a rota administrativa põe uma conta em ATIVO sem tocar na data, e
       * `redefinir-senha` também grava ATIVO. Uma conta nesse estado — ATIVO com a data nula —
       * ficava barrada ao contratar (o gate lê a data) e NÃO recebia este aviso (que lia o
       * status): a recusa da venda mandava clicar num botão que não estava em tela nenhuma.
       *
       * A divergência nasceu de um teste que afirmava que o gate usa a data e não o status,
       * enquanto o aviso continuava no status. Um fato, um lugar.
       */}
      {!user.emailVerifiedAt && <AvisoVerificarEmail email={user.email} />}
      {children}
    </AppShell>
  );
}
