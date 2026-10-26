import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getSessionUser } from "@/lib/auth";
import { LoginScreen } from "@/components/auth/login-screen";
import { Logo } from "@/components/ui/logo";

/**
 * Tela de login.
 *
 * A página principal (/) passou a ser a vitrine comercial; o acesso à conta vive
 * aqui, dentro do layout de autenticação (fundo institucional escuro). Antes
 * disto o /login apenas redirecionava para /, e como / deixou de conter o
 * formulário, ninguém conseguiria entrar, este arquivo fecha esse buraco.
 *
 * O card é de vidro sobre fundo escuro (não a classe `card`, que é clara): os
 * campos do LoginScreen têm texto branco e sumiriam numa superfície clara.
 */
export const metadata: Metadata = {
  title: "Entrar",
  robots: { index: false, follow: false },
};
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams: searchParamsAsync,
}: {
  searchParams: Promise<{ next?: string; motivo?: string }>;
}) {
  const searchParams = await searchParamsAsync;
  /**
   * `next` é validado ANTES do redirecionamento de quem já está autenticado.
   *
   * Só caminho interno é aceito, senão isto viraria redirecionamento aberto:
   * bastaria mandar `?next=https://site-falso` para usar o nosso domínio como
   * trampolim numa fraude.
   *
   * A recusa de `//` não é detalhe: `//site-falso.com` também começa com "/", mas é
   * URL protocolo-relativa e o navegador a trata como endereço EXTERNO. Exigir só
   * o "/" inicial deixaria o buraco aberto.
   */
  const bruto = typeof searchParams.next === "string" ? searchParams.next : "";
  const next = bruto.startsWith("/") && !bruto.startsWith("//") ? bruto : undefined;

  /**
   * Já autenticado vai direto ao destino — respeitando o `next`.
   *
   * Ignorar o `next` aqui quebrava justamente o caminho de quem acabou de se
   * cadastrar: a pessoa confirma o e-mail, volta ao login já com sessão válida e
   * era despejada no painel, perdendo o plano que havia escolhido.
   */
  const user = await getSessionUser();
  if (user) redirect(next ?? (user.role === "ADMIN" ? "/admin" : "/painel"));

  return (
    <section className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/[0.04] p-8 shadow-[0_24px_70px_-20px_rgba(0,0,0,0.7)] backdrop-blur-xl">
      <h1 className="sr-only">Entrar</h1>
      <div className="mb-8 flex justify-center">
        <Logo variant="light" className="h-16" />
      </div>
      {/**
       * Por que a sessão caiu, dito em uma frase.
       *
       * Sem isto, quem volta a esta tela depois do encerramento por inatividade não tem como
       * saber se foi expulso, se a senha venceu ou se o sistema quebrou — e a leitura natural
       * de um logout sem explicação é a terceira. A frase também diz que nada foi perdido,
       * porque a preocupação imediata de quem estava no meio de uma análise é essa.
       *
       * ⚠️ SEM o número de minutos, de propósito. O prazo depende do papel (administrador tem
       * o curto) e aqui não existe mais sessão para consultar o papel: quem chega nesta tela
       * acabou de ser desconectado. Dizer "30 minutos" a um administrador desconectado em 10
       * seria informação errada; buscar o número na URL seria pior, porque a URL é digitável
       * por qualquer um e a frase passaria a afirmar o que o visitante quisesse.
       */}
      {searchParams.motivo === "inatividade" && (
        <p className="mx-auto mb-4 max-w-sm rounded-xl border border-white/15 bg-white/10 p-3 text-center text-sm text-white/80">
          Sua sessão foi encerrada por inatividade, por segurança. Entre novamente para
          continuar — nada do seu trabalho foi perdido.
        </p>
      )}
      {/**
       * ⚠️ Motivo NEUTRO, e é por não saber qual dos três casos foi.
       *
       * Este aviso vem dos layouts, que só sabem uma coisa: existia cookie e a sessão não vale
       * mais. Pode ter sido inatividade, revogação por troca de papel ou bloqueio da conta.
       * Escrever "inatividade" aqui seria informação errada em dois dos três — e informação
       * errada numa tela de acesso manda a pessoa procurar o problema no lugar errado.
       *
       * O que a frase afirma é o que vale nos três, mais a parte que a pessoa quer saber
       * primeiro: que o trabalho dela está onde estava.
       */}
      {searchParams.motivo === "sessao-encerrada" && (
        <p className="mx-auto mb-4 max-w-sm rounded-xl border border-white/15 bg-white/10 p-3 text-center text-sm text-white/80">
          Sua sessão foi encerrada. Entre novamente para continuar — nada do seu trabalho foi
          perdido.
        </p>
      )}
      <LoginScreen next={next} />
      <p className="mt-6 text-center text-xs text-white/45">
        Ainda não tem conta?{" "}
        <a href="/planos" className="font-medium text-white/75 underline transition hover:text-white">
          Conheça os planos
        </a>
      </p>
    </section>
  );
}
