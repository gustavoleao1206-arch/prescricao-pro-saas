"use client";

import { useState } from "react";
import { MarkdownView } from "@/components/app/markdown-view";
import { materiaPorSlug } from "@/lib/ai/materias";
import {
  rotuloConclusao,
  GRAU_CONFIANCA,
  type AnaliseDirigida,
  type ResultadoAnalise,
} from "@/lib/ai/analise-dirigida";
import type { ChecklistDocumentos } from "@/lib/legal/checklist-documentos";

/**
 * Resultado da análise dirigida, nos 11 blocos padronizados da especificação:
 * resposta objetiva, fundamentação, linha do tempo, quadro cronológico,
 * documentos utilizados e ausentes, riscos, estratégia, jurisprudência, peça e
 * grau de confiança justificado. A ordem é fixa para o cliente sempre saber
 * onde encontrar cada informação.
 *
 * O bloco "Sugestão de petição" só existe quando o resultado é positivo, e a
 * ausência aqui é apenas o reflexo da regra: o servidor já não grava peça em
 * resultado negativo ou inconclusivo.
 */

/**
 * Cores por situação (item 16 da especificação):
 * verde = consumada e comprovada · azul = prazo em andamento ·
 * amarelo = inconclusiva/pendência documental · vermelho = contradição corrigida.
 */
const DESTAQUE: Record<ResultadoAnalise, { caixa: string; texto: string }> = {
  positivo: {
    caixa: "border-sucesso/30 bg-sucesso-50 dark:bg-sucesso/10",
    texto: "text-sucesso",
  },
  // Negativo = prazo em andamento (ou interrompido): informativo, azul.
  negativo: {
    caixa: "border-marca-200 bg-marca-50 dark:border-marca-500/30 dark:bg-marca-500/10",
    texto: "text-marca-700 dark:text-marca-200",
  },
  // Inconclusivo = pendência documental: amarelo.
  inconclusivo: {
    caixa: "border-atencao-100 bg-atencao-50 dark:bg-atencao/10",
    texto: "text-atencao",
  },
};

const SITUACAO_PRAZO: Record<string, string> = {
  consumado: "Prazo completo na data da análise",
  em_andamento: "Prazo em andamento (consumação futura)",
  indeterminado: "Situação do prazo não determinável com os documentos atuais",
};

/** "2029-07-03" → "03/07/2029". */
function dataBR(iso: string | null): string {
  return iso ? iso.split("-").reverse().join("/") : "-";
}

export function AnalysisResult({
  dados,
  peticaoDownloadUrl,
  checklist,
}: {
  dados: AnaliseDirigida;
  peticaoDownloadUrl?: string;
  /** Checklist determinístico feito no envio; null quando a análise é antiga. */
  checklist?: ChecklistDocumentos | null;
}) {
  const positivo = dados.resultado === "positivo";
  const cor = DESTAQUE[dados.resultado];
  const materia = materiaPorSlug(dados.tipoAnalise);
  const vt = dados.verificacaoTemporal;

  return (
    <div className="space-y-4">
      {/* Contradição detectada e corrigida: o cliente precisa saber que a
          resposta original da IA foi ajustada pela verificação de datas. */}
      {vt?.corrigido && (
        <section className="rounded-2xl border border-alerta-500/40 bg-alerta-50 p-4 dark:bg-alerta-500/10">
          <p className="text-sm font-semibold text-alerta-700">Correção automática aplicada</p>
          <p className="mt-1 text-sm text-alerta-700">
            A conclusão original da análise ({vt.resultadoOriginalIA}) foi ajustada pela verificação temporal do
            sistema, com base nas datas documentadas. Os detalhes estão em &quot;Riscos e elementos contrários&quot;.
          </p>
        </section>
      )}

      {/* Bloco 1: resposta objetiva à pergunta da matéria */}
      <section className={`rounded-2xl border p-6 ${cor.caixa}`}>
        <p className="text-xs uppercase tracking-wide text-neutro-500">Tipo de análise: {materia.label}</p>
        <h2 className={`mt-2 text-lg font-bold ${cor.texto}`}>{materia.pergunta}</h2>
        <p className={`mt-1 text-xl font-bold ${cor.texto}`}>{rotuloConclusao(dados.tipoAnalise, dados.resultado)}</p>
        <p className="mt-3 whitespace-pre-line text-sm text-neutro-700">{dados.conclusao}</p>

        {/* Datas-chave da verificação temporal (item 16). */}
        {vt && (
          <dl className="mt-4 grid gap-3 border-t border-neutro-200 pt-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-neutro-500">Data da análise</dt>
              <dd className="text-sm font-medium text-neutro-700">{dataBR(vt.dataAnalise)}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-neutro-500">Marco inicial adotado</dt>
              <dd className="text-sm font-medium text-neutro-700">{dados.calculoPrazo.marcoInicial}</dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-neutro-500">Consumação calculada</dt>
              <dd className="text-sm font-medium text-neutro-700">
                {vt.dataConsumacao ? dataBR(vt.dataConsumacao) : dados.calculoPrazo.dataProvavelConsumacao}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wide text-neutro-500">Situação do prazo</dt>
              <dd className="text-sm font-medium text-neutro-700">{SITUACAO_PRAZO[vt.situacaoPrazo]}</dd>
            </div>
          </dl>
        )}

        {/* Memória de cálculo GERADA PELO SISTEMA, não pela IA (item 11). */}
        {vt && vt.memoriaCalculo.length > 0 && (
          <div className="mt-4 rounded-xl bg-white/60 p-4 dark:bg-white/5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutro-500">
              Memória de cálculo (verificação do sistema)
            </h3>
            <ul className="mt-2 space-y-1 font-mono text-xs text-neutro-700">
              {vt.memoriaCalculo.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Bloco 11 resumido no destaque; a justificativa completa vem abaixo. */}
        <p className="mt-4 text-xs text-neutro-500">
          Grau de confiança da análise: <strong>{GRAU_CONFIANCA[dados.grauConsistencia]}</strong>
        </p>
      </section>

      <Bloco titulo="Resumo executivo" aberto>
        <p className="whitespace-pre-line text-sm text-neutro-700">{dados.resumoExecutivo}</p>
      </Bloco>

      <Bloco titulo={`Linha do tempo (${dados.linhaDoTempo.length})`} aberto={dados.linhaDoTempo.length > 0}>
        {dados.linhaDoTempo.length === 0 ? (
          <Vazio>Nenhum evento datado foi localizado no documento analisado.</Vazio>
        ) : (
          <ol className="space-y-3">
            {dados.linhaDoTempo.map((e, i) => (
              <li key={`${e.data}-${i}`} className="border-l-2 border-marca-300 pl-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="text-sm font-semibold text-marinho-700">{e.data}</span>
                  {e.pagina && <span className="text-xs text-neutro-400">pág. {e.pagina}</span>}
                  <span className="badge bg-neutro-100 text-[10px] uppercase text-neutro-600">{e.relevancia}</span>
                </div>
                <p className="text-sm text-neutro-700">{e.evento}</p>
                {e.efeitoJuridico && <p className="text-xs text-marca-700 dark:text-marca-300">{e.efeitoJuridico}</p>}
              </li>
            ))}
          </ol>
        )}
      </Bloco>

      {/* Bloco 4: quadro cronológico, a mesma cronologia em forma de tabela,
          com a página de cada ato, para conferência rápida contra os autos. */}
      {dados.linhaDoTempo.length > 0 && (
        <Bloco titulo="Quadro cronológico">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-b border-neutro-200 text-left text-xs uppercase tracking-wide text-neutro-400">
                  <th className="py-2 pr-3 font-medium">Data</th>
                  <th className="py-2 pr-3 font-medium">Ato processual</th>
                  <th className="py-2 pr-3 font-medium">Página</th>
                  <th className="py-2 pr-3 font-medium">Classificação</th>
                  <th className="py-2 pr-3 font-medium">Efeito jurídico</th>
                  <th className="py-2 font-medium">Confiança</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutro-100">
                {dados.linhaDoTempo.map((e, i) => (
                  <tr key={`q-${e.data}-${i}`} className="align-top">
                    <td className="whitespace-nowrap py-2 pr-3 font-medium text-marinho-700">{e.data}</td>
                    <td className="py-2 pr-3 text-neutro-700">{e.evento}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-neutro-500">{e.pagina || "-"}</td>
                    <td className="whitespace-nowrap py-2 pr-3 text-neutro-600">{e.classificacao || "-"}</td>
                    <td className="py-2 pr-3 text-neutro-600">{e.efeitoJuridico || "-"}</td>
                    <td className="whitespace-nowrap py-2 text-neutro-500">{GRAU_CONFIANCA[e.confianca]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Bloco>
      )}

      <Bloco titulo="Cálculo do prazo">
        <dl className="grid gap-3 sm:grid-cols-2">
          <Campo termo="Marco inicial" valor={dados.calculoPrazo.marcoInicial} />
          <Campo termo="Prazo aplicável" valor={dados.calculoPrazo.prazoAplicavel} />
          <Campo termo="Marco final" valor={dados.calculoPrazo.marcoFinal} />
          <Campo termo="Data provável da consumação" valor={dados.calculoPrazo.dataProvavelConsumacao} />
        </dl>
        <ListaSe titulo="Períodos de suspensão" itens={dados.calculoPrazo.periodosSuspensao} />
        <ListaSe titulo="Atos interruptivos" itens={dados.calculoPrazo.atosInterruptivos} />
        <div className="mt-4">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-neutro-500">Memória da contagem</h4>
          <p className="mt-1 whitespace-pre-line text-sm text-neutro-700">{dados.calculoPrazo.explicacao}</p>
        </div>
      </Bloco>

      <Bloco titulo="Fundamentação jurídica">
        <ListaSe titulo="Dispositivos legais" itens={dados.fundamentacaoLegal} />
        <ListaSe titulo="Súmulas, temas e precedentes" itens={dados.precedentes} />
        {dados.fundamentacaoLegal.length === 0 && dados.precedentes.length === 0 && (
          <Vazio>Nenhuma fundamentação foi produzida para esta análise.</Vazio>
        )}
      </Bloco>

      {dados.elementosFavoraveis.length > 0 && (
        <Bloco titulo="Elementos favoráveis">
          <Lista itens={dados.elementosFavoraveis} />
        </Bloco>
      )}

      {dados.riscos.length > 0 && (
        <Bloco titulo="Riscos e elementos contrários">
          <Lista itens={dados.riscos} />
        </Bloco>
      )}

      {dados.pontosParaAvaliacao.length > 0 && (
        <Bloco titulo="Pontos para avaliação do advogado">
          <p className="mb-2 text-xs text-neutro-500">
            Seção informativa. Não substitui a conclusão acima.
          </p>
          <Lista itens={dados.pontosParaAvaliacao} />
        </Bloco>
      )}

      <Bloco titulo="Documentos">
        {/* Checklist determinístico do envio, quando existir. */}
        {checklist && (
          <div className="mb-4">
            <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutro-500">
              Checklist da matéria ({checklist.encontrados} de {checklist.total} localizados)
            </h4>
            <ul className="grid gap-1 sm:grid-cols-2">
              {checklist.itens.map((item) => (
                <li key={item.id} className="flex items-start gap-2 text-sm">
                  <span aria-hidden className={item.encontrado ? "text-sucesso" : "text-alerta-500"}>
                    {item.encontrado ? "✓" : "✗"}
                  </span>
                  <span className={item.encontrado ? "text-neutro-700" : "text-neutro-500"}>{item.rotulo}</span>
                </li>
              ))}
            </ul>
            {checklist.aviso && (
              <p className="mt-3 rounded-xl bg-atencao-50 px-4 py-3 text-sm text-atencao">{checklist.aviso}</p>
            )}
          </div>
        )}
        <ListaSe titulo="Utilizados na análise" itens={dados.documentosUtilizados} />
        <ListaSe titulo="Ausentes (obter para aumentar a segurança)" itens={dados.documentosAusentes} />
      </Bloco>

      {/* Bloco 8: estratégia processual, presente em qualquer resultado. */}
      {dados.estrategiaRecomendada && (
        <Bloco titulo="Estratégia processual recomendada" aberto>
          <p className="whitespace-pre-line text-sm text-neutro-700">{dados.estrategiaRecomendada}</p>
        </Bloco>
      )}

      {/* Bloco 11: grau de confiança com a justificativa da classificação. */}
      <Bloco titulo={`Grau de confiança: ${GRAU_CONFIANCA[dados.grauConsistencia]}`}>
        <p className="whitespace-pre-line text-sm text-neutro-700">{dados.justificativaConfianca}</p>
      </Bloco>

      {/* Item 13: quando a consumação não está comprovada, a minuta é bloqueada
          e o cliente sabe o porquê, em vez de só não ver o bloco. */}
      {!positivo && (
        <section className="rounded-2xl border border-neutro-200 p-5">
          <h3 className="text-base font-semibold text-marinho-700">Minuta de petição</h3>
          <p className="mt-2 text-sm text-neutro-600">
            Minuta não disponibilizada porque os documentos atuais não comprovam a consumação da{" "}
            {materia.label.toLowerCase()}.
          </p>
        </section>
      )}

      {positivo && dados.peticao && (
        <Bloco titulo="Sugestão de petição" aberto>
          {dados.medidaProcessualSugerida && (
            <div className="mb-4 rounded-xl border border-neutro-200 p-3">
              <p className="text-sm font-semibold text-marinho-700">{dados.medidaProcessualSugerida}</p>
              {dados.justificativaMedida && (
                <p className="mt-1 text-xs text-neutro-500">{dados.justificativaMedida}</p>
              )}
            </div>
          )}
          <AcoesPeticao texto={dados.peticao} downloadUrl={peticaoDownloadUrl} />
          <div className="prose-legal mt-4 max-w-none overflow-x-auto">
            <MarkdownView markdown={dados.peticao} />
          </div>
        </Bloco>
      )}

      <p className="rounded-xl border border-neutro-200 p-4 text-xs leading-relaxed text-neutro-500">
        {dados.avisoLegal}
      </p>
    </div>
  );
}

function AcoesPeticao({ texto, downloadUrl }: { texto: string; downloadUrl?: string }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      setCopiado(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => void copiar()} className="btn-outline text-sm">
        {copiado ? "Copiado ✓" : "Copiar texto"}
      </button>
      {downloadUrl && (
        <a href={downloadUrl} className="btn-outline text-sm">Baixar DOCX</a>
      )}
    </div>
  );
}

function Bloco({ titulo, aberto = false, children }: { titulo: string; aberto?: boolean; children: React.ReactNode }) {
  return (
    <details open={aberto} className="card overflow-hidden">
      <summary className="cursor-pointer list-none px-5 py-4 text-base font-semibold text-marinho-700 marker:content-['']">
        {titulo}
      </summary>
      <div className="border-t border-neutro-200 px-5 py-4">{children}</div>
    </details>
  );
}

function Campo({ termo, valor }: { termo: string; valor: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-neutro-500">{termo}</dt>
      <dd className="text-sm text-neutro-700">{valor}</dd>
    </div>
  );
}

function Lista({ itens }: { itens: string[] }) {
  return (
    <ul className="space-y-1.5 text-sm text-neutro-700">
      {itens.map((i, n) => (
        <li key={`${n}-${i.slice(0, 24)}`} className="flex gap-2">
          <span aria-hidden className="text-neutro-400">·</span>
          <span className="min-w-0 break-words">{i}</span>
        </li>
      ))}
    </ul>
  );
}

function ListaSe({ titulo, itens }: { titulo: string; itens: string[] }) {
  if (itens.length === 0) return null;
  return (
    <div className="mt-4 first:mt-0">
      <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-neutro-500">{titulo}</h4>
      <Lista itens={itens} />
    </div>
  );
}

function Vazio({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-neutro-500">{children}</p>;
}
