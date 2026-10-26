import { redirect } from "next/navigation";
import Link from "next/link";
import { getAppContext } from "@/lib/tenant";
import { NewAnalysisWizard } from "@/components/app/new-analysis-wizard";

export const dynamic = "force-dynamic";

/**
 * Preenchimento manual, mantido para os casos em que o automático não dá conta:
 * PDF digitalizado sem camada de texto, processo físico, ou quando o(a)
 * advogado(a) quer informar as datas conferidas em vez das lidas do arquivo.
 */
export default async function NovaAnaliseManualPage() {
  const ctx = await getAppContext();
  if (!ctx) redirect("/login");

  if (ctx.user.role === "CLIENTE" && !ctx.access.hasAccess) {
    return (
      <div className="mx-auto max-w-xl">
        <div className="card p-8 text-center">
          <h1 className="text-2xl">Acesso indisponível</h1>
          <p className="mt-3 text-sm text-neutro-600">{ctx.access.message}</p>
          <Link href="/assinatura" className="btn-primary mt-6 inline-flex">Ver minha assinatura</Link>
        </div>
      </div>
    );
  }

  if (!ctx.quota.allowed) {
    return (
      <div className="mx-auto max-w-xl">
        <div className="card p-8 text-center">
          <h1 className="text-2xl">Limite atingido</h1>
          <p className="mt-3 text-sm text-neutro-600">
            Você atingiu o limite de análises do seu plano neste período.
          </p>
          <Link href="/assinatura" className="btn-primary mt-6 inline-flex">Ver minha assinatura</Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <Link href="/nova-analise" className="text-sm text-neutro-500 hover:text-marca-600">← Voltar para a análise automática</Link>
        <h1 className="mt-2 text-2xl">Nova análise: preenchimento manual</h1>
      </div>
      <NewAnalysisWizard />
      {/*
        O link para um agente de IA externo, hospedado em serviço de terceiro, foi REMOVIDO, por decisão do dono.
        Ele criava um caminho em que o cliente levava cópia de execução fiscal — com
        dados de terceiros sob sigilo profissional — para fora da plataforma: fora do
        armazenamento privado, fora da trilha de auditoria e fora do contrato de
        operador que a Política de Privacidade descreve. O aviso que acompanhava o
        link transferia ao usuário uma avaliação de sigilo que o produto não deveria
        propor, e era o único ponto do sistema em que o conteúdo saía sem passar pelo
        nosso tratamento. Não recolocar.
      */}
    </div>
  );
}
