#!/usr/bin/env node
/**
 * Postgres descartável para os testes que precisam de banco de verdade.
 *
 * ── Por que existe ────────────────────────────────────────────────────────────
 * Os testes de crédito, do webhook de pagamento e da exclusão de conta (ver
 * TESTES_DE_BANCO, no fim deste arquivo) vão ao banco de propósito: a idempotência
 * que protege o caixa vive na transação e na chave da razão, e a cascata de
 * exclusão vive nas chaves estrangeiras — nada disso se prova com mock. Sem um
 * Postgres no ar, esses testes simplesmente não rodavam, e eram justamente os que
 * cobrem dinheiro.
 *
 * O docker-compose.yml resolveria, mas o Docker Desktop desta máquina está
 * quebrado. Este script dispensa Docker: baixa os binários oficiais do
 * PostgreSQL 16 pelo npm (mesma major da produção no Render) e sobe um servidor
 * local numa porta própria (55432), sem instalar serviço no Windows e sem
 * privilégio de administrador.
 *
 * ── Por que o banco mora FORA do projeto ──────────────────────────────────────
 * O `initdb` falha com "invalid byte sequence for encoding UTF8: 0xe3 0x6f 0x2f"
 * quando o caminho dos binários contém caractere acentuado — e um perfil de
 * usuário como `C:\Users\João\` basta. O `0xe3 0x6f` é o "ão" de "João" lido na
 * codepage antiga do Windows enquanto o servidor esperava UTF-8. Por isso tanto
 * os binários quanto o diretório de dados ficam em BASE, um caminho só com ASCII.
 * (É forte candidato a ser a mesma causa do Docker quebrado nesta máquina.)
 *
 * ── Uso ───────────────────────────────────────────────────────────────────────
 *   npm test                 a suíte inteira (sobe o banco sozinho)
 *   npm run test:db          só os testes que precisam de banco
 *   npm run test:sem-banco   só os que não precisam (mais rápido)
 *   npm run db:teste:parar   desliga o servidor
 *   node scripts/pg-teste.mjs status
 *
 * O diretório de dados é descartável: pode apagar BASE a qualquer momento; o
 * próximo `start` recria tudo. Nenhum dado real trafega aqui.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fora do projeto e sem acento — ver o cabeçalho.
/**
 * Onde o banco de teste mora, por sistema.
 *
 * No Windows o caminho tem de ficar FORA do perfil do usuário por causa do acento
 * (ver o cabeçalho). Em macOS e Linux não existe esse problema, e usar o
 * diretório temporário do sistema é o esperado — deixar `C:/Users/Public` fixo
 * fazia o `npm test` falhar no primeiro comando em qualquer máquina que não fosse
 * a do Windows.
 */
const BASE =
  process.env.PTP_PG_BASE ??
  (process.platform === "win32" ? "C:/Users/Public/ptp-pgtest" : join(tmpdir(), "ptp-pgtest"));
const PORTA = Number(process.env.PTP_PG_PORT ?? 55432);
const USUARIO = "ptp";
const SENHA = "ptp";
const BANCO = "postgres";

const DADOS = join(BASE, "data");
const LOG = join(BASE, "log.txt");
const ARQUIVO_SENHA = join(BASE, "pw.txt");

/** Postgres 16: mesma major da produção, para o teste valer como evidência. */
const VERSAO = "16.14.0-beta.17";
const PACOTES = {
  win32: { x64: "@embedded-postgres/windows-x64" },
  darwin: { arm64: "@embedded-postgres/darwin-arm64", x64: "@embedded-postgres/darwin-x64" },
  linux: { x64: "@embedded-postgres/linux-x64", arm64: "@embedded-postgres/linux-arm64" },
};

export const URL_BANCO = `postgresql://${USUARIO}:${SENHA}@127.0.0.1:${PORTA}/${BANCO}?schema=public`;

/**
 * Conexão do usuário NÃO-DONO. É esta que os testes de RLS usam — com a do dono, a política é ignorada e
 * o teste passaria nos dois estados.
 */
export const URL_BANCO_APLICACAO = `postgresql://ptp_app:ptp_app@127.0.0.1:${PORTA}/${BANCO}?schema=public`;

function pacoteDaPlataforma() {
  const nome = PACOTES[process.platform]?.[process.arch];
  if (!nome) {
    throw new Error(`Sem binários de Postgres para ${process.platform}/${process.arch}.`);
  }
  return nome;
}

function dirBin() {
  return join(BASE, "node_modules", pacoteDaPlataforma(), "native", "bin");
}

function exe(nome) {
  return join(dirBin(), process.platform === "win32" ? `${nome}.exe` : nome);
}

/**
 * Aspas para o shell. Não use JSON.stringify aqui: ele DOBRA as contrabarras do
 * caminho do Windows (`C:\Users` viraria `C:\\Users`), e o que chega ao comando
 * deixa de ser o caminho original.
 */
const q = (s) => `"${s}"`;

/**
 * Monta a linha de comando já pronta para o shell.
 *
 * Passar `args` separados COM `shell: true` dispara o aviso DEP0190 do Node em
 * cada chamada (os argumentos são concatenados sem escape, então a separação é
 * ilusória). Aqui a concatenação é explícita e o `q()` cuida das aspas.
 */
const linha = (cmd, args) => [cmd, ...args].join(" ");

function rodar(cmd, args, opcoes = {}) {
  const r = spawnSync(linha(cmd, args), { stdio: "inherit", shell: true, ...opcoes });
  if (r.status !== 0) {
    throw new Error(`Falhou: ${cmd} ${args.join(" ")} (código ${r.status})`);
  }
}

/** Baixa os binários do Postgres na primeira vez. */
function garantirBinarios() {
  if (existsSync(exe("initdb"))) return;
  console.log(`→ baixando binários do PostgreSQL 16 em ${BASE} (só na primeira vez)`);
  mkdirSync(BASE, { recursive: true });
  if (!existsSync(join(BASE, "package.json"))) {
    writeFileSync(join(BASE, "package.json"), JSON.stringify({ name: "ptp-pgtest", private: true }, null, 2));
  }
  const pacote = pacoteDaPlataforma();
  rodar("npm", ["install", `${pacote}@${VERSAO}`, "--no-audit", "--no-fund"], { cwd: BASE });
  // O npm 11 não executa postinstall de pacote novo sem aprovação interativa, e
  // é esse script que materializa os binários. Chamamos direto.
  const hidratar = join(BASE, "node_modules", pacote, "scripts", "hydrate-symlinks.js");
  if (existsSync(hidratar)) rodar("node", [q(hidratar)], { cwd: BASE });
  if (!existsSync(exe("initdb"))) throw new Error("binários baixados, mas initdb não apareceu.");
}

/** Cria o cluster (uma vez). */
function garantirCluster() {
  if (existsSync(join(DADOS, "PG_VERSION"))) return;
  console.log("→ criando o cluster (initdb)");
  writeFileSync(ARQUIVO_SENHA, SENHA);
  // locale=C evita mistura entre a codepage do Windows e a codificação UTF-8.
  rodar(q(exe("initdb")), [
    "-D", q(DADOS),
    "-U", USUARIO,
    `--pwfile=${q(ARQUIVO_SENHA)}`,
    "--encoding=UTF8",
    "--locale=C",
  ]);
}

function noAr(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const s = connect(PORTA, "127.0.0.1");
    const fim = (v) => { s.destroy(); resolve(v); };
    s.on("connect", () => fim(true));
    s.on("error", () => resolve(false));
    setTimeout(() => fim(false), timeoutMs);
  });
}

async function esperar(ligado, limiteMs = 60000) {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if ((await noAr()) === ligado) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

async function start() {
  garantirBinarios();
  garantirCluster();
  if (await noAr()) {
    console.log(`→ Postgres já estava no ar em 127.0.0.1:${PORTA}`);
    return;
  }
  console.log("→ subindo o Postgres");
  /**
   * `stdio: "ignore"` + `detached` são obrigatórios: o `pg_ctl` deixa o processo
   * do servidor herdando a saída padrão, então qualquer pipe (um `| tail`, por
   * exemplo) fica pendurado para sempre esperando o servidor fechar a saída.
   */
  const p = spawn(
    linha(q(exe("pg_ctl")), ["-D", q(DADOS), "-l", q(LOG), "-o", `"-p ${PORTA}"`, "start"]),
    { stdio: "ignore", shell: true, detached: true },
  );
  p.unref();
  if (!(await esperar(true))) throw new Error(`o Postgres não subiu — veja ${LOG}`);
  console.log(`→ no ar em 127.0.0.1:${PORTA}`);
}

async function stop() {
  if (!existsSync(exe("pg_ctl")) || !existsSync(join(DADOS, "PG_VERSION"))) {
    console.log("→ nada para parar");
    return;
  }
  if (!(await noAr())) {
    console.log("→ já estava desligado");
    return;
  }
  console.log("→ desligando");
  spawnSync(linha(q(exe("pg_ctl")), ["-D", q(DADOS), "-m", "fast", "stop"]), {
    stdio: "ignore",
    shell: true,
  });
  await esperar(false, 20000);
  console.log("→ desligado");
}

function migrar() {
  console.log("→ aplicando as migrações no banco de teste");
  rodar("npx", ["prisma", "migrate", "deploy"], { env: { ...process.env, DATABASE_URL: URL_BANCO } });
  criarUsuarioDeAplicacao();
}

/**
 * Cria o usuário NÃO-DONO usado para provar a tranca de linha (RLS).
 *
 * ⚠️ Sem isto, nenhum teste de RLS prova nada: a suíte conecta como superusuário, e superusuário ignora
 * política de RLS SEMPRE. Um teste de isolamento rodando como superusuário passa com a tranca ligada e
 * passa com ela desligada — exatamente o teste que este projeto proíbe.
 *
 * Roda depois das migrações porque os GRANT precisam das tabelas já criadas.
 */
function criarUsuarioDeAplicacao() {
  console.log("→ criando o usuário de aplicação (para os testes de RLS valerem)");
  rodar("npx", ["prisma", "db", "execute", "--file", "prisma/rls/usuario-de-teste.sql", "--schema", "prisma/schema.prisma"], {
    env: { ...process.env, DATABASE_URL: URL_BANCO },
  });
}

/** Roda o vitest apontado para o banco de teste. */
function testar(alvos) {
  const r = spawnSync(linha("npx", ["vitest", "run", ...alvos]), {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: URL_BANCO },
  });
  return r.status ?? 1;
}

/** Os arquivos que exigem banco. Os demais rodam em `npm test` sem nada no ar. */
const TESTES_DE_BANCO = [
  "tests/retencao.test.ts",
  "tests/analise-sem-texto-nao-cobra.test.ts",
  "tests/tranca-do-banco.test.ts",
  "tests/cifragem-de-paginas.test.ts",
  "tests/creditos.test.ts",
  "tests/asaas-creditos.test.ts",
  "tests/asaas-email-falha.test.ts",
  "tests/asaas-payload-real.test.ts",
  "tests/asaas-metodo-pagamento.test.ts",
  "tests/asaas-boleto.test.ts",
  "tests/asaas-dinheiro-sem-destino.test.ts",
  "tests/downgrade.test.ts",
  "tests/analise-travada.test.ts",
  "tests/webhook-falha.test.ts",
  "tests/reprocessamento-equipe.test.ts",
  "tests/boleto-rota.test.ts",
  "tests/organizacao-sob-demanda.test.ts",
  "tests/revisao-contestacao.test.ts",
  "tests/ciclo-anual.test.ts",
  "tests/apagar-conta.test.ts",
  "tests/ativacao-manual.test.ts",
  "tests/reconciliacao.test.ts",
  "tests/reconciliacao-sem-credencial.test.ts",
  "tests/pedido-do-titular.test.ts",
  "tests/sessao-inatividade.test.ts",
  "tests/troca-de-papel.test.ts",
  "tests/reenviar-verificacao.test.ts",
  "tests/contratar-exige-email.test.ts",
  "tests/troca-de-email.test.ts",
  "tests/troca-email-e-senha.test.ts",
  "tests/avisos-de-email.test.ts",
  "tests/troca-email-oraculo-de-senha.test.ts",
  "tests/link-de-email-reaberto.test.ts",
  "tests/cancelar-troca-pelo-titular.test.ts",
  "tests/link-nao-reativa-conta.test.ts",
  "tests/situacao-da-analise.test.ts",
  "tests/rota-situacao-analise.test.ts",
  "tests/estorno-do-entregue.test.ts",
  "tests/estorno-concorrente-e-varredura.test.ts",
  "tests/trilha-de-leitura.test.ts",
];

const comando = process.argv[2] ?? "test";

switch (comando) {
  case "setup":
    garantirBinarios();
    garantirCluster();
    console.log("→ pronto. Use: npm run test:db");
    break;
  case "start":
    await start();
    console.log(`DATABASE_URL=${URL_BANCO}`);
    break;
  case "stop":
    await stop();
    break;
  case "status":
    console.log((await noAr()) ? `no ar em 127.0.0.1:${PORTA}` : "desligado");
    break;
  case "test":
    await start();
    migrar();
    process.exit(testar(TESTES_DE_BANCO));
  // eslint-disable-next-line no-fallthrough
  case "test:tudo":
    await start();
    migrar();
    process.exit(testar([]));
  // eslint-disable-next-line no-fallthrough
  default:
    console.error(`Comando desconhecido: ${comando}\nUse: setup | start | stop | status | test | test:tudo`);
    process.exit(2);
}
