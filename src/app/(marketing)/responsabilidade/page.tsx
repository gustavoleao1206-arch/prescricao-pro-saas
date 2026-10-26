import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/marketing/legal-shell";
import { MAX_PAGINAS_AUTOMATICO } from "@/lib/credits";
import { AVISO_REVISAO } from "@/lib/planos";
import { MATERIAS } from "@/lib/ai/materias";
import { rotulosDosFormatos } from "@/lib/documents";
import { FORNECEDOR, qualificacaoFornecedor } from "@/lib/fornecedor";
import { ATENDIMENTO, linkWhatsApp } from "@/lib/contato";

export const metadata: Metadata = {
  title: "Aviso de Responsabilidade Técnica e Jurídica",
};

const num = (n: number) => n.toLocaleString("pt-BR");

const listar = (itens: string[]) =>
  itens.length <= 1 ? (itens[0] ?? "") : `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;

/**
 * Matérias que a análise dirigida oferece — derivadas de MATERIAS, nunca escritas
 * à mão.
 *
 * Este parágrafo é oferta que vincula o fornecedor (art. 30 do CDC): acrescentar
 * uma matéria no código sem tocar no texto faria o aviso prometer menos do que o
 * produto entrega, e retirar uma faria prometer o que ele não faz — que é
 * exatamente o defeito corrigido aqui (o texto anunciava quatro institutos
 * examinados em conjunto, e a análise DIRIGIDA apura UM, o escolhido no envio).
 */
const MATERIAS_OFERECIDAS = listar(MATERIAS.map((m) => m.label.toLowerCase()));

/**
 * Formatos aceitos no envio que NÃO são PDF.
 *
 * Vem de `rotulosDosFormatos()`, fonte única dos nomes comerciais: ela já devolve
 * a INTERSEÇÃO entre a configuração e o que a extração realmente lê — e não
 * `UPLOAD_ALLOWED_MIME`, que já listou DOCX e XLSX sem que houvesse leitura para
 * eles — e descarta o formato sem rótulo, de modo que nenhum MIME cru chega a este
 * texto. O mapa local que existia aqui tinha fallback para o MIME técnico: bastaria
 * a extração passar a ler um formato novo para o aviso publicar "image/webp" no
 * corpo do texto. Se um dia a configuração deixar só o PDF, a lista fica vazia e a
 * frase sobre os demais formatos desaparece sozinha.
 */
const FORMATOS_SEM_PDF = rotulosDosFormatos().filter((r) => r !== "PDF");

/**
 * Aviso de Responsabilidade Técnica e Jurídica.
 *
 * ── Por que este documento é curto em cláusulas e longo em fatos ──────────────
 * Ele não distribui obrigações patrimoniais (isso é dos Termos de Uso, da Política
 * de Assinatura e da de Reembolso). O que ele faz é cumprir o art. 6º, III, do CDC:
 * informar, de forma adequada e clara, os RISCOS do serviço. Num produto cujo dano
 * típico é a perda de prazo processual por confiança indevida no resultado, o aviso
 * de risco é simultaneamente a principal proteção do usuário e a principal defesa
 * do fornecedor — e só funciona se cada risco declarado for verdadeiro no sistema.
 * Por isso todo item abaixo descreve comportamento que o código realmente tem.
 *
 * ── O que este documento deliberadamente NÃO faz ──────────────────────────────
 * 1. Não estipula limite de indenização nem exclusão de danos. Cláusula que
 *    exonera ou atenua a obrigação de indenizar é vedada pelo art. 25 e nula pelo
 *    art. 51, I, do CDC. O que aqui se faz é delimitar o OBJETO (ferramenta de
 *    apoio, obrigação de meio quanto ao êxito da tese), o que é lícito, e ressalvar
 *    expressamente a responsabilidade por defeito e por vício do próprio serviço
 *    (arts. 14 e 20 do CDC) — ver seção 11. Sem essa ressalva, o conjunto de
 *    advertências poderia ser lido como renúncia prévia de direito. A seção 11
 *    REMETE à seção 10 dos Termos para a extensão da reparação e o limite de
 *    indenização; remeter não é estipular, e é o que evita que este aviso e os
 *    Termos descrevam a mesma responsabilidade em extensões incompatíveis.
 * 2. Não repete o aviso sobre a natureza da pessoa jurídica do fornecedor: a
 *    decisão (a razão social a preencher deve ser a da empresa de tecnologia, não
 *    a da sociedade de advogados — art. 16 do Estatuto da Advocacia e vedação à
 *    mercantilização) está registrada em src/lib/fornecedor.ts e no aviso de
 *    /termos. A seção 1 depende dela: a afirmação de que o fornecedor não pratica
 *    ato privativo de advocacia só é verdadeira se o fornecedor não for o
 *    escritório.
 */
export default function ResponsabilidadePage() {
  return (
    <LegalShell title="Aviso de Responsabilidade Técnica e Jurídica">
      <p>
        Este aviso integra os <Link href="/termos">Termos de Uso</Link> e é emitido por{" "}
        {qualificacaoFornecedor()}. Ele descreve, de forma deliberadamente detalhada, o que a análise
        produzida pela Plataforma é, o que ela não é, de que depende, onde pode errar e quais deveres
        permanecem integralmente com o(a) profissional que utiliza o resultado.
      </p>
      <p>
        A leitura deste documento é condição de uso consciente do serviço. As informações abaixo são
        prestadas em cumprimento ao dever de informar os riscos do serviço (art. 6º, III, do Código de
        Defesa do Consumidor) e vinculam o fornecedor nos termos do art. 30 do mesmo Código.
      </p>

      <h2>1. Natureza do serviço</h2>
      <p>
        O {FORNECEDOR.nomeFantasia} é uma <strong>ferramenta de apoio à análise jurídica</strong>. A
        Plataforma processa documentos processuais enviados pelo próprio assinante e devolve um
        relatório técnico e, nas hipóteses da seção 2, uma minuta para revisão.
      </p>
      <p>Em consequência, e sem qualquer atenuação:</p>
      <ul>
        <li>
          <strong>Não há prestação de serviço de advocacia.</strong> A contratação da assinatura não
          constitui mandato, não estabelece relação de cliente e advogado entre o fornecedor e o
          assinante, nem entre o fornecedor e o cliente do assinante.
        </li>
        <li>
          O resultado <strong>não é parecer jurídico definitivo</strong>, não é consultoria
          individualizada e não é opinião legal sobre o caso concreto.
        </li>
        {/*
          A postulação é atividade privativa de advocacia (art. 1º, I, da Lei 8.906/1994). Dizer que
          a Plataforma não postula não é modéstia comercial: é o que separa a venda de licença de
          software do exercício da profissão. Pressupõe que o fornecedor seja a empresa de
          tecnologia — ver o comentário no topo deste arquivo.
        */}
        <li>
          A Plataforma <strong>não postula, não peticiona e não protocola</strong> em nome de ninguém.
          A postulação é atividade privativa de advocacia (art. 1º, I, da Lei 8.906/1994) e permanece
          exclusivamente com o(a) advogado(a) do caso.
        </li>
        <li>
          A Plataforma <strong>não decide</strong>. A conclusão automatizada é insumo de trabalho; a
          decisão sobre alegar, quando alegar, como alegar e se alegar é do(a) profissional.
        </li>
      </ul>

      <h2>2. Objeto da análise e o que está fora dele</h2>
      <p>
        A análise é especializada em <strong>execução fiscal</strong>. No envio automático e nos tipos
        do preenchimento manual que correspondem a uma matéria, ela é{" "}
        <strong>dirigida a uma matéria escolhida pelo usuário</strong> no momento do envio, entre{" "}
        {MATERIAS_OFERECIDAS}: a conclusão responde <strong>apenas à matéria escolhida</strong>, os
        demais institutos não são apurados naquela análise, e o silêncio do relatório sobre eles{" "}
        <strong>não é conclusão de que não existam</strong>. Para obter análise dirigida a outro
        instituto do mesmo processo é necessária nova análise, com a matéria correspondente. Nos{" "}
        <strong>tipos genéricos</strong> do preenchimento manual, que não correspondem a uma matéria, a
        conclusão <strong>não fica restrita a um instituto</strong>: o quadro do resultado traz cada
        instituto examinado com resultado próprio, e vale como exame{" "}
        <strong>indicativo</strong> — não como a análise dirigida àquele instituto.
      </p>
      {/*
        A redação anterior ("os institutos são examinados em conjunto, mesmo quando o usuário
        solicita apenas um deles") descrevia o prompt genérico, não o produto: o envio exige a
        escolha de uma matéria, o esquema de resposta admite um único resultado e o relatório
        responde uma pergunta. Prometer quatro institutos e apurar um é oferta descumprida
        (art. 30 do CDC) — e, pior para quem confia no texto, convida a ler o silêncio do
        relatório sobre a decadência como se fosse conclusão negativa sobre ela.

        Isso vale nos fluxos DIRIGIDOS: o envio automático exige a escolha da matéria e três dos
        seis tipos do preenchimento manual correspondem a uma delas. Nos outros três (execução
        fiscal completa, nulidades e análise geral) não há matéria, e é o oposto que acontece — o
        pedido manda examinar os institutos em conjunto e o quadro volta com uma linha para cada um.
        A primeira correção afirmou o parágrafo sem essa ressalva, o que fazia o aviso dizer a quem
        rodou "execução fiscal completa" que os institutos do próprio quadro que ele recebeu "não
        foram apurados" — convite a descartar resultado real ou a repetir análise já feita.
      */}
      <p>
        A <strong>prescrição do redirecionamento</strong> contra sócio ou terceiro{" "}
        <strong>não está entre as matérias oferecidas</strong> e não integra o objeto contratado
        (seção 3.1 dos <Link href="/termos">Termos de Uso</Link>): nenhuma análise dirigida a apura.
        Ela figura apenas no quadro dos tipos genéricos do preenchimento manual, que não têm matéria
        dirigida — sem checklist de documentos e sem seleção de páginas voltada ao instituto —, de
        modo que aquele quadro é indicativo e <strong>não equivale ao exame do redirecionamento</strong>.
      </p>
      <p>O resultado é composto de:</p>
      <ul>
        <li>conclusão objetiva sobre a matéria analisada, com o motivo em uma frase;</li>
        <li>
          linha do tempo dos atos processuais, com a página de origem de cada evento, a{" "}
          <strong>classificação do ato</strong>, o efeito jurídico possível e o grau de confiança da
          extração;
        </li>
        <li>fundamentação com dispositivo legal, súmula e tema vinculante, e memória de cálculo dos prazos;</li>
        <li>relação dos documentos utilizados, dos documentos ausentes e dos riscos da conclusão;</li>
        <li>grau de confiança da análise;</li>
        <li>
          minuta de exceção de pré-executividade, observados os requisitos de cabimento (Súmula 393 do
          Superior Tribunal de Justiça). Na análise dirigida a uma das matérias, a minuta{" "}
          <strong>só é gerada quando o resultado é positivo</strong> — a trava fica no servidor, não na
          interface. Nos demais tipos de análise ela pode ser entregue{" "}
          <strong>condicionada à confirmação documental</strong>, e nesse caso a sua simples existência{" "}
          <strong>não significa que haja tese favorável</strong>: a condição consta do título e das
          ressalvas da própria minuta.
        </li>
      </ul>
      <p>
        <strong>Está fora do objeto da análise</strong>, e não é apurado pela Plataforma: o mérito do
        lançamento tributário; a correção do valor inscrito e dos cálculos da exequente; a apuração de
        matéria que exija dilação probatória, incompatível com a via da exceção de pré-executividade;
        a elaboração de outras defesas, inclusive embargos à execução; o acompanhamento processual; e
        a prática de qualquer ato no processo.
      </p>
      <p>
        Processos com mais de {num(MAX_PAGINAS_AUTOMATICO)} páginas <strong>não são processados
        automaticamente</strong> e nenhum crédito é debitado. Nesse caso o atendimento orienta sobre a
        análise especial, nos termos da{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>.
      </p>

      <h2>3. A conclusão depende integralmente do material enviado</h2>
      <p>
        A Plataforma <strong>não tem acesso aos autos</strong>. Ela lê exclusivamente os arquivos que o
        usuário envia. Cópia incompleta, ilegível, fora de ordem cronológica ou com folhas faltando
        produz conclusão diferente da que os autos íntegros produziriam — e essa diferença não é
        detectável pelo sistema, porque o que falta é justamente o que ele não recebeu.
      </p>
      <p>Limites técnicos de leitura que o usuário precisa conhecer antes de confiar no resultado:</p>
      <ul>
        <li>
          <strong>Somente arquivos PDF são transcritos.</strong> No envio automático, que é o fluxo
          principal, <strong>apenas PDF é aceito</strong>.
          {FORMATOS_SEM_PDF.length > 0 && (
            <>
              {" "}
              No preenchimento manual os demais formatos admitidos ({listar(FORMATOS_SEM_PDF)}) são
              aceitos no envio, mas <strong>não passam por reconhecimento de texto e são marcados como
              ilegíveis</strong> — o conteúdo deles não é considerado na análise.
            </>
          )}
        </li>
        <li>
          Cada documento recebe um <strong>diagnóstico de leitura</strong> (legível, parcial ou
          digitalizado), registrado com a proporção de páginas aproveitadas. Documento classificado
          como digitalizado tem pouca ou nenhuma página com texto e não sustenta análise.
        </li>
        <li>
          O reconhecimento de texto de PDF digitalizado roda no próprio servidor da Plataforma e tem
          <strong> teto de páginas por documento</strong>. Havendo páginas além do teto, isso é
          informado na nota do documento e essas páginas não integram a análise.
        </li>
        <li>
          O modelo <strong>não lê o processo inteiro</strong>: há teto de tamanho no pedido enviado ao
          provedor de inteligência artificial e, alcançado esse teto, é submetida apenas parte das
          páginas — na análise dirigida a uma matéria, as apuradas como mais relevantes para ela.{" "}
          <strong>Em processos extensos essa seleção parcial é a regra, não a exceção.</strong> O
          sistema instrui o modelo a registrar a limitação entre os documentos ausentes e os riscos da
          conclusão, mas{" "}
          <strong>não há garantia de que a ressalva apareça em todos os relatórios</strong>: o usuário
          deve presumir, em qualquer análise, que a leitura pode ter sido parcial.
        </li>
        <li>
          Os dados que o usuário informa no assistente (datas, número do processo, partes) podem
          divergir dos documentos. O sistema sinaliza a divergência quando a identifica, mas{" "}
          <strong>não confere a autenticidade de nenhum documento</strong> nem consulta fonte externa
          para validá-lo.
        </li>
      </ul>
      {/*
        Esta é a advertência de maior valor prático do documento e é literalmente a
        instrução que o sistema dá ao modelo quando a seleção de páginas é parcial. Sem
        ela, o leitor tende a tratar "não consta no relatório" como "não consta nos autos" —
        exatamente o raciocínio que leva a alegar prescrição intercorrente contra ato que
        estava numa página não enviada.

        Aqui estava escrito que "o próprio resultado o declara" sempre que a seleção fosse
        parcial — e isso era promessa que o sistema não cumpre. Quem registra a ressalva é o
        MODELO, a quem o pedido pede que anote a limitação em `documentosAusentes`; os campos
        `truncado` e `paginasOmitidas` da seleção não são persistidos nem exibidos, e não há
        bloco determinístico do relatório ou da tela que informe a seleção parcial. Com o teto
        de produção, seleção parcial é o caso comum em processo real: garantir a ressalva
        justamente onde ela pode faltar é o pior lugar para errar. Por isso o texto passou a
        dizer que a possibilidade existe em TODA análise.
      */}
      <p>
        <strong>
          A ausência de um ato processual no relatório não prova a ausência desse ato nos autos.
        </strong>{" "}
        Ela pode significar apenas que a página correspondente não foi enviada, não foi legível ou não
        entrou na seleção. <strong>Essa possibilidade existe em toda análise</strong>, esteja ou não
        ressalvada no texto do relatório.
      </p>

      <h2>4. Como o resultado se apresenta — e como conferi-lo</h2>
      <p>
        A Plataforma é construída para expor os critérios da conclusão, e não para entregar uma
        resposta fechada. O relatório permite a conferência item por item:
      </p>
      <ul>
        <li>
          a matéria analisada recebe um resultado explícito — <strong>sim</strong> (consumada),{" "}
          <strong>não</strong> (ainda não consumada) ou <strong>inconclusiva por insuficiência
          documental</strong> —, sempre com o motivo declarado;
        </li>
        {/*
          O item anterior dizia que o sistema "não presume o ato ausente, em nenhum sentido". A
          regra de coerência do servidor faz exatamente o contrário num sentido: com marco
          documentado, contagem vencida e nenhum ato obstativo nas páginas lidas, ela devolve a
          resposta ao modelo exigindo conclusão positiva — inclusive contra um "inconclusivo".
          Negar isso no texto esconderia do(a) advogado(a) o único ponto em que a conclusão
          depende de uma inferência do sistema, e é uma inferência que corre sobre corpus que
          pode ser parcial. Declarar a regra e o seu alcance protege mais que omiti-la.
        */}
        <li>
          o sistema <strong>não presume a existência de ato que não consta</strong> dos documentos. Em
          sentido inverso, opera uma <strong>regra de coerência declarada</strong>: quando o marco
          inicial está documentado, a contagem legal já venceu e nenhum ato interruptivo ou suspensivo
          aparece nas páginas lidas, o sistema recusa a conclusão negativa ou inconclusiva do modelo e
          exige que ela seja refeita ou justificada com o ato concreto, data e página, porque a inércia
          documentada é o próprio fundamento da tese. Essa regra trabalha{" "}
          <strong>apenas sobre as páginas efetivamente lidas</strong>, que podem ser parte do processo
          (seção 3): por isso a conferência do intervalo inteiro nos autos é indispensável antes de
          confiar no resultado;
        </li>
        <li>
          cada evento da linha do tempo indica a <strong>página de origem</strong> no arquivo enviado, a{" "}
          <strong>classificação do ato</strong> (ajuizamento, citação, ciência da Fazenda, suspensão,
          arquivamento, penhora, mera intimação e assim por diante), o <strong>efeito jurídico
          possível</strong> e o <strong>grau de confiança da extração</strong> — alto quando data e ato
          constam expressos no texto, médio quando inferidos do contexto, baixo quando incertos. Evento
          lido de documento por inteligência artificial é tratado como{" "}
          <strong>interpretação, nunca como fato confirmado</strong>;
        </li>
        <li>
          datas que não foram localizadas aparecem <strong>marcadas no texto</strong>, com a indicação
          do documento em que devem ser confirmadas, tanto no relatório quanto na minuta;
        </li>
        <li>
          o <strong>grau de confiança</strong> é informado (alto, médio, baixo ou indeterminado),
          acompanhado da justificativa;
        </li>
        <li>
          quando o sistema identifica incompatibilidade entre a conclusão do modelo e as datas
          apuradas, a correção é aplicada e <strong>registrada no próprio relatório</strong>, com
          indicação do resultado original;
        </li>
        <li>
          o relatório traz seção própria com os <strong>documentos e informações a confirmar</strong> e
          com os <strong>riscos da conclusão</strong>, incluindo as teses contrárias previsíveis.
        </li>
      </ul>
      <p>
        Esses elementos existem para serem usados. <strong>Conferir cada data indicada contra a folha
        dos autos apontada é dever do(a) profissional</strong>, e é a única forma de transformar o
        resultado em trabalho defensável.
      </p>

      <h2>5. Limites conhecidos da análise automatizada</h2>
      <p>
        A análise é <strong>automatizada e utiliza inteligência artificial</strong>. Sistemas dessa
        natureza erram, e este pode errar: omitir um ato relevante, ler uma data equivocadamente,
        atribuir a um ato efeito jurídico que ele não tem, ou apresentar como consolidado um
        entendimento em disputa. O sistema opera sob regras que proíbem inventar datas, atos, folhas,
        precedentes, súmulas e temas, e que impõem o registro da lacuna quando a informação não existe
        nos documentos. Essas regras <strong>reduzem</strong> o risco de erro; não o eliminam.
      </p>
      <p>
        A jurisprudência muda. Súmulas e temas repetitivos são revistos, superados e reinterpretados.{" "}
        <strong>A vigência e a redação atual de cada súmula, tema e precedente citado devem ser
        conferidas antes de qualquer uso processual.</strong>
      </p>

      <h3>5.1 Prescrição intercorrente</h3>
      <p>
        A prescrição intercorrente é o instituto mais sensível à completude da cópia. O rito do art. 40
        da Lei 6.830/1980, na leitura dos Temas 566 a 571 do Superior Tribunal de Justiça, depende de
        fatos que frequentemente não constam do material enviado: a ciência da Fazenda Pública quanto à
        primeira diligência frustrada, a suspensão e o arquivamento do feito, a adesão a parcelamento e
        sua rescisão, a existência de constrição efetiva e a data do protocolo do pedido que a produziu.
        Depende, ainda, da apreciação de demora imputável ao Poder Judiciário (Súmula 106 do Superior
        Tribunal de Justiça), que é matéria de valoração e não de leitura de data.
      </p>
      <p>
        Faltando essas peças, a conclusão sai inconclusiva por insuficiência documental, ou com grau de
        confiança reduzido. Tratar conclusão de confiança baixa como base suficiente para peticionar é
        risco assumido por quem peticiona.
      </p>

      <h3>5.2 Análise em modo heurístico</h3>
      <p>
        Se o provedor de inteligência artificial estiver indisponível ou não configurado, a Plataforma
        entrega o resultado em <strong>modo heurístico</strong>, com aviso ostensivo no topo do
        relatório e da minuta. Nesse modo o sistema apenas aplica o cálculo de prazo às datas
        identificadas: <strong>não interpreta o conteúdo das peças</strong>. O grau de confiança é
        baixo por definição e a minuta é sempre condicionada à confirmação documental. O modo
        heurístico serve para não deixar o usuário sem resposta auditável — não para fundamentar
        petição sem conferência integral dos autos.
      </p>
      {/*
        O crédito é debitado ANTES da chamada de IA, e a queda para o heurístico acontece depois:
        o cliente paga o preço cheio e recebe um resultado que não lê as peças. Informar o defeito
        e calar sobre o remédio (art. 20 do CDC) seria a pior combinação possível num documento
        que se apresenta como aviso de risco. O compromisso é sustentável porque o consumo é
        idempotente por análise: reprocessar a mesma análise não cobra de novo.

        O remédio fica; a etiqueta saiu. Chamar o modo heurístico de "falha na prestação do serviço"
        qualificava o mesmo evento de um jeito que os Termos §3.3 qualificam de outro (lá ele é forma
        REGULAR de produzir a Análise, com aviso destacado e confiança baixa). A promessa não precisa
        da etiqueta: a Política de Créditos §7 já garante o reprocessamento sem novo consumo quando o
        resultado saiu em contingência por indisponibilidade do provedor, e a seção 11 deste aviso
        preserva a responsabilidade dos arts. 14, 20 e 25 do CDC sem depender desta frase.
      */}
      <p>
        O modo heurístico <strong>não altera o preço nem a cobrança</strong> da análise. Tendo o
        resultado sido produzido nesse modo por indisponibilidade do provedor de inteligência
        artificial, o usuário pode pedir, pelos canais da seção 10, o{" "}
        <strong>reprocessamento com inteligência artificial sem novo consumo de crédito</strong>, na
        forma da seção 7 da <Link href="/politica-de-creditos">Política de Créditos</Link>.
      </p>

      <h2>6. Revisão por advogado(a) habilitado(a) é obrigatória</h2>
      <p>
        <strong>
          Nenhum resultado da Plataforma pode ser utilizado em processo sem revisão prévia por
          advogado(a) habilitado(a).
        </strong>{" "}
        A minuta é peça técnica destinada a profissional: exige conferência das datas, adequação ao
        caso concreto, preenchimento dos campos marcados como não localizados, revisão da
        fundamentação, conferência da jurisprudência e assinatura.
      </p>
      <p>
        A responsabilidade técnica e ética pelo conteúdo do que é protocolado permanece,{" "}
        <strong>integralmente e sem transferência</strong>, com o(a) advogado(a) responsável pelo caso,
        que responde pelos atos que praticar com dolo ou culpa no exercício profissional (art. 32 da
        Lei 8.906/1994) e está sujeito(a) ao Código de Ética e Disciplina da Ordem dos Advogados do
        Brasil. O uso de ferramenta de apoio não desloca esse dever nem o atenua.
      </p>
      <p>
        A Plataforma registra a revisão jurídica de cada análise — quem revisou, quando, com quais
        ressalvas, riscos e divergências anotadas, e se o resultado foi aprovado ou devolvido. Esse
        registro existe para documentar a diligência do(a) profissional.{" "}
        <strong>Ele não transfere ao fornecedor a responsabilidade profissional</strong> nem substitui
        a conferência dos autos.
      </p>

      <h2>7. Ausência de garantia de resultado</h2>
      <p>
        A obrigação do fornecedor é disponibilizar a ferramenta em funcionamento, nos termos
        contratados. <strong>Não há, e não poderia haver, garantia de êxito de tese jurídica</strong>,
        cuja apreciação é exclusiva do Poder Judiciário. Especificamente:
      </p>
      <ul>
        <li>
          a indicação de tese favorável <strong>não representa garantia de acolhimento</strong> pelo
          juízo, pelo tribunal ou pela instância superior;
        </li>
        <li>
          a conclusão de que <strong>não há</strong> prescrição, prescrição intercorrente ou decadência
          a alegar é resultado válido e regular da análise, e não caracteriza falha na prestação do
          serviço, conforme a <Link href="/politica-de-creditos">Política de Créditos</Link> e a{" "}
          <Link href="/reembolso">Política de Reembolso</Link>;
        </li>
        <li>
          divergência entre a conclusão da Plataforma e a decisão judicial não é, por si, defeito do
          serviço.
        </li>
      </ul>

      <h2>8. Prazos processuais: a Plataforma não os controla</h2>
      {/*
        Seção deliberadamente enfática e colocada em destaque próprio: a perda de prazo por
        confiar no sistema como se fosse controle processual é o dano mais provável do produto.
        Cada negativa abaixo é verificável no código — não há consulta a tribunal, não há
        recebimento de intimação, não há rotina que avise vencimento de prazo, e a comunicação
        por e-mail existente trata apenas de conta, assinatura, pagamento e suporte.
      */}
      <p>
        Esta é a advertência mais importante deste documento. A Plataforma{" "}
        <strong>não é sistema de gestão de prazos</strong> e não cumpre nenhuma das funções abaixo:
      </p>
      <ul>
        <li>
          <strong>não consulta o andamento do processo</strong> em sistema de tribunal e não verifica
          se houve movimentação após o envio dos documentos;
        </li>
        <li><strong>não recebe intimações</strong> e não tem acesso a portal, diário oficial ou push de tribunal;</li>
        <li>
          <strong>não calcula, não controla e não monitora prazo processual</strong>, e não avisa o
          usuário do vencimento de prazo algum — as comunicações que a Plataforma envia tratam apenas
          da conta, da assinatura, do pagamento e do atendimento;
        </li>
        <li>
          <strong>não substitui agenda, controle de prazos ou sistema de gestão de escritório</strong>,
          ainda que a linha do tempo produzida contenha datas.
        </li>
      </ul>
      <p>
        A linha do tempo é reconstrução retrospectiva de atos já praticados, extraída dos arquivos
        enviados, e reflete a situação existente <strong>na data em que a análise foi feita</strong> e
        apenas conforme aqueles arquivos. Atos posteriores ao envio, ou constantes de páginas não
        enviadas, não estão nela.
      </p>
      <p>
        <strong>
          O controle dos prazos do processo é, exclusivamente e em todas as hipóteses, do(a)
          advogado(a) responsável pelo caso.
        </strong>
      </p>

      <h2>9. Uso por quem não é advogado(a)</h2>
      {/*
        Nem o número de acessos nem a qualificação exigida ficam escritos aqui: o número vem do
        catálogo (a venda de um segundo assento tornaria este parágrafo falso sozinho) e a
        qualificação é a dos Termos §4.1, que admitem também quem atue SOB SUPERVISÃO de
        advogado(a) responsável — hipótese que a redação anterior excluía, negando acesso a quem
        o contrato aceita.
      */}
      <p>
        O serviço é destinado a <strong>uso profissional</strong> por advogado(a) regularmente
        inscrito(a) na Ordem dos Advogados do Brasil, por sociedade de advogados ou por quem atue{" "}
        <strong>sob supervisão</strong> de advogado(a) habilitado(a) responsável pelo caso, na forma da
        seção 4.1 dos <Link href="/termos">Termos de Uso</Link>. O acesso é{" "}
        <strong>pessoal e individual</strong>, no número de acessos por plano previsto na seção 4.3 dos
        mesmos Termos e na <Link href="/politica-de-assinatura">Política de Assinatura</Link>. O
        relatório e a minuta são documentos técnicos endereçados a profissional habilitado(a).
      </p>
      <p>
        <strong>É vedado utilizar o resultado da Plataforma como fundamento de decisão jurídica
        própria por quem não é advogado(a) habilitado(a).</strong> A Plataforma não presta orientação
        jurídica ao público, não indica advogado(a) e não avalia caso concreto de terceiro. Quem não é
        advogado(a) e precisa decidir sobre execução fiscal deve consultar profissional habilitado(a),
        a quem cabe examinar os autos.
      </p>

      <h2>10. Como reportar erro de análise</h2>
      <p>
        Erro na análise deve ser reportado, e o fornecedor se compromete a apurá-lo. O canal próprio é
        o <strong>chamado de Suporte na área do cliente</strong>, que gera número e mantém o histórico
        das mensagens; os canais de atendimento da seção 13 também recebem o relato.
      </p>
      <p>Ao relatar, descreva o instituto, o ponto do relatório e a folha dos autos que o contradiz. Havendo relato:</p>
      <ul>
        <li>a apuração é registrada no chamado e a resposta é dada pelo mesmo canal;</li>
        <li>
          confirmado <strong>erro técnico</strong>, o reprocessamento após a correção{" "}
          <strong>não consome novo crédito</strong>, e o crédito de análise que falhou por problema
          técnico é <strong>estornado automaticamente</strong> à mesma origem, com lançamento no
          extrato;
        </li>
        <li>
          resultado desfavorável do ponto de vista da tese não é erro técnico, conforme a seção 7;
        </li>
        <li>
          enquanto a apuração estiver em curso, o resultado questionado{" "}
          <strong>não deve ser utilizado</strong> em processo.
        </li>
      </ul>
      {/*
        Este parágrafo negava o reexame de mérito e omitia o canal de privacidade — enquanto os
        Termos §8.4 prometem, para o art. 20 da LGPD, "reexame do caso por pessoa natural do
        Fornecedor" e indicam também aquele canal. Dois documentos que se integram não podem
        descrever o mesmo direito de formas incompatíveis, e o titular de dados de terceiro não
        tem conta para abrir chamado no Suporte: sem o canal de privacidade, ele não tem via.
      */}
      <p>
        O usuário pode solicitar <strong>explicação sobre os critérios</strong> que levaram à conclusão
        automatizada e a <strong>revisão</strong> do resultado, na forma do art. 20 da Lei 13.709/2018,
        pelo chamado de Suporte, pelos canais da seção 13 ou pelo canal de privacidade indicado na{" "}
        <Link href="/privacidade">Política de Privacidade</Link>. Parte dessa explicação já vem no
        próprio relatório: fundamento legal, memória de cálculo, página de origem de cada evento,
        classificação e confiança de cada evento e grau de confiança da análise. A revisão, na forma da
        seção 8.4 dos <Link href="/termos">Termos de Uso</Link>, consiste em{" "}
        <strong>reexame do caso por pessoa natural do fornecedor</strong>, com esclarecimento do método
        e, apurada falha técnica, reprocessamento sem novo consumo de crédito; ela{" "}
        <strong>não compreende a emissão de opinião jurídica</strong> sobre a tese, que seria atividade
        de advocacia estranha ao objeto contratado. A{" "}
        <strong>revisão jurídica registrada no sistema é ato do próprio assinante</strong>, que é o(a)
        advogado(a) do caso, e não substitui nem transfere essa responsabilidade.
      </p>

      <h2>11. Alcance deste aviso</h2>
      {/*
        Cláusula de salvaguarda. Sem ela, o acúmulo de advertências das seções 1 a 10 pode ser
        lido como exoneração de responsabilidade — vedada pelo art. 25 e nula pelo art. 51, I,
        do CDC — arrastando o documento inteiro para a nulidade. Delimitar objeto é lícito;
        afastar responsabilidade por defeito do próprio serviço não é.

        A remissão final à seção 10 dos Termos não é recuo: sem ela, este aviso afirmava
        responsabilidade sem limite algum por indisponibilidade, perda de documento e cobrança
        incorreta — justamente as hipóteses que os Termos §10.4 colocam sob o teto dos 12 meses.
        Dois documentos que se integram descrevendo extensões incompatíveis fazem prevalecer a
        leitura mais favorável ao consumidor (art. 47 do CDC), esvaziando o teto sem que ninguém
        tenha decidido isso. Quem define a extensão da reparação é a seção 10; aqui se ressalva
        que este aviso não a reduz.
      */}
      <p>
        Este aviso <strong>delimita o objeto</strong> do serviço e informa seus riscos.{" "}
        <strong>Ele não exclui, não limita e não atenua</strong> a responsabilidade do fornecedor por
        defeito ou vício do próprio serviço, inclusive por indisponibilidade indevida, perda de
        documento enviado, cobrança incorreta ou falha de segurança, nas hipóteses e na extensão da
        legislação aplicável, especialmente os arts. 14, 20 e 25 do Código de Defesa do Consumidor. A
        extensão da reparação e o limite de indenização, com as ressalvas que a lei impõe, são os da
        seção 10 dos <Link href="/termos">Termos de Uso</Link>: este aviso não os amplia nem os
        restringe.
      </p>
      <p>
        Nenhuma disposição deste aviso implica renúncia prévia a direito do usuário, e as advertências
        aqui prestadas não invertem contra ele o ônus de provar fato que a lei atribui ao fornecedor.
      </p>

      <h2>12. Avisos obrigatórios</h2>
      <p>{AVISO_REVISAO}</p>
      <ul>
        <li>
          A <strong>responsabilidade pelo protocolo e pelo uso da petição</strong> gerada é
          exclusivamente do usuário.
        </li>
        <li>
          Os documentos enviados devem ter <strong>finalidade jurídica legítima</strong>. O usuário é
          responsável por observar a LGPD e o sigilo profissional em relação aos dados que submete à
          Plataforma.
        </li>
      </ul>
      <p>
        Os documentos processuais enviados costumam conter dados pessoais de terceiros e informação
        protegida por sigilo profissional (art. 7º, II, e art. 34, VII, da Lei 8.906/1994) e por
        segredo de justiça (art. 189 do Código de Processo Civil). Ao enviá-los, o usuário declara
        deter legitimidade e base legal para fazê-lo. O tratamento desses dados pelo fornecedor, os
        operadores envolvidos e os direitos do titular estão descritos na{" "}
        <Link href="/privacidade">Política de Privacidade</Link>.
      </p>

      <h2>13. Contato</h2>
      <p>Para relatar erro de análise, pedir explicação sobre os critérios ou esclarecer este aviso:</p>
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
          Clientes autenticados podem abrir um chamado em <strong>Suporte</strong> dentro da
          Plataforma, com número de protocolo e histórico das mensagens.
        </li>
      </ul>
      <p>
        Documentos relacionados: <Link href="/termos">Termos de Uso</Link>,{" "}
        <Link href="/privacidade">Política de Privacidade</Link>,{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>,{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link> e{" "}
        <Link href="/reembolso">Política de Reembolso</Link>.
      </p>
    </LegalShell>
  );
}
