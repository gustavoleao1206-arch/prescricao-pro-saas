import type { Metadata } from "next";
import { ConfirmarTrocaEmail } from "@/components/auth/confirmar-troca-email";

export const metadata: Metadata = { title: "Confirmar troca de e-mail" };

/**
 * Destino do link enviado ao endereço NOVO.
 *
 * Fica em `(auth)`, fora da área logada, porque o link é aberto na caixa do endereço novo — em
 * geral no celular e sem sessão. E o e-mail antigo, que é o login, pode ser exatamente o que
 * está errado: exigir entrada aqui trancaria a pessoa fora do conserto que ela está fazendo.
 */
export default async function ConfirmarTrocaEmailPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  return <ConfirmarTrocaEmail token={(await searchParams).token} />;
}
