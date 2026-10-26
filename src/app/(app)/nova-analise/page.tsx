import { redirect } from "next/navigation";
import Link from "next/link";
import { getAppContext } from "@/lib/tenant";
import { isAiConfigured } from "@/lib/ai/provider";
import { AutoAnalysis } from "@/components/app/auto-analysis";

export const dynamic = "force-dynamic";

/**
 * Nova análise, fluxo automático: o cliente anexa a cópia do processo e o
 * servidor cuida do resto (leitura do documento, identificação, motor jurídico,
 * relatório e minuta). O preenchimento manual continua disponível em
 * /nova-analise/manual, para PDFs digitalizados e ajustes finos.
 */
export default async function NovaAnalisePage() {
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
      <h1 className="mb-2 text-2xl">Nova análise</h1>
      <p className="mb-6 text-sm text-neutro-500">
        Escolha a matéria, anexe o processo e receba a conclusão fundamentada.
      </p>

      {!isAiConfigured() && (
        <div className="mx-auto mb-6 max-w-2xl rounded-xl border border-atencao-100 bg-atencao-50 p-4 text-sm text-atencao">
          <strong>Modo heurístico.</strong> A chave de IA não está configurada, então a análise sai
          apenas dos cálculos determinísticos sobre as datas que o sistema conseguir ler do documento.
          A leitura completa do processo depende da IA.
        </div>
      )}

      <AutoAnalysis />
    </div>
  );
}
