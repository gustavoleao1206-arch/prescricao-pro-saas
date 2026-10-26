import Link from "next/link";
import { Logo } from "@/components/ui/logo";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="veu-escuro flex min-h-screen flex-col">
      <header className="container-page flex h-16 items-center">
        <Link href="/"><Logo variant="light" /></Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-md">{children}</div>
      </main>
      <footer className="container-page py-6 text-center text-xs text-white/40">
        Ferramenta de apoio jurídico · Sujeita a revisão por advogado(a).
      </footer>
    </div>
  );
}
