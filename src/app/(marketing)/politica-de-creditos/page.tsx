import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/marketing/legal-shell";
import { FAIXAS_CUSTO, MAX_PAGINAS_AUTOMATICO } from "@/lib/credits";
import { AVISO_REVISAO, CREDITOS_MENSAIS, LIMITE_MB_ARQUIVO, PACOTES, PLANOS, precoBR } from "@/lib/planos";
import { ATENDIMENTO, linkWhatsApp } from "@/lib/contato";

export const metadata: Metadata = { title: "Política de Créditos" };

/**
 * As faixas exibidas são DERIVADAS de FAIXAS_CUSTO, nunca escritas no texto: a
 * política publicada e a cobrança precisam dizer o mesmo número. Manter os dois
 * lados em lugares diferentes já causou divergência entre a página de vendas e
 * o que o sistema cobra, e aqui o custo de errar é jurídico, não só comercial.
 *
 * O início de cada faixa é o fim da faixa anterior + 1; a primeira começa em 1.
 */
const FAIXAS = FAIXAS_CUSTO.map((faixa, i) => ({
  de: (i === 0 ? 0 : (FAIXAS_CUSTO[i - 1]?.atePaginas ?? 0)) + 1,
  ate: faixa.atePaginas,
  creditos: faixa.creditos,
  // `maxMb` de FAIXAS_CUSTO não entra: o limite publicado é LIMITE_MB_ARQUIVO, que é
  // o que a tela de envio aplica. Ver o comentário na seção 2.
}));

/**
 * Validade dos créditos avulsos. Só afirmamos um prazo único no texto corrido
 * quando todos os itens avulsos realmente compartilham a mesma validade. Se um
 * dia houver item com prazo diferente, a página passa a remeter à tabela em vez
 * de publicar um prazo que deixou de ser verdade para todos.
 */
const VALIDADES_PACOTE = [...new Set(PACOTES.map((p) => p.validityDays))];
const VALIDADE_UNICA = VALIDADES_PACOTE.length === 1 ? VALIDADES_PACOTE[0] : null;

/**
 * Planos vendidos ao público. O filtro por `contactOnly` continua porque o campo
 * existe no catálogo, mas hoje nenhum plano é sob consulta: a família Empresarial
 * foi extinta na reformulação da oferta.
 */
const PLANOS_COM_COTA = PLANOS.filter((p) => !p.contactOnly);

const num = (n: number) => n.toLocaleString("pt-BR");

export default function CreditosPage() {
  return (
    <LegalShell title="Política de Créditos">
      <p>
        Esta política descreve como os créditos do Prescrição Pro são liberados, consumidos, estornados e
        expirados. Ela integra os <Link href="/termos">Termos de Uso</Link> e vale para todos os planos e créditos
        avulsos.
      </p>

      <h2>1. O que é um crédito</h2>
      <p>
        O crédito é a unidade de consumo da Plataforma. <strong>1 crédito corresponde a 1 análise jurídica de um
        processo</strong> dentro do limite padrão de tamanho. Processos maiores consomem mais de um crédito, porque o
        custo de processamento cresce com o volume de páginas.
      </p>

      <h2>2. Quanto custa cada análise</h2>
      <p>
        O custo é apurado automaticamente pelo número de páginas do processo enviado.
      </p>
      {/*
        A coluna "Tamanho máximo do arquivo" saiu da tabela, e não por estética.
        Ela publicava os 30, 60 e 120 MB de FAIXAS_CUSTO, enquanto a tela de envio
        recusa qualquer arquivo acima de LIMITE_MB_ARQUIVO. Um processo de 300 páginas
        com 40 MB era aceito pelo documento e recusado pelo sistema — divergência que
        o cliente descobre depois de montar o arquivo. O limite publicado passa a ser
        o único que o sistema aplica de fato.
      */}
      <p>
        O envio aceita <strong>um arquivo PDF de até {LIMITE_MB_ARQUIVO} MB</strong>, qualquer que seja a faixa de
        páginas. Processo mais pesado que isso costuma trazer anexos de mídia: a orientação é exportar o PDF sem eles
        ou dividir o processo em partes, enviando cada parte como uma análise.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Tamanho do processo</th>
              <th>Custo</th>
            </tr>
          </thead>
          <tbody>
            {FAIXAS.map((f) => (
              <tr key={f.ate}>
                <td>
                  {f.de === 1 ? `Até ${num(f.ate)} páginas` : `De ${num(f.de)} a ${num(f.ate)} páginas`}
                </td>
                <td>{f.creditos === 1 ? "1 crédito" : `${f.creditos} créditos`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        O custo é informado ao usuário <strong>antes da confirmação do envio</strong>, e nenhum crédito é debitado se o
        envio for recusado.
      </p>

      <h3>Processos acima de {num(MAX_PAGINAS_AUTOMATICO)} páginas</h3>
      <p>
        Acima de {num(MAX_PAGINAS_AUTOMATICO)} páginas o <strong>processamento automático é recusado</strong> e nenhum
        crédito é debitado. Nesses casos o usuário é orientado a solicitar uma <strong>análise especial</strong> aos
        canais de atendimento, que será tratada em condições específicas.
      </p>

      <h2>3. Créditos incluídos no plano</h2>
      <p>
        Os planos vigentes incluem uma <strong>cota de {CREDITOS_MENSAIS} créditos por ciclo mensal</strong>. Isso
        equivale a {CREDITOS_MENSAIS} análises por mês nos processos da primeira faixa da tabela da seção 2, e a menos
        análises quando o processo é maior, porque o custo em créditos acompanha o número de páginas.
      </p>
      <p>
        A cota <strong>não é cumulativa</strong>: o saldo mensal não utilizado <strong>expira na virada do ciclo</strong>
        {" "}e o lançamento fica registrado no extrato. Utilizada a cota, o usuário pode comprar{" "}
        <strong>créditos avulsos</strong> a qualquer momento, na quantidade que precisar e sem alterar a assinatura, nas
        condições da seção 4.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Plano</th>
              <th>Periodicidade</th>
              <th>Créditos por ciclo mensal</th>
              <th>Preço</th>
            </tr>
          </thead>
          <tbody>
            {PLANOS_COM_COTA.map((p) => (
              <tr key={p.slug}>
                <td>{p.name}</td>
                <td>{p.period === "ANUAL" ? "Anual" : "Mensal"}</td>
                {/*
                  Cota 0 continua significando SEM LIMITE em todo o sistema, e nenhum plano
                  vigente usa esse modo — só plano legado. O desvio fica aqui para que a
                  tabela nunca publique "0 créditos" se um dia um plano voltar a ser ilimitado.
                */}
                <td>{p.monthlyCredits === 0 ? "Sem limite" : num(p.monthlyCredits)}</td>
                <td>{precoBR(p.priceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        No plano anual o pagamento é feito uma única vez e o acesso vale por doze meses, com a{" "}
        <strong>mesma cota de {CREDITOS_MENSAIS} créditos liberada a cada ciclo mensal</strong> — e não o total do ano de
        uma só vez. As regras da periodicidade anual estão na seção 8.
      </p>
      <p>
        <strong>Planos contratados anteriormente</strong>, com cota mensal de créditos, seguem as regras vigentes na
        data da contratação: a cota é liberada a cada ciclo mensal, não é cumulativa e o saldo não utilizado expira na
        virada do ciclo, ficando registrado no extrato.
      </p>

      <h2>4. Créditos adicionais (avulsos)</h2>
      <p>
        Quem precisa de mais análises do que a cota mensal do plano pode comprar créditos avulsos{" "}
        <strong>a qualquer momento e na quantidade que quiser</strong>, sem alterar a assinatura, sem trocar de plano e
        sem esperar a renovação do ciclo.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Produto</th>
              <th>Créditos</th>
              <th>Preço</th>
              <th>Validade</th>
            </tr>
          </thead>
          <tbody>
            {PACOTES.map((p) => (
              <tr key={p.slug}>
                <td>{p.name}</td>
                <td>{p.credits}</td>
                <td>{precoBR(p.priceCents)}</td>
                <td>{p.validityDays} dias</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        {VALIDADE_UNICA !== null ? (
          <>
            Os créditos adicionais têm <strong>validade de {VALIDADE_UNICA} dias</strong>, contados da liberação após
            a confirmação do pagamento.
          </>
        ) : (
          <>
            Os créditos adicionais têm a validade indicada na tabela acima, contada da liberação após a confirmação do
            pagamento.
          </>
        )}{" "}
        Vencido o prazo, o saldo não utilizado expira e o lançamento aparece no extrato. Diferentemente do crédito
        mensal, o crédito adicional atravessa a virada do ciclo enquanto estiver dentro da validade.
      </p>

      <h2>5. Ordem de consumo</h2>
      <p>
        O consumo utiliza <strong>primeiro o crédito mensal e depois o crédito adicional</strong>. A ordem existe para
        proteger o usuário: o crédito mensal expira antes, então é o primeiro a ser gasto, e o crédito comprado só é
        tocado quando a cota do plano acaba.
      </p>
      <p>
        Quando uma única análise precisa de mais créditos do que resta na cota mensal, a diferença é retirada dos
        créditos adicionais, e cada origem aparece como um lançamento próprio no extrato.
      </p>

      <h2>6. Débito e estorno</h2>
      <ul>
        <li>
          O crédito é debitado <strong>no momento em que o processamento começa</strong>, e não na conclusão da
          análise.
        </li>
        <li>
          Havendo <strong>erro técnico</strong> no processamento, o estorno é <strong>automático</strong>: os créditos
          voltam para a mesma origem de onde saíram: o que saiu da cota mensal volta para a cota mensal, e o que saiu
          do saldo avulso volta para o saldo avulso, preservando a validade contratada.
        </li>
        <li>
          O envio duplicado da mesma solicitação não gera cobrança em duplicidade: cada análise é debitada uma única
          vez.
        </li>
      </ul>

      <h2>7. Reprocessamento</h2>
      {/*
        A hipótese do provedor de IA indisponível ficou explícita porque a redação
        anterior — "após uma correção técnica" — não a alcançava literalmente: quando o
        provedor cai, a análise é entregue por rotina heurística local e não há nada a
        "corrigir". O Aviso de Responsabilidade já promete o reprocessamento nesse caso;
        sem esta frase, dois documentos do mesmo contrato qualificariam o mesmo evento
        de formas diferentes.
      */}
      <p>
        <strong>Reprocessar a mesma análise após uma correção técnica não consome novo crédito.</strong> O mesmo vale
        quando o resultado foi produzido em <strong>modo de contingência</strong>, por indisponibilidade do provedor de
        inteligência artificial: pedido o reprocessamento ao suporte, ele é feito sem novo consumo. Já uma
        <strong> análise nova</strong> (outro processo, outros documentos, ou nova submissão do mesmo processo por
        opção do usuário) consome crédito conforme a tabela da seção 2.
      </p>
      {/*
        Esta frase descreve exatamente o que o sistema faz — ver `consumirCreditos`, em
        src/lib/credits.ts. A regra publicada permitiria tratar "outros documentos" como
        análise nova e cobrar o custo CHEIO; o sistema cobra apenas a diferença, que é
        mais favorável ao assinante. Escrever isso aqui é o que impede a situação inversa
        no futuro: cobrança de diferença sem previsão no instrumento (arts. 30 e 46 do
        CDC), que é exatamente o defeito que este parágrafo nasceu para fechar — a tela de
        confirmação anunciava "1 análise" e o débito era por faixa de páginas.
      */}
      <p>
        Quando documentos são <strong>acrescentados a uma análise já cobrada</strong> e o processo passa a uma faixa de
        tamanho superior, é debitada <strong>apenas a diferença</strong> entre a faixa nova e o que já foi pago — nunca
        o custo cheio outra vez. O valor a debitar é informado na tela <strong>antes da confirmação</strong>. Se a faixa
        diminuir (documentos removidos), não há devolução: o serviço da faixa maior já foi executado.
      </p>
      <p>
        Resultado insatisfatório do ponto de vista da tese jurídica não caracteriza erro técnico. A conclusão de que
        não há prescrição ou decadência a alegar é um resultado válido da análise e consome crédito normalmente.
      </p>

      <h2>8. Planos anuais</h2>
      {/*
        A cota do anual é MENSAL, não anual: `liberarCreditosDoCiclo` credita
        CREDITOS_MENSAIS a cada ciclo mensal também no plano anual, e o que sobra
        expira na virada. Publicar aqui "12 × a cota, liberadas de uma vez" seria
        prometer um acúmulo que o sistema não faz (arts. 30 e 37 do CDC).
      */}
      <p>
        No plano anual o pagamento é único e o acesso vale os doze meses contratados, mas os créditos são liberados{" "}
        <strong>mês a mês</strong>: a cota de {CREDITOS_MENSAIS} créditos entra a cada ciclo mensal e o total do ano
        nunca é liberado de uma só vez. O que sobra da cota de um ciclo não passa para o seguinte, e a compra de
        créditos avulsos da seção 4 continua disponível a qualquer momento.
      </p>
      <p>
        <strong>Planos legados com cota</strong> (contratados antes da reformulação da oferta) mantêm a regra da época:
        os créditos são liberados <strong>mês a mês</strong>, na mesma quantidade do plano mensal correspondente — o ano
        inteiro nunca é liberado de uma só vez —, e a não cumulatividade da seção 3 se aplica a cada ciclo mensal.
      </p>

      <h2>9. Extrato de créditos</h2>
      <p>
        Toda movimentação fica registrada no extrato de créditos da conta, com <strong>saldo anterior e saldo
        posterior</strong> de cada lançamento, além de data, tipo e descrição. São registrados: créditos liberados pela
        assinatura, créditos utilizados, créditos estornados, créditos adicionais comprados, créditos expirados,
        bônus e ajustes administrativos.
      </p>
      <p>
        O extrato é a fonte oficial de conferência do saldo. Divergências devem ser comunicadas aos canais de
        atendimento indicados na seção 12.
      </p>

      <h2>10. Saldo insuficiente</h2>
      <p>
        Sem saldo suficiente para o custo da análise, o processamento não é iniciado e nenhum crédito é debitado. O
        usuário pode comprar créditos adicionais ou aguardar a próxima renovação.
      </p>

      <h2>11. Avisos obrigatórios</h2>
      <p>{AVISO_REVISAO}</p>
      <ul>
        <li>
          A <strong>responsabilidade pelo protocolo e pelo uso da petição</strong> gerada é exclusivamente do usuário.
        </li>
        <li>
          Os documentos enviados devem ter <strong>finalidade jurídica legítima</strong>. O usuário é responsável por
          observar a LGPD e o sigilo profissional em relação aos dados que submete à Plataforma.
        </li>
      </ul>

      <h2>12. Contato</h2>
      <p>Dúvidas sobre créditos, extrato, estornos ou solicitação de análise especial:</p>
      <ul>
        {ATENDIMENTO.map((canal) => (
          <li key={canal.whatsapp}>
            <strong>{canal.rotulo}:</strong>{" "}
            <a
              href={linkWhatsApp(canal)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-marinho-700 underline hover:text-marca-600"
            >
              {canal.numero}
            </a>
            . {canal.horario}.
          </li>
        ))}
        <li>
          Clientes autenticados podem abrir um chamado em <strong>Suporte</strong> dentro da Plataforma.
        </li>
      </ul>
      <p>
        Documentos relacionados: <Link href="/politica-de-assinatura">Política de Assinatura</Link>,{" "}
        <Link href="/reembolso">Política de Reembolso</Link>, <Link href="/termos">Termos de Uso</Link> e{" "}
        <Link href="/privacidade">Política de Privacidade</Link>.
      </p>
    </LegalShell>
  );
}
