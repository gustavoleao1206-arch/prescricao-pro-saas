import { prisma } from "@/lib/db";
import { PromptActivate } from "@/components/admin/prompt-activate";
import { dateBR } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminPromptsPage() {
  const prompts = await prisma.promptVersion.findMany({ orderBy: [{ kind: "asc" }, { version: "desc" }] });

  return (
    <div>
      <h1 className="mb-2 text-2xl">Prompts da IA (versões)</h1>
      <p className="mb-6 max-w-3xl text-sm text-neutro-500">
        Instruções versionadas que orientam a análise jurídica. Ativar uma versão desativa as demais do mesmo tipo. As
        alterações são auditadas. A versão ativa é usada em novas análises.
      </p>
      <div className="space-y-4">
        {prompts.map((p) => (
          <div key={p.id} className="card p-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-marinho-700">{p.kind} · v{p.version}</div>
                <div className="text-xs text-neutro-400">{p.label ?? ""} · atualizado {dateBR(p.createdAt)}</div>
              </div>
              <PromptActivate id={p.id} active={p.active} />
            </div>
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-neutro-50 p-3 text-xs text-neutro-600">{p.content.slice(0, 800)}{p.content.length > 800 ? "…" : ""}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}
