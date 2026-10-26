import { describe, it, expect } from "vitest";
import { can, permissionsFor } from "../src/lib/rbac";

describe("RBAC — matriz de permissões", () => {
  it("cliente pode criar análise, mas não gerenciar usuários", () => {
    expect(can("CLIENTE", "analysis:create")).toBe(true);
    expect(can("CLIENTE", "user:manage")).toBe(false);
    expect(can("CLIENTE", "analysis:read:all")).toBe(false);
  });

  it("revisor pode decidir revisão e editar linha do tempo", () => {
    expect(can("REVISOR", "review:decide")).toBe(true);
    expect(can("REVISOR", "timeline:edit")).toBe(true);
    expect(can("REVISOR", "user:manage")).toBe(false);
  });

  it("suporte não acessa documentos jurídicos por padrão", () => {
    expect(can("SUPORTE", "support:handle")).toBe(true);
    expect(can("SUPORTE", "analysis:read:all")).toBe(false);
    expect(can("SUPORTE", "report:download:own")).toBe(false);
  });

  it("admin possui as permissões sensíveis", () => {
    expect(can("ADMIN", "user:manage")).toBe(true);
    expect(can("ADMIN", "prompt:manage")).toBe(true);
    expect(can("ADMIN", "data:anonymize")).toBe(true);
    expect(can("ADMIN", "analysis:read:all")).toBe(true);
  });

  it("permissionsFor retorna lista não vazia por papel", () => {
    for (const role of ["ADMIN", "CLIENTE", "REVISOR", "SUPORTE"] as const) {
      expect(permissionsFor(role).length).toBeGreaterThan(0);
    }
  });
});
