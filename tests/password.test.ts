import { describe, it, expect } from "vitest";
import { validatePasswordStrength } from "../src/lib/password";

describe("política de senha", () => {
  it("aceita senha forte", () => {
    expect(validatePasswordStrength("Senha@Forte1")).toEqual([]);
  });
  it("rejeita senha curta", () => {
    expect(validatePasswordStrength("Ab1@").length).toBeGreaterThan(0);
  });
  it("exige variedade de caracteres", () => {
    expect(validatePasswordStrength("somentelminusculas")).toContain("Inclua ao menos uma letra maiúscula.");
    expect(validatePasswordStrength("SEMNUMEROSNEM@")).toContain("Inclua ao menos um número.");
  });
});
