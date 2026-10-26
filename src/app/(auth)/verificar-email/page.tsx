import type { Metadata } from "next";
import { VerifyEmail } from "@/components/auth/verify-email";

export const metadata: Metadata = { title: "Verificar e-mail" };

export default async function VerificarEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  return <VerifyEmail token={(await searchParams).token} />;
}
