import { NextRequest } from "next/server";
import { ok, fail, route } from "@/lib/api";
import { prisma } from "@/lib/db";
import { requireAppContext, assertActiveSubscription, garantirOrganizacao } from "@/lib/tenant";
import { agentRateAllowed } from "@/lib/rate-limit";
import { receberDocumento, extrairEPersistirPaginas } from "@/lib/document-intake";
import { extrairDadosProcesso, tituloSugerido } from "@/lib/legal/extracao";
import { isMateriaSlug, materiaPorSlug } from "@/lib/ai/materias";
import { montarChecklist } from "@/lib/legal/checklist-documentos";
import { temSaldo, MSG_SEM_SALDO } from "@/lib/credits";
import { orcamentoDaAnalise, orcamentoParaJson } from "@/lib/orcamento";
import { encryptField } from "@/lib/crypto";
import { logAudit } from "@/lib/audit";
import { formDataComTeto } from "@/lib/corpo-da-requisicao";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Análise automática: o cliente anexa a cópia do processo e o servidor faz o
 * resto — cria a análise, guarda os arquivos, lê o texto, identifica processo,
 * partes e datas-marco, e devolve o id pronto para processar.
 *
 * O que é lido aqui é HIPÓTESE de triagem, exibida ao cliente para conferência;
 * a conclusão jurídica é responsabilidade do motor de análise + revisão humana.
 */
export const POST = route(async (req: NextRequest) => {
  const ctx = await requireAppContext();
  /**
   * A organização é CRIADA se ainda não existir, em vez de recusar.
   *
   * A linha aqui era `if (!ctx.organization) return fail("Organização não encontrada.", 400)`.
   * Recusar era estranho: a conta existe, está autenticada, e criar a organização é barato
   * e automático em todos os outros caminhos (cadastro pelo site, primeira aprovação de
   * pagamento no webhook, liberação manual pelo painel). Quem não passou por nenhum
   * deles — o ADMIN da semente, um REVISOR, um SUPORTE — não conseguia criar análise
   * nenhuma, e a mensagem não dizia o que fazer porque não havia nada a fazer.
   *
   * Ver `garantirOrganizacao`, em src/lib/tenant.ts, que é a única cópia desta regra.
   */
  const organizacao = ctx.organization ?? (await garantirOrganizacao(ctx.user.id, ctx.user.name));

  // Mesmos portões do fluxo manual: assinatura ativa, uso justo e cota.
  assertActiveSubscription(ctx);
  if (!agentRateAllowed(ctx.user.id, "create"))
    return fail("Muitas solicitações em pouco tempo. Aguarde alguns segundos e tente novamente.", 429);
  // Saldo mínimo já aqui: subir e ler um processo de 160 páginas para depois
  // dizer "sem créditos" gasta o tempo do cliente à toa. O custo exato só é
  // conhecido depois da extração, então aqui basta ter pelo menos 1 crédito.
  if (ctx.user.role === "CLIENTE" && !temSaldo(ctx.subscription, 1))
    return fail(MSG_SEM_SALDO, 402, { reason: "sem_creditos" });

  /**
   * ⚠️ Teto ANTES de o corpo entrar na memória — e aqui doía mais que na rota manual: esta aceita VÁRIAS
   * partes `file` na mesma requisição, então o limite de 25 MB por arquivo não limitava o total. Ver
   * `@/lib/corpo-da-requisicao`.
   */
  const corpo = await formDataComTeto(req);
  if (!corpo.ok) return fail(corpo.erro, corpo.status);
  const formData = corpo.formData;

  // Matéria é obrigatória: sem ela a análise seria genérica, que é justamente o
  // que este fluxo substitui.
  const materiaBruta = formData.get("materia");
  if (!isMateriaSlug(materiaBruta)) {
    return fail("Selecione o tipo de análise jurídica antes de continuar.", 400);
  }
  const materia = materiaPorSlug(materiaBruta);

  const arquivos = formData.getAll("file").filter((f): f is File => f instanceof File);
  const primeiro = arquivos[0];
  if (!primeiro) return fail("Anexe o processo antes de iniciar a análise.", 400);

  /**
   * ⚠️ Quantidade conferida AQUI, e não só dentro do laço.
   *
   * O teto por análise existia em `receberDocumento`, contando o que já estava no BANCO — portanto atuava
   * arquivo por arquivo, depois de a requisição inteira estar em memória e depois de a análise já ter sido
   * criada. Recusar antes evita criar análise que vai ser recusada em seguida.
   */
  if (arquivos.length > env.upload.maxFiles) {
    return fail(`Envie no máximo ${env.upload.maxFiles} arquivos por análise.`, 422);
  }

  // Este fluxo aceita apenas PDF: as demais extrações (DOCX/OCR) ainda não
  // produzem texto confiável e levariam a uma análise sem base documental.
  const naoPdf = arquivos.find((f) => f.type !== "application/pdf");
  if (naoPdf) return fail("O arquivo enviado não é um PDF válido.", 422);

  // Cria a análise antes do upload: os arquivos são guardados sob a chave dela.
  const analysis = await prisma.analysis.create({
    data: {
      organizationId: organizacao.id,
      ownerId: ctx.user.id,
      title: `Análise — ${primeiro.name}`.slice(0, 200),
      // O tipo guarda a matéria escolhida; é o que o runner lê ao processar.
      type: materia.tipo,
      objective: `Análise dirigida de ${materia.label}, a partir da cópia do processo anexada.`,
      facts: {},
      status: "RASCUNHO",
    },
  });

  const enviados: string[] = [];
  const recusados: string[] = [];
  const notas: string[] = [];
  let textoTotal = "";
  let algumLegivel = false;
  let paginasComTexto = 0;
  let totalPaginas = 0;

  for (const file of arquivos) {
    const r = await receberDocumento({ analysisId: analysis.id, organizationId: organizacao.id, file });
    if (!r.ok) {
      recusados.push(`${file.name}: ${r.erro}`);
      continue;
    }
    enviados.push(r.documento.filename);
    const leitura = await extrairEPersistirPaginas(r.documento);
    const { texto, legivel, nota } = leitura;
    textoTotal += `\n${texto}`;
    if (legivel) algumLegivel = true;
    paginasComTexto += leitura.paginasComTexto;
    totalPaginas += leitura.totalPaginas;
    if (nota) notas.push(`${file.name}: ${nota}`);
    await logAudit({
      actorId: ctx.user.id,
      action: "document.upload",
      entityType: "Document",
      entityId: r.documento.id,
      metadata: { analysisId: analysis.id, sizeBytes: r.documento.sizeBytes, via: "automatica" },
    });
  }

  if (enviados.length === 0) {
    // Nenhum arquivo aceito: desfaz a análise para não deixar rascunho órfão.
    await prisma.analysis.delete({ where: { id: analysis.id } });
    return fail(recusados[0] ?? "Nenhum arquivo pôde ser recebido.", 422);
  }

  // PDF digitalizado (imagem): sem camada de texto não há o que analisar. Para
  // aqui e diz o motivo, em vez de devolver uma análise vazia — e desfaz o
  // rascunho para não consumir uma análise do plano.
  if (!algumLegivel) {
    await prisma.analysis.delete({ where: { id: analysis.id } });
    return fail(
      `Não foi possível ler o texto deste PDF: ${paginasComTexto} de ${totalPaginas} páginas têm texto; ` +
        `as demais são imagem digitalizada. Envie o PDF original do sistema processual (com texto pesquisável), ` +
        `passe o arquivo por OCR, ou informe os dados pelo preenchimento manual.`,
      422,
      { reason: "documento_digitalizado" },
    );
  }

  // Leitura determinística: identificação e datas-marco.
  const dados = extrairDadosProcesso(textoTotal);

  // Checklist de documentos da matéria, ANTES da análise (e da cobrança): é o
  // que a tela de confirmação mostra e o que avisa se a conclusão será limitada.
  // Persistido em facts para a página do resultado exibir depois.
  const checklist = montarChecklist(materia.slug, textoTotal);

  await prisma.analysis.update({
    where: { id: analysis.id },
    data: {
      title: tituloSugerido(dados, primeiro.name),
      processNumber: dados.processNumber,
      court: dados.court,
      jurisdiction: dados.jurisdiction,
      courtDivision: dados.courtDivision,
      creditor: dados.creditor,
      debtor: dados.debtor,
      debtorDocEnc: dados.debtorDocument ? encryptField(dados.debtorDocument) : null,
      cdaNumber: dados.cdaNumber,
      taxType: dados.taxType,
      facts: { ...dados.facts, checklistDocumentos: checklist as unknown as object },
      status: "DOCUMENTOS_ENVIADOS",
    },
  });

  await logAudit({
    actorId: ctx.user.id,
    actorRole: ctx.user.role,
    action: "analysis.create",
    entityType: "Analysis",
    entityId: analysis.id,
    metadata: { via: "automatica", arquivos: enviados.length, camposLidos: dados.encontrados.length },
  });

  // Agora que o processo foi lido, o custo é conhecido: vai junto na resposta
  // para a tela de confirmação, sem uma segunda ida ao servidor.
  const orcamento = await orcamentoDaAnalise(analysis.id, ctx.subscription);

  return ok(
    {
      id: analysis.id,
      materia: materia.slug,
      materiaLabel: materia.label,
      titulo: tituloSugerido(dados, primeiro.name),
      enviados,
      recusados,
      // `textoLegivel: false` = PDF digitalizado sem camada de texto. O cliente
      // precisa saber, porque nesse caso a análise sai sem base documental.
      textoLegivel: algumLegivel,
      encontrados: dados.encontrados,
      ausentes: dados.ausentes,
      notas,
      orcamento: orcamentoParaJson(orcamento),
      checklist,
    },
    { status: 201 },
  );
});
