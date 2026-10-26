import { describe, it, expect } from "vitest";
import { authenticator } from "otplib";
import { generateSecret, verifyTotp, generateBackupCodes, matchBackupCode } from "../src/lib/twofactor";

describe("2FA — TOTP", () => {
  it("verifica um código gerado pelo mesmo segredo", () => {
    const secret = generateSecret();
    const token = authenticator.generate(secret);
    expect(verifyTotp(secret, token)).toBe(true);
  });
  it("rejeita um código incorreto", () => {
    const secret = generateSecret();
    const token = authenticator.generate(secret);
    const errado = token === "000000" ? "111111" : "000000";
    expect(verifyTotp(secret, errado)).toBe(false);
  });
});

describe("2FA — códigos de backup", () => {
  it("gera 10 códigos e garante uso único", () => {
    const { plain, hashed } = generateBackupCodes();
    expect(plain).toHaveLength(10);
    expect(hashed).toHaveLength(10);

    const primeiro = plain[0]!;
    const m = matchBackupCode(hashed, primeiro);
    expect(m.ok).toBe(true);
    expect(m.remaining).toHaveLength(9);
    // Consumido: não bate mais na lista restante.
    expect(matchBackupCode(m.remaining, primeiro).ok).toBe(false);
  });

  it("aceita o código com ou sem hífen e ignorando maiúsculas", () => {
    const { plain, hashed } = generateBackupCodes();
    const normalizado = plain[0]!.replace("-", "").toUpperCase();
    expect(matchBackupCode(hashed, normalizado).ok).toBe(true);
  });
});
