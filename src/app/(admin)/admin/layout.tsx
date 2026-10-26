import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSessionUser, INATIVIDADE_MINUTOS, NOME_DO_COOKIE_DE_SESSAO } from "@/lib/auth";
import { AdminShell } from "@/components/admin/admin-shell";
import { EncerrarPorInatividade } from "@/components/app/encerrar-por-inatividade";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();
  if (!user) {
    // Mesma distinção da área do cliente: sessão que existiu e acabou merece explicação.
    // Aqui vale ainda mais, porque o prazo da equipe é o curto — 10 minutos.
    const sessaoExistia = (await cookies()).has(NOME_DO_COOKIE_DE_SESSAO);
    redirect(sessaoExistia ? "/login?motivo=sessao-encerrada&next=/admin" : "/login?next=/admin");
  }
  if (user.role !== "ADMIN") redirect("/painel");

  return (
    <AdminShell name={user.name}>
      {/**
       * ⚠️ O relógio de inatividade PRECISA estar aqui também, e a falta dele era um defeito
       * criado pela própria mudança que encurtou o prazo do administrador.
       *
       * O painel administrativo tem layout PRÓPRIO — não passa por `(app)/layout.tsx`. Com o
       * componente montado só lá, o servidor encerrava a sessão do admin em 10 minutos e a
       * tela dele não fazia nada, o que produzia as duas piores consequências ao mesmo tempo:
       *
       *  1. A tela seguia aberta com e-mail de cliente, valores, e a trilha de auditoria à
       *     mostra, com a sessão já morta no servidor. É exatamente o risco que o
       *     encerramento por inatividade existe para tratar, ausente na tela mais
       *     privilegiada do sistema.
       *  2. Sem o ping de atividade, o `lastSeenAt` só avançava em navegação. Ler a auditoria
       *     ou preencher a liberação manual por dez minutos sem trocar de página derrubava a
       *     sessão de quem estava trabalhando — e num limite de 10 minutos isso não é caso de
       *     borda, é o uso normal.
       *
       * A lição: guarda montada em layout vale só para a árvore daquele layout. Área
       * autenticada nova precisa montar esta também.
       */}
      <EncerrarPorInatividade minutos={INATIVIDADE_MINUTOS(user.role)} />
      {children}
    </AdminShell>
  );
}
