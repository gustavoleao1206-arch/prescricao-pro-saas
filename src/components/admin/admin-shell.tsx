"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Logo } from "@/components/ui/logo";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const NAV = [
  { href: "/admin", label: "Visão geral" },
  { href: "/admin/usuarios", label: "Usuários" },
  { href: "/admin/assinaturas", label: "Assinaturas" },
  { href: "/admin/planos", label: "Planos" },
  { href: "/admin/custos", label: "Custos e receita" },
  { href: "/admin/analises", label: "Análises" },
  { href: "/admin/base-conhecimento", label: "Base de conhecimento" },
  { href: "/admin/prompts", label: "Prompts (IA)" },
  { href: "/admin/conteudo", label: "Conteúdo do site" },
  { href: "/admin/suporte", label: "Suporte" },
  { href: "/admin/logs", label: "Logs e auditoria" },
];

export function AdminShell({ children, name }: { children: React.ReactNode; name: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
  }

  return (
    <div className="veu-claro flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-neutro-200 bg-marinho-800 lg:flex">
        <div className="flex h-16 items-center border-b border-white/10 px-5">
          <Logo variant="light" />
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {NAV.map((item) => {
            const active = pathname === item.href || (item.href !== "/admin" && pathname.startsWith(item.href));
            return (
              <Link key={item.href} href={item.href} className={`block rounded-lg px-3 py-2 text-sm font-medium ${active ? "grad-marca text-[#04122E]" : "text-marinho-100 hover:bg-white/10"}`}>
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-white/10 p-3 text-marinho-100">
          <div className="flex items-center justify-between gap-2 px-2">
            <div className="min-w-0">
              <div className="truncate text-sm">{name}</div>
              <div className="text-xs text-marinho-300">Administrador</div>
            </div>
            <ThemeToggle className="border-white/15 text-marinho-100" />
          </div>
          <div className="mt-2 flex gap-2 px-2">
            <Link href="/painel" className="text-xs text-marca-300 hover:underline">Área do cliente</Link>
            <button onClick={logout} className="text-xs text-marinho-200 hover:underline">Sair</button>
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 lg:p-8">{children}</main>
    </div>
  );
}
