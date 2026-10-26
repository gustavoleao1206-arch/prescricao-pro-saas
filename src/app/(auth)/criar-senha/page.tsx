import type { Metadata } from "next";
import { ResetForm } from "@/components/auth/reset-form";

export const metadata: Metadata = { title: "Criar senha" };

export default async function CriarSenhaPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  return <ResetForm token={(await searchParams).token} mode="create" />;
}
