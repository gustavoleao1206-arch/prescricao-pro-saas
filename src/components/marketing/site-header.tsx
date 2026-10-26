import Link from "next/link";
import { Logo } from "@/components/ui/logo";
import { ThemeToggle } from "@/components/ui/theme-toggle";

const NAV = [
  { href: "/como-funciona", label: "Como funciona" },
  { href: "/planos", label: "Planos" },
  { href: "/faq", label: "Perguntas frequentes" },
  { href: "/contato", label: "Contato" },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-neutro-200 bg-superficie/90 backdrop-blur">
      <div className="container-page flex h-16 items-center justify-between">
        <Link href="/" aria-label="Página inicial">
          <Logo />
        </Link>
        <nav className="hidden items-center gap-6 md:flex" aria-label="Principal">
          {NAV.map((item) => (
            <Link key={item.href} href={item.href} className="text-sm font-medium text-neutro-600 hover:text-marinho-700">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link href="/login" className="btn-ghost hidden sm:inline-flex">
            Entrar
          </Link>
          <Link href="/planos" className="btn-primary">
            Comprar acesso
          </Link>
        </div>
      </div>
    </header>
  );
}
