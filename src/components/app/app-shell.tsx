"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRouter } from "next/navigation";
import { Logo } from "@/components/ui/logo";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import type { Role } from "@prisma/client";

const CLIENT_NAV = [
  { href: "/painel", label: "Painel", icon: "◆" },
  { href: "/nova-analise", label: "Nova análise", icon: "＋" },
  { href: "/analises", label: "Minhas análises", icon: "▤" },
  { href: "/creditos", label: "Créditos", icon: "◉" },
  { href: "/assinatura", label: "Assinatura", icon: "◈" },
  { href: "/suporte", label: "Suporte", icon: "✆" },
  { href: "/configuracoes", label: "Configurações", icon: "⚙" },
];

export function AppShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user: { name: string; email: string; role: Role };
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  return (
    <div className="veu-claro flex min-h-screen">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-neutro-200 bg-white lg:flex">
        <div className="flex h-16 items-center border-b border-neutro-200 px-5">
          <Link href="/painel"><Logo /></Link>
        </div>
        <nav className="flex-1 space-y-1 p-3">
          {CLIENT_NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                  active ? "bg-marinho-700 text-white" : "text-neutro-600 hover:bg-marinho-50"
                }`}
              >
                <span className="w-5 text-center">{item.icon}</span>
                {item.label}
              </Link>
            );
          })}
          {user.role === "ADMIN" && (
            <Link href="/admin" className="mt-2 flex items-center gap-3 rounded-xl border border-marca-200 px-3 py-2.5 text-sm font-medium text-marca-700 hover:bg-marca-50">
              <span className="w-5 text-center">★</span> Painel administrativo
            </Link>
          )}
        </nav>
        <div className="border-t border-neutro-200 p-3">
          <div className="truncate px-2 text-sm font-medium text-neutro-700">{user.name}</div>
          <div className="truncate px-2 text-xs text-neutro-400">{user.email}</div>
          <button onClick={logout} className="btn-ghost mt-2 w-full justify-start text-sm">Sair</button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center justify-between border-b border-neutro-200 bg-white px-4 lg:px-8">
          <div className="lg:hidden"><Logo /></div>
          <div className="ml-auto flex items-center gap-3">
            <ThemeToggle />
            <button onClick={logout} className="btn-ghost text-sm lg:hidden">Sair</button>
          </div>
        </header>
        <main className="flex-1 p-4 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
