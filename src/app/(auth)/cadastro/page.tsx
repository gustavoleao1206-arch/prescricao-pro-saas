import type { Metadata } from "next";
import { RegisterForm } from "@/components/auth/register-form";

export const metadata: Metadata = { title: "Criar conta" };

export default async function CadastroPage({ searchParams }: { searchParams: Promise<{ plano?: string }> }) {
  return <RegisterForm plano={(await searchParams).plano} />;
}
