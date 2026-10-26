import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import nextConfig from "../next.config.mjs";

/**
 * O otimizador de imagem do Next (`/_next/image`) fica desligado.
 *
 * ── Por que um teste para uma linha de configuração ───────────────────────────
 * O endpoint vem LIGADO por padrão, mesmo sem nenhum uso de `next/image`, e foi por ele que passaram os dois
 * advisories críticos de execução remota de código sem autenticação do Next 14 e 15 (GHSA-2464-fhr4-w9xw e
 * GHSA-2xp9-vwfh-vxw4). Apagar `images: { unoptimized: true }` não quebra tela nenhuma nem teste nenhum —
 * religa a superfície em silêncio. Este arquivo existe para que religar seja uma decisão visível.
 *
 * Com `unoptimized: true`, o servidor do Next responde 404 em `/_next/image` antes de ler a URL pedida.
 */

describe("⚠️ /_next/image desligado", () => {
  it("next.config.mjs declara images.unoptimized = true", () => {
    expect(nextConfig.images?.unoptimized).toBe(true);
  });

  it("nenhum loader externo de imagem foi configurado no lugar", () => {
    /** Loader diferente de "default" também desliga o endpoint, mas passa a mandar a URL da imagem a terceiros. */
    expect(nextConfig.images?.loader ?? "default").toBe("default");
    expect(nextConfig.images?.loaderFile).toBeUndefined();
  });

  it("nenhum arquivo de src/ usa next/image — desligar não muda nada na tela", () => {
    /**
     * Se um dia `next/image` entrar no código, este teste avisa que a decisão precisa ser revista: a imagem
     * continua aparecendo com o otimizador desligado, só deixa de ser redimensionada no servidor.
     */
    const usos: string[] = [];
    const varrer = (dir: string) => {
      for (const nome of readdirSync(dir)) {
        const caminho = join(dir, nome);
        if (statSync(caminho).isDirectory()) varrer(caminho);
        else if (/\.(tsx?|jsx?|mjs)$/.test(nome) && /from\s+["']next\/(legacy\/)?image["']/.test(readFileSync(caminho, "utf8"))) {
          usos.push(caminho);
        }
      }
    };
    varrer("src");
    expect(usos).toEqual([]);
  });
});
