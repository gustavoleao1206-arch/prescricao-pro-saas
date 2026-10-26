import { prisma } from "@/lib/db";
import { dateTimeBR } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AdminConteudoPage() {
  const blocks = await prisma.contentBlock.findMany({ orderBy: { slug: "asc" } });

  return (
    <div>
      <h1 className="mb-2 text-2xl">Conteúdo do site</h1>
      <p className="mb-6 max-w-3xl text-sm text-neutro-500">
        Blocos editáveis (home, FAQ, planos, avisos, modelos de e-mail) armazenados como pares slug/JSON. A edição por
        formulário é uma extensão prevista; hoje os blocos são versionáveis via API administrativa.
      </p>
      <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400">
            <tr><th className="px-4 py-3">Slug</th><th className="px-4 py-3">Locale</th><th className="px-4 py-3">Atualizado</th></tr>
          </thead>
          <tbody className="divide-y divide-neutro-100">
            {blocks.map((b) => (
              <tr key={b.id}>
                <td className="px-4 py-3 font-mono text-xs text-marinho-700">{b.slug}</td>
                <td className="px-4 py-3 text-neutro-500">{b.locale}</td>
                <td className="px-4 py-3 text-neutro-400">{dateTimeBR(b.updatedAt)}</td>
              </tr>
            ))}
            {blocks.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-neutro-500">Nenhum bloco. Execute o seed.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
