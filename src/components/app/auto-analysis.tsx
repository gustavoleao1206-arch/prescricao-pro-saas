"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MATERIAS, type MateriaSlug } from "@/lib/ai/materias";
import { LIMITE_MB_ARQUIVO } from "@/lib/planos";
import { durante } from "@/lib/operacao-em-andamento";
import { aguardarConclusao } from "@/lib/aguardar-analise";

/**
 * Nova análise dirigida: o cliente escolhe a matéria, anexa o processo e
 * acompanha o andamento até o resultado.
 *
 * A matéria é obrigatória e vai como parâmetro para a IA, é o que impede a
 * análise genérica que este fluxo substituiu.
 */

type Etapa =
  | "ocioso"
  | "enviando"
  | "confirmar"
  | "lendo"
  | "cronologia"
  | "criterios"
  | "concluindo"
  | "erro"
  /**
   * Sessão encerrada por inatividade durante a espera. Etapa PRÓPRIA, e não um caso de "erro":
   * o que se diz e o que se oferece são outros — nada falhou, nada será estornado, e o botão é
   * "entrar novamente", não "tentar de novo".
   */
  | "sessao-encerrada";

/** Orçamento devolvido pelo servidor, espelha orcamentoParaJson em src/lib/orcamento.ts. */
interface Orcamento {
  paginas: number;
  megabytes: string;
  arquivos: number;
  creditos: number;
  bloqueado: boolean;
  motivoBloqueio: string | null;
  faixa: string | null;
  ilimitado: boolean;
  saldoAtual: number | null;
  saldoApos: number | null;
  podeIniciar: boolean;
  mensagem: string;
}

/** Checklist devolvido pelo servidor, espelho de ChecklistDocumentos. */
interface Checklist {
  itens: { id: string; rotulo: string; essencial: boolean; encontrado: boolean }[];
  encontrados: number;
  total: number;
  limitada: boolean;
  aviso: string | null;
}

interface Leitura {
  id: string;
  materiaLabel: string;
  titulo: string;
  textoLegivel: boolean;
  encontrados: string[];
  ausentes: string[];
  recusados: string[];
  orcamento: Orcamento;
  checklist: Checklist;
}

/** Mensagens fiéis ao que o servidor está fazendo, sem porcentagem inventada. */
const PASSOS: { etapa: Etapa; rotulo: string }[] = [
  { etapa: "enviando", rotulo: "Lendo o processo… (PDF digitalizado passa por OCR e pode levar alguns minutos)" },
  { etapa: "lendo", rotulo: "Identificando datas e movimentações relevantes…" },
  { etapa: "cronologia", rotulo: "Organizando a linha do tempo…" },
  { etapa: "criterios", rotulo: "Aplicando os critérios jurídicos da matéria selecionada…" },
  { etapa: "concluindo", rotulo: "Elaborando a conclusão…" },
];

const ORDEM: Etapa[] = ["ocioso", "enviando", "lendo", "cronologia", "criterios", "concluindo"];
// O limite é o mesmo que a Política de Créditos publica — ver LIMITE_MB_ARQUIVO.
const MAX_MB = LIMITE_MB_ARQUIVO;

export function AutoAnalysis() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [materia, setMateria] = useState<MateriaSlug | null>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [etapa, setEtapa] = useState<Etapa>("ocioso");
  const [erro, setErro] = useState<string | null>(null);
  const [leitura, setLeitura] = useState<Leitura | null>(null);
  const [arrastando, setArrastando] = useState(false);

  // "confirmar" não é processamento: é a pausa em que o cliente decide gastar
  // crédito. Fica de fora para a tela de etapas não aparecer nesse momento.
  //
  // "sessao-encerrada" também fica de fora, e por motivo mais forte: se entrasse aqui, a tela
  // de etapas continuaria girando — que é exatamente o defeito que esta etapa existe para
  // consertar.
  const processando =
    etapa !== "ocioso" && etapa !== "erro" && etapa !== "confirmar" && etapa !== "sessao-encerrada";
  const pronto = materia !== null && arquivo !== null;

  function escolherArquivo(lista: FileList | null) {
    setErro(null);
    const f = lista?.[0];
    if (!f) return;
    if (f.type !== "application/pdf") {
      setErro("O arquivo enviado não é um PDF válido.");
      return;
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      setErro(`O arquivo excede o limite de ${MAX_MB} MB.`);
      return;
    }
    setArquivo(f);
  }

  function limparArquivo() {
    setArquivo(null);
    setErro(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function reiniciar() {
    setMateria(null);
    setArquivo(null);
    setLeitura(null);
    setErro(null);
    setEtapa("ocioso");
    if (inputRef.current) inputRef.current.value = "";
  }

  /**
   * Passo 1, envia e LÊ o processo, sem cobrar nada.
   *
   * A leitura precisa vir antes da cobrança porque só depois de contar as
   * páginas dá para saber quantos créditos a análise custa. Nada é chamado no
   * provedor de IA aqui, então parar neste ponto não gera custo.
   */
  const enviar = useCallback(async () => {
    if (processando) return;
    if (!materia) {
      setErro("Selecione o tipo de análise jurídica antes de continuar.");
      return;
    }
    if (!arquivo) {
      setErro("Anexe o processo antes de iniciar a análise.");
      return;
    }

    setErro(null);
    setLeitura(null);
    setEtapa("enviando");

    try {
      const fd = new FormData();
      fd.append("materia", materia);
      fd.append("file", arquivo);

      /**
       * ⚠️ O envio corre dentro de `durante`, senão o relógio de inatividade o mata no meio.
       *
       * Anexar o processo e mandar são interação; o que vem depois é espera de transferência,
       * sem clique, tecla nem rolagem. Um PDF de execução fiscal com centenas de páginas leva
       * minutos, e a tela navegava para o login com a requisição em voo — o arquivo se perdia
       * e a pessoa não entendia por quê.
       *
       * Cobre só o ENVIO. A espera pelo processamento (o laço de espera mais abaixo) fica de
       * fora de propósito: ali a pessoa pode ter saído de perto, e é justamente esse o caso
       * que o encerramento por inatividade existe para pegar.
       */
      const envio = await durante(() =>
        fetch("/api/analises/automatica", { method: "POST", body: fd }),
      );
      const dados = await envio.json();
      if (!envio.ok || !dados.ok) {
        setEtapa("erro");
        setErro(dados.error ?? "Não foi possível concluir a análise neste momento. Tente novamente.");
        return;
      }

      setLeitura(dados.data as Leitura);
      setEtapa("confirmar");
    } catch {
      setEtapa("erro");
      // Mensagem genérica de propósito: detalhes de exceção podem vazar
      // informação de infraestrutura.
      setErro("Não foi possível concluir a análise neste momento. Tente novamente.");
    }
  }, [processando, materia, arquivo]);

  /** Passo 2, só aqui o crédito é debitado e a IA é chamada. */
  const confirmarEIniciar = useCallback(async () => {
    if (!leitura) return;
    setErro(null);
    setEtapa("criterios");

    try {
      const proc = await fetch(`/api/analises/${leitura.id}/processar`, { method: "POST" });
      /**
       * A sessão pode ter sido encerrada por inatividade ENTRE a leitura e a confirmação: a
       * tela de conferência é lida com calma, e ler não gera clique nem rolagem. Aqui o crédito
       * ainda NÃO foi debitado, então não há nada a estornar — e é isso que a mensagem diz.
       */
      if (proc.status === 401) {
        setEtapa("sessao-encerrada");
        return;
      }
      const procDados = await proc.json();
      if (!proc.ok || !procDados.ok) {
        setEtapa("erro");
        setErro(procDados.error ?? "Não foi possível concluir a análise neste momento. Tente novamente.");
        return;
      }

      setEtapa("concluindo");
      const fim = await aguardarConclusao(leitura.id);
      /**
       * ⚠️ Sessão encerrada NÃO é erro de análise, e tratar como erro seria mentir duas vezes.
       *
       * Antes, o 401 durante a espera caía no desfecho "tempo" e a tela girava até o teto de
       * quatro minutos para então dizer "tempo esgotado". Duas afirmações falsas: o tempo não
       * esgotou, e a análise não falhou — ela continua correndo NO SERVIDOR e vai terminar. O
       * que acabou foi a sessão.
       *
       * Por isso a mensagem não fala de estorno: não há o que estornar, o crédito comprou uma
       * análise que está sendo entregue. Dizer "será estornado" faria a pessoa esperar dinheiro
       * de volta por um serviço que ela vai receber.
       */
      if (fim === "sessao") {
        setEtapa("sessao-encerrada");
        return;
      }
      if (fim === "erro") {
        setEtapa("erro");
        // O estorno é automático no servidor; dizer isso evita o pior efeito de
        // um erro num sistema por crédito, que é o cliente achar que pagou.
        setErro("Não foi possível concluir a análise. O crédito utilizado será estornado automaticamente.");
        return;
      }

      router.push(`/analises/${leitura.id}`);
    } catch {
      setEtapa("erro");
      setErro("Não foi possível concluir a análise. O crédito utilizado será estornado automaticamente.");
    }
  }, [leitura, router]);

  if (processando) {
    return <Processando etapa={etapa} materia={leitura?.materiaLabel} />;
  }

  if (etapa === "sessao-encerrada") {
    return <SessaoEncerrada analiseId={leitura?.id ?? null} />;
  }

  if (etapa === "confirmar" && leitura) {
    return (
      <Confirmacao
        leitura={leitura}
        onConfirmar={() => void confirmarEIniciar()}
        onCancelar={reiniciar}
        erro={erro}
      />
    );
  }

  const rotuloMateria = MATERIAS.find((m) => m.slug === materia)?.label;

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* 1, Matéria */}
      <section>
        <h2 className="text-base font-semibold text-marinho-700">Qual matéria você deseja analisar?</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          {MATERIAS.map((m) => {
            const ativa = materia === m.slug;
            return (
              <button
                key={m.slug}
                type="button"
                onClick={() => { setMateria(m.slug); setErro(null); }}
                aria-pressed={ativa}
                // flex-col + items-stretch: sem isso o <button> centraliza o
                // conteúdo verticalmente quando o grid iguala a altura dos cards.
                className={`flex h-full flex-col items-stretch rounded-2xl border p-4 text-left transition ${
                  ativa
                    ? "border-marca-500 bg-marca-50 ring-1 ring-marca-500 dark:bg-marca-500/15"
                    : "border-neutro-200 hover:border-marca-300"
                }`}
              >
                <span className="flex items-start justify-between gap-2">
                  <span className="text-sm font-semibold text-marinho-700">{m.label}</span>
                  {ativa && <span aria-hidden className="text-marca-600 dark:text-marca-300">✓</span>}
                </span>
                <span className="mt-1 block text-xs text-neutro-500">{m.resumo}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* 2, Documento (habilitado após escolher a matéria) */}
      <section>
        <h2 className="text-base font-semibold text-marinho-700">Anexe o processo para análise</h2>
        <p className="mt-1 text-sm text-neutro-600">
          Envie o processo completo em formato PDF para que o sistema identifique os fatos, datas,
          movimentações e documentos relevantes.
        </p>

        {arquivo ? (
          <div className="mt-3 flex items-center gap-3 rounded-2xl border border-neutro-200 p-4">
            <span aria-hidden className="text-marca-600 dark:text-marca-300"><IconePdf /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-marinho-700">{arquivo.name}</span>
              <span className="block text-xs text-neutro-500">
                {formatarTamanho(arquivo.size)} · pronto para análise
              </span>
            </span>
            <button type="button" onClick={() => inputRef.current?.click()} className="btn-ghost shrink-0 text-sm">
              Substituir
            </button>
            <button type="button" onClick={limparArquivo} className="btn-ghost shrink-0 text-sm text-alerta-700">
              Remover
            </button>
          </div>
        ) : (
          <div
            onDragOver={(e) => { if (materia) { e.preventDefault(); setArrastando(true); } }}
            onDragLeave={() => setArrastando(false)}
            onDrop={(e) => { if (!materia) return; e.preventDefault(); setArrastando(false); escolherArquivo(e.dataTransfer.files); }}
            onClick={() => materia && inputRef.current?.click()}
            role="button"
            aria-disabled={!materia}
            tabIndex={materia ? 0 : -1}
            onKeyDown={(e) => { if (materia && (e.key === "Enter" || e.key === " ")) inputRef.current?.click(); }}
            className={`mt-3 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed p-8 text-center transition ${
              !materia
                ? "cursor-not-allowed border-neutro-200 bg-neutro-50"
                : arrastando
                  ? "cursor-pointer border-marca-500 bg-marca-50 dark:bg-marca-500/10"
                  : "cursor-pointer border-neutro-300 hover:border-marca-400"
            }`}
          >
            <IconeAnexo ativo={Boolean(materia)} />
            {materia ? (
              <>
                <span className="btn-outline mt-1 text-sm">Selecionar processo</span>
                <span className="text-xs text-neutro-500">ou arraste o PDF até aqui · até {MAX_MB} MB</span>
              </>
            ) : (
              // Diz o motivo em vez de só apagar o bloco: o cliente não precisa
              // adivinhar por que não consegue anexar.
              <span className="mt-1 text-sm font-medium text-neutro-500">
                Escolha a matéria acima para liberar o envio
              </span>
            )}
          </div>
        )}

        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => escolherArquivo(e.target.files)}
        />
      </section>

      {/* 3, Resumo do que será analisado */}
      {pronto && rotuloMateria && (
        <div className="rounded-2xl border border-marca-200 bg-marca-50 p-4 text-sm dark:border-marca-500/30 dark:bg-marca-500/10">
          <span className="font-semibold text-marinho-700">Tipo de análise: {rotuloMateria}</span>
          <span className="mt-1 block text-neutro-600">
            A inteligência artificial vai avaliar exclusivamente esta matéria no documento anexado.
          </span>
        </div>
      )}

      {erro && (
        <p role="alert" className="rounded-xl bg-alerta-50 px-4 py-3 text-sm text-alerta-700">{erro}</p>
      )}

      <button type="button" onClick={() => void enviar()} disabled={!pronto} className="btn-primary w-full justify-center">
        Continuar
      </button>

      <p className="text-center text-xs text-neutro-600">
        PDF digitalizado (imagem, sem texto) não pode ser lido automaticamente.{" "}
        <Link href="/nova-analise/manual" className="font-medium text-marca-600 underline dark:text-marca-300">
          Preencher manualmente
        </Link>
      </p>
    </div>
  );
}

/**
 * Confirmação antes de gastar crédito.
 *
 * O processo já foi lido neste ponto, o que permite mostrar o custo REAL, e não
 * uma estimativa. É a tela que impede a reclamação mais previsível de um sistema
 * por crédito: "gastou meu saldo sem avisar".
 */
function Confirmacao({
  leitura,
  onConfirmar,
  onCancelar,
  erro,
}: {
  leitura: Leitura;
  onConfirmar: () => void;
  onCancelar: () => void;
  erro: string | null;
}) {
  const o = leitura.orcamento;
  const plural = (n: number) => (n === 1 ? "1 crédito" : `${n} créditos`);

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="card p-6">
        <h2 className="text-lg font-semibold text-marinho-700">Confirme antes de iniciar</h2>
        <p className="mt-1 text-sm text-neutro-600">
          Tipo de análise: <strong className="text-marinho-700">{leitura.materiaLabel}</strong>
        </p>

        <dl className="mt-5 grid gap-3 sm:grid-cols-2">
          <Dado rotulo="Páginas do processo" valor={String(o.paginas)} />
          <Dado rotulo="Tamanho do arquivo" valor={o.megabytes} />
          <Dado
            rotulo="Créditos desta análise"
            valor={o.bloqueado ? "-" : plural(o.creditos)}
            destaque
          />
          <Dado
            rotulo="Seu saldo atual"
            valor={o.ilimitado ? "Sem limite" : plural(o.saldoAtual ?? 0)}
          />
        </dl>

        {!o.bloqueado && !o.ilimitado && o.podeIniciar && (
          <p className="mt-4 rounded-xl bg-marca-50 px-4 py-3 text-sm text-marinho-700 dark:bg-marca-500/10">
            {o.mensagem}
          </p>
        )}

        {/* PDF digitalizado: a análise sai sem base documental, e o cliente
            precisa saber ANTES de gastar o crédito. */}
        {!leitura.textoLegivel && (
          <p className="mt-4 rounded-xl bg-atencao-50 px-4 py-3 text-sm text-atencao">
            Este PDF é digitalizado e o texto não pôde ser lido por completo. A análise pode sair sem base
            documental suficiente.
          </p>
        )}
      </div>

      {/* Checklist de documentos da matéria, detectado ANTES da análise: o
          cliente decide gastar o crédito sabendo o que o processo contém. */}
      {leitura.checklist && (
        <div className="card p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold text-marinho-700">Documentos da matéria</h3>
            <span className="text-xs text-neutro-500">
              {leitura.checklist.encontrados} de {leitura.checklist.total} localizados
            </span>
          </div>
          <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {leitura.checklist.itens.map((item) => (
              <li key={item.id} className="flex items-start gap-2 text-sm">
                <span aria-hidden className={item.encontrado ? "text-sucesso" : "text-alerta-500"}>
                  {item.encontrado ? "✓" : "✗"}
                </span>
                <span className={item.encontrado ? "text-neutro-700" : "text-neutro-500"}>
                  {item.rotulo}
                  {item.essencial && !item.encontrado && (
                    <span className="ml-1 text-xs font-medium text-alerta-700">(essencial)</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {leitura.checklist.aviso && (
            <p className="mt-4 rounded-xl bg-atencao-50 px-4 py-3 text-sm text-atencao">{leitura.checklist.aviso}</p>
          )}
          <p className="mt-3 text-xs text-neutro-500">
            Detecção automática pelo texto do PDF: serve de orientação e não substitui a conferência dos autos.
          </p>
        </div>
      )}

      {/* Caminho bloqueado: processo grande demais ou saldo insuficiente. */}
      {!o.podeIniciar && (
        <div className="rounded-2xl border border-atencao-100 bg-atencao-50 p-5">
          <p className="text-sm font-medium text-atencao">{o.mensagem}</p>
          {!o.bloqueado && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/assinatura#creditos" className="btn-primary text-sm">Comprar créditos</Link>
              <Link href="/planos" className="btn-outline text-sm">Fazer upgrade</Link>
              <Link href="/assinatura" className="btn-ghost text-sm">Ver data da renovação</Link>
            </div>
          )}
          {o.bloqueado && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/suporte" className="btn-primary text-sm">Solicitar análise especial</Link>
            </div>
          )}
        </div>
      )}

      {erro && <p role="alert" className="rounded-xl bg-alerta-50 px-4 py-3 text-sm text-alerta-700">{erro}</p>}

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onConfirmar}
          disabled={!o.podeIniciar}
          className="btn-primary flex-1 justify-center"
        >
          Confirmar e iniciar análise
        </button>
        <button type="button" onClick={onCancelar} className="btn-outline">
          Cancelar
        </button>
      </div>

      <p className="text-center text-xs text-neutro-500">
        O crédito só é descontado quando o processamento começa. Em caso de erro técnico, o estorno é automático.
      </p>
    </div>
  );
}

function Dado({ rotulo, valor, destaque = false }: { rotulo: string; valor: string; destaque?: boolean }) {
  return (
    <div className="rounded-xl border border-neutro-200 p-3">
      <dt className="text-xs font-medium uppercase tracking-wide text-neutro-400">{rotulo}</dt>
      <dd className={`mt-1 font-semibold ${destaque ? "text-lg text-marca-600 dark:text-marca-300" : "text-marinho-700"}`}>
        {valor}
      </dd>
    </div>
  );
}

function Processando({ etapa, materia }: { etapa: Etapa; materia?: string }) {
  const atual = ORDEM.indexOf(etapa);
  return (
    <div className="mx-auto max-w-2xl">
      <div className="card p-8">
        {materia && <p className="mb-5 text-sm text-neutro-500">Tipo de análise: <strong className="text-marinho-700">{materia}</strong></p>}
        <ol className="space-y-4">
          {PASSOS.map((p) => {
            const idx = ORDEM.indexOf(p.etapa);
            const feito = atual > idx;
            const agora = atual === idx;
            return (
              <li key={p.etapa} className="flex items-center gap-3">
                <span
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                    feito ? "bg-sucesso text-white" : agora ? "grad-marca text-[#04122E]" : "bg-neutro-200 text-neutro-500"
                  }`}
                >
                  {feito ? "✓" : idx}
                </span>
                <span className={agora ? "font-semibold text-marinho-700" : feito ? "text-neutro-600" : "text-neutro-400"}>
                  {p.rotulo}
                </span>
              </li>
            );
          })}
        </ol>
        <p className="mt-6 text-xs text-neutro-400">
          Processos longos levam mais tempo. Você pode acompanhar por “Minhas análises” se sair desta tela.
        </p>
      </div>
    </div>
  );
}

/**
 * Sessão encerrada por inatividade durante a espera do processamento.
 *
 * ── O que esta tela conserta ──────────────────────────────────────────────────
 * Acompanhar um processamento é espera PASSIVA, e de propósito não conta como presença: a
 * pessoa pode ter saído de perto, que é o caso do encerramento por inatividade. Passando do
 * prazo, a consulta de status responde 401 — e a tela girava até o teto de quatro minutos para
 * então dizer "tempo esgotado". Duas mentiras: o tempo não esgotou, e a análise não falhou.
 *
 * ── As três coisas que esta tela precisa dizer ────────────────────────────────
 * 1. O QUE aconteceu, sem jargão: a sessão foi encerrada, não o sistema quebrou.
 * 2. Que a análise NÃO se perdeu. É a preocupação imediata de quem gastou crédito, e é
 *    verdade: o processamento corre no servidor e termina independentemente desta tela.
 * 3. Para onde ir, num clique — e voltando para a própria análise, não para o painel. Entrar
 *    de novo e ter de procurar onde estava é o tipo de detalhe que faz a pessoa achar que
 *    perdeu o trabalho.
 *
 * O destino vai por `next`, que a tela de login valida (só caminho interno) — a mesma guarda
 * que impede usar o endereço como trampolim para site falso.
 */
function SessaoEncerrada({ analiseId }: { analiseId: string | null }) {
  const destino = analiseId ? `/analises/${analiseId}` : "/analises";
  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-neutro-200 bg-white p-6 text-center dark:border-neutro-700 dark:bg-neutro-900">
      <h2 className="text-base font-semibold text-marinho-700">Sua sessão foi encerrada por inatividade</h2>
      <p className="mt-3 text-sm text-neutro-600">
        Por segurança, a sessão é encerrada depois de um tempo sem uso — e o acompanhamento nesta
        tela não conta como uso.
      </p>
      <p className="mt-3 text-sm font-medium text-neutro-700">
        <strong>A sua análise não foi perdida.</strong> Ela continua sendo processada no servidor
        e o crédito já utilizado está aplicado a ela.
      </p>
      <a
        href={`/login?motivo=inatividade&next=${encodeURIComponent(destino)}`}
        className="btn-primary mt-6 inline-block text-sm"
      >
        Entrar novamente e ver a análise
      </a>
    </div>
  );
}

/** KB abaixo de 1 MB, senão um anexo pequeno aparece como "0.00 MB". */
function formatarTamanho(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(2)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function IconeAnexo({ ativo = true }: { ativo?: boolean }) {
  return (
    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={ativo ? "text-marca-500" : "text-neutro-400"} aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" /><path d="M12 18v-6" /><path d="m9 15 3-3 3 3" />
    </svg>
  );
}

function IconePdf() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}
