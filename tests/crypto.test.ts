import { describe, it, expect } from "vitest";
import { encryptField, decryptField, sha256, hmacSha256, safeEqual, maskDocument } from "../src/lib/crypto";

describe("criptografia de campos (AES-256-GCM)", () => {
  it("faz roundtrip encrypt/decrypt", () => {
    const enc = encryptField("123.456.789-00");
    expect(enc).toMatch(/^v1\./);
    expect(decryptField(enc)).toBe("123.456.789-00");
  });
  it("retorna null para payload inválido", () => {
    expect(decryptField("invalido")).toBeNull();
    expect(decryptField(null)).toBeNull();
  });
});

describe("hash e comparação", () => {
  it("sha256 é determinístico", () => {
    expect(sha256("abc")).toBe(sha256("abc"));
    expect(sha256("abc")).not.toBe(sha256("abd"));
  });
  it("hmac depende do segredo", () => {
    expect(hmacSha256("x", "s1")).not.toBe(hmacSha256("x", "s2"));
  });
  it("safeEqual compara corretamente", () => {
    expect(safeEqual("token", "token")).toBe(true);
    expect(safeEqual("token", "outro")).toBe(false);
  });
});

describe("máscara de documento", () => {
  it("mostra apenas os últimos 4 dígitos", () => {
    expect(maskDocument("123.456.789-00")).toMatch(/8900$/);
    expect(maskDocument(null)).toBe("");
  });
});
