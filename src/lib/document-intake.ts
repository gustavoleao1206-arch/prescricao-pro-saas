import { prisma } from "./db";
import { putObject } from "./storage";
import {
  validateUpload,
  conferirAssinatura,
  computeChecksum,
  extractText,
  diagnosticarLeitura,
  type DiagnosticoLeitura,
} from "./documents";
import { env } from "./env";
import { cifrarTextoDaPagina } from "./pagina-do-processo";

/**
 * Recebimento de documento — implementação única usada tanto pelo envio manual
 * (/api/documentos) quanto pelo fluxo automático (/api/analises/automatica).
 *
 * Mantém num só lugar as regras que protegem o armazenamento: limite de
 * quantidade por análise, formato/tamanho aceitos e deduplicação por checksum.
 */

export interface DocumentoRecebido {
  id: string;
  filename: string;
  sizeBytes: number;
  mimeType: string;
  buffer: Buffer;
}

export type ResultadoIntake =
  | { ok: true; documento: DocumentoRecebido }
  | { ok: false; erro: string; status: number };

export async function receberDocumento(params: {
  analysisId: string;
  organizationId: string;
  file: File;
}): Promise<ResultadoIntake> {
  const { analysisId, organizationId, file } = params;

  const count = await prisma.document.count({ where: { analysisId, deletedAt: null } });
  if (count >= env.upload.maxFiles) {
    return { ok: false, erro: `Limite de ${env.upload.maxFiles} documentos por análise.`, status: 422 };
  }

  const validationError = validateUpload(file.type, file.size);
  if (validationError) return { ok: false, erro: validationError, status: 422 };

  const buffer = Buffer.from(await file.arrayBuffer());

  /**
   * ⚠️ Só agora dá para saber o que o arquivo é: `file.type` é o rótulo que quem envia escolheu.
   *
   * A checagem vem antes de gravar no bucket e antes de criar a linha no banco — arquivo que não é o que
   * diz ser não deve custar armazenamento nem virar documento da análise. Ver `conferirAssinatura`.
   */
  const assinaturaInvalida = conferirAssinatura(file.type, buffer);
  if (assinaturaInvalida) return { ok: false, erro: assinaturaInvalida, status: 422 };

  const checksum = computeChecksum(buffer);

  const dup = await prisma.document.findFirst({ where: { analysisId, checksum, deletedAt: null } });
  if (dup) return { ok: false, erro: "Documento idêntico já enviado nesta análise.", status: 409 };

  const stored = await putObject(`org/${organizationId}/analysis/${analysisId}`, file.name, buffer);

  const doc = await prisma.document.create({
    data: {
      organizationId,
      analysisId,
      filename: file.name,
      mimeType: file.type,
      sizeBytes: stored.sizeBytes,
      storageKey: stored.key,
      checksum,
      status: "RECEBIDO",
    },
  });

  return {
    ok: true,
    documento: { id: doc.id, filename: doc.filename, sizeBytes: doc.sizeBytes, mimeType: doc.mimeType, buffer },
  };
}

/**
 * Extrai o texto e persiste as páginas, para que o processamento posterior não
 * precise reprocessar o arquivo. Devolve o texto concatenado do documento.
 */
export async function extrairEPersistirPaginas(doc: DocumentoRecebido): Promise<{
  texto: string;
  legivel: boolean;
  diagnostico: DiagnosticoLeitura;
  paginasComTexto: number;
  totalPaginas: number;
  nota?: string;
}> {
  try {
    const result = await extractText(doc.buffer, doc.mimeType);
    if (result.pages.length) {
      await prisma.documentPage.createMany({
        data: result.pages.map((p) => ({
          documentId: doc.id,
          pageNumber: p.page,
          text: cifrarTextoDaPagina(p.text),
          legible: p.legible,
        })),
        skipDuplicates: true,
      });
    }
    const diagnostico = diagnosticarLeitura(result);
    const legivel = diagnostico !== "digitalizado";
    await prisma.document.update({
      where: { id: doc.id },
      data: {
        status: legivel ? "PROCESSADO" : "ILEGIVEL",
        pageCount: result.pageCount,
        ocrApplied: result.ocrApplied,
        notes: result.note,
      },
    });
    return {
      texto: result.pages.map((p) => p.text).join("\n"),
      legivel,
      diagnostico,
      paginasComTexto: result.paginasComTexto,
      totalPaginas: Math.max(result.pageCount, result.pages.length),
      ...(result.note ? { nota: result.note } : {}),
    };
  } catch (e) {
    const nota = (e as Error).message;
    await prisma.document.update({ where: { id: doc.id }, data: { status: "ILEGIVEL", notes: nota } });
    return { texto: "", legivel: false, diagnostico: "digitalizado", paginasComTexto: 0, totalPaginas: 0, nota };
  }
}
