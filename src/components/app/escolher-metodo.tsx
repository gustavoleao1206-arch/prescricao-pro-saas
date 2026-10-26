import Link from "next/link";

/**
 * Escolha do meio de pagamento, depois de o cliente já ter escolhido o plano.
 *
 * Antes, a página de planos oferecia as três formas lado a lado no cartão do
 * plano, e o cliente decidia plano e forma de pagar no mesmo clique. O dono
 * pediu um botão só, "Assinar", com a forma de pagamento no passo seguinte —
 * que é onde ela cabe: aqui há espaço para dizer o que cada uma faz sem espremer
 * o cartão de venda.
 *
 * As três diferenças NÃO são cosméticas, e é por isso que cada opção carrega a
 * sua consequência escrita:
 *   - cartão: vira assinatura no gateway e cobra sozinho a cada ciclo;
 *   - boleto: também renova, mas o acesso só entra quando o banco confirma
 *     (1 a 3 dias úteis), e boleto vencido cancela a assinatura;
 *   - PIX: cobrança única, SEM renovação — o acesso vale um ciclo e encerra.
 * Apresentar as três como equivalentes prometeria renovação que o PIX não tem e
 * liberação imediata que o boleto não dá.
 */
export function EscolherMetodo({
  plano,
  nome,
  preco,
  anual,
}: {
  plano: string;
  nome: string;
  preco: string;
  anual: boolean;
}) {
  const formas = [
    {
      metodo: "cartao",
      rotulo: "Cartão",
      resumo: "Renova sozinho",
      detalhe: `Vira assinatura e é cobrado automaticamente a cada ${anual ? "ano" : "mês"}. O acesso é liberado na hora.`,
      fundo: "linear-gradient(135deg,#4f7cff 0%,#26d5ee 100%)",
    },
    {
      metodo: "boleto",
      rotulo: "Boleto",
      resumo: "1 a 3 dias úteis",
      detalhe:
        "Também renova a cada ciclo, mas o acesso só entra quando o banco confirma o pagamento. Pedimos o CPF ou CNPJ antes de emitir.",
      fundo: "linear-gradient(135deg,#ff9f1c 0%,#ffd166 100%)",
    },
    {
      metodo: "pix",
      rotulo: "PIX",
      resumo: "Pagamento único",
      detalhe: `Acesso liberado na hora, sem renovação automática: vale ${anual ? "um ano" : "um mês"} e encerra. Para continuar, é preciso pagar de novo.`,
      fundo: "linear-gradient(135deg,#00c39a 0%,#4ce0b3 100%)",
    },
  ];

  return (
    <div className="container-page py-12">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl">Como você quer pagar?</h1>
        <p className="mt-2 text-sm text-neutro-600">
          Plano <strong>{nome}</strong>, {preco} {anual ? "por ano" : "por mês"}. Escolha a forma de
          pagamento para concluir a assinatura.
        </p>

        <div className="mt-8 space-y-3">
          {formas.map((forma) => (
            <Link
              key={forma.metodo}
              href={`/assinatura/contratar?plano=${encodeURIComponent(plano)}&metodo=${forma.metodo}`}
              prefetch={false}
              className="card flex items-center gap-4 p-4 transition hover:border-marca-400 hover:shadow-elevada sm:gap-5 sm:p-5"
            >
              {/*
                O bloco colorido identifica a forma de pagamento de relance. Texto em
                azul-noite fixo: o fundo é vivo nos dois temas, e seguir a rampa neutra
                faria o rótulo clarear e sumir sobre o amarelo e o verde no tema escuro.
              */}
              <span
                className="flex h-16 w-24 shrink-0 items-center justify-center rounded-xl text-center font-display text-base font-bold text-[#04122e] shadow-card"
                style={{ backgroundImage: forma.fundo }}
              >
                {forma.rotulo}
              </span>
              {/*
                O título ao lado é a CONSEQUÊNCIA, não o nome do meio de pagamento:
                o nome já está no bloco colorido, e repeti-lo gastava a linha mais
                visível da opção dizendo o que o cliente acabou de ler.
              */}
              <span className="min-w-0">
                <span className="block font-display text-base font-semibold text-marinho-700">
                  {forma.resumo}
                </span>
                <span className="mt-0.5 block text-sm text-neutro-600">{forma.detalhe}</span>
              </span>
            </Link>
          ))}
        </div>

        <p className="mt-6 text-sm text-neutro-500">
          Pagamento processado em ambiente seguro.{" "}
          <Link href="/planos" className="underline">
            Voltar aos planos
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
