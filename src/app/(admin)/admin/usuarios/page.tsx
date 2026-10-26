import { prisma } from "@/lib/db";
import { UserActions } from "@/components/admin/user-actions";
import { dateBR } from "@/lib/format";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminUsuariosPage() {
  // Quem está logado: a própria linha não oferece "Bloquear", para o admin não
  // se trancar fora do sistema com um clique.
  const atual = await getSessionUser();
  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { organization: { select: { name: true } } },
  });

  return (
    <div>
      <h1 className="mb-6 text-2xl">Usuários ({users.length})</h1>
      <div className="overflow-x-auto rounded-2xl border border-neutro-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-neutro-50 text-left text-xs uppercase text-neutro-400">
            <tr>
              <th className="px-4 py-3">Nome</th>
              <th className="px-4 py-3">E-mail</th>
              <th className="px-4 py-3">Perfil</th>
              <th className="px-4 py-3">Organização</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Criado</th>
              <th className="px-4 py-3">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutro-100">
            {users.map((u) => (
              <tr key={u.id} className="hover:bg-neutro-50">
                <td className="px-4 py-3 font-medium text-marinho-700">{u.name}</td>
                <td className="px-4 py-3 text-neutro-500">{u.email}</td>
                <td className="px-4 py-3"><span className="badge bg-marca-50 text-marca-700 dark:bg-marca-500/20 dark:text-marca-200">{u.role}</span></td>
                <td className="px-4 py-3 text-neutro-500">{u.organization?.name ?? "-"}</td>
                <td className="px-4 py-3">{u.status}</td>
                <td className="px-4 py-3 text-neutro-400">{dateBR(u.createdAt)}</td>
                <td className="px-4 py-3">
                  <UserActions id={u.id} status={u.status} email={u.email} ehVoceMesmo={u.id === atual?.id} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
