import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/marketing/legal-shell";
import { FORNECEDOR, qualificacaoFornecedor } from "@/lib/fornecedor";
import { ATENDIMENTO, SAC, linkWhatsApp } from "@/lib/contato";
import {
  AVISO_REVISAO,
  CREDITOS_MENSAIS,
  DIAS_COMPENSACAO_BOLETO,
  DIAS_TOLERANCIA_INADIMPLENCIA,
  PLANOS,
  VALIDADE_CREDITO_ADICIONAL_DIAS,
} from "@/lib/planos";
import { PRAZO_REVISAO_DIAS_UTEIS } from "@/lib/revisao-contestacao";
import { PRAZO_RESPOSTA_TITULAR_DIAS as PRAZO_RESPOSTA_TITULAR_LGPD } from "@/lib/pedido-do-titular";
import { RETENCAO } from "@/lib/retencao";

export const metadata: Metadata = {
  title: "Política de Cancelamento, Suspensão e Retenção de Dados",
};

/**
 * Prazos de retenção — a fonte mudou de endereço (set/2026).
 *
 * Este bloco dizia, com razão, que "não há rotina de expurgo" e que publicar os
 * prazos aqui criava a obrigação de executá-los. A obrigação foi cumprida: os
 * números agora vivem em `@/lib/retencao`, importados por ESTA página, pela
 * Política de Privacidade e pela manutenção diária que executa a parte
 * executável (sessões mortas e o teto da auditoria). A tabela da seção 8, o
 * texto corrido e a rotina leem a mesma constante — divergência interna num
 * contrato de adesão é o que o art. 46 do CDC pune com a inexigibilidade.
 *
 * A DECISÃO DO DONO sobre `conteudoMeses` (6 vs 12 meses) está documentada no
 * próprio módulo, junto do que segue manual e por quê.
 */

/**
 * Resposta completa ao titular: prazo do art. 19, II, da LGPD.
 *
 * ⚠️ Deixou de ser digitado aqui. O mesmo número estava nesta página e na Política de
 * Privacidade, cada uma com a sua constante — e este documento afirma, na seção de prazos,
 * que "no mesmo prazo é executada a exclusão ou a anonimização". Isso é promessa que agora
 * tem mecanismo: `vigiarPrazosDoTitular` mede o prazo praticado e avisa antes e depois do
 * vencimento. Três lugares dependendo do número, um só lugar guardando ele.
 *
 * É o mesmo arranjo de `PRAZO_REVISAO_CONTESTACAO_DIAS_UTEIS`, logo abaixo: documento e
 * sistema não podem anunciar prazos diferentes.
 */
const PRAZO_RESPOSTA_TITULAR_DIAS = PRAZO_RESPOSTA_TITULAR_LGPD;

/**
 * Prazo de reflexão do art. 49 do CDC. O número aparece no título da seção 3, no
 * preâmbulo e nos efeitos do arrependimento: fica numa constante para que essas
 * menções não se separem numa revisão futura.
 */
const PRAZO_ARREPENDIMENTO_DIAS = 7;

/** Revisão administrativa de estorno/chargeback — a Política de Reembolso promete a revisão sem prazo; o prazo é assumido aqui. */
/**
 * O prazo da revisão vem do MÓDULO que o aplica, não de um número escrito aqui.
 *
 * Ele deixou de ser só texto: a manutenção diária mede este prazo e restabelece o
 * acesso quando ele vence sem decisão, e o painel administrativo o exibe na linha da
 * assinatura. Duplicar o número faria o documento prometer um prazo e o sistema
 * cumprir outro — ver src/lib/revisao-contestacao.ts.
 */
const PRAZO_REVISAO_CONTESTACAO_DIAS_UTEIS = PRAZO_REVISAO_DIAS_UTEIS;

/**
 * Prazos do estorno no arrependimento — obrigação contratual, não medida pelo sistema.
 *
 * O parágrafo único do art. 49 do CDC manda devolver "de imediato": o prazo da
 * ORDEM de devolução é do fornecedor e é o que fica prometido aqui. O CRÉDITO
 * efetivo depende da processadora, mas o risco da demora não pode ser jogado no
 * consumidor (art. 51, I, do CDC) — daí o limite após o qual o fornecedor devolve
 * por outro meio. A Política de Reembolso §3 deixou este prazo em [DEFINIR]; até
 * que ela seja atualizada, este documento é o único que dá um número ao cliente.
 */
const PRAZO_ORDEM_ESTORNO_DIAS_UTEIS = 2;
const PRAZO_LIMITE_DEVOLUCAO_DIAS = 30;

/** Aviso prévio de descontinuação do serviço ou de um plano. */
const PRAZO_DESCONTINUACAO_DIAS = 30;

/**
 * Acessos por plano, do catálogo: o texto só afirma um número enquanto o catálogo
 * disser isso. O número vive em `PLANOS` (maxUsers) e é gravado como snapshot na
 * assinatura — escrevê-lo à mão aqui autorizaria, no dia em que existir plano com
 * assento adicional, encerrar a conta de quem usa o que comprou.
 */
const ACESSOS_POR_PLANO = [...new Set(PLANOS.filter((p) => !p.contactOnly).map((p) => p.maxUsers))];
const ACESSOS_UNICO = ACESSOS_POR_PLANO.length === 1 ? ACESSOS_POR_PLANO[0] : null;

/**
 * A tabela da seção 8 é construída daqui, e não escrita no JSX, para que cada
 * prazo apareça uma única vez no arquivo. A coluna de fundamento não é enfeite:
 * retenção sem base legal declarada é tratamento sem finalidade informada
 * (art. 6º, I e III, e art. 9º da LGPD).
 */
const RETENCAO_TABELA: { categoria: string; prazo: string; fundamento: string }[] = [
  {
    categoria:
      "Cadastro e conta: nome, e-mail, telefone, CPF/CNPJ (armazenado criptografado), nome do escritório, data do último acesso e controles de segurança do login",
    prazo: `${RETENCAO.cadastroAnos} anos contados do encerramento`,
    fundamento:
      "Conservação autorizada para cumprimento de obrigação legal e exercício regular de direitos (art. 16, I, e art. 7º, VI, da LGPD), pelo prazo de 5 anos do art. 27 do CDC e do art. 206, § 5º, I, do Código Civil",
  },
  {
    categoria:
      "Documentos processuais enviados, texto extraído de cada página e dados processuais deles derivados ou informados no formulário: executado e seu CPF/CNPJ (criptografado), exequente, número do processo, vara e comarca, número da CDA e valor",
    prazo: `${RETENCAO.conteudoMeses} meses contados do encerramento — ou de imediato, a pedido do assinante`,
    fundamento:
      "Necessidade e finalidade (art. 6º, I e III, da LGPD) e término do tratamento por alcance da finalidade ou fim do período (art. 15, I e II), executado conforme as instruções de quem controla os dados (art. 39). Quanto a esses dados o assinante é o controlador e o fornecedor, operador",
  },
  {
    categoria: "Análises, linha do tempo, relatórios e minutas gerados",
    prazo: `${RETENCAO.conteudoMeses} meses contados do encerramento — é também a janela de reativação com histórico (seção 10)`,
    fundamento:
      "Execução do contrato e recomposição do histórico em caso de reativação (art. 7º, V, da LGPD)",
  },
  {
    categoria: "Extrato de créditos e registros de consumo das análises",
    prazo: `${RETENCAO.fiscalAnos} anos contados do encerramento`,
    fundamento:
      "Prova da execução do contrato e da regularidade da cobrança (art. 7º, V e VI, e art. 16, I, da LGPD)",
  },
  {
    categoria:
      "Registros de pagamento: valor, meio, situação, identificador da transação na processadora e o retorno por ela enviado, inclusive os registros do meio de pagamento utilizado antes do atual",
    prazo: `${RETENCAO.fiscalAnos} anos contados do encerramento do exercício em que a operação ocorreu`,
    fundamento:
      "Obrigação legal e regulatória (art. 16, I, da LGPD) e prazos de 5 anos dos arts. 173 e 174 do CTN. Não são excluídos a pedido do titular",
  },
  {
    categoria:
      "Registros de acesso à aplicação: data e hora, endereço IP e identificação do navegador de cada sessão",
    prazo: `${RETENCAO.logAcessoMeses} meses, no mínimo`,
    fundamento:
      "Guarda obrigatória imposta ao provedor de aplicações pelo art. 15 da Lei nº 12.965/2014 (Marco Civil da Internet), com prazo prorrogável por requisição da autoridade competente",
  },
  {
    categoria:
      "Trilha de auditoria das operações (entrada na conta, cadastro, envio e download de arquivo, criação, alteração e exclusão de análise, exportação de dados, ajuste de crédito, eventos de pagamento e revisão) e registros de eventos de segurança",
    prazo: `${RETENCAO.auditoriaAnos} anos`,
    fundamento:
      "Segurança, prevenção à fraude e exercício regular de direitos (art. 7º, VI e IX, da LGPD) e dever de manter registro das operações de tratamento (art. 37 da LGPD)",
  },
  {
    categoria: "Chamados de suporte: assunto, mensagens trocadas e situação do atendimento",
    prazo: `${RETENCAO.fiscalAnos} anos contados do encerramento do chamado`,
    fundamento:
      "Prova do atendimento prestado (art. 7º, VI, da LGPD), sem prejuízo do prazo mínimo de conservação do registro de atendimento exigido pela regulamentação do serviço de atendimento ao consumidor",
  },
  {
    categoria:
      "Registro dos consentimentos manifestados no cadastro: data, endereço IP e identificação do documento aceito",
    prazo: `${RETENCAO.cadastroAnos} anos contados do encerramento`,
    fundamento:
      "Prova do cumprimento da LGPD e registro das operações de tratamento (art. 37 e art. 7º, VI, da LGPD)",
  },
];

export default function CancelamentoPage() {
  return (
    <LegalShell title="Política de Cancelamento, Suspensão e Retenção de Dados">
      <p>
        Esta política descreve como a assinatura do Prescrição Pro é cancelada, suspensa e encerrada, e por quanto
        tempo cada categoria de dado é conservada depois disso. O serviço é fornecido por {qualificacaoFornecedor()}.
      </p>
      <p>
        Ela integra os <Link href="/termos">Termos de Uso</Link> e deve ser lida com a{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link> (regras de contratação e renovação), a{" "}
        <Link href="/reembolso">Política de Reembolso</Link> (devolução de valores), a{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link> (saldo e extrato), a{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link> (condutas vedadas e escalonamento das medidas) e a{" "}
        <Link href="/privacidade">Política de Privacidade</Link> (tratamento de dados pessoais). Havendo divergência,
        prevalece o que está aqui quanto a <strong>prazo de retenção, janela de reativação, direito de arrependimento,
        contagem do período de tolerância na inadimplência e efeitos da suspensão e do encerramento sobre o acesso e
        sobre os dados</strong> — <strong>salvo</strong> quando outro instrumento (i) assegurar ao assinante condição
        mais favorável, ou (ii) descrever com maior precisão o funcionamento efetivo da Plataforma, hipóteses em que
        prevalece a disposição mais favorável ou mais precisa. Em nenhum caso a prevalência de um documento suprime
        garantia legal do assinante. Em especial, a seção 3 <strong>resolve</strong> o ponto deixado em aberto na
        Política de Reembolso quanto às análises realizadas dentro dos {PRAZO_ARREPENDIMENTO_DIAS} dias, e as
        contagens descritas nas seções 4 e 5 prevalecem sobre a redação da Política de Assinatura, por serem mais
        favoráveis ao assinante.
      </p>

      <h2>1. Cancelamento pelo assinante</h2>
      <p>
        O cancelamento pode ser pedido <strong>a qualquer momento, sem carência e sem multa</strong>. Não há fidelidade,
        e o pedido não é condicionado a justificativa, a ligação telefônica, a oferta de retenção ou a qualquer etapa
        adicional — o Decreto nº 7.962/2013 exige do comércio eletrônico atendimento eletrônico eficaz e confirmação
        imediata do recebimento das demandas do consumidor.
      </p>

      <h3>Como pedir</h3>
      <ul>
        <li>
          Na área do cliente, em <strong>Minha assinatura</strong>, pelo botão{" "}
          <strong>Cancelar assinatura</strong>. O efeito é imediato e a confirmação aparece na própria tela.
        </li>
        <li>
          Por chamado em <strong>Suporte</strong>, dentro da Plataforma, que gera número de protocolo e histórico de
          mensagens.
        </li>
        <li>
          Pelo SAC, no número {SAC.numero}, e pelos demais canais da seção 12.
        </li>
      </ul>
      <p>
        O botão de autoatendimento aparece enquanto a assinatura está vigente. Se ela já estiver inadimplente, vencida,
        suspensa ou encerrada, o autoatendimento não se aplica e o pedido deve ser feito pelo atendimento, que registra
        a solicitação com data e interrompe a cobrança do mesmo modo.
      </p>

      <h3>Efeitos</h3>
      <ul>
        <li>
          O cancelamento <strong>interrompe as renovações futuras</strong> e nada mais: não encerra o período que já
          foi pago.
        </li>
        {/*
          A cota vem do catálogo (`CREDITOS_MENSAIS`), não escrita aqui: preço e cota
          anunciados vinculam o fornecedor (arts. 30 e 37 do CDC) e já divergiram do
          sistema neste projeto. O crédito avulso é citado no mesmo período por decisão
          de redação: anunciar o teto sem a saída faria a cota parecer uma parede, e o
          que o cancelamento preserva é a condição contratada inteira — cota mais a
          possibilidade de comprar mais.
        */}
        <li>
          O <strong>acesso é mantido até o fim do período já pago</strong>, com as mesmas condições contratadas —
          inclusive a cota de {CREDITOS_MENSAIS} créditos por ciclo mensal dos planos vigentes e a compra de créditos
          avulsos a qualquer momento, na forma da <Link href="/politica-de-creditos">Política de Créditos</Link>, que
          traz também quantos créditos cada análise consome conforme o tamanho do processo.
        </li>
        <li>
          O cancelamento, por si só, <strong>não gera devolução de valores</strong> do período em curso. As hipóteses de
          devolução estão na seção 3 e na <Link href="/reembolso">Política de Reembolso</Link>.
        </li>
        <li>
          Encerrado o período pago, valem os prazos de conservação da seção 8 e a janela de reativação da seção 10.
        </li>
      </ul>

      <h3>O que muda em cada forma de pagamento</h3>
      {/*
        A recorrência vive no provedor de pagamento, não aqui. A rota de
        cancelamento grava o pedido PRIMEIRO e só depois fala com o provedor,
        justamente para que indisponibilidade dele não faça o cliente perder o
        direito de cancelar — e, quando a interrupção não é confirmada, a resposta
        diz isso. O texto tem de assumir esse cenário: prometer "não haverá nova
        cobrança" sem ressalva seria promessa que o sistema pode não cumprir
        (arts. 30 e 31 do CDC), e a saída correta é garantir a devolução integral
        de qualquer cobrança posterior ao pedido.
      */}
      <ul>
        <li>
          <strong>Cartão de crédito:</strong> a cobrança recorrente é interrompida junto ao provedor de pagamento no
          mesmo ato. Quando a interrupção não pode ser confirmada de imediato, o pedido já está registrado com data,
          nossa equipe é acionada para concluí-la e{" "}
          <strong>qualquer cobrança lançada após o pedido é devolvida integralmente</strong>, bastando comunicar o
          atendimento.
        </li>
        <li>
          <strong>Boleto bancário:</strong> os boletos dos ciclos seguintes deixam de ser emitidos. Boleto já emitido e
          ainda não pago <strong>não precisa ser pago</strong>; se for pago depois do cancelamento, o assinante escolhe
          entre a devolução do valor e a abertura de um novo período de acesso.
        </li>
        <li>
          <strong>PIX:</strong> não há renovação a cancelar. O pagamento por PIX é único e o acesso termina sozinho ao
          fim do período contratado. Pedir o cancelamento <strong>não antecipa esse fim</strong>: o acesso é mantido até
          o último dia do período já pago, exatamente como nas demais formas de pagamento, e não há devolução fora da
          hipótese da seção 3.
        </li>
      </ul>

      <h2>2. Antes do encerramento: exportação e cópia dos arquivos</h2>
      {/*
        Ponto de honestidade que muda a experiência do cliente: o download do
        relatório, da minuta e dos documentos passa por `assertActiveSubscription`,
        enquanto a LEITURA da análise na tela e a exportação LGPD não passam. Dizer
        apenas "o histórico continua acessível" seria prometer mais do que o
        sistema entrega. Em vez de esconder a limitação, ela é declarada e
        compensada por uma obrigação do fornecedor (fornecer cópia pelo suporte,
        sem custo) — retenção de entregável já pago seria vantagem manifestamente
        excessiva (art. 51, IV, do CDC).
      */}
      <p>
        Enquanto a assinatura está vigente, o assinante pode baixar tudo o que produziu. Recomendamos fazer isso{" "}
        <strong>antes</strong> do encerramento, porque parte dos downloads depende de assinatura ativa:
      </p>
      <ul>
        <li>
          <strong>Relatórios e minutas</strong> podem ser baixados em <strong>PDF</strong> e <strong>DOCX</strong> pelos
          botões da página de cada análise. Os arquivos são gerados no próprio servidor da Plataforma.
        </li>
        <li>
          <strong>Documentos enviados</strong> podem ser baixados individualmente na análise a que pertencem.
        </li>
        <li>
          <strong>Exportação dos dados da conta</strong>, em <strong>Configurações da conta</strong>, pelo botão{" "}
          <strong>Exportar meus dados</strong>: gera um arquivo JSON com o perfil (nome, e-mail, telefone e o CPF/CNPJ
          mascarado), os consentimentos registrados, a relação das análises (identificador, título, situação e data) e
          os chamados de suporte abertos. Essa exportação{" "}
          <strong>não inclui os documentos enviados, o texto das páginas, os relatórios, as minutas, o extrato de
          créditos nem os registros de pagamento</strong>, que devem ser baixados como indicado acima.
        </li>
      </ul>
      <p>
        Encerrada a assinatura, a entrada na conta e a <strong>leitura</strong> das análises e dos relatórios na tela
        continuam disponíveis enquanto durar o prazo de conservação da seção 8, e a exportação dos dados da conta
        continua funcionando — <strong>salvo</strong> se a assinatura estiver suspensa ou encerrada por estorno,
        hipóteses em que a entrada na conta fica indisponível, como nas seções 6 e 7, e os pedidos de acesso, correção,
        exportação e eliminação são atendidos pelos canais da seção 12 e pelo canal de privacidade da seção 9, no prazo
        de {PRAZO_RESPOSTA_TITULAR_DIAS} dias. O <strong>download</strong> dos arquivos (relatório, minuta e
        documentos), porém, exige assinatura ativa. Para não deixar o assinante sem o que já pagou,{" "}
        <strong>o fornecedor obriga-se a fornecer, sem custo, cópia dos relatórios e das minutas de análises já
        concluídas</strong>, mediante pedido pelos canais da seção 12, enquanto os dados existirem.
      </p>

      <h2>3. Direito de arrependimento ({PRAZO_ARREPENDIMENTO_DIAS} dias)</h2>
      <p>
        A contratação é feita fora do estabelecimento comercial, pela internet. Aplica-se o{" "}
        <strong>art. 49 do Código de Defesa do Consumidor</strong>: o assinante pode desistir da contratação no prazo de{" "}
        <strong>{PRAZO_ARREPENDIMENTO_DIAS} dias corridos</strong>, contados da contratação ou da liberação do acesso,{" "}
        <strong>o que ocorrer por último</strong>. O direito é assegurado a todo assinante como condição contratual,
        independentemente da discussão sobre a incidência do CDC ao uso profissional da ferramenta.
      </p>
      <p>
        <strong>Não é preciso justificar.</strong> A manifestação de arrependimento basta, e o atendimento não pode
        condicioná-la a motivo, a formulário específico ou a qualquer contrapartida.
      </p>

      <h3>Devolução integral, sem desconto pelo uso</h3>
      {/*
        Este parágrafo resolve o "[CONFERIR]" que estava publicado e o [DEFINIR] da
        Política de Reembolso §1. Duas posições eram sustentáveis: (a) devolver
        integralmente; (b) descontar o valor das análises realizadas nos 7 dias.
        Adotada a (a): o art. 49 não autoriza retenção — o parágrafo único manda
        devolver "os valores eventualmente pagos, a qualquer título, durante o
        prazo de reflexão", e a experimentação é justamente a finalidade do prazo.
        Cobrar pelo uso no período de reflexão criaria cláusula que impõe ao
        consumidor ônus não previsto em lei, com risco de nulidade pelo art. 51, I
        e IV, do CDC — e transformaria cada arrependimento em discussão sobre preço
        de análise avulsa.
      */}
      <p>
        Exercido o arrependimento no prazo, os valores pagos são{" "}
        <strong>devolvidos integralmente e monetariamente atualizados</strong>, na forma do parágrafo único do art. 49
        do CDC. <strong>Nenhum valor é retido ou descontado por análise realizada durante os{" "}
        {PRAZO_ARREPENDIMENTO_DIAS} dias</strong>: usar o serviço é exatamente a finalidade do prazo de reflexão, e a
        lei não autoriza a retenção.
      </p>
      <p>Efeitos do arrependimento:</p>
      <ul>
        <li>a assinatura é encerrada e o acesso cessa;</li>
        <li>
          os créditos não utilizados do plano são cancelados, com o lançamento correspondente no extrato, na forma da{" "}
          <Link href="/politica-de-creditos">Política de Créditos</Link>;
        </li>
        <li>
          os relatórios, as minutas e os documentos que o assinante já tenha baixado{" "}
          <strong>permanecem com ele</strong> — não são exigidos de volta nem há cobrança por eles;
        </li>
        <li>
          os dados permanecem conservados pelos prazos da seção 8, e a exportação da seção 2 continua disponível;
        </li>
        <li>
          os créditos avulsos comprados <strong>dentro do prazo de reflexão</strong> também são cancelados, e{" "}
          <strong>o valor pago por eles é devolvido junto com o da assinatura</strong>: o parágrafo único do art. 49 do
          CDC manda devolver os valores pagos “a qualquer título” durante o prazo, e o art. 5º, § 2º, do Decreto nº
          7.962/2013 rescinde os contratos acessórios sem ônus para o consumidor. Cada compra de créditos avulsos tem,
          além disso, prazo próprio de arrependimento de {PRAZO_ARREPENDIMENTO_DIAS} dias corridos contados dela, com a
          mesma devolução integral.
        </li>
      </ul>

      <h3>Procedimento e prazo do estorno</h3>
      <p>
        O pedido é feito por qualquer canal da seção 12, informando o nome e o e-mail cadastrados e a identificação da
        compra. O recebimento é confirmado e o pedido registrado com data e protocolo.
      </p>
      <ul>
        <li>
          <strong>Cartão de crédito:</strong> a devolução é lançada pela administradora do cartão e costuma aparecer em
          fatura posterior à do lançamento original.
        </li>
        <li>
          <strong>PIX:</strong> a devolução é feita para a conta pagadora.
        </li>
        <li>
          <strong>Boleto:</strong> a devolução depende da indicação, pelo titular, da conta bancária de recebimento.
        </li>
      </ul>
      <p>
        A ordem de devolução é dada pelo fornecedor <strong>de imediato</strong>, como manda o parágrafo único do art.
        49 do CDC, e em nenhuma hipótese depois de {PRAZO_ORDEM_ESTORNO_DIAS_UTEIS} dias úteis do pedido; quando a
        fatura ainda não tiver sido emitida, pedimos à administradora que o lançamento não seja feito. O{" "}
        <em>crédito efetivo</em> segue o calendário da processadora e da instituição financeira, o que não transfere ao
        assinante o risco da demora: <strong>não confirmada a devolução em {PRAZO_LIMITE_DEVOLUCAO_DIAS} dias do
        pedido, o fornecedor a realiza por outro meio</strong> indicado pelo titular. O andamento pode ser cobrado do
        SAC a qualquer momento.
      </p>

      <h2>4. Suspensão por inadimplência</h2>
      <p>
        Não confirmado o pagamento da renovação, o assinante recebe aviso na área do cliente e comunicação por e-mail,
        com orientação para regularizar. Abre-se então um período de tolerância de{" "}
        <strong>{DIAS_TOLERANCIA_INADIMPLENCIA} dias</strong>.
      </p>
      {/*
        O prazo é contado da COMUNICAÇÃO do atraso pelo provedor de pagamento, não
        do vencimento: `graceUntil` é gravado como "agora + dias" quando o evento
        de atraso é processado, e o provedor comunica no dia seguinte ao
        vencimento. Escrever "contados do vencimento" (como faz hoje a Política de
        Assinatura §6) descreveria prazo MENOR do que o sistema concede; a
        redação abaixo é a verdadeira e é mais favorável ao assinante.
      */}
      <ul>
        <li>
          <strong>Durante a tolerância nada muda:</strong> o acesso segue integral, inclusive para novas análises e
          para os downloads. O prazo é contado da comunicação do atraso pelo provedor de pagamento — que ocorre depois
          do vencimento — e a data-limite exata é exibida no aviso da área do cliente.
        </li>
        <li>
          <strong>Vencida a tolerância</strong> ficam bloqueados o envio de documentos, o início de novas análises e o
          download de relatórios, minutas e documentos.
        </li>
        <li>
          <strong>Continuam disponíveis</strong>, enquanto a assinatura estiver apenas inadimplente ou vencida, a
          entrada na conta, a consulta ao histórico e a leitura das análises e dos relatórios na tela, a exportação dos
          dados da conta e o pedido de cópia previsto na seção 2. Vindo a assinatura a ser{" "}
          <strong>suspensa</strong>, a entrada na conta fica indisponível, como na seção 6, e os pedidos de acesso,
          correção, exportação e eliminação passam a ser atendidos fora da Plataforma, pelos canais da seção 12 e pelo
          canal de privacidade da seção 9, no prazo de {PRAZO_RESPOSTA_TITULAR_DIAS} dias.
        </li>
        <li>
          <strong>Regularizado o pagamento, o acesso é restabelecido automaticamente</strong>, sem taxa de
          reativação.
        </li>
        <li>
          Créditos mensais do ciclo em que houve bloqueio não são recompostos retroativamente: a cota do ciclo não é
          reposta nem prorrogada em razão do período bloqueado. Regularizado o pagamento, o saldo que ainda restava do
          ciclo continua disponível, e créditos avulsos podem ser comprados a qualquer momento, na forma da{" "}
          <Link href="/politica-de-creditos">Política de Créditos</Link>.
        </li>
      </ul>
      <p>
        Persistindo a inadimplência, a assinatura pode ser suspensa ou encerrada, observados os prazos de conservação da
        seção 8. As regras completas de cobrança e renovação estão na{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>.
      </p>

      <h2>5. Encerramento por boleto vencido</h2>
      <p>
        No pagamento por boleto não existe nova tentativa de cobrança: o boleto simplesmente vence. Vencido sem
        pagamento, a assinatura é <strong>encerrada</strong> e as cobranças seguintes deixam de ser emitidas, inclusive
        junto ao provedor de pagamento — cobrar sem entregar o serviço seria pior do que não cobrar.
      </p>
      <p>
        O encerramento ocorre depois de <strong>{DIAS_COMPENSACAO_BOLETO} dias</strong> contados da comunicação do
        atraso pelo provedor de pagamento, e é executado na rotina diária de manutenção seguinte. Esse prazo não é
        cortesia: <strong>boleto pago na data de vencimento é compensado em 1 a 3 dias úteis</strong>, e o aviso de
        atraso chega antes da compensação. Sem essa janela, quem pagou em dia seria encerrado e o dinheiro entraria
        numa assinatura já encerrada.
      </p>
      <p>
        Encerrada a assinatura por boleto vencido, o acesso cessa e não há reativação automática: para voltar a usar a
        Plataforma é necessário contratar novamente, nas condições da seção 10. Os dados seguem conservados pelos
        prazos da seção 8.
      </p>

      <h2>6. Estorno e chargeback</h2>
      <p>
        <em>Estorno</em> é a devolução solicitada e processada pela processadora de pagamento.{" "}
        <em>Chargeback</em> é a contestação da cobrança feita diretamente à administradora do cartão, sem passar pelo
        atendimento. Recebido o evento correspondente do meio de pagamento, o sistema atua automaticamente:
      </p>
      <ul>
        <li>a assinatura é encerrada por estorno e o uso do serviço é interrompido;</li>
        <li>
          os <strong>créditos não utilizados são bloqueados</strong>, com lançamento identificado no extrato de
          créditos;
        </li>
        <li>o caso é encaminhado para revisão administrativa, que apura a origem da contestação.</li>
      </ul>
      {/*
        A distinção entre devolução PARCIAL e TOTAL precisa estar escrita porque o efeito
        é oposto, e porque o sistema fazia a coisa errada: o evento de devolução parcial
        caía no mesmo caminho da total, e devolver R$ 10,00 de uma mensalidade encerrava a
        assinatura, recusava o login e bloqueava a cota do mês. Ver `handleEstorno`, em
        src/lib/asaas.ts. Sem esta ressalva, o texto descreveria como automático um
        encerramento que não acontece mais — o inverso do defeito, e igualmente ruim
        (arts. 30 e 46 do CDC).
      */}
      <p>
        As consequências acima pressupõem a devolução <strong>integral</strong> da cobrança. A devolução{" "}
        <strong>parcial</strong> — desconto de cortesia, ajuste de valor, correção de cobrança — <strong>não</strong>{" "}
        encerra a assinatura, <strong>não</strong> bloqueia créditos e <strong>não</strong> interrompe o acesso: a parte
        não devolvida continua paga, e o que ela contratou continua entregue. O caso é registrado e conferido pelo
        fornecedor; havendo intenção de encerrar a assinatura, o encerramento segue as seções 3 a 5, com aviso ao
        assinante.
      </p>
      {/*
        Consequência severa que precisa estar escrita: com a assinatura em ESTORNADA
        (ou SUSPENSA) o LOGIN é recusado, e não apenas o uso do agente. O titular
        não entra nem para exportar os próprios dados. Enquanto o comportamento for
        esse, negar o acesso sem oferecer via alternativa esvaziaria o art. 18 da
        LGPD — daí a obrigação expressa de atender o pedido fora da Plataforma, no
        prazo do art. 19, II.
      */}
      <p>
        <strong>Nesse estado a entrada na conta fica indisponível</strong>, e não apenas o uso do serviço: a
        Plataforma recusa o acesso e orienta a procurar o suporte. Para que isso não prejudique direitos, o fornecedor
        obriga-se a atender, pelos canais da seção 12 e pelo canal de privacidade indicado na seção 9, os pedidos de
        acesso, correção, exportação e eliminação de dados, entregando a exportação em até{" "}
        {PRAZO_RESPOSTA_TITULAR_DIAS} dias do pedido.
      </p>

      <h3>Revisão administrativa</h3>
      <p>
        A revisão é concluída em até <strong>{PRAZO_REVISAO_CONTESTACAO_DIAS_UTEIS} dias úteis</strong> do recebimento
        do evento, prorrogáveis uma única vez por igual período, com comunicação do motivo ao assinante. O resultado é
        comunicado por e-mail e pode ser:
      </p>
      <ul>
        <li>
          <strong>restabelecimento</strong> do acesso e desbloqueio dos créditos, quando o pagamento for regularizado
          ou quando a contestação decorrer de erro de cobrança; ou
        </li>
        <li>
          <strong>confirmação do encerramento</strong>, com a conservação dos dados pelos prazos da seção 8.
        </li>
      </ul>

      <h3>Contestação indevida</h3>
      {/*
        Cobrança de contestação indevida é legítima como indenização do que foi
        efetivamente prestado, mas só depois de apuração com direito de
        manifestação, e sem penalidade inventada em contrato: multa por chargeback
        e negativação automática seriam vantagem excessiva (art. 51, IV, do CDC) e
        atropelariam a comunicação prévia do art. 43, § 2º.
      */}
      <p>
        Concluída a revisão pela improcedência da contestação, e tendo o serviço sido efetivamente prestado, o valor
        correspondente permanece devido. Ele pode ser cobrado pelas vias ordinárias, acrescido de correção monetária e
        dos juros legais, bem como das despesas que a contestação tenha imposto ao fornecedor. Não há multa
        contratual, e nenhuma inscrição em cadastro de inadimplentes é feita sem a comunicação prévia por escrito
        exigida pelo art. 43, § 2º, do CDC.
      </p>
      <p>
        Recomendamos procurar o atendimento antes de abrir um <em>chargeback</em>: o pedido pelos canais oficiais é
        resolvido mais rápido e não implica bloqueio preventivo da conta. As demais regras de devolução estão na{" "}
        <Link href="/reembolso">Política de Reembolso</Link>.
      </p>

      <h2>7. Suspensão e encerramento por iniciativa do fornecedor</h2>
      {/*
        Cláusula de rescisão pelo fornecedor só é válida porque o assinante tem o
        mesmo direito, a qualquer momento e sem ônus (seção 1): o art. 51, XI, do
        CDC anula a que autoriza o fornecedor a cancelar unilateralmente sem
        conferir igual direito ao consumidor. O aviso prévio com prazo de
        manifestação e a exportação garantida antes do corte existem para que a
        medida não seja sanção sumária.
      */}
      <p>
        O fornecedor pode suspender ou encerrar a assinatura, sempre de forma motivada, nas seguintes hipóteses:
      </p>
      <ul>
        <li>inadimplência não regularizada, nos termos das seções 4 e 5;</li>
        <li>estorno ou contestação de cobrança julgada improcedente, nos termos da seção 6;</li>
        <li>
          violação dos <Link href="/termos">Termos de Uso</Link> e da{" "}
          <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>, inclusive uso da conta por pessoa diversa do
          titular, cessão, revenda ou compartilhamento das credenciais de acesso —{" "}
          {ACESSOS_UNICO != null ? (
            <>
              cada plano dá direito a{" "}
              <strong>
                {ACESSOS_UNICO} {ACESSOS_UNICO === 1 ? "(um) usuário" : "usuários"}
              </strong>
            </>
          ) : (
            <>
              o número de acessos de cada plano é o indicado em <Link href="/planos">Planos</Link>
            </>
          )}
          ;
        </li>
        <li>
          uso automatizado, tentativa de contornar os limites técnicos de envio e de uso justo, ou conduta que degrade
          o funcionamento do serviço para os demais assinantes;
        </li>
        <li>
          envio de conteúdo manifestamente ilícito ou sem finalidade jurídica legítima, e uso da Plataforma para
          finalidade diversa da análise de prescrição, prescrição intercorrente e decadência;
        </li>
        <li>fraude, falsidade dos dados cadastrais ou uso de meio de pagamento de terceiro sem autorização;</li>
        <li>determinação legal ou judicial;</li>
        <li>descontinuação do serviço ou de um plano.</li>
      </ul>

      <h3>Procedimento</h3>
      <p>
        As medidas por violação seguem a <strong>gradação</strong> e os prazos da{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link> — aviso e diálogo, limitação temporária, suspensão
        e, por último, encerramento —, aplicando-se sempre a menor medida suficiente para fazer cessar a violação, com
        direito a <strong>reexame</strong> no prazo ali previsto. Esta seção descreve apenas os efeitos sobre o acesso e
        sobre os dados.
      </p>
      <ul>
        <li>
          <strong>Regra:</strong> comunicação prévia por e-mail e aviso na área do cliente, com a descrição objetiva do
          motivo e prazo para o assinante regularizar a situação, apresentar sua manifestação e exportar os dados, nos
          prazos da Política de Uso Aceitável. Só depois desse prazo a medida é executada.
        </li>
        <li>
          <strong>Exceção — suspensão imediata:</strong> em caso de fraude, conteúdo manifestamente ilícito,
          determinação judicial ou risco atual à segurança e à integridade do serviço, a suspensão é imediata. A
          comunicação do motivo é enviada em seguida, com o prazo de manifestação e de reexame da Política de Uso
          Aceitável, e a medida é revertida se a apuração for favorável ao assinante.
        </li>
        <li>
          <strong>Descontinuação do serviço ou de plano:</strong> aviso prévio de, no mínimo,{" "}
          {PRAZO_DESCONTINUACAO_DIAS} dias, com <strong>devolução proporcional</strong> do valor correspondente ao
          período pago e não usufruído e prazo para exportar os dados. Descontinuar um plano não encerra a assinatura
          vigente antes do fim do período pago.
        </li>
      </ul>
      <p>
        Não havendo fraude nem uso ilícito comprovado, o encerramento por iniciativa do fornecedor{" "}
        <strong>devolve o valor proporcional ao período contratado e não fruído</strong>, monetariamente atualizado,
        como já assegurado nos <Link href="/termos">Termos de Uso</Link> e na{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>. Havendo fraude ou uso ilícito comprovado, não há
        devolução. Em qualquer hipótese o assinante pode pedir o <strong>reexame</strong> da medida, no prazo e na forma
        da Política de Uso Aceitável, aplicáveis por analogia às demais hipóteses desta seção que aquela política não
        regula; revertida a decisão, o acesso é restabelecido sem custo de reativação e o valor
        proporcional é devolvido. O encerramento por inadimplência segue as seções 4 e 5, e o decorrente de estorno ou
        de contestação de cobrança, a seção 6.
      </p>
      <p>
        Em qualquer hipótese, os dados seguem conservados pelos prazos da seção 8. A exportação feita pela própria
        Plataforma depende de a conta estar acessível e,{" "}
        <strong>na suspensão, a entrada na conta fica indisponível</strong>, como na seção 6 — por isso a janela para
        exportar é anterior ao corte. Executada a medida, o pedido de cópia, de exportação, de acesso, de correção e de
        eliminação apresentado pelos canais da seção 12 ou pelo canal de privacidade da seção 9 é atendido em até{" "}
        {PRAZO_RESPOSTA_TITULAR_DIAS} dias, na forma do art. 19, II, da LGPD. Havendo apuração de fraude, os elementos
        necessários à apuração e à defesa de direitos são conservados pelo prazo da tabela, ressalvado o pedido de
        eliminação imediata da seção 8, que nessa hipótese não alcança tais elementos.
      </p>

      <h2>8. Retenção de dados após o encerramento</h2>
      <p>
        Os prazos abaixo são contados do <strong>encerramento definitivo</strong> da assinatura — o fim do período pago
        ou o encerramento por qualquer das causas desta política —, salvo quando a tabela indicar marco diferente. A
        conservação é limitada às finalidades declaradas: nenhum dado é usado para outra finalidade depois do
        encerramento, e <strong>o conteúdo enviado à Plataforma não é utilizado para treinar modelo de inteligência
        artificial</strong> — os provedores de IA são contratados por interface de programação sob essa condição, nos
        termos e com as ressalvas da <Link href="/privacidade">Política de Privacidade</Link>, inclusive a do caminho
        alternativo fora da Plataforma, em que o tratamento passa a sujeitar-se aos termos do serviço de terceiro.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Categoria de dado</th>
              <th>Prazo de conservação</th>
              <th>Fundamento</th>
            </tr>
          </thead>
          <tbody>
            {RETENCAO_TABELA.map((linha) => (
              <tr key={linha.categoria}>
                <td>{linha.categoria}</td>
                <td>{linha.prazo}</td>
                <td>{linha.fundamento}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/*
        Transparência que evita promessa falsa: não existe rotina automática de
        expurgo. Declarar prazo e omitir que a execução é administrativa produziria
        exatamente a afirmação factual que o código não sustenta.
      */}
      <p>
        A exclusão e a anonimização são executadas por <strong>procedimento administrativo do fornecedor</strong>, com
        conferência prévia dos registros que a lei obriga a conservar, e não por rotina automática que apaga o dado no
        instante em que o prazo vence. O prazo da tabela é o <strong>limite</strong> após o qual o dado deixa de ser
        conservado; a execução ocorre na conferência periódica seguinte. Até que ocorra, os dados permanecem sujeitos
        às mesmas medidas de segurança descritas na{" "}
        <Link href="/privacidade">Política de Privacidade</Link>, e o assinante pode antecipar a exclusão a qualquer
        momento, na forma da seção 9.
      </p>
      <p>
        <strong>Exclusão imediata pelo próprio assinante.</strong> Excluir uma análise na área do cliente é imediato e
        definitivo: apaga os arquivos enviados do armazenamento privado, o texto extraído de suas páginas, a linha do
        tempo, o relatório e a minuta daquela análise. Não há lixeira nem desfazer — o que ainda for necessário deve
        ser baixado antes.
      </p>

      <h2>9. Exclusão, anonimização e direitos do titular</h2>
      <h3>Como pedir</h3>
      <ul>
        <li>
          Na área do cliente, em <strong>Configurações da conta</strong>, pelo botão{" "}
          <strong>Solicitar exclusão</strong>. O pedido é registrado com data e recebe confirmação; a execução é feita
          pelo procedimento administrativo descrito na seção 8, e não no instante do clique.
        </li>
        <li>
          Pelo canal de privacidade: {FORNECEDOR.emailPrivacidade}.
        </li>
        <li>
          Junto ao Encarregado pelo tratamento de dados pessoais (art. 41 da LGPD): {FORNECEDOR.encarregado}.
        </li>
        <li>Pelos canais de atendimento da seção 12.</li>
      </ul>

      <h3>Prazos</h3>
      <p>
        O recebimento do pedido é confirmado de imediato. A resposta em formato simplificado é dada de imediato e a
        resposta completa, em até <strong>{PRAZO_RESPOSTA_TITULAR_DIAS} dias</strong> contados do pedido, na forma do
        art. 19, II, da LGPD. No mesmo prazo é executada a exclusão ou a anonimização dos dados que não estejam entre
        os de conservação obrigatória.
      </p>

      <h3>O que é excluído e o que a lei obriga a conservar</h3>
      <ul>
        <li>
          <strong>Excluídos a pedido:</strong> documentos enviados, texto extraído das páginas, dados processuais
          deles derivados, análises, linha do tempo, relatórios, minutas e os dados de cadastro que não sejam
          necessários aos registros conservados.
        </li>
        <li>
          <strong>Conservados ainda que haja pedido de exclusão:</strong> os registros de pagamento, pelo prazo fiscal
          da tabela (art. 16, I, da LGPD); os registros de acesso à aplicação, pelo prazo mínimo do art. 15 do Marco
          Civil da Internet; e a trilha de auditoria e os eventos de segurança, necessários à segurança e à defesa de
          direitos.
        </li>
        <li>
          <strong>Anonimização em lugar da eliminação:</strong> conta que possui pagamento aprovado{" "}
          <strong>não é excluída integralmente</strong> — o registro da venda é conservado pelo prazo fiscal, sem o
          vínculo com a pessoa quando isso é tecnicamente possível. A trilha de auditoria não é apagada com a conta: o
          registro permanece e o vínculo com o titular é desfeito. Registros de eventos de segurança podem conservar o
          e-mail informado na tentativa de acesso, porque é ele que identifica o evento.
        </li>
      </ul>
      <p>
        A eliminação de dados tratados para executar o contrato ou para cumprir obrigação legal não é incondicionada: o
        art. 16 e o art. 18, VI, da LGPD autorizam a conservação nessas hipóteses. Nenhum dado conservado é usado para
        finalidade diversa da declarada na tabela.
      </p>

      <h3>Demais direitos e dados de terceiros</h3>
      <p>
        Confirmação de tratamento, acesso, correção, anonimização, bloqueio, eliminação, portabilidade e informação
        sobre compartilhamento são exercidos pelos mesmos canais, na forma do art. 18 da LGPD e do procedimento
        detalhado na <Link href="/privacidade">Política de Privacidade</Link>.
      </p>
      {/*
        Divisão de papéis da LGPD aplicada à retenção: quanto aos dados de
        terceiros que constam dos autos, o assinante é controlador e o fornecedor
        opera sob instrução (art. 5º, VI e VII). Operador não pode decidir sobre
        eliminação de dado que não controla, e prometer o contrário criaria
        obrigação impossível — o correto é encaminhar ao controlador (art. 39).
      */}
      <p>
        Quanto aos <strong>dados pessoais de terceiros contidos nos documentos processuais</strong> — partes,
        executados e demais pessoas mencionadas nos autos —, o assinante é o controlador e o fornecedor atua como
        operador, tratando-os apenas para executar a análise solicitada. Pedido de eliminação formulado por esses
        terceiros diretamente ao fornecedor é encaminhado ao assinante, a quem cabe decidir, com o auxílio devido pelo
        operador. O assinante permanece responsável por observar a LGPD e o sigilo profissional em relação ao que
        submete à Plataforma.
      </p>

      <h2>10. Reativação</h2>
      <ul>
        <li>
          <strong>Dentro de {RETENCAO.conteudoMeses} meses do encerramento:</strong> contratando novamente, a conta e o
          login são os mesmos e o histórico de análises, relatórios e minutas é retomado.
        </li>
        <li>
          <strong>Depois desse prazo:</strong> o cadastro e a conta continuam existindo pelo prazo da tabela, mas as
          análises, os documentos enviados e os relatórios já não existem e{" "}
          <strong>não há como recuperá-los</strong>.
        </li>
        <li>
          <strong>Depois de exclusão a pedido:</strong> é necessário novo cadastro, sem histórico anterior.
        </li>
        <li>
          <strong>Assinatura encerrada por estorno ou suspensa:</strong> a entrada na conta está indisponível e a
          reativação depende da conclusão da revisão da seção 6, pelo atendimento.
        </li>
      </ul>
      <p>
        A reativação é uma <strong>nova contratação</strong>, sujeita ao plano e ao preço vigentes na data, publicados
        em <Link href="/planos">Planos</Link>. Plano descontinuado não é retomado: assinatura ativa em plano aposentado
        continua valendo nas condições contratadas, mas, uma vez encerrada, a nova contratação se dá entre os planos
        então oferecidos.
      </p>
      <p>Não são restaurados pela reativação:</p>
      <ul>
        <li>
          créditos avulsos vencidos, cuja validade é de {VALIDADE_CREDITO_ADICIONAL_DIAS} dias contados da liberação;
        </li>
        <li>créditos cancelados em razão de reembolso deferido ou de arrependimento;</li>
        <li>créditos bloqueados por estorno, enquanto não concluída a revisão administrativa;</li>
        <li>créditos mensais de ciclos passados, que não são cumulativos.</li>
      </ul>

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
      <p>
        A assinatura dá acesso a uma ferramenta de apoio. Não há contratação de serviço de advocacia, consultoria
        individualizada ou parecer jurídico definitivo. O encerramento da assinatura, por qualquer causa, não afeta os
        prazos processuais dos autos analisados, cujo acompanhamento é do advogado responsável.
      </p>

      <h2>12. Contato</h2>
      <p>
        Pedidos de cancelamento, arrependimento, regularização de pagamento, cópia de arquivos, exportação e exclusão
        de dados, reexame das medidas da seção 7, entre outros assuntos desta política:
      </p>
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
          Clientes autenticados podem abrir um chamado em <strong>Suporte</strong> dentro da Plataforma, com número de
          protocolo e histórico de mensagens.
        </li>
        <li>
          Assuntos de privacidade e direitos do titular: {FORNECEDOR.emailPrivacidade} — Encarregado:{" "}
          {FORNECEDOR.encarregado}.
        </li>
        <li>
          Demais assuntos: {FORNECEDOR.email} — {FORNECEDOR.site}.
        </li>
      </ul>
      <p>
        Documentos relacionados: <Link href="/politica-de-assinatura">Política de Assinatura</Link>,{" "}
        <Link href="/reembolso">Política de Reembolso</Link>,{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>,{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>,{" "}
        <Link href="/privacidade">Política de Privacidade</Link>,{" "}
        <Link href="/responsabilidade">Aviso de Responsabilidade Técnica e Jurídica</Link> e{" "}
        <Link href="/termos">Termos de Uso</Link>.
      </p>
    </LegalShell>
  );
}
