"use client";

import { useState } from "react";
import Link from "next/link";
import { validarCpfCnpj, formatarCpfCnpj, apenasDigitos } from "@/lib/documento";

/**
 * Contratação por boleto: pede CPF/CNPJ, emite e mostra o boleto.
 *
 * Por que esta tela existe, quando cartão e PIX não precisam de nenhuma: o
 * Checkout hospedado do Asaas não emite boleto, então o boleto passa pela API de
 * Assinaturas — e ela exige um cliente com CPF/CNPJ criado antes da cobrança. O
 * papel que a página do Asaas cumpria (pedir o documento) passa a ser nosso.
 *
 * A validação dos dígitos verificadores roda AQUI, antes de enviar, e roda de novo
 * no servidor. A daqui não é segurança — é conversão: documento digitado errado
 * devolve resposta na hora, em vez de o cliente esperar a ida ao gateway para ver
 * um erro cru de provedor no meio da compra.
 *
 * O botão não fica desabilitado enquanto o documento está incompleto. Campo que
 * não explica por que o botão não funciona é pior que erro na submissão.
 */
export function ContratarBoleto({ plano, nome, preco }: { plano: string; nome: string; preco: string }) {
  const [doc, setDoc] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [emitido, setEmitido] = useState<{
    boletoUrl: string | null;
    faturaUrl: string | null;
    vencimento: string | null;
    message: string;
  } | null>(null);

  const digitos = apenasDigitos(doc);
  const documentoOk = validarCpfCnpj(doc) !== null;

  async function emitir(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    if (!documentoOk) {
      setErro(
        digitos.length < 11
          ? "Informe o CPF (11 dígitos) ou o CNPJ (14 dígitos) completo."
          : "O CPF ou CNPJ informado não é válido. Confira os números.",
      );
      return;
    }
    setEnviando(true);
    try {
      const res = await fetch("/api/assinatura/boleto", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planoSlug: plano, cpfCnpj: digitos }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErro(data.error ?? "Não foi possível emitir o boleto agora.");
        return;
      }
      setEmitido(data.data);
    } catch {
      setErro("Falha de conexão. Verifique sua internet e tente novamente.");
    } finally {
      setEnviando(false);
    }
  }

  if (emitido) {
    const link = emitido.boletoUrl ?? emitido.faturaUrl;
    return (
      <div className="mx-auto max-w-lg py-12">
        <div className="card p-8">
          <h1 className="text-xl text-marinho-700">Boleto emitido</h1>
          <p className="mt-3 text-sm text-neutro-600">{emitido.message}</p>
          {emitido.vencimento ? (
            <p className="mt-2 text-sm text-neutro-600">
              Vencimento: <strong>{dataBR(emitido.vencimento)}</strong>
            </p>
          ) : null}

          {/**
            * O aviso do prazo bancário não é enfeite. O acesso só é liberado quando o
            * banco confirma o pagamento, e isso leva de 1 a 3 dias úteis. Sem esta
            * frase, quem paga o boleto hoje acha que o sistema falhou ao não liberar
            * na hora — e abre suporte.
            */}
          <p className="mt-4 rounded-md bg-neutro-50 p-3 text-sm text-neutro-600">
            Depois do pagamento, o banco leva de 1 a 3 dias úteis para confirmar. O acesso é liberado
            automaticamente assim que a confirmação chega, e avisamos por e-mail. Se o boleto vencer sem
            pagamento, a assinatura é cancelada.
          </p>

          <div className="mt-6 flex flex-wrap gap-2">
            {link ? (
              <a href={link} target="_blank" rel="noopener noreferrer" className="btn-primary text-sm">
                Abrir o boleto
              </a>
            ) : null}
            <Link href="/assinatura" className="btn-outline text-sm">
              Ver minha assinatura
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg py-12">
      <form onSubmit={emitir} className="card p-8">
        <h1 className="text-xl text-marinho-700">Pagar com boleto</h1>
        <p className="mt-2 text-sm text-neutro-600">
          {nome} — <strong>{preco}</strong>
        </p>
        <p className="mt-4 text-sm text-neutro-600">
          O boleto é emitido no nome do titular do pagamento. Informe o CPF ou o CNPJ para gerar a cobrança.
        </p>

        <label htmlFor="cpfCnpj" className="mt-6 block text-sm font-medium text-marinho-700">
          CPF ou CNPJ
        </label>
        <input
          id="cpfCnpj"
          name="cpfCnpj"
          inputMode="numeric"
          autoComplete="off"
          // 18 = comprimento do CNPJ com máscara.
          maxLength={18}
          value={doc}
          onChange={(e) => {
            setErro(null);
            setDoc(formatarEnquantoDigita(e.target.value));
          }}
          placeholder="000.000.000-00"
          className="input mt-1 w-full"
          aria-invalid={erro ? true : undefined}
          aria-describedby={erro ? "cpfCnpj-erro" : undefined}
        />
        {erro ? (
          <p id="cpfCnpj-erro" className="mt-2 text-sm text-alerta-700">
            {erro}
          </p>
        ) : null}

        <p className="mt-4 text-xs text-neutro-500">
          A cobrança se repete a cada ciclo: um novo boleto é enviado por e-mail antes do vencimento. Se um
          boleto vencer sem pagamento, a assinatura é cancelada.
        </p>

        <div className="mt-6 flex flex-wrap gap-2">
          <button type="submit" disabled={enviando} className="btn-primary text-sm">
            {enviando ? "Emitindo…" : "Emitir boleto"}
          </button>
          <Link href="/assinatura" className="btn-ghost text-sm">
            Cancelar
          </Link>
        </div>
      </form>
    </div>
  );
}

/**
 * Máscara progressiva: só aplica quando o comprimento já identifica o tipo, para
 * não escrever pontuação de CPF em quem está digitando um CNPJ.
 */
function formatarEnquantoDigita(valor: string): string {
  const d = apenasDigitos(valor).slice(0, 14);
  if (d.length === 11 || d.length === 14) return formatarCpfCnpj(d);
  return d;
}

/** YYYY-MM-DD do Asaas para data brasileira, sem passar por fuso horário. */
function dataBR(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split("-");
  return d && m && a ? `${d}/${m}/${a}` : iso;
}
