import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/marketing/legal-shell";
import { AVISO_REVISAO } from "@/lib/planos";
import { ATENDIMENTO, linkWhatsApp } from "@/lib/contato";

export const metadata: Metadata = { title: "Política de Reembolso" };

/**
 * Prazo de resposta conclusiva ao consumidor: art. 4º do Decreto nº 11.034/2022,
 * que regulamenta o SAC. Vira constante para não ser reescrito à mão em cada seção
 * que o cita — e para que mudá-lo seja uma decisão visível, não um typo.
 */
const PRAZO_RESPOSTA_SAC_DIAS = 7;

export default function ReembolsoPage() {
  return (
    <LegalShell title="Política de Reembolso">
      <p>
        Esta política descreve as hipóteses e o procedimento de devolução de valores pagos pela assinatura e pelos
        créditos avulsos do Prescrição Pro. Ela integra os <Link href="/termos">Termos de Uso</Link> e deve ser lida
        em conjunto com a <Link href="/politica-de-assinatura">Política de Assinatura</Link> e a{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>.
      </p>

      <h2>1. Direito de arrependimento (7 dias)</h2>
      <p>
        A contratação do Prescrição Pro é feita <strong>fora do estabelecimento comercial</strong>, pela internet.
        Aplica-se, portanto, o <strong>art. 49 do Código de Defesa do Consumidor</strong>: o consumidor pode desistir
        da contratação no prazo de <strong>7 (sete) dias corridos</strong>, contados da data da contratação ou da
        liberação do acesso, o que ocorrer por último.
      </p>
      <p>
        Exercido o arrependimento dentro do prazo, os valores pagos são <strong>devolvidos integralmente</strong>,
        monetariamente atualizados na forma da lei, e a assinatura é encerrada.
      </p>
      {/*
        O "[DEFINIR]" que estava PUBLICADO aqui foi resolvido, e na mesma direção que
        a Política de Cancelamento e Retenção: devolução integral, sem desconto por
        análise realizada. Das duas posições sustentáveis, esta é a que o art. 49
        comporta — o parágrafo único manda devolver "os valores eventualmente pagos, a
        qualquer título, durante o prazo de reflexão", e experimentar o serviço é a
        própria finalidade do prazo. Descontar criaria ônus não previsto em lei
        (art. 51, I e IV) e transformaria cada arrependimento numa discussão sobre
        preço de análise avulsa.
      */}
      <p>
        <strong>Nenhum valor é retido ou descontado por análise realizada durante os 7 dias.</strong> Usar o serviço no
        prazo de reflexão é o que a lei assegura ao consumidor, e o art. 49, parágrafo único, do Código de Defesa do
        Consumidor não autoriza retenção. Os relatórios e as minutas já baixados permanecem com o usuário, sem cobrança.
        Créditos avulsos comprados no período são devolvidos pelo valor pago, e o saldo não utilizado é cancelado com o
        lançamento correspondente no extrato.
      </p>

      <h2>2. Como solicitar</h2>
      <p>A solicitação pode ser feita por qualquer um dos canais abaixo, e deve indicar:</p>
      <ul>
        <li>nome e e-mail cadastrados na conta;</li>
        <li>identificação da compra (assinatura ou créditos avulsos) e a data;</li>
        <li>o motivo da solicitação.</li>
      </ul>
      <p>
        Recebida a solicitação, ela é registrada e encaminhada à plataforma de pagamento. O usuário recebe confirmação
        do protocolo e do encaminhamento.
      </p>

      <h2>3. Prazos</h2>
      <ul>
        <li>
          <strong>Solicitação:</strong> até 7 dias corridos da contratação, na hipótese de arrependimento.
        </li>
        {/*
          Outro "[DEFINIR]" que estava publicado. O prazo não é escolha livre: o art. 4º
          do Decreto 11.034/2022 (regulamento do SAC) dá 7 dias corridos para a resposta
          conclusiva ao consumidor, e é esse o compromisso assumido — com resposta de
          recebimento imediata, que é o que evita o cliente sem notícia.
        */}
        <li>
          <strong>Análise e encaminhamento:</strong> o recebimento é confirmado de imediato, com protocolo, e a{" "}
          <strong>resposta conclusiva é dada em até {PRAZO_RESPOSTA_SAC_DIAS} dias corridos</strong> do pedido, na forma
          do art. 4º do Decreto nº 11.034/2022. Deferido o pedido, a ordem de devolução é encaminhada à processadora de
          pagamento no mesmo prazo.
        </li>
        <li>
          <strong>Devolução:</strong> o crédito efetivo depende do meio de pagamento utilizado e do prazo da
          administradora do cartão ou da instituição financeira. Em compras no cartão de crédito, a devolução costuma
          aparecer em fatura posterior à do lançamento original.
        </li>
      </ul>

      <h2>4. O que acontece com os créditos</h2>
      <ul>
        <li>
          Deferido o reembolso, a assinatura é encerrada e os <strong>créditos não utilizados são cancelados</strong>,
          com o lançamento correspondente no extrato de créditos.
        </li>
        <li>
          <strong>Análises já realizadas permanecem no histórico</strong> enquanto durar o acesso, e os créditos
          consumidos por elas não retornam ao saldo, pois o serviço correspondente foi prestado.
        </li>
        <li>
          Créditos estornados por <strong>erro técnico</strong> não são consumo: retornam automaticamente ao saldo, na
          forma da <Link href="/politica-de-creditos">Política de Créditos</Link>, e não dependem de pedido de reembolso.
        </li>
      </ul>

      <h2>5. Fora do prazo de arrependimento</h2>
      <p>
        Encerrados os 7 dias, a assinatura segue as regras de cancelamento: as renovações futuras são interrompidas e
        o acesso é mantido até o fim do período já pago, <strong>sem devolução proporcional</strong> do período em
        curso, salvo falha na prestação do serviço ou disposição legal aplicável. Créditos avulsos, por
        terem liberação imediata e validade própria, não são reembolsáveis após o prazo de arrependimento.
      </p>
      <p>
        Resultado desfavorável da análise não caracteriza falha na prestação do serviço. A conclusão de que não há
        prescrição ou decadência a alegar é um resultado válido, e a indicação favorável não representa garantia de
        êxito judicial.
      </p>

      <h2>6. Estorno e chargeback</h2>
      <p>
        Estorno é a devolução solicitada e processada pela plataforma de pagamento. <em>Chargeback</em> é a contestação
        da cobrança feita diretamente à administradora do cartão, sem passar pelo atendimento. Recebido qualquer um
        desses eventos:
      </p>
      {/*
        O primeiro item dizia que "o acesso a novas análises é interrompido", promessa
        branda e falsa: em assinatura ESTORNADA ou SUSPENSA o próprio login é recusado
        (src/app/api/auth/login/route.ts:91), então o titular não entra nem para
        consultar. Descrever menos do que o sistema faz é pior que descrever demais —
        a pessoa descobre no momento em que tenta entrar. Dito o efeito real, a
        contrapartida obrigatória é o prazo da revisão e a via de exportação.
      */}
      <ul>
        <li>
          a <strong>assinatura é suspensa e o acesso à conta é bloqueado</strong> enquanto durar a revisão — não apenas
          o de novas análises, mas também a consulta ao histórico;
        </li>
        <li>
          os <strong>créditos não utilizados são bloqueados</strong>;
        </li>
        <li>
          o caso é <strong>encaminhado para revisão administrativa</strong>, que apura a origem da contestação e as
          análises já realizadas, no <strong>prazo previsto na</strong>{" "}
          <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>;
        </li>
        <li>
          durante o bloqueio, o pedido de <strong>exportação dos dados</strong> apresentado pelos canais de atendimento
          é atendido normalmente, na forma do art. 18, V, da Lei nº 13.709/2018 — o bloqueio alcança o uso do serviço,
          nunca o direito do titular aos próprios dados;
        </li>
        <li>
          concluída a revisão, o acesso é restabelecido ou o encerramento é confirmado, e o usuário é comunicado da
          decisão, com motivação.
        </li>
      </ul>
      <p>
        Recomendamos procurar o atendimento antes de abrir um <em>chargeback</em>: o pedido pelos canais oficiais é
        resolvido de forma mais rápida e não implica bloqueio preventivo da conta.
      </p>

      <h2>7. Plataforma de pagamento</h2>
      <p>
        O reembolso é <strong>operado pela processadora de pagamento</strong>, empresa terceira responsável pela
        transação. A devolução é executada pelo mesmo meio utilizado na compra, observados os prazos e as regras dessa
        processadora e da instituição financeira envolvida. O acompanhamento da solicitação também pode ser feito na
        área do assinante.
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

      <h2>9. Contato</h2>
      <p>Pedidos de reembolso e dúvidas sobre cobranças:</p>
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
