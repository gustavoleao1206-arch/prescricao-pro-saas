import { env } from "./env";

/**
 * Leitura do corpo de requisição com TETO DE BYTES.
 *
 * ── O defeito que isto conserta (achado da auditoria de 17/08/2026) ───────────
 * As duas rotas de envio de documento faziam `await req.formData()` como primeira coisa. Isso lê o corpo
 * INTEIRO para a memória. Só depois, dentro de `receberDocumento`, o tamanho era conferido contra o limite
 * de 25 MB por arquivo — ou seja, o limite nunca chegava a ser consultado: o servidor já tinha engolido o
 * arquivo antes de olhar o tamanho.
 *
 * E o limite por arquivo não protegia o total: o fluxo automático aceita várias partes `file` na mesma
 * requisição, então 20 arquivos de 25 MB entravam juntos — 500 MB numa instância de 512 MB que atende
 * TODOS os clientes ao mesmo tempo, porque a produção roda com uma instância só. Quem derruba não é um
 * invasor: é um cliente pagante enviando documento, sem nenhum rastro de ataque.
 *
 * ── Por que não basta olhar o `Content-Length` ────────────────────────────────
 * O `Content-Length` é declarado por quem envia. Recusar por ele é filtro barato e serve para não gastar
 * nada com o caso óbvio, mas quem mente no cabeçalho passaria. Por isso a defesa de verdade está em CONTAR
 * os bytes enquanto o corpo é lido e abortar ao cruzar o teto — o consumo fica limitado ao teto mesmo
 * quando o cabeçalho é falso ou ausente.
 *
 * ── Por que reconstruir a requisição em vez de trocar o parser ────────────────
 * `req.formData()` não aceita limite. Depois de ler os bytes com teto, `new Response(bytes, ...).formData()`
 * faz a MESMA análise multipart da plataforma — nada de parser próprio, que seria a parte mais fácil de
 * errar e a mais difícil de perceber errada.
 */

/**
 * Teto total do corpo, em bytes.
 *
 * ── Por que existe um teto por REQUISIÇÃO, além do teto por arquivo ───────────
 * `UPLOAD_MAX_FILES` × `UPLOAD_MAX_FILE_MB` dá 500 MB com os padrões atuais, e a máquina tem 512 MB. Um
 * teto por requisição é o que faz a conta fechar: permite muitos arquivos pequenos ou poucos grandes, e
 * limita o que cabe na memória de uma vez.
 *
 * A margem cobre o envelope multipart — fronteiras, cabeçalhos de cada parte e os campos comuns
 * (`analysisId`, `materia`). Sem ela, um envio de exatamente o tamanho do teto seria recusado por causa de
 * alguns bytes de protocolo, o que pareceria defeito para quem enviou.
 */
export function tetoDoCorpoEmBytes(): number {
  const MARGEM_DO_ENVELOPE = 1024 * 1024;
  return env.upload.maxRequestMb * 1024 * 1024 + MARGEM_DO_ENVELOPE;
}

/** Mensagem única, para as duas rotas dizerem a mesma coisa. */
export function mensagemDeEnvioGrande(): string {
  return (
    `O envio excede o limite de ${env.upload.maxRequestMb} MB por vez. ` +
    `Envie menos arquivos de uma só vez — cada arquivo pode ter até ${env.upload.maxFileMb} MB.`
  );
}

export type CorpoLido =
  | { ok: true; formData: FormData }
  | { ok: false; erro: string; status: number };

/**
 * Lê o corpo contando os bytes e devolve o `FormData`, ou recusa.
 *
 * Recusa com 413 (payload grande) quando passa do teto, e com 400 quando o corpo não é um multipart
 * válido — recusar cedo é melhor do que deixar o erro estourar dentro da rota.
 */
export async function formDataComTeto(req: Request): Promise<CorpoLido> {
  const teto = tetoDoCorpoEmBytes();

  /** Filtro barato: se quem envia declara tamanho acima do teto, nem começa a ler. */
  const declarado = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declarado) && declarado > teto) {
    return { ok: false, erro: mensagemDeEnvioGrande(), status: 413 };
  }

  const tipo = req.headers.get("content-type") ?? "";
  if (!tipo.toLowerCase().includes("multipart/form-data")) {
    return { ok: false, erro: "Envio inválido: esperado formulário com arquivo.", status: 400 };
  }

  const corpo = req.body;
  if (!corpo) return { ok: false, erro: "Envio inválido: corpo ausente.", status: 400 };

  const partes: Uint8Array[] = [];
  let total = 0;
  const leitor = corpo.getReader();
  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > teto) {
        /**
         * Cancelar o fluxo é o que evita continuar recebendo o resto do arquivo depois de já ter decidido
         * recusar. Sem isso, a recusa economizaria memória e não economizaria rede nem tempo.
         */
        await leitor.cancel().catch(() => {});
        return { ok: false, erro: mensagemDeEnvioGrande(), status: 413 };
      }
      partes.push(value);
    }
  } catch {
    return { ok: false, erro: "Falha ao receber o arquivo. Tente enviar novamente.", status: 400 };
  }

  try {
    const resposta = new Response(Buffer.concat(partes), { headers: { "content-type": tipo } });
    return { ok: true, formData: await resposta.formData() };
  } catch {
    return { ok: false, erro: "Envio inválido: formulário não pôde ser lido.", status: 400 };
  }
}
