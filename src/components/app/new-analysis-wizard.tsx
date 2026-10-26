"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { materiaPorTipo } from "@/lib/ai/materias";
import { durante } from "@/lib/operacao-em-andamento";

type Facts = Record<string, string | boolean>;
type Ident = Record<string, string>;

const TYPES = [
  { v: "PRESCRICAO", l: "Prescrição ordinária" },
  { v: "PRESCRICAO_INTERCORRENTE", l: "Prescrição intercorrente (art. 40 LEF)" },
  { v: "DECADENCIA", l: "Decadência" },
  { v: "EXECUCAO_FISCAL_COMPLETA", l: "Execução fiscal (completa)" },
  { v: "NULIDADES", l: "Nulidades" },
  { v: "GERAL", l: "Análise geral" },
];

const STEPS = ["Identificação", "Datas e fatos", "Documentos", "Confirmação"];

/**
 * Orçamento devolvido pelo servidor — espelha `orcamentoParaJson`, em
 * src/lib/orcamento.ts. Mesmo contrato que a análise automática consome.
 */
interface Orcamento {
  paginas: number;
  arquivos: number;
  megabytes: string;
  creditos: number;
  aCobrar: number;
  jaCobrados: number;
  bloqueado: boolean;
  motivoBloqueio: string | null;
  faixa: string | null;
  ilimitado: boolean;
  saldoAtual: number | null;
  saldoApos: number | null;
  podeIniciar: boolean;
  mensagem: string;
}

export function NewAnalysisWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [ident, setIdent] = useState<Ident>({ type: "PRESCRICAO_INTERCORRENTE" });
  const [facts, setFacts] = useState<Facts>({});
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [files, setFiles] = useState<{ id: string; filename: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [orcamento, setOrcamento] = useState<Orcamento | null>(null);
  const [orcamentoErro, setOrcamentoErro] = useState<string | null>(null);

  /**
   * Custo REAL, buscado no servidor antes da confirmação.
   *
   * Esta tela anunciava "Consumo estimado: 1 análise do seu plano", escrito à mão. O
   * custo é por FAIXA DE PÁGINAS e vai a 4 créditos num processo de mil páginas: quem
   * enviava um processo grande pelo preenchimento manual lia "1", confirmava, e via
   * quatro créditos saírem. A Política de Créditos publica que o custo é informado
   * ANTES da confirmação — era promessa quebrada, não só texto impreciso.
   *
   * O número vem do mesmo endpoint que a análise automática usa, então as duas telas
   * não podem divergir.
   */
  async function carregarOrcamento(id: string) {
    setOrcamento(null);
    setOrcamentoErro(null);
    try {
      const res = await fetch(`/api/analises/${id}/orcamento`);
      const data = await res.json();
      if (res.ok && data.ok) setOrcamento(data.data as Orcamento);
      else setOrcamentoErro(data.error ?? "Não foi possível calcular o custo desta análise.");
    } catch {
      setOrcamentoErro("Não foi possível calcular o custo desta análise.");
    }
  }

  function irParaConfirmacao() {
    setStep(3);
    if (analysisId) void carregarOrcamento(analysisId);
  }

  const setI = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setIdent((s) => ({ ...s, [k]: e.target.value }));
  const setF = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setFacts((s) => ({ ...s, [k]: e.target.value }));
  const setFB = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setFacts((s) => ({ ...s, [k]: e.target.checked }));

  async function createAnalysis() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/analises", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identification: {
          ...ident,
          approxValue: ident.approxValue ? Number(ident.approxValue) : undefined,
        },
        facts,
      }),
    });
    const data = await res.json();
    setBusy(false);
    if (res.ok && data.ok) {
      setAnalysisId(data.data.id);
      setStep(2);
    } else {
      setError(data.error ?? "Não foi possível criar a análise.");
    }
  }

  async function uploadFiles(list: FileList | null) {
    if (!list || !analysisId) return;
    setError(null);
    /**
     * ⚠️ O envio inteiro roda dentro de `durante`, e isso não é detalhe.
     *
     * Subir documento não gera clique, tecla nem rolagem — a pessoa escolhe o arquivo, manda,
     * e espera. Um PDF de execução fiscal com centenas de páginas em conexão comum leva
     * minutos, e o encerramento por inatividade navegava para o login NO MEIO: a requisição
     * em voo morria com a navegação e o documento se perdia. `durante` avisa o relógio de que
     * há operação do navegador em curso, e o `finally` dele solta o aviso em qualquer
     * desfecho — inclusive quando um arquivo falha no meio da lista.
     *
     * Envolve o LAÇO todo, não cada arquivo: entre um arquivo e o outro também não há
     * interação, e a janela entre eles bastaria para o relógio disparar.
     */
    await durante(async () => {
      for (const file of Array.from(list)) {
        const fd = new FormData();
        fd.append("analysisId", analysisId);
        fd.append("file", file);
        const res = await fetch("/api/documentos", { method: "POST", body: fd });
        const data = await res.json();
        if (res.ok && data.ok) setFiles((f) => [...f, { id: data.data.id, filename: data.data.filename }]);
        else setError(`${file.name}: ${data.error ?? "falha no envio"}`);
      }
    });
  }

  async function confirmAndProcess() {
    if (!analysisId) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/analises/${analysisId}/processar`, { method: "POST" });
    const data = await res.json();
    setBusy(false);
    if (res.ok && data.ok) {
      router.push(`/analises/${analysisId}`);
    } else {
      setError(data.error ?? "Falha ao iniciar o processamento.");
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <ol className="mb-8 flex items-center gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2">
            <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${i <= step ? "bg-marinho-700 text-white" : "bg-neutro-200 text-neutro-500"}`}>{i + 1}</span>
            <span className={`hidden sm:inline ${i === step ? "font-semibold text-marinho-700" : "text-neutro-400"}`}>{s}</span>
            {i < STEPS.length - 1 && <span className="h-px flex-1 bg-neutro-200" />}
          </li>
        ))}
      </ol>

      {error && <p className="mb-4 rounded-lg bg-alerta-50 px-3 py-2 text-sm text-alerta-700">{error}</p>}

      {/* Etapa 1, Identificação */}
      {step === 0 && (
        <div className="card space-y-4 p-6">
          <h2 className="text-lg">Identificação da análise</h2>
          <Field label="Título *"><input className="input" value={ident.title ?? ""} onChange={setI("title")} required /></Field>
          <Field label="Tipo de análise">
            <select className="input" value={ident.type} onChange={setI("type")}>
              {TYPES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
            </select>
          </Field>
          <Field label="Objetivo"><textarea className="input" rows={2} value={ident.objective ?? ""} onChange={setI("objective")} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Número do processo"><input className="input" value={ident.processNumber ?? ""} onChange={setI("processNumber")} /></Field>
            <Field label="Tribunal"><input className="input" value={ident.court ?? ""} onChange={setI("court")} /></Field>
            <Field label="Seção/Comarca"><input className="input" value={ident.jurisdiction ?? ""} onChange={setI("jurisdiction")} /></Field>
            <Field label="Vara"><input className="input" value={ident.courtDivision ?? ""} onChange={setI("courtDivision")} /></Field>
            <Field label="Exequente"><input className="input" value={ident.creditor ?? ""} onChange={setI("creditor")} /></Field>
            <Field label="Executado"><input className="input" value={ident.debtor ?? ""} onChange={setI("debtor")} /></Field>
            <Field label="CPF/CNPJ do executado"><input className="input" value={ident.debtorDocument ?? ""} onChange={setI("debtorDocument")} /></Field>
            <Field label="Tributo"><input className="input" value={ident.taxType ?? ""} onChange={setI("taxType")} /></Field>
            <Field label="Ente público"><input className="input" value={ident.publicEntity ?? ""} onChange={setI("publicEntity")} /></Field>
            <Field label="Nº da CDA"><input className="input" value={ident.cdaNumber ?? ""} onChange={setI("cdaNumber")} /></Field>
            <Field label="Nº inscrição dívida ativa"><input className="input" value={ident.dividaAtivaNumber ?? ""} onChange={setI("dividaAtivaNumber")} /></Field>
            <Field label="Valor aproximado (R$)"><input className="input" type="number" value={ident.approxValue ?? ""} onChange={setI("approxValue")} /></Field>
          </div>
          <div className="flex justify-end">
            <button className="btn-primary" disabled={!ident.title} onClick={() => setStep(1)}>Continuar</button>
          </div>
        </div>
      )}

      {/* Etapa 2, Datas e fatos */}
      {step === 1 && (
        <div className="card space-y-4 p-6">
          <h2 className="text-lg">Datas e informações processuais</h2>
          <p className="text-sm text-neutro-500">Opcional, pode ser extraído dos documentos. Preencha o que souber (datas em DD/MM/AAAA ou AAAA-MM-DD).</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Fato gerador"><input className="input" value={str(facts.dataFatoGerador)} onChange={setF("dataFatoGerador")} /></Field>
            <Field label="Constituição definitiva"><input className="input" value={str(facts.dataConstituicaoDefinitiva)} onChange={setF("dataConstituicaoDefinitiva")} /></Field>
            <Field label="Notificação"><input className="input" value={str(facts.dataNotificacao)} onChange={setF("dataNotificacao")} /></Field>
            <Field label="Inscrição em dívida ativa"><input className="input" value={str(facts.dataInscricaoDividaAtiva)} onChange={setF("dataInscricaoDividaAtiva")} /></Field>
            <Field label="Ajuizamento"><input className="input" value={str(facts.dataAjuizamento)} onChange={setF("dataAjuizamento")} /></Field>
            <Field label="Despacho citatório"><input className="input" value={str(facts.dataDespachoCitatorio)} onChange={setF("dataDespachoCitatorio")} /></Field>
            <Field label="Citação"><input className="input" value={str(facts.dataCitacao)} onChange={setF("dataCitacao")} /></Field>
            <Field label="Modalidade da citação"><input className="input" value={str(facts.modalidadeCitacao)} onChange={setF("modalidadeCitacao")} /></Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Check label="Possui parcelamento" checked={!!facts.possuiParcelamento} onChange={setFB("possuiParcelamento")} />
            <Check label="Possui penhora" checked={!!facts.possuiPenhora} onChange={setFB("possuiPenhora")} />
            <Check label="Possui suspensão" checked={!!facts.possuiSuspensao} onChange={setFB("possuiSuspensao")} />
            <Check label="Possui arquivamento" checked={!!facts.possuiArquivamento} onChange={setFB("possuiArquivamento")} />
          </div>

          {/*
            O bloco de redirecionamento só aparece nos tipos que de fato o usam.
            Nos três tipos DIRIGIDOS a uma matéria (prescrição ordinária,
            intercorrente e decadência) o resultado é reconstruído com uma única
            linha e o cálculo do redirecionamento é descartado — o formulário pedia
            data de citação da PJ, dissolução irregular e inércia da Fazenda para
            jogar fora. Além de fazer o usuário trabalhar de graça, é coleta de dado
            sem finalidade, o que a minimização do art. 6º, III, da LGPD não admite e
            a Política de Privacidade promete não fazer.
          */}
          {materiaPorTipo(ident.type as never) === null && (
          <div className="rounded-xl border border-neutro-200 p-3">
            <Check label="Há sócio/terceiro no polo passivo (redirecionamento)" checked={!!facts.possuiRedirecionamento} onChange={setFB("possuiRedirecionamento")} />
            {!!facts.possuiRedirecionamento && (
              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Field label="Citação da pessoa jurídica"><input className="input" value={str(facts.dataCitacaoPJ)} onChange={setF("dataCitacaoPJ")} /></Field>
                <Field label="Dissolução irregular / ato inequívoco"><input className="input" value={str(facts.dataDissolucaoIrregular)} onChange={setF("dataDissolucaoIrregular")} /></Field>
                <Field label="Pedido de redirecionamento / citação do sócio"><input className="input" value={str(facts.dataPedidoRedirecionamento)} onChange={setF("dataPedidoRedirecionamento")} /></Field>
                <div className="flex items-end"><Check label="Inércia da Fazenda comprovada" checked={!!facts.fazendaInerteRedirecionamento} onChange={setFB("fazendaInerteRedirecionamento")} /></div>
              </div>
            )}
          </div>
          )}

          <Field label="Movimentações relevantes"><textarea className="input" rows={3} value={str(facts.movimentacoesRelevantes)} onChange={setF("movimentacoesRelevantes")} /></Field>
          <div className="flex justify-between">
            <button className="btn-outline" onClick={() => setStep(0)}>Voltar</button>
            <button className="btn-primary" disabled={busy} onClick={createAnalysis}>{busy ? "Salvando…" : "Continuar"}</button>
          </div>
        </div>
      )}

      {/* Etapa 3, Documentos */}
      {step === 2 && (
        <div className="card space-y-4 p-6">
          <h2 className="text-lg">Envio de documentos</h2>
          {/*
            ⚠️ Só PDF — e o texto diz exatamente o que o sistema faz.
            A frase anterior anunciava "DOCX ou imagens": DOCX era recusado no envio e imagem era aceita e
            nunca lida (analise vazia, credito cobrado). Oferta veiculada dentro do produto vincula o
            fornecedor (arts. 30 e 37 do CDC), e os textos legais publicados dizem que so o PDF tem o
            texto lido. O `accept` no input abaixo impede a selecao de outro formato antes do envio.
          */}
          <p className="text-sm text-neutro-500">
            Somente PDF. Se o arquivo vier do sistema processual com texto pesquisável, a leitura é imediata;
            PDF digitalizado (só imagem) passa por OCR. Recomenda-se anonimizar dados desnecessários.
          </p>
          <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-neutro-300 p-8 text-center hover:border-marinho-400">
            <span className="text-sm font-medium text-marinho-700">Clique para selecionar arquivos</span>
            <span className="text-xs text-neutro-400">Vários arquivos permitidos</span>
            <input type="file" multiple accept="application/pdf" className="hidden" onChange={(e) => uploadFiles(e.target.files)} />
          </label>
          {files.length > 0 && (
            <ul className="space-y-1 text-sm">
              {files.map((f) => <li key={f.id} className="flex items-center gap-2 rounded-lg bg-sucesso-50 px-3 py-2 text-sucesso">✓ {f.filename}</li>)}
            </ul>
          )}
          <div className="flex justify-between">
            <button className="btn-outline" onClick={() => setStep(1)}>Voltar</button>
            <button className="btn-primary" onClick={irParaConfirmacao}>Continuar</button>
          </div>
        </div>
      )}

      {/* Etapa 4, Confirmação */}
      {step === 3 && (
        <div className="card space-y-4 p-6">
          <h2 className="text-lg">Confirmação</h2>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Info k="Título" v={ident.title} />
            <Info k="Tipo" v={TYPES.find((t) => t.v === ident.type)?.l} />
            <Info k="Processo" v={ident.processNumber || "-"} />
            <Info k="Documentos enviados" v={String(files.length)} />
            {orcamento && <Info k="Páginas" v={String(orcamento.paginas)} />}
            {orcamento && <Info k="Tamanho" v={orcamento.megabytes} />}
          </dl>

          {/*
            O custo aparece com as PÁGINAS e a FAIXA ao lado, porque é o número de
            páginas que determina o preço. Sem isso, "4 créditos" parece arbitrário.
          */}
          {orcamentoErro && (
            <div className="rounded-xl border border-alerta-100 bg-alerta-50 p-4 text-sm text-alerta-700">
              {orcamentoErro} Recarregue a página antes de confirmar — não queremos debitar o que não foi anunciado.
            </div>
          )}
          {!orcamento && !orcamentoErro && (
            <div className="rounded-xl border border-neutro-200 bg-neutro-50 p-4 text-sm text-neutro-500">
              Calculando o custo desta análise…
            </div>
          )}
          {orcamento && (
            <div
              className={`rounded-xl border p-4 text-sm ${
                orcamento.podeIniciar
                  ? "border-atencao-100 bg-atencao-50 text-atencao"
                  : "border-alerta-100 bg-alerta-50 text-alerta-700"
              }`}
            >
              <p>
                {orcamento.ilimitado ? (
                  <>Seu plano não tem limite de créditos.</>
                ) : (
                  <>
                    Custo desta análise:{" "}
                    <strong>
                      {orcamento.aCobrar === 1 ? "1 crédito" : `${orcamento.aCobrar} créditos`}
                    </strong>
                    {orcamento.faixa ? ` (${orcamento.paginas} páginas, ${orcamento.faixa})` : ""}.{" "}
                    {orcamento.mensagem}
                  </>
                )}
              </p>
              <p className="mt-2">
                A análise é <strong>apoio jurídico</strong>; o resultado e a minuta{" "}
                <strong>devem ser revisados por advogado(a)</strong>. Informações ausentes podem alterar a conclusão.
              </p>
            </div>
          )}

          <div className="flex justify-between">
            <button className="btn-outline" onClick={() => setStep(2)}>Voltar</button>
            {/*
              Confirmar só é possível com o custo na tela e com saldo para ele: era esta
              porta que permitia autorizar um débito que o cliente não tinha visto.
            */}
            <button
              className="btn-primary"
              disabled={busy || !orcamento || !orcamento.podeIniciar}
              onClick={confirmAndProcess}
            >
              {busy ? "Processando…" : "Confirmar e analisar"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="label">{label}</span>{children}</label>;
}
function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return <label className="flex items-center gap-2 rounded-lg bg-neutro-50 px-3 py-2 text-sm"><input type="checkbox" checked={checked} onChange={onChange} /> {label}</label>;
}
function Info({ k, v }: { k: string; v?: string }) {
  return <div><dt className="text-xs text-neutro-400">{k}</dt><dd className="font-medium text-neutro-700">{v || "-"}</dd></div>;
}
function str(v: string | boolean | undefined): string {
  return typeof v === "string" ? v : "";
}
