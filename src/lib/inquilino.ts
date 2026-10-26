import { prisma } from "./db";
import type { Prisma } from "@prisma/client";

/**
 * Informa ao BANCO de quem é a consulta, para a tranca de linha (RLS) poder decidir.
 *
 * ── O que isto protege ────────────────────────────────────────────────────────
 * Hoje o isolamento entre escritórios existe só na aplicação: cada consulta filtra por
 * `organizationId` na mão. Basta uma rota nova esquecer o filtro para um cliente ler os autos de outro —
 * e nenhum erro apareceria, porque a consulta seria válida. A política no banco é a segunda linha:
 * mesmo que a aplicação erre, o Postgres recusa a linha.
 *
 * ── Por que precisa de transação ──────────────────────────────────────────────
 * A política lê `current_setting('app.organizacao')`. Esse valor precisa valer para AQUELA consulta e
 * para mais nenhuma: com pool de conexões, uma conexão atende clientes diferentes em sequência, e um
 * valor que sobrevivesse à consulta faria o próximo cliente herdar o inquilino do anterior — exatamente
 * o vazamento que a tranca existe para impedir. `SET LOCAL` vale só até o fim da transação, e é por isso
 * que tudo aqui roda dentro de uma.
 *
 * O custo é real e está registrado: uma ida a mais ao banco por operação. Foi medido como aceitável para
 * os caminhos que tocam conteúdo de processo, que são poucos; não é para ser usado em toda consulta do
 * sistema.
 *
 * ── ⚠️ Enquanto a aplicação conectar como DONA das tabelas, isto não protege ──
 * O Postgres ignora política de RLS para o dono da tabela, e a `DATABASE_URL` de produção é a do usuário
 * dono. As políticas estão instaladas e inertes: passam a valer quando a aplicação passar a conectar com
 * um usuário próprio, criado no painel do Render. Ver `prisma/rls/usuario-de-aplicacao.sql`.
 *
 * Isto é dito aqui porque a diferença é invisível: o código roda igual nos dois casos, e só um teste com
 * usuário não-dono distingue "protegido" de "parece protegido".
 */

/**
 * `definirInquilino` e `definirPapelDeServico` são exportadas para que o TESTE possa exercitar exatamente
 * o mesmo SQL com uma conexão de usuário não-dono — a única forma de a prova valer, já que a política é
 * ignorada para o dono das tabelas.
 */

/** Nomes das variáveis de sessão. Iguais aos usados nas políticas da migração. */
const CHAVE_ORGANIZACAO = "app.organizacao";
const CHAVE_PAPEL = "app.papel";

/** Cliente dentro da transação. É por ele que a consulta enxerga o inquilino definido. */
export type ClienteComInquilino = Prisma.TransactionClient;

/**
 * Roda `fn` com o inquilino definido para o banco.
 *
 * `set_config(chave, valor, true)` é o equivalente de `SET LOCAL` que aceita parâmetro — e parâmetro é o
 * que impede injeção pelo id da organização. Interpolar o id numa string de SQL seria abrir, dentro da
 * própria trava de segurança, o buraco que ela existe para fechar.
 */
export async function definirInquilino(tx: ClienteComInquilino, organizationId: string): Promise<void> {
  await tx.$executeRaw`SELECT set_config(${CHAVE_ORGANIZACAO}, ${organizationId}, true)`;
}

export async function definirPapelDeServico(tx: ClienteComInquilino): Promise<void> {
  await tx.$executeRaw`SELECT set_config(${CHAVE_PAPEL}, 'servico', true)`;
}

export async function comInquilino<T>(
  organizationId: string,
  fn: (tx: ClienteComInquilino) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await definirInquilino(tx, organizationId);
    return fn(tx);
  });
}

/**
 * Roda `fn` como SERVIÇO: enxerga todas as organizações.
 *
 * ── Por que esta porta existe, e por que ela não é preguiça ───────────────────
 * O webhook de pagamento do Asaas DESCOBRE de quem é a cobrança consultando o banco: ele recebe uma
 * referência externa e precisa achar a assinatura correspondente. Não há como saber o inquilino antes de
 * consultar — é a natureza do fluxo, não código melhorável. Sem esta porta, a consulta voltaria vazia, o
 * cliente pagaria e não receberia acesso, e nada seria registrado como erro.
 *
 * O mesmo vale para a rotina diária de créditos e para a varredura de análises travadas, que percorrem
 * todas as organizações por definição.
 *
 * ⚠️ É uma chave-mestra. Todo uso deve ser um fluxo SEM inquilino por natureza — nunca um atalho para
 * não passar o `organizationId` que se tem à mão.
 */
export async function comoServico<T>(fn: (tx: ClienteComInquilino) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await definirPapelDeServico(tx);
    return fn(tx);
  });
}
