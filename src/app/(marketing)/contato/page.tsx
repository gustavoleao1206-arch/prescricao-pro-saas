import type { Metadata } from "next";
import { ContactForm } from "@/components/marketing/contact-form";
import { CanaisAtendimento } from "@/components/ui/canais-atendimento";
import { FORNECEDOR } from "@/lib/fornecedor";

export const metadata: Metadata = { title: "Contato e suporte" };

export default function ContatoPage() {
  return (
    <div className="container-page grid gap-10 py-16 md:grid-cols-2">
      <div>
        <span className="badge bg-marca-50 text-marca-700 dark:bg-marca-500/20 dark:text-marca-200">Fale conosco</span>
        <h1 className="mt-3 text-4xl font-bold">Contato e suporte</h1>
        <p className="mt-3 hyphens-auto text-justify text-neutro-500">
          Dúvidas comerciais, suporte técnico ou jurídico-operacional. Clientes autenticados contam com abertura de
          chamados e histórico dentro da plataforma.
        </p>
        <CanaisAtendimento className="mt-8" />

        <dl className="mt-6 space-y-4">
          <div>
            <dt className="font-semibold text-neutro-700">E-mail</dt>
            <dd className="text-neutro-500">{FORNECEDOR.email}</dd>
          </div>
          <div>
            <dt className="font-semibold text-neutro-700">Suporte a clientes</dt>
            <dd className="text-neutro-500">Abra um chamado em “Suporte” após fazer login.</dd>
          </div>
        </dl>
      </div>
      <ContactForm />
    </div>
  );
}
