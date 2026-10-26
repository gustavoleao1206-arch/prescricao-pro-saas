import { prisma } from "@/lib/db";
import { dateBR } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminBaseConhecimentoPage() {
  const docs = await prisma.knowledgeDocument.findMany({ orderBy: [{ category: "asc" }, { title: "asc" }] });

  return (
    <div>
      <h1 className="mb-2 text-2xl">Base de conhecimento</h1>
      <p className="mb-6 max-w-3xl text-sm text-neutro-500">
        Documentos jurídicos de referência (CTN, LEF, súmulas, temas, modelos). Cada documento tem categoria, versão,
        status e origem, com histórico de revisões. A inclusão/edição de arquivos é feita por rotas administrativas
        (upload privado), ver documentação.
      </p>
      <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400">
            <tr><th className="px-4 py-3">Título</th><th className="px-4 py-3">Categoria</th><th className="px-4 py-3">Tema</th><th className="px-4 py-3">Versão</th><th className="px-4 py-3">Ativo</th><th className="px-4 py-3">Atualizado</th></tr>
          </thead>
          <tbody className="divide-y divide-neutro-100">
            {docs.map((d) => (
              <tr key={d.id}>
                <td className="px-4 py-3 font-medium text-marinho-700">{d.title}</td>
                <td className="px-4 py-3 text-neutro-500">{d.category}</td>
                <td className="px-4 py-3 text-neutro-500">{d.theme ?? "-"}</td>
                <td className="px-4 py-3">{d.version}</td>
                <td className="px-4 py-3">{d.active ? "Sim" : "Não"}</td>
                <td className="px-4 py-3 text-neutro-400">{dateBR(d.updatedAt)}</td>
              </tr>
            ))}
            {docs.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-neutro-500">Nenhum documento cadastrado.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
