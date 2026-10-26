import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

/**
 * O docker-compose de desenvolvimento só publica portas em 127.0.0.1.
 *
 * As senhas dele são triviais de propósito (o banco é "ptp"/"ptp", o Redis não tem senha), porque o ambiente
 * só existe na máquina de quem desenvolve. Isso só é verdade enquanto a porta não sai da máquina: sem o
 * prefixo de endereço, o Docker publica em 0.0.0.0 e qualquer um na mesma rede alcança o banco.
 */

type Servico = { ports?: string[] };
const compose = load(readFileSync("docker-compose.yml", "utf8")) as { services: Record<string, Servico> };

describe("⚠️ docker-compose publica só no endereço local", () => {
  const portas = Object.entries(compose.services).flatMap(([nome, s]) => (s.ports ?? []).map((p) => [nome, p] as const));

  it("há portas publicadas (o teste mede alguma coisa)", () => {
    expect(portas.length).toBeGreaterThan(0);
  });

  it.each(portas)("%s: %s começa com 127.0.0.1", (_servico, porta) => {
    expect(porta.startsWith("127.0.0.1:")).toBe(true);
  });
});
