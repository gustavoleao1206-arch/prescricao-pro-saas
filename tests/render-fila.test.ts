import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";

/**
 * A fila de análises no blueprint do Render: Key Value (Redis) + worker.
 *
 * ── Por que um teste sobre um arquivo de configuração ─────────────────────────
 * O `render.yaml` é aplicado no push. Um erro nele não quebra um recurso: quebra a sincronização do
 * blueprint inteiro, e a partir daí NENHUM deploy sobe — o mesmo mecanismo que já deixou produção 22 dias
 * servindo build velho. E os erros mais prováveis aqui são silenciosos: worker sem a chave de cifragem
 * (toda análise falha com "página ilegível"), worker com valor diferente do web (comportamento diverge
 * entre o que o cliente vê e o que a fila faz), política de memória de cache numa fila (análise
 * enfileirada some sem erro).
 *
 * Este arquivo lê o YAML de verdade e recusa cada um desses estados.
 */

type EnvVar = {
  key: string;
  value?: string;
  sync?: boolean;
  generateValue?: boolean;
  fromDatabase?: { name: string; property: string };
  fromService?: { name: string; type: string; property?: string; envVarKey?: string };
};
type Servico = {
  type: string;
  name: string;
  plan?: string;
  runtime?: string;
  dockerCommand?: string;
  maxmemoryPolicy?: string;
  ipAllowList?: unknown[];
  envVars?: EnvVar[];
};

const blueprint = load(readFileSync("render.yaml", "utf8")) as { services: Servico[] };
const servico = (nome: string) => blueprint.services.find((s) => s.name === nome)!;
const variavel = (s: Servico, chave: string) => s.envVars?.find((v) => v.key === chave);

const web = servico("prescricao-pro");
const fila = servico("prescricao-pro-fila");
const worker = servico("prescricao-pro-worker");

describe("a fila (Render Key Value)", () => {
  it("existe, é keyvalue e só aceita a rede interna", () => {
    expect(fila).toBeDefined();
    expect(fila.type).toBe("keyvalue");
    expect(fila.ipAllowList).toEqual([]);
  });

  it("⚠️ política de memória é noeviction — cache apaga chave, fila não pode", () => {
    /**
     * O padrão do Render é `allkeys-lru`, política de CACHE: quando a memória enche, chaves são apagadas.
     * Para o BullMQ, chave apagada é análise enfileirada que desaparece sem erro nenhum. `noeviction` faz
     * memória cheia RECUSAR trabalho novo — falha visível, que é a que se quer.
     */
    expect(fila.maxmemoryPolicy).toBe("noeviction");
  });
});

describe("o worker de análises", () => {
  it("existe, usa a mesma imagem Docker e roda o consumidor da fila", () => {
    expect(worker).toBeDefined();
    expect(worker.type).toBe("worker");
    expect(worker.runtime).toBe("docker");
    expect(worker.dockerCommand).toContain("src/lib/queue/worker.ts");
    /** A trava do server-only: sem o tsconfig dos scripts o worker morre no boot (ver CONTRIBUTING.md). */
    expect(worker.dockerCommand).toContain("--tsconfig tsconfig.scripts.json");
  });

  it("recebe o Redis da fila e o banco do próprio blueprint", () => {
    expect(variavel(worker, "REDIS_URL")?.fromService).toEqual({
      name: "prescricao-pro-fila",
      type: "keyvalue",
      property: "connectionString",
    });
    expect(variavel(worker, "DATABASE_URL")?.fromDatabase).toEqual({
      name: "prescricao-pro-db",
      property: "connectionString",
    });
    expect(variavel(worker, "QUEUE_DRIVER")?.value).toBe("bullmq");
  });

  it("⚠️ os segredos que o processamento precisa vêm do web — os MESMOS valores", () => {
    /**
     * FIELD_ENCRYPTION_KEY é a que abre o texto cifrado dos processos: com valor diferente, toda análise
     * falha com "página ilegível" (src/lib/pagina-do-processo.ts). AUTH_SECRET é exigido no boot em
     * produção (src/lib/env.ts): sem ele o worker nem sobe. Os demais são o que a análise lê: IA, bucket
     * dos PDFs e e-mail de alerta de operação.
     */
    for (const chave of [
      "AUTH_SECRET",
      "FIELD_ENCRYPTION_KEY",
      "OPENAI_API_KEY",
      "S3_ENDPOINT",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "RESEND_API_KEY",
    ]) {
      const v = variavel(worker, chave);
      expect(v?.fromService, chave).toEqual({ name: "prescricao-pro", type: "web", envVarKey: chave });
      /** E o web tem de DECLARAR a variável referenciada, senão o Render recusa o blueprint. */
      expect(variavel(web, chave), `${chave} referenciada pelo worker mas ausente no web`).toBeDefined();
    }
  });

  it("⚠️ valores espelhados do web são IGUAIS aos do web — sem deriva", () => {
    /**
     * OPENAI_MODEL diferente = o cliente vê o orçamento calculado para um modelo e a análise roda em
     * outro. OCR_CONCORRENCIA diferente = memória estourando num processo e não no outro. Cada valor que o
     * worker copia do web tem de ser cópia de verdade, e este teste é o que impede os dois arquivos de se
     * afastarem em silêncio numa edição futura.
     */
    for (const chave of [
      "NODE_ENV",
      "APP_NAME",
      "APP_URL",
      "AI_PROVIDER",
      "OPENAI_MODEL",
      "AI_MAX_OUTPUT_TOKENS",
      "AI_MAX_KNOWLEDGE_CHARS",
      "AI_MAX_CORPUS_CHARS",
      "USD_BRL",
      "OCR_CONCORRENCIA",
      "UPLOAD_MAX_PAGINAS",
      "STORAGE_DRIVER",
      "S3_REGION",
      "S3_BUCKET",
      "EMAIL_DRIVER",
      "EMAIL_FROM",
      "OPERACAO_EMAIL",
    ]) {
      expect(variavel(worker, chave)?.value, chave).toBe(variavel(web, chave)?.value);
    }
  });

  it("não roda migração nem o site — só consome a fila", () => {
    expect(worker.dockerCommand).not.toContain("prisma migrate");
    expect(worker.dockerCommand).not.toContain("server.js");
  });
});

describe("⚠️ a troca em dois pushes", () => {
  it("o web já recebe o REDIS_URL, para o segundo push ser uma palavra", () => {
    expect(variavel(web, "REDIS_URL")?.fromService).toEqual({
      name: "prescricao-pro-fila",
      type: "keyvalue",
      property: "connectionString",
    });
  });

  it("o web continua em async até o worker ser observado — mude ESTE teste junto com o render.yaml", () => {
    /**
     * Push 1 (este): worker sobe, conecta, fica ocioso; nada muda para o cliente. Push 2: trocar o web
     * para `bullmq`. Este teste existe para a troca ser uma decisão consciente, com o teste atualizado
     * no mesmo commit — e não um efeito colateral de outra edição no arquivo.
     */
    expect(variavel(web, "QUEUE_DRIVER")?.value).toBe("async");
  });
});
