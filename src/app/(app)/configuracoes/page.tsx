import { redirect } from "next/navigation";
import { getAppContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { AccountActions } from "@/components/app/account-actions";
import { ChangePasswordForm } from "@/components/app/change-password-form";
import { TwoFactorSetup } from "@/components/app/twofactor-setup";
import { TrocarEmailForm } from "@/components/app/trocar-email-form";

export const dynamic = "force-dynamic";

export default async function ConfiguracoesPage() {
  const ctx = await getAppContext();
  if (!ctx) redirect("/login");

  const conta = await prisma.user.findUnique({
    where: { id: ctx.user.id },
    select: { twoFactorEnabled: true, pendingEmail: true, emailVerifiedAt: true },
  });

  /**
   * ⚠️ O LINK DA TROCA PENDENTE AINDA ESTÁ VIVO? A tela precisa saber, e não sabia.
   *
   * `pendingEmail` fica gravado até a confirmação, o cancelamento ou um pedido novo — mas o LINK
   * vale só 1 hora. Passada a hora, a conta continuava com endereço pendente e a tela seguia
   * dizendo "confirme pelo link enviado a esse endereço": promessa de um link que não funciona mais.
   * Quem obedecia procurava o e-mail, clicava, recebia recusa e ficava sem entender o que fazer —
   * e a saída real (pedir de novo, ou cancelar) não estava escrita em lugar nenhum.
   *
   * A pergunta é respondida no servidor de propósito: a tela não pode depender do relógio de quem
   * navega para decidir se promete o link ou não.
   */
  const linkDaTroca = conta?.pendingEmail
    ? await prisma.authToken.findFirst({
        where: {
          userId: ctx.user.id,
          type: "TROCA_EMAIL",
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: "desc" },
        select: { expiresAt: true },
      })
    : null;

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl">Configurações da conta</h1>

      <section className="card p-6">
        <h2 className="mb-4 text-lg">Dados da conta</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Row k="Nome" v={ctx.user.name} />
          {/**
           * O estado da confirmação aparece junto do endereço. Sem isso, quem foi barrado ao
           * tentar contratar por e-mail não confirmado não tem onde descobrir que é esse o
           * problema — a recusa fala do e-mail, e a tela da conta não dizia nada sobre ele.
           */}
          <Row
            k="E-mail"
            v={`${ctx.user.email}${conta?.emailVerifiedAt ? "" : " (não confirmado)"}`}
          />
          <Row k="Perfil" v={ctx.user.role} />
          <Row k="Organização" v={ctx.organization?.name ?? "-"} />
        </dl>
      </section>

      <section className="card p-6">
        <h2 className="mb-3 text-lg">Alterar senha</h2>
        <ChangePasswordForm />
      </section>

      <section className="card p-6">
        <h2 className="mb-3 text-lg">Trocar o e-mail da conta</h2>
        <TrocarEmailForm
          emailAtual={ctx.user.email}
          pendente={conta?.pendingEmail ?? null}
          linkExpiraEm={linkDaTroca?.expiresAt.toISOString() ?? null}
        />
      </section>

      <section className="card p-6">
        <h2 className="mb-2 text-lg">Privacidade e dados (LGPD)</h2>
        <p className="mb-4 text-sm text-neutro-500">
          Você pode redefinir a senha por e-mail, exportar seus dados ou solicitar a exclusão da conta.
        </p>
        <AccountActions email={ctx.user.email} />
      </section>

      <section className="card p-6">
        <h2 className="mb-2 text-lg">Autenticação em dois fatores (2FA)</h2>
        <TwoFactorSetup enabled={Boolean(conta?.twoFactorEnabled)} />
      </section>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs uppercase text-neutro-400">{k}</dt>
      <dd className="font-medium text-neutro-700">{v}</dd>
    </div>
  );
}
