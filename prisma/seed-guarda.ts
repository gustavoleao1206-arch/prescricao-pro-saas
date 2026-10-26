import { validatePasswordStrength } from "../src/lib/password";

/**
 * Trava do seed para PRODUÇÃO — o que ele se recusa a gravar num banco de verdade.
 *
 * ── O buraco que isto fecha ───────────────────────────────────────────────────
 * O seed já exigia SEED_ADMIN_EMAIL e SEED_ADMIN_PASSWORD, mas só conferia se existiam. O `.env.example`
 * trazia `SEED_ADMIN_PASSWORD=Admin@Demo123`, a mesma senha publicada no README e no manual do administrador.
 * Quem montasse o `.env` de produção a partir do exemplo e rodasse o seed criava um ADMINISTRADOR com senha
 * pública — e ela passa na política de senha do sistema (13 caracteres, maiúscula, número e símbolo), então
 * nada mais a barrava.
 *
 * As contas de demonstração (revisor, suporte, cliente) têm o mesmo problema por construção: nascem com
 * senha de demonstração. Fora de produção nascem por padrão; em produção só com SEED_DEMO=true — e uma
 * delas é REVISOR, papel que lê análise de cliente.
 *
 * ── Por que só em produção ────────────────────────────────────────────────────
 * Em desenvolvimento as contas de demonstração são o objetivo do seed, e o banco é descartável. A régua é a
 * mesma variável que a aplicação usa para se comportar como produção: NODE_ENV=production, que a imagem
 * Docker define — inclusive no Shell do Render, que é de onde o seed de produção roda.
 *
 * Fica num arquivo próprio para ser testável sem banco (tests/seed-guarda.test.ts). A lista abaixo é de
 * senhas PROIBIDAS; o seed em si continua sem nenhum valor padrão de senha de administrador.
 */

/** Senhas de demonstração que já foram documentadas em versões anteriores do projeto (lista de bloqueio). */
export const SENHAS_DE_DEMONSTRACAO = ["Admin@Demo123", "Revisor@Demo123", "Suporte@Demo123", "Cliente@Demo123"] as const;

/**
 * Mínimo para o administrador criado pelo seed em produção.
 *
 * Acima dos 10 da política geral (src/lib/password.ts) porque é a conta mais privilegiada do sistema e é
 * escolhida uma vez, por quem administra — não por um cliente no meio do cadastro.
 */
export const TAMANHO_MINIMO_SENHA_ADMIN_PRODUCAO = 12;

/** Família das senhas de demonstração (`<Papel>@Demo123`), para pegar variações como `Admin@Demo1234`. */
const PADRAO_DE_DEMONSTRACAO = /@demo/i;

export type OpcoesDoSeed = {
  /** NODE_ENV === "production". */
  producao: boolean;
  senhaAdmin: string;
  /** Se o seed vai criar as contas e os dados de demonstração. */
  semearDemo: boolean;
};

/**
 * Lista o que impede o seed de rodar. Vazia = pode seguir.
 *
 * Devolve TODOS os problemas de uma vez: quem está no Shell do Render corrigindo a variável não deve descobrir
 * o segundo motivo só na segunda tentativa.
 */
export function problemasDoSeed({ producao, senhaAdmin, semearDemo }: OpcoesDoSeed): string[] {
  if (!producao) return [];

  const problemas: string[] = [];

  if (semearDemo) {
    problemas.push(
      "SEED_DEMO=true em produção criaria as contas de demonstração (revisor, suporte e cliente) com as senhas " +
        "publicadas no repositório. Para um ambiente de demonstração, rode o seed com NODE_ENV=development.",
    );
  }

  const normalizada = senhaAdmin.trim().toLowerCase();
  const ehDeDemonstracao =
    SENHAS_DE_DEMONSTRACAO.some((s) => s.toLowerCase() === normalizada) || PADRAO_DE_DEMONSTRACAO.test(senhaAdmin);
  if (ehDeDemonstracao) {
    problemas.push(
      "SEED_ADMIN_PASSWORD é uma senha de demonstração publicada no repositório. Escolha uma senha sua, " +
        "guardada no gerenciador de senhas.",
    );
  }

  if (senhaAdmin.length < TAMANHO_MINIMO_SENHA_ADMIN_PRODUCAO) {
    problemas.push(
      `SEED_ADMIN_PASSWORD precisa ter ao menos ${TAMANHO_MINIMO_SENHA_ADMIN_PRODUCAO} caracteres em produção.`,
    );
  }

  /**
   * A mesma política que o sistema aplica a toda troca de senha — o administrador não pode nascer abaixo dela.
   * O item de tamanho da política (10) é descartado porque o mínimo acima já é mais alto e já foi avisado.
   */
  for (const p of validatePasswordStrength(senhaAdmin)) {
    if (!p.includes("caracteres")) problemas.push(`SEED_ADMIN_PASSWORD: ${p}`);
  }

  return problemas;
}
