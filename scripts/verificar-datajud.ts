/**
 * Teste de integração manual do cliente DataJud.
 *
 * Fica fora da suíte do vitest de propósito: bate na API do CNJ, e teste que
 * depende de serviço externo no ar quebra a suíte por motivo que não é
 * regressão de código.
 *
 *   npx tsx scripts/verificar-datajud.ts [numeroDoProcesso]
 */

import { consultarProcesso, DataJudError, formatarNumero } from "../src/lib/pje/datajud";

const PADRAO = "99999997220264058400"; // fictício: passe um número real como argumento

async function main() {
  const numero = process.argv[2] ?? PADRAO;
  console.log(`Consultando ${formatarNumero(numero)} ...\n`);

  try {
    const processo = await consultarProcesso(numero);

    if (!processo) {
      console.log("Processo não consta no índice público do DataJud.");
      process.exitCode = 1;
      return;
    }

    console.log(`  tribunal        : ${processo.tribunal} (grau ${processo.grau})`);
    console.log(`  órgão julgador  : ${processo.orgaoJulgador}`);
    console.log(`  classe          : ${processo.classe}`);
    console.log(`  assuntos        : ${processo.assuntos.join("; ") || "—"}`);
    console.log(
      `  ajuizamento     : ${processo.dataAjuizamento?.toLocaleDateString("pt-BR") ?? "—"}`,
    );
    console.log(`  nível de sigilo : ${processo.nivelSigilo}`);
    console.log(`  movimentos      : ${processo.movimentos.length}`);

    const primeiro = processo.movimentos[0];
    const ultimo = processo.movimentos[processo.movimentos.length - 1];
    if (primeiro && ultimo) {
      console.log(
        `\n  primeiro : ${primeiro.dataHora.toLocaleDateString("pt-BR")} — ${primeiro.nome}`,
      );
      console.log(
        `  último   : ${ultimo.dataHora.toLocaleDateString("pt-BR")} — ${ultimo.nome}`,
      );
    }

    // Confirma a premissa do módulo: o índice público não traz dado pessoal.
    const chaves = Object.keys(processo);
    const pessoais = chaves.filter((k) => /parte|cpf|cnpj|nome|documento/i.test(k));
    console.log(
      `\n  campos com dado pessoal: ${pessoais.length === 0 ? "nenhum (esperado)" : pessoais.join(", ")}`,
    );
  } catch (erro) {
    if (erro instanceof DataJudError) {
      console.error(`Falhou [${erro.codigo}]: ${erro.message}`);
      process.exitCode = 1;
      return;
    }
    throw erro;
  }
}

main();
