/**
 * Operação longa em andamento no navegador — o que não pode ser interrompido pelo relógio
 * de inatividade.
 *
 * ── O defeito que isto conserta ───────────────────────────────────────────────
 * O encerramento por inatividade conta interação real: clique, tecla, rolagem, toque. Subir
 * um documento não gera nenhum dos quatro. A pessoa escolhe o arquivo (isso é interação),
 * clica em enviar (idem) e então espera — e um PDF de execução fiscal com centenas de páginas
 * em conexão comum leva minutos. Passando do prazo, a tela ia para o login NO MEIO DO ENVIO:
 * a requisição em voo era abortada pela navegação e o documento se perdia. Com 10 minutos de
 * prazo para a equipe, isso não é caso de borda.
 *
 * ── O critério, e por que ele é estreito ──────────────────────────────────────
 * Vale para operação que o NAVEGADOR está executando com os dados da pessoa — uma requisição
 * em voo carregando o arquivo dela. Não vale para espera passiva por trabalho do servidor
 * (acompanhar um processamento, por exemplo): ali a pessoa pode ter saído de perto, e é
 * justamente o caso que o encerramento existe para pegar. A distinção importa: a primeira é
 * limitada pela transferência e destrói trabalho se cortada; a segunda pode durar
 * indefinidamente e não perde nada.
 *
 * Registrar o fim como atividade é deliberado. Sem isso, um envio de vinte minutos terminaria
 * e a sessão morreria no instante seguinte, com a pessoa ali, olhando o arquivo que acabou de
 * subir e perdendo o passo seguinte — o pior momento possível para encerrar.
 *
 * ── Por que módulo, e não contexto do React ───────────────────────────────────
 * Quem precisa da informação (`EncerrarPorInatividade`) está montado no layout, e quem a
 * produz (as telas de envio) está em outra parte da árvore. Um provedor comum obrigaria a
 * envolver a aplicação inteira para transportar um contador. Estado de módulo é compartilhado
 * por todo o pacote do cliente e resolve sem essa cerimônia.
 */

let emAndamento = 0;

/**
 * Marca o começo de uma operação longa e devolve a função que a encerra.
 *
 * A forma "devolve o encerramento" existe para o par não se separar: quem inicia recebe o
 * fim na mão e o chama no `finally`. Duas funções soltas — iniciar e encerrar — é como o
 * segundo é esquecido num caminho de erro, e contador que nunca zera desliga o encerramento
 * por inatividade para sempre, em silêncio.
 */
export function iniciarOperacaoLonga(): () => void {
  emAndamento++;
  let encerrada = false;
  return () => {
    // Idempotente: chamar duas vezes não pode zerar a conta de outra operação em paralelo.
    if (encerrada) return;
    encerrada = true;
    emAndamento = Math.max(0, emAndamento - 1);
  };
}

/** Há operação longa em andamento agora? */
export function temOperacaoLonga(): boolean {
  return emAndamento > 0;
}

/**
 * Envolve uma operação longa, garantindo o encerramento em qualquer desfecho.
 *
 * É a forma preferida: o `finally` não pode ser esquecido porque não é escrito por quem
 * chama. Erro e sucesso soltam o contador do mesmo jeito.
 */
export async function durante<T>(operacao: () => Promise<T>): Promise<T> {
  const encerrar = iniciarOperacaoLonga();
  try {
    return await operacao();
  } finally {
    encerrar();
  }
}
