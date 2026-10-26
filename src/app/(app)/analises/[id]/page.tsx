import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getAppContext } from "@/lib/tenant";
import { prisma } from "@/lib/db";
import { AnalysisStatusBadge, ConfidenceBadge } from "@/components/ui/badge";
import { MarkdownView } from "@/components/app/markdown-view";
import { AnalysisActions } from "@/components/app/analysis-actions";
import { AnalysisResult } from "@/components/app/analysis-result";
import { ReviewPanel } from "@/components/app/review-panel";
import type { AnaliseDirigida } from "@/lib/ai/analise-dirigida";
import { checklistDeFacts } from "@/lib/legal/checklist-documentos";
import { MINUTOS_SEM_SINAL_DE_VIDA, STATUS_EM_EXECUCAO, ultimoSinal } from "@/lib/analise-travada";
import { podeExecutar } from "@/lib/situacao-da-analise";
import { creditoDevolvivel } from "@/lib/credits";
import { dateBR, dateTimeBR } from "@/lib/format";
import { logLeitura } from "@/lib/audit";

export const dynamic = "force-dynamic";

export default async function AnalysisDetailPage({ params: paramsAsync }: { params: Promise<{ id: string }> }) {
  const params = await paramsAsync;
  const ctx = await getAppContext();
  if (!ctx) redirect("/login");

  const analysis = await prisma.analysis.findUnique({
    where: { id: params.id },
    include: {
      documents: { where: { deletedAt: null } },
      timeline: { orderBy: [{ eventDate: "asc" }, { createdAt: "asc" }] },
      reports: { orderBy: { version: "desc" }, take: 1 },
      petitions: { orderBy: { createdAt: "desc" } },
      review: { include: { reviewer: { select: { name: true } } } },
    },
  });
  if (!analysis) notFound();

  // Isolamento: dono, mesma organização, ou papel privilegiado.
  const allowed =
    analysis.ownerId === ctx.user.id ||
    (ctx.organization && analysis.organizationId === ctx.organization.id) ||
    ctx.user.role === "ADMIN" ||
    ctx.user.role === "REVISOR";
  if (!allowed) notFound();

  /**
   * ⚠️ É POR ESTA TELA que a leitura interna realmente acontece: o link da lista administrativa aponta para
   * cá, e ela renderiza o relatório inteiro, o texto da minuta e a linha do tempo com o efeito jurídico de
   * cada evento. ADMIN e REVISOR liam o processo completo de terceiro e nada ficava gravado.
   *
   * A LGPD (art. 6, X, e art. 37) cobra poder DEMONSTRAR as operações de tratamento. Sem esta linha, "quem
   * leu a análise do cliente X" é uma pergunta cuja resposta honesta seria "não sei".
   *
   * A folga de 15 minutos de `logLeitura` é o que impede o `router.refresh()` de 4 segundos desta mesma tela
   * de gravar ~150 linhas idênticas por leitor durante um processamento.
   */
  await logLeitura({
    actorId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "analysis.view",
    entityType: "Analysis",
    entityId: params.id,
    metadata: { própriaConta: analysis.ownerId === ctx.user.id },
  });

  /**
   * Mudar a SITUAÇÃO é mais restrito que LER: a mesma condição da rota `/situacao` — dono ou ADMIN.
   * Membro da organização e REVISOR leem a análise; encerrá-la não é leitura.
   */
  const podeMudarSituacao = analysis.ownerId === ctx.user.id || ctx.user.role === "ADMIN";

  /**
   * Crédito que Excluir jogaria fora — e que Cancelar devolveria.
   *
   * Consultado só quando cancelar é possível para esta pessoa e nesta situação: avisar sobre um caminho
   * que ela não tem seria confundir, e a consulta ao banco não se justifica.
   */
  const creditoAPerder =
    podeMudarSituacao && podeExecutar("cancelar", analysis).pode ? await creditoDevolvivel(analysis.id) : 0;

  const report = analysis.reports[0];
  const petition = analysis.petitions[0];

  // Análises dirigidas guardam o resultado estruturado em `content`. As
  // anteriores a esta funcionalidade não têm o campo e seguem no formato antigo.
  const revisorNome = analysis.review?.reviewer?.name ?? null;
  const conteudo = report?.content as { dirigida?: AnaliseDirigida } | null | undefined;
  const dirigida = conteudo?.dirigida;
  // Checklist determinístico gravado no envio dos documentos (pode não existir
  // em análises antigas ou criadas pelo fluxo manual).
  const checklist = checklistDeFacts(analysis.facts);

  /**
   * Execução em andamento que parou de dar sinal de vida — o processo morreu sem passar
   * pelo tratamento de erro. Mesmo critério da varredura de manutenção, para a tela e a
   * rotina nunca discordarem sobre o que está travado.
   */
  const processamentoInterrompido =
    STATUS_EM_EXECUCAO.includes(analysis.status) &&
    ultimoSinal(analysis).getTime() < Date.now() - MINUTOS_SEM_SINAL_DE_VIDA * 60_000;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/analises" className="text-sm text-marinho-600 hover:underline">← Voltar</Link>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl">{analysis.title}</h1>
          <div className="flex items-center gap-2">
            <AnalysisStatusBadge status={analysis.status} />
            <ConfidenceBadge level={analysis.confidence} />
          </div>
        </div>
        <p className="mt-1 text-sm text-neutro-500">
          {analysis.processNumber ?? "sem nº"} · {analysis.court ?? "-"} · criada em {dateBR(analysis.createdAt)}
        </p>
      </div>

      <AnalysisActions
        id={analysis.id}
        status={analysis.status}
        temPeticao={Boolean(petition)}
        interrompido={processamentoInterrompido}
        /**
         * Quais ações de situação cabem — decidido AQUI, no servidor, pela mesma função que a rota usa.
         * Duas versões da regra dariam botão visível que o servidor recusa, ou saída escondida de quem
         * está tentando se resolver. Ver src/lib/situacao-da-analise.ts.
         *
         * ⚠️ E a PERMISSÃO entra na conta, não só o status. A rota exige dono ou ADMIN; a tela é aberta
         * também a REVISOR e a membro da mesma organização (ver `allowed` acima). Sem esta condição, o
         * revisor via "Cancelar análise" e recebia 403 ao clicar — botão que existe só para negar.
         */
        acoes={
          podeMudarSituacao
            ? {
                cancelar: podeExecutar("cancelar", analysis).pode,
                arquivar: podeExecutar("arquivar", analysis).pode,
                desarquivar: podeExecutar("desarquivar", analysis).pode,
              }
            : { cancelar: false, arquivar: false, desarquivar: false }
        }
        /**
         * Quanto se perde ao EXCLUIR. Só é consultado quando a pessoa pode cancelar — se cancelar não é
         * uma opção para ela, avisar sobre um caminho que ela não tem só confunde.
         */
        creditoAPerder={creditoAPerder}
        /**
         * O papel de quem está olhando decide DE QUEM é o crédito no reprocessamento: a
         * equipe interna reprocessa sem debitar o cliente, e cobrar em nome dele passou a
         * ser um botão separado. Antes, um clique de revisor gastava crédito do cliente
         * sem avisar ninguém.
         */
        papel={ctx.user.role}
      />

      {analysis.status === "ERRO_PROCESSAMENTO" && (
        <div className="rounded-xl border border-alerta-100 bg-alerta-50 p-4 text-sm text-alerta-700">
          Ocorreu um erro no processamento. Tente reprocessar; se persistir, contate o suporte.
        </div>
      )}

      {/*
        Execução que parou de dar sinal de vida.
        Sem esta caixa, a tela mostrava "processando" indefinidamente — e o cliente ficava
        olhando um estado que nunca mudaria, com o crédito debitado. O aviso diz o que
        aconteceu e onde clicar; o crédito é devolvido pelo próprio "Reprocessar", que
        destrava a análise antes de rodar. Ver src/lib/analise-travada.ts.
      */}
      {processamentoInterrompido && (
        <div className="rounded-xl border border-atencao-100 bg-atencao-50 p-4 text-sm text-atencao">
          <strong>O processamento foi interrompido</strong> antes de terminar — sem sinal de atividade desde{" "}
          {dateTimeBR(ultimoSinal(analysis))}. Clique em <strong>Reprocessar</strong> acima: o crédito desta análise é
          devolvido ao seu saldo e a apuração começa de novo, sem cobrança nova.
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {dirigida ? (
            <>
              <AnalysisResult
                dados={dirigida}
                checklist={checklist}
                {...(petition ? { peticaoDownloadUrl: `/api/analises/${analysis.id}/peca?petitionId=${petition.id}&format=docx` } : {})}
              />
              <Link href="/nova-analise" className="btn-primary inline-flex">Realizar nova análise</Link>
            </>
          ) : (
            <>
              {/* Relatório */}
              <section className="card p-6">
                <h2 className="mb-2 text-lg">Relatório</h2>
                {report ? (
                  <div className="prose-legal max-w-none"><MarkdownView markdown={report.markdown} /></div>
                ) : (
                  <p className="text-sm text-neutro-500">Relatório ainda não disponível. Após o processamento, ele aparecerá aqui.</p>
                )}
              </section>

              {/* Minuta */}
              {petition && (
                <section className="card p-6">
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-lg">Exceção de Pré-Executividade (minuta)</h2>
                    <a href={`/api/analises/${analysis.id}/peca?petitionId=${petition.id}&format=docx`} className="btn-outline text-sm">Baixar DOCX</a>
                  </div>
                  <div className="prose-legal max-w-none"><MarkdownView markdown={petition.markdown} /></div>
                </section>
              )}
            </>
          )}
        </div>

        <div className="space-y-6">
          {/* Linha do tempo */}
          <section className="card p-5">
            <h2 className="mb-3 text-base">Linha do tempo</h2>
            {analysis.timeline.length === 0 ? (
              <p className="text-sm text-neutro-500">Sem eventos registrados.</p>
            ) : (
              <ol className="space-y-3">
                {analysis.timeline.map((t) => (
                  <li key={t.id} className="border-l-2 border-marinho-200 pl-3">
                    <div className="text-xs font-semibold text-marinho-700">{t.dateText ?? dateBR(t.eventDate)}</div>
                    <div className="text-sm text-neutro-700">{t.description}</div>
                    {t.legalEffect && <div className="text-xs text-marca-700">{t.legalEffect}</div>}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {/* Documentos */}
          <section className="card p-5">
            <h2 className="mb-3 text-base">Documentos ({analysis.documents.length})</h2>
            <ul className="space-y-2 text-sm">
              {analysis.documents.map((d) => (
                <li key={d.id} className="flex items-center justify-between gap-2">
                  <a href={`/api/documentos/${d.id}/download`} className="truncate text-marinho-600 hover:underline">{d.filename}</a>
                  <span className="shrink-0 text-xs text-neutro-400">{(d.sizeBytes / 1024).toFixed(0)} KB</span>
                </li>
              ))}
              {analysis.documents.length === 0 && <li className="text-neutro-500">Nenhum documento.</li>}
            </ul>
          </section>

          {/* Revisão jurídica, conferência do advogado, que é o que tira a
              análise de "aguardando revisão". Antes só existia a exibição do
              status, sem nenhum caminho para concluí-lo. */}
          {analysis.review && analysis.status !== "PROCESSANDO" && (
            <ReviewPanel
              analysisId={analysis.id}
              revisao={{
                status: analysis.review.status,
                notes: analysis.review.notes,
                risks: analysis.review.risks,
                divergences: analysis.review.divergences,
                decidedAt: analysis.review.decidedAt?.toISOString() ?? null,
                revisor: revisorNome,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
