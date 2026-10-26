import { authenticator } from "otplib";
import { randomBytes } from "node:crypto";
import { sha256, encryptField, decryptField } from "./crypto";

/**
 * Autenticação em dois fatores (TOTP, RFC 6238) com otplib.
 *  - O segredo é criptografado em repouso (AES-256-GCM) via encryptSecret/decryptSecret.
 *  - Códigos de backup são armazenados como hash sha-256 (uso único).
 *  - Tolerância de ±1 janela (30s) para relógios levemente dessincronizados.
 */

authenticator.options = { window: 1 };

const ISSUER = "Prescrição Pro";

export function generateSecret(): string {
  return authenticator.generateSecret();
}

export function otpauthUrl(email: string, secret: string): string {
  return authenticator.keyuri(email, ISSUER, secret);
}

export function verifyTotp(secret: string, token: string): boolean {
  try {
    return authenticator.verify({ token: normalize(token), secret });
  } catch {
    return false;
  }
}

/** Gera o QR code como data URI PNG (import dinâmico do qrcode). */
export async function qrDataUrl(otpauth: string): Promise<string> {
  const QRCode = (await import("qrcode")).default;
  return QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
}

/** Gera códigos de backup — retorna os textos (mostrados 1x) e os hashes (armazenar). */
export function generateBackupCodes(quantidade = 10): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  for (let i = 0; i < quantidade; i++) {
    const raw = randomBytes(5).toString("hex"); // 10 hex chars
    plain.push(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  const hashed = plain.map((c) => sha256(normalize(c)));
  return { plain, hashed };
}

/** Confere um código de backup; se válido, retorna a lista restante (uso único). */
export function matchBackupCode(hashed: string[], code: string): { ok: boolean; remaining: string[] } {
  const h = sha256(normalize(code));
  const idx = hashed.indexOf(h);
  if (idx === -1) return { ok: false, remaining: hashed };
  return { ok: true, remaining: hashed.filter((_, i) => i !== idx) };
}

function normalize(code: string): string {
  return code.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

// Criptografia do segredo em repouso (reexport para clareza semântica).
export const encryptSecret = encryptField;
export const decryptSecret = decryptField;
