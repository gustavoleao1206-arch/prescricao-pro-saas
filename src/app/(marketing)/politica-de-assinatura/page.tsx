import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/marketing/legal-shell";
import {
  AVISO_REVISAO,
  CREDITOS_MENSAIS,
  PLANOS,
  precoBR,
  VALIDADE_CREDITO_ADICIONAL_DIAS,
  VALOR_UNITARIO_CREDITO_CENTS,
  DIAS_TOLERANCIA_INADIMPLENCIA,
  DIAS_COMPENSACAO_BOLETO,
} from "@/lib/planos";
import { FAIXAS_CUSTO } from "@/lib/credits";
import { ATENDIMENTO, linkWhatsApp } from "@/lib/contato";
import { qualificacaoFornecedor } from "@/lib/fornecedor";

export const metadata: Metadata = { title: "Política de Assinatura" };

/**
 * Preços e cotas saem do catálogo (src/lib/planos.ts) em vez de escritos no
 * texto: a política é documento público e não pode anunciar um preço diferente
 * do que a assinatura cobra.
 */
const PLANOS_ASSINATURA = PLANOS.filter((p) => !p.contactOnly);
const PLANOS_SOB_CONSULTA = PLANOS.filter((p) => p.contactOnly);

/**
 * Faixa padrão de tamanho do processo — a que custa 1 crédito.
 *
 * Sai de FAIXAS_CUSTO porque é ela que traduz "20 créditos" em "20 análises":
 * a equivalência só é verdadeira dentro desta faixa, e é a mesma tabela que a
 * Política de Créditos publica. Escrever "250 páginas" à mão faria a cota
 * prometida aqui divergir do que o motor de créditos cobra.
 */
const FAIXA_PADRAO = FAIXAS_CUSTO[0]!;

const num = (n: number) => n.toLocaleString("pt-BR");

export default function PoliticaDeAssinaturaPage() {
  return (
    <LegalShell title="Política de Assinatura">
      {/*
        A qualificação do fornecedor vem da constante. Este parágrafo escrevia "Leão
        Amorim Advocacia" à mão, seguido de um "[CONFERIR ...]" publicado no ar — e o
        fornecedor é a empresa de tecnologia, não a sociedade de advogados.
      */}
      <p>
        Esta política descreve as regras de contratação, renovação, alteração e encerramento da assinatura do
        Prescrição Pro, fornecido por {qualificacaoFornecedor()}. Ela integra os{" "}
        <Link href="/termos">Termos de Uso</Link> e deve ser lida em conjunto com a{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>, a{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>, a{" "}
        <Link href="/reembolso">Política de Reembolso</Link> e a{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>.
      </p>

      <h2>1. Planos e periodicidade</h2>
      {/*
        A oferta voltou a ter COTA: foi sem limite por um período e o custo medido de
        R$ 1,07 por análise não fecha sem teto — uma única conta de uso intenso consome
        mais do que paga e o preço subiria para todos. Ver o comentário de
        CREDITOS_MENSAIS em src/lib/planos.ts.

        A cota nunca é anunciada sozinha neste documento: dizer o teto sem dizer que
        existe crédito avulso faria a cota parecer uma parede, o que ela não é. Quem
        editar este parágrafo mantém as duas informações juntas.
      */}
      <p>
        A assinatura dá acesso a uma cota de{" "}
        <strong>{CREDITOS_MENSAIS} créditos por ciclo mensal</strong> — o equivalente a {CREDITOS_MENSAIS} análises de
        processo de até {num(FAIXA_PADRAO.atePaginas)} páginas —, a mesma nos dois planos. O que varia entre eles é
        apenas a <strong>periodicidade</strong> da cobrança — mensal ou anual — e o preço correspondente; no plano
        anual a cota é liberada mês a mês. Esgotada a cota, as análises continuam disponíveis por{" "}
        <strong>crédito avulso</strong>, na forma da seção 2. Os limites técnicos que valem para qualquer plano
        (tamanho do arquivo, páginas por processo, ritmo de uso) estão na{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Plano</th>
              <th>Periodicidade</th>
              {/* "Créditos por mês", não "Análises": aqui o texto é contratual, e a
                  equivalência com análise depende do tamanho do processo. */}
              <th>Créditos por mês</th>
              <th>Usuários</th>
              <th>Preço</th>
            </tr>
          </thead>
          <tbody>
            {PLANOS_ASSINATURA.map((p) => (
              <tr key={p.slug}>
                <td>{p.name}</td>
                <td>{p.period === "ANUAL" ? "Anual" : "Mensal"}</td>
                {/* Cota 0 significa SEM LIMITE no sistema (`saldoDe` devolve
                    ilimitado). Nenhum plano vigente usa isso, mas o guarda fica:
                    imprimir o número cru anunciaria "0 créditos" numa política
                    pública — o oposto do que esse plano entrega. */}
                <td>{p.monthlyCredits === 0 ? "Sem limite" : num(p.monthlyCredits)}</td>
                <td>{p.maxUsers}</td>
                <td>{precoBR(p.priceCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {PLANOS_SOB_CONSULTA.length > 0 && (
        <p>
          {PLANOS_SOB_CONSULTA.map((p) => p.name).join(", ")}: condições, cotas e número de usuários definidos sob
          consulta, mediante proposta específica.
        </p>
      )}
      <p>
        Os planos e os preços podem ser atualizados. <strong>Alteração de preço não retroage ao período já pago</strong>
        e é comunicada antes da renovação seguinte, com a antecedência prevista nos{" "}
        <Link href="/termos">Termos de Uso</Link>; discordando, o assinante pode encerrar a assinatura sem ônus antes de
        a nova condição entrar em vigor.
      </p>

      <h2>2. Análises e créditos</h2>
      {/*
        A unidade contratada é o CRÉDITO, não a análise. Dizer só "20 análises por mês"
        seria promessa vinculante (art. 30 do CDC) que o sistema não cumpre num processo
        de 600 páginas, que custa mais de um crédito — daí a equivalência vir sempre
        acompanhada da faixa e da remissão à Política de Créditos.
      */}
      <p>
        A unidade de consumo é o <strong>crédito</strong>: 1 crédito corresponde a 1 análise de processo de até{" "}
        {num(FAIXA_PADRAO.atePaginas)} páginas, e processo maior consome mais de um crédito, na forma da tabela da{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>.
      </p>
      <p>
        Os planos vigentes liberam <strong>{CREDITOS_MENSAIS} créditos por ciclo mensal</strong> — inclusive no plano
        anual, em que a liberação é mês a mês, nunca o ano inteiro de uma vez. O saldo mensal{" "}
        <strong>não é cumulativo</strong>: o que não for utilizado expira na virada do ciclo, quando a cota é reposta
        por inteiro. Cada análise é registrada no extrato da conta, com o saldo anterior e o posterior.
      </p>
      <p>
        Utilizada a cota do ciclo, o assinante pode comprar <strong>créditos avulsos</strong> a{" "}
        {precoBR(VALOR_UNITARIO_CREDITO_CENTS)} cada, na quantidade que precisar e a qualquer momento,{" "}
        <strong>sem alteração do plano</strong> nem da data de renovação. O crédito avulso tem validade de{" "}
        {VALIDADE_CREDITO_ADICIONAL_DIAS} dias contados da liberação e <strong>atravessa a virada do ciclo</strong>; o
        consumo tira primeiro do saldo mensal, que expira antes, e só depois do avulso.
      </p>
      <p>
        <strong>Planos legados com cota</strong>, contratados antes da reformulação da oferta, mantêm as condições da
        época: liberação mês a mês — inclusive no anual, nunca o ano inteiro de uma vez — e saldo não cumulativo, que
        expira na virada do ciclo. As regras completas de consumo, estorno e validade estão na{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>.
      </p>

      <h2>3. Renovação e forma de pagamento</h2>
      {/*
        A renovação NÃO é igual nas três formas de pagamento, e o texto tem de dizer
        isso. Anunciar "renovação automática" sem ressalva prometeria ao cliente de
        PIX uma continuidade que o meio não permite — não existe mandato de débito em
        PIX comum, então não há como cobrar o ciclo seguinte. É a mesma distinção que
        o sistema aplica: `nextRenewalAt` nulo significa "vale um ciclo e encerra".
      */}
      <p>
        A renovação observa a periodicidade contratada — mensal a cada mês, anual a cada doze meses — e depende da
        forma de pagamento escolhida:
      </p>
      <ul>
        <li>
          <strong>Cartão de crédito:</strong> renovação automática. Ao fim de cada período a cobrança é processada e o
          acesso segue sem interrupção, até que o usuário cancele.
        </li>
        <li>
          <strong>Boleto bancário:</strong> renovação automática mediante pagamento. Um novo boleto é emitido a cada
          ciclo e enviado por e-mail. O acesso é liberado após a <strong>confirmação bancária do pagamento</strong>,
          que ocorre em prazo de 1 (um) a 3 (três) dias úteis contados do pagamento.
        </li>
        <li>
          <strong>PIX:</strong> pagamento único, <strong>sem renovação automática</strong>. O acesso vale o período
          contratado e encerra ao fim do prazo; para continuar, é necessário contratar novamente.
        </li>
      </ul>
      <p>A liberação do acesso e dos créditos é automática após a confirmação do pagamento.</p>

      <h2>4. Alteração de plano</h2>
      <h3>Upgrade</h3>
      <p>
        A mudança para um plano superior <strong>passa a valer após a confirmação do pagamento</strong>, com liberação
        imediata da nova cota de créditos e dos demais limites do plano contratado.
      </p>
      <h3>Downgrade</h3>
      <p>
        A mudança para um plano inferior <strong>não interrompe o período já pago</strong>: o plano atual permanece
        vigente até o fim do ciclo, e o novo plano, com a cota e os limites correspondentes, entra em vigor
        <strong> na renovação seguinte</strong>. Não há devolução proporcional do período em curso.
      </p>
      {/*
        A regra fica porque a troca de plano pode reduzir o número de acessos num
        catálogo futuro; hoje os dois planos vigentes têm o mesmo número de usuários,
        então ela não tem hipótese de aplicação. Escrita no condicional, não promete
        variação que não existe.
      */}
      <p>
        Havendo, no catálogo vigente, plano com número de acessos menor que o contratado, a troca para ele exige ajustar
        os acessos excedentes antes da renovação.
      </p>

      <h2>5. Cobrança</h2>
      <p>
        A cobrança e o processamento do pagamento são realizados por <strong>processadora de pagamento contratada</strong>,
        empresa terceira responsável pela transação. Os dados de pagamento são fornecidos diretamente ao ambiente
        seguro dessa processadora e não transitam pela Plataforma. Meios de pagamento aceitos, comprovantes e gestão da
        recorrência seguem as regras da processadora e ficam disponíveis na área do assinante.
      </p>

      <h2>6. Inadimplência</h2>
      <p>Não confirmado o pagamento na data da renovação:</p>
      <ul>
        <li>
          O usuário recebe <strong>aviso no painel</strong> e comunicação por e-mail, com orientação para regularizar.
        </li>
        {/*
          Aqui estava escrito que "o acesso ao histórico é mantido", sem ressalva —
          e não é o que o sistema faz. Encerrada a tolerância, o titular ENTRA e vê a
          listagem das análises, mas o download de documento, de relatório e de peça
          passa pelo mesmo guarda de assinatura ativa (`assertActiveSubscription`).
          Prometer a retirada do material sem ressalva é promessa que o sistema não
          cumpre (art. 30 do CDC), e no pior momento: quando o cliente precisa dos
          próprios autos. A saída honesta é dizer a verdade E garantir a via da
          exportação, que é atendida por pedido mesmo sem acesso.
        */}
        <li>
          O <strong>histórico das análises continua visível</strong> na conta. A retirada de arquivos, relatórios e
          minutas — como qualquer nova análise — <strong>depende de regularizar o pagamento</strong>. Precisando do
          material antes disso, basta pedir a <strong>exportação</strong> pelos canais de atendimento da seção 9: o
          pedido é atendido independentemente do estado da assinatura, na forma do art. 18, V, da Lei nº 13.709/2018.
        </li>
        <li>
          <strong>Novas análises são bloqueadas</strong> após o período de tolerância de{" "}
          {DIAS_TOLERANCIA_INADIMPLENCIA} dias contados do vencimento. Durante a tolerância o acesso é mantido para
          dar tempo de regularizar um pagamento recusado.
        </li>
        <li>
          Regularizado o pagamento, o acesso é restabelecido automaticamente. Créditos mensais do ciclo em que houve o
          bloqueio não são recompostos retroativamente.
        </li>
        {/*
          O boleto tem regra própria porque não existe nova tentativa de cobrança: o
          boleto simplesmente vence. O prazo de {DIAS_COMPENSACAO_BOLETO} dias é a
          janela de COMPENSAÇÃO bancária, não cortesia — quem paga no dia do
          vencimento só é confirmado depois, e cancelar antes disso encerraria a
          assinatura de quem pagou em dia.
        */}
        <li>
          <strong>Pagamento por boleto:</strong> vencido o boleto sem pagamento, a assinatura é{" "}
          <strong>encerrada</strong> e as cobranças seguintes deixam de ser emitidas. O encerramento ocorre após{" "}
          {DIAS_COMPENSACAO_BOLETO} dias contados do vencimento, prazo destinado à compensação bancária de boleto pago
          na data-limite. Para retomar o acesso, é necessário contratar novamente.
        </li>
      </ul>
      <p>
        Persistindo a inadimplência, a assinatura pode ser suspensa ou encerrada, observadas as regras de retenção de
        dados da <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>.
      </p>

      <h2>7. Cancelamento</h2>
      <ul>
        <li>O cancelamento pode ser solicitado a qualquer momento, pelos canais indicados na seção 9.</li>
        <li>
          O cancelamento <strong>interrompe as renovações futuras</strong>; não gera, por si só, devolução de valores
          do período em curso.
        </li>
        <li>
          O <strong>acesso é mantido até o fim do período já pago</strong>. Durante esse prazo os créditos do ciclo
          continuam disponíveis.
        </li>
        <li>
          O <strong>histórico é preservado</strong> após o encerramento, pelo prazo definido na Política de
          Cancelamento e Retenção.
        </li>
        <li>
          A <strong>reativação é possível</strong>: contratando novamente, a conta e o histórico anterior são
          retomados, desde que dentro do prazo de retenção.
        </li>
      </ul>
      <p>
        O direito de arrependimento e as hipóteses de devolução de valores estão na{" "}
        <Link href="/reembolso">Política de Reembolso</Link>.
      </p>

      <h2>8. Avisos obrigatórios</h2>
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
      <p>
        A assinatura dá acesso a uma ferramenta de apoio. Não há contratação de serviço de advocacia, consultoria
        individualizada ou parecer jurídico definitivo.
      </p>

      <h2>9. Contato</h2>
      <p>Solicitações de alteração de plano, cancelamento ou regularização de pagamento:</p>
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
    </LegalShell>
  );
}
