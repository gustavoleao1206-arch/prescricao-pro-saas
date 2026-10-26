import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { env } from "./env";

/**
 * Utilitários de criptografia:
 *  - encryptField/decryptField: AES-256-GCM para dados sensíveis em repouso
 *    (ex.: CPF/CNPJ). A chave vem de FIELD_ENCRYPTION_KEY (base64, 32 bytes).
 *  - sha256: hash para checksums de documentos e para tokens (comparação).
 *  - hmac: assinatura HMAC (validação de webhooks).
 *  - randomToken: geração de tokens opacos (verificação de e-mail, sessão).
 */

/**
 * Já avisamos que a chave de campo está ausente? Uma vez por processo é o suficiente: repetir a cada
 * cadastro encheria o log e a mensagem que importa se perderia no meio.
 */
let avisouChaveAusente = false;

function getKey(): Buffer {
  const raw = env.fieldEncryptionKey;
  if (!raw) {
    /**
     * ⚠️ ESTA QUEDA ERA SILENCIOSA, E O SILÊNCIO É O DEFEITO.
     *
     * Sem `FIELD_ENCRYPTION_KEY`, a chave de cifragem passa a ser derivada do `AUTH_SECRET` — sem erro,
     * sem log, sem checar se está em produção. Duas consequências, e a primeira é perda de dado:
     *
     *  1. Trocar o `AUTH_SECRET` — que é exatamente o que se faz depois de qualquer incidente de sessão —
     *     torna TODO CPF/CNPJ já cifrado impossível de ler. Em silêncio, e sem volta.
     *  2. Duas fechaduras passam a ter a mesma chave: quem comprometer o segredo de sessão decifra dado
     *     pessoal.
     *
     * ── Em PRODUÇÃO, recusa. Em desenvolvimento, avisa ────────────────────────
     * A variável foi confirmada preenchida no painel do Render em 17/08/2026, e é isso que permite
     * recusar: a queda para a chave derivada deixa de ser possível onde há dado real. Se a variável
     * desaparecer um dia, o cadastro para com erro em vez de gravar CPF com a chave errada — e dado
     * gravado com a chave errada é dado que ninguém recupera depois.
     *
     * Em desenvolvimento a queda continua, com o alarme: exigir a variável em cada máquina nova
     * quebraria a suíte de testes e o primeiro `npm run dev` de quem clona o repositório, sem proteger
     * dado nenhum — ali não há dado real.
     */
    if (env.isProd) {
      throw new Error(
        "[crypto] FIELD_ENCRYPTION_KEY ausente em PRODUÇÃO. Recusando cifrar: a alternativa seria " +
          "derivar a chave do AUTH_SECRET, e todo CPF/CNPJ gravado assim se tornaria ilegível na " +
          "próxima troca do AUTH_SECRET. Configure a variável no painel do Render.",
      );
    }
    if (!avisouChaveAusente) {
      avisouChaveAusente = true;
      console.error(
        "[crypto] ⚠️ FIELD_ENCRYPTION_KEY ausente. CPF/CNPJ está sendo cifrado com uma chave DERIVADA do " +
          "AUTH_SECRET — trocar o AUTH_SECRET tornaria esses dados ilegíveis. Em desenvolvimento é " +
          "esperado e não há dado real; em produção esta função recusa.",
      );
    }
    return createHash("sha256").update(env.authSecret).digest();
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("FIELD_ENCRYPTION_KEY deve ter 32 bytes (base64).");
  }
  return key;
}

export function encryptField(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Formato: iv.tag.ciphertext (base64), com versão para rotação futura.
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

export function decryptField(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const parts = payload.split(".");
  const [version, ivB64, tagB64, dataB64] = parts;
  if (parts.length !== 4 || version !== "v1" || !ivB64 || !tagB64 || !dataB64) return null;
  try {
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const data = Buffer.from(dataB64, "base64");
    const decipher = createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString("utf8");
  } catch {
    return null;
  }
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacSha256(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Comparação em tempo constante para evitar timing attacks. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Máscara para exibição de documentos sensíveis (ex.: ***.***.**9-00). */
export function maskDocument(doc: string | null): string {
  if (!doc) return "";
  const digits = doc.replace(/\D/g, "");
  if (digits.length <= 4) return "•".repeat(digits.length);
  return "•".repeat(digits.length - 4) + digits.slice(-4);
}
