import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/marketing/legal-shell";
import { FAIXAS_CUSTO, MAX_PAGINAS_AUTOMATICO } from "@/lib/credits";
import { rotulosDosFormatos } from "@/lib/documents";
import {
  AVISO_REVISAO,
  PLANOS,
  VALIDADE_CREDITO_ADICIONAL_DIAS,
  VALOR_UNITARIO_CREDITO_CENTS,
  precoBR,
} from "@/lib/planos";
import { ATENDIMENTO, linkWhatsApp } from "@/lib/contato";
import { FORNECEDOR, qualificacaoFornecedor } from "@/lib/fornecedor";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Política de Uso Aceitável" };

/**
 * Renderização por requisição, e não estática, por um motivo factual.
 *
 * Este documento publica valores lidos de `env` (limites de arquivo, páginas, ritmo
 * de uso, provedor de IA). Página estática é montada no BUILD, e o estágio de build
 * da imagem define apenas variáveis de fachada — `AI_PROVIDER`, `SESSION_MAX_AGE` e
 * companhia não existem lá. O resultado seria um documento legal publicando o padrão
 * do código em vez da configuração que roda em produção: no caso do provedor de IA,
 * nomear o operador ERRADO na cláusula de transferência internacional (arts. 33 a 36
 * da LGPD), que é exatamente o dado que o assinante advogado lê para decidir se pode
 * subir o processo de um cliente.
 */
export const dynamic = "force-dynamic";

/**
 * Política de Uso Aceitável — por que este documento existe.
 *
 * ── O problema que ele resolve ────────────────────────────────────────────────
 * Os planos vigentes vendem uma COTA de créditos por ciclo mensal (`monthlyCredits`
 * em src/lib/planos.ts) por um preço mensal baixo, com crédito avulso para quem
 * precisar de mais. A cota resolve a QUANTIDADE, e só ela: o contrato ainda tem de
 * distinguir o uso profissional de um assinante do compartilhamento de um login por
 * um escritório inteiro, da revenda da análise como produto de terceiro e da
 * automação por script — nenhuma dessas condutas é medida em créditos, e um
 * escritório inteiro dentro de uma conta consome a cota de forma perfeitamente
 * regular. Pior: o código JÁ barra automação (limite por usuário em
 * src/lib/rate-limit.ts, chamado a partir de env.security.agentRateMax) sem que
 * nenhum texto avisasse o cliente — bloqueio sem base contratual publicada é
 * exatamente o que o art. 6º, III, do CDC não admite.
 *
 * Este documento foi escrito para a oferta ILIMITADA, em que o uso justo tinha de
 * fazer o papel do teto que não existia. Com cota, o limite de quantidade passou a
 * ser contratual e explícito (seção 2), e o que sobra aqui é COMO o acesso é usado.
 *
 * ── Duas fontes de número, e nenhuma digitada ────────────────────────────────
 * 1. Limites que o SISTEMA aplica (requisições por janela, arquivos por análise,
 *    MB por arquivo, formatos, páginas, tentativas de login) vêm de `env` e do
 *    catálogo. São configuráveis por ambiente: se o dono mudar a variável, o texto
 *    publicado muda com ela, e nunca passa a mentir.
 * 2. Prazos do ESCALONAMENTO (aviso, limitação, suspensão, encerramento, reexame)
 *    não existem em lugar nenhum do código: são obrigação contratual criada aqui.
 *    Ficam nas constantes abaixo para que haja um só lugar a ajustar.
 *
 * ── O que este documento deliberadamente NÃO faz ─────────────────────────────
 * Não cria cota além da publicada. A cota da seção 2 é medida pelo sistema para
 * DEBITAR crédito, nunca para punir: esgotá-la recusa a análise seguinte e abre a
 * compra de avulso, e nada mais decorre disso. Somar a ela um teto secreto de
 * punição seria oferta obscura. O que autoriza medida é indício de
 * compartilhamento, automação ou revenda — e sempre com aviso antes, porque
 * cláusula que permite ao fornecedor cortar o serviço de imediato e a seu critério
 * é nula pelo art. 51, IV e XI, do CDC.
 */

/** Prazos contratuais desta política. Não são medidos pelo sistema. */
const DIAS_AVISO_REDUCAO_LIMITE = 30;
const DIAS_UTEIS_RESPOSTA_AVISO = 5;
const DIAS_LIMITACAO_MAXIMA = 15;
const DIAS_UTEIS_AVISO_SUSPENSAO = 5;
/**
 * Aviso prévio do encerramento por violação (seção 10.4). Existe porque a Política de
 * Cancelamento remete a esta política para saber o prazo, e esta seção não tinha nenhum.
 */
const DIAS_UTEIS_AVISO_ENCERRAMENTO = 5;
const DIAS_APURACAO_DENUNCIA = 10;
const DIAS_REEXAME = 10;
const DIAS_DECISAO_REEXAME = 10;
/** Prazo do art. 19, II, da LGPD para atender pedido de acesso aos dados. */
const DIAS_ATENDIMENTO_EXPORTACAO = 15;
/** Prazo para encaminhar à processadora a ordem de devolução proporcional. */
const DIAS_UTEIS_ORDEM_DEVOLUCAO = 5;

/**
 * Rótulo da janela do limite por usuário. A janela é configurável em segundos;
 * escrever “por minuto” no texto sem conferir o valor produziria divergência
 * entre a política e o que o sistema recusa.
 */
const JANELA_SEGUNDOS = env.security.agentRateWindow;
const JANELA_ROTULO =
  JANELA_SEGUNDOS === 60 ? "por minuto" : `a cada ${JANELA_SEGUNDOS} segundos`;

/**
 * Formatos que o texto pode declarar como aceitos.
 *
 * A lista vem de `rotulosDosFormatos()` (src/lib/documents.ts), que traduz em nome
 * comercial a INTERSEÇÃO entre o que a variável de ambiente admite no envio e o que
 * o extrator realmente processa — a mesma interseção que o `validateUpload` aplica,
 * para que o texto e a recusa no envio não digam coisas diferentes. A separação não
 * é preciosismo: o .env deste projeto já admitiu DOCX e XLSX, formatos para os quais
 * a extração de texto não está implementada. Imprimir a variável crua na política
 * anunciaria capacidade inexistente — publicidade que vincula o fornecedor (arts. 30
 * e 37 do CDC) — além de exibir o MIME cru ao leitor. Os rótulos moram junto da lista
 * de formatos processáveis, e não aqui, porque vários documentos publicam a mesma
 * lista e cada cópia local era uma chance de um deles ficar atrás dos outros.
 */
const FORMATOS = rotulosDosFormatos();
const FORMATOS_ROTULO = FORMATOS.length > 0 ? FORMATOS.join(", ") : "os indicados na tela de envio";

/**
 * Usuários por conta. Só afirmamos um número único quando todos os planos
 * públicos o compartilham; havendo divergência, o texto remete ao plano.
 */
const USUARIOS = [...new Set(PLANOS.filter((p) => !p.contactOnly).map((p) => p.maxUsers))];
const USUARIOS_UNICO = USUARIOS.length === 1 ? USUARIOS[0]! : null;
const usuariosTexto =
  USUARIOS_UNICO !== null
    ? `${USUARIOS_UNICO} ${USUARIOS_UNICO === 1 ? "usuário" : "usuários"}`
    : "o número de usuários indicado no plano contratado";

const num = (n: number) => n.toLocaleString("pt-BR");

/**
 * Cota de créditos dos planos vigentes. Mesma cautela do número de usuários: só
 * afirmamos um número único quando todos os planos públicos o compartilham.
 *
 * Cota 0 fica fora da conta porque em todo o sistema ela significa SEM LIMITE
 * (`saldoDe` em src/lib/credits.ts), condição que hoje só existe em plano legado.
 * Sem esse filtro, um plano ilimitado no catálogo faria este documento publicar
 * “0 créditos por ciclo mensal” — o oposto do que a cota 0 quer dizer.
 */
const COTAS = [...new Set(PLANOS.filter((p) => !p.contactOnly && p.monthlyCredits > 0).map((p) => p.monthlyCredits))];
const COTA_UNICA = COTAS.length === 1 ? COTAS[0]! : null;
const cotaTexto =
  COTA_UNICA !== null
    ? `${num(COTA_UNICA)} créditos por ciclo mensal`
    : "a cota de créditos por ciclo mensal indicada no plano contratado";
const cotaAnalisesTexto =
  COTA_UNICA !== null ? `${num(COTA_UNICA)} análises por mês` : "esse número de análises por mês";

export default function UsoAceitavelPage() {
  return (
    <LegalShell title="Política de Uso Aceitável">
      <p>
        Esta política define o que é uso aceitável do Prescrição Pro, plataforma fornecida por{" "}
        {qualificacaoFornecedor()}. Ela integra os <Link href="/termos">Termos de Uso</Link> e deve ser lida em
        conjunto com a <Link href="/politica-de-assinatura">Política de Assinatura</Link>, a{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link> e a{" "}
        <Link href="/privacidade">Política de Privacidade</Link>.
      </p>
      <p>
        O objetivo é um só: os planos vigentes oferecem uma <strong>cota de créditos</strong> por um preço baixo, e essa
        oferta só se sustenta se o acesso for usado como foi contratado — por profissional identificado, em casos
        próprios, pela interface da Plataforma. <strong>Quanto</strong> pode ser analisado é questão de cota, tratada na
        seção 2 e na <Link href="/politica-de-creditos">Política de Créditos</Link>. Este documento trata de{" "}
        <strong>como</strong> o acesso é usado: diz, em termos verificáveis, onde está essa fronteira, quais limites
        técnicos existem hoje e o que acontece, passo a passo, quando um uso a ultrapassa.
      </p>

      <h2>1. Objeto e alcance</h2>
      <p>
        Esta política se aplica a todo acesso à Plataforma, por qualquer meio, incluindo o site público, a área do
        assinante e as rotinas de envio de documentos e de geração de análises. Vincula o assinante, os usuários
        cadastrados na conta e qualquer pessoa que utilize as credenciais da conta.
      </p>
      <p>
        As regras aqui previstas não substituem as obrigações legais do assinante — em especial os deveres do Estatuto
        da Advocacia (Lei nº 8.906/1994), o sigilo profissional e a Lei nº 13.709/2018 (LGPD) — e não criam para o
        fornecedor poder de fiscalizar a atividade profissional do assinante.
      </p>

      <h2>2. A cota de créditos e o que a assinatura autoriza</h2>
      <p>
        Nos planos vigentes, a assinatura libera uma <strong>cota de {cotaTexto}</strong>. A unidade cobrada é o{" "}
        <strong>crédito</strong>, e o custo em créditos acompanha o tamanho do processo: a cota equivale a{" "}
        {cotaAnalisesTexto} nos processos da primeira faixa — até {num(FAIXAS_CUSTO[0].atePaginas)} páginas — e a menos
        análises quando o processo é maior, na forma da tabela da{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>. A cota <strong>não é cumulativa</strong>: o
        saldo mensal não utilizado expira na virada do ciclo.
      </p>
      <p>
        Esgotada a cota, o assinante pode comprar <strong>créditos avulsos</strong> a{" "}
        {precoBR(VALOR_UNITARIO_CREDITO_CENTS)} cada, a qualquer momento, na quantidade que precisar e{" "}
        <strong>sem alterar a assinatura</strong>. O crédito avulso vale {num(VALIDADE_CREDITO_ADICIONAL_DIAS)} dias
        contados da liberação e <strong>atravessa a virada do ciclo</strong>. Esgotar a cota, portanto, não interrompe o
        trabalho e <strong>não é infração desta política</strong>: enquanto não houver crédito, a análise seguinte é
        recusada, e nada além disso decorre do fato.
      </p>
      <p>
        A cota existe por uma razão de custo, e não de desconfiança: cada análise consome processamento pago pelo
        fornecedor, e um plano sem teto obrigaria a cobrar de todos os assinantes o consumo de poucas contas de uso
        intenso. O teto acompanhado de crédito avulso é o que mantém o preço do plano baixo para quem usa a Plataforma
        normalmente. Assinatura contratada em plano descontinuado continua regida pelas condições vigentes na data da
        contratação, na forma da <Link href="/politica-de-creditos">Política de Créditos</Link>.
      </p>
      <p>
        A cota responde <strong>quanto</strong> pode ser analisado; ela não altera o <strong>como</strong>. Contratar o
        plano, e comprar créditos avulsos, <strong>não</strong> significa:
      </p>
      <ul>
        <li>
          <strong>licença coletiva</strong> — cada plano vigente contempla {usuariosTexto}, e o acesso é pessoal e
          intransferível;
        </li>
        <li>
          <strong>licença de revenda</strong> — o resultado da análise é insumo do trabalho do assinante, não produto
          a ser comercializado como serviço próprio de análise automatizada;
        </li>
        <li>
          <strong>ausência de limites técnicos</strong> — o processamento tem limites de tamanho, de formato e de
          ritmo, publicados na seção 3;
        </li>
        <li>
          <strong>autorização para acesso automatizado</strong> — o uso é humano, pela interface, nos termos da seção
          5.
        </li>
      </ul>
      <p>
        Uso aceitável é, portanto, o uso profissional normal de {usuariosTexto} da conta, nos processos em que o
        assinante atua ou cuja análise lhe foi legitimamente confiada — qualquer que seja a quantidade de créditos
        consumida no período.
      </p>

      <h2>3. Limites técnicos e operacionais em vigor</h2>
      <p>
        Os limites abaixo são aplicados automaticamente pela Plataforma e são publicados para que o assinante saiba de
        antemão o que esperar. Exceder um limite <strong>técnico</strong> desta seção <strong>não é infração</strong>: a
        operação é simplesmente recusada, com mensagem na tela, e nenhuma medida da seção 10 decorre disso. O mesmo vale
        para a <strong>cota de créditos</strong> da seção 2, que o sistema mede para debitar, e não para punir: esgotada
        a cota, a análise é recusada até que haja crédito — avulso, ou o do ciclo seguinte —, e nada mais. Não se
        confundem com nenhum dos dois as <strong>regras contratuais de uso</strong> das seções 2, 4, 5 e 6 — número de
        usuários da conta, caráter individual da credencial, vedação de automação e de revenda —, que o sistema não mede
        nem barra sozinho e cujo descumprimento é violação desta política, sujeita às medidas da seção 10.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Limite</th>
              <th>Valor em vigor</th>
              <th>Efeito ao exceder</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                Operações por usuário, em cada tipo de operação — abertura de análise, processamento, envio de
                documento, download de relatório e download de minuta
              </td>
              <td>
                {num(env.security.agentRateMax)} {JANELA_ROTULO}, contadas <strong>separadamente por tipo</strong>
              </td>
              <td>A operação é recusada e volta a ser aceita na janela seguinte, sem penalidade na conta.</td>
            </tr>
            <tr>
              <td>Arquivos por análise</td>
              <td>{num(env.upload.maxFiles)}</td>
              <td>O envio adicional é recusado; o processo pode ser dividido em mais de uma análise.</td>
            </tr>
            <tr>
              <td>Tamanho por arquivo</td>
              <td>{num(env.upload.maxFileMb)} MB</td>
              <td>O arquivo é recusado antes do processamento.</td>
            </tr>
            <tr>
              <td>Formatos aceitos no envio</td>
              <td>{FORMATOS_ROTULO}</td>
              <td>
                Arquivo em outro formato é recusado no envio. Entre os aceitos,{" "}
                <strong>somente o PDF tem o texto lido</strong>: imagem enviada como anexo é armazenada, não passa por
                reconhecimento de texto e fica sinalizada como ilegível.
              </td>
            </tr>
            <tr>
              <td>Páginas por processo, no processamento automático</td>
              <td>Até {num(MAX_PAGINAS_AUTOMATICO)}</td>
              <td>
                Acima disso o processamento automático é recusado e <strong>nenhum crédito é debitado</strong>; o caso
                é encaminhado a análise especial pelos canais de atendimento. A análise especial{" "}
                <strong>não está incluída em nenhum plano</strong> e depende de proposta específica, com preço, prazo e
                escopo acordados por escrito antes da execução.
              </td>
            </tr>
            <tr>
              <td>Páginas transcritas por reconhecimento de texto (OCR), por documento</td>
              <td>Até {num(env.ocr.maxPaginas)}</td>
              <td>As páginas seguintes não são transcritas e a análise informa a leitura parcial.</td>
            </tr>
            <tr>
              <td>Tentativas de login malsucedidas</td>
              <td>{num(env.security.loginMaxAttempts)}</td>
              <td>
                O acesso é bloqueado temporariamente por {num(env.security.loginLockMinutes)} minutos, medida de
                proteção contra tentativa de adivinhação de senha.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        O tamanho máximo do conjunto de arquivos varia conforme a faixa de páginas do processo e está na tabela da{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>. Rotinas públicas — cadastro, recuperação de
        senha e formulário de contato — têm limite próprio por endereço IP, destinado a conter abuso automatizado.
      </p>
      <p>
        Quanto ao reconhecimento de texto: somente arquivos <strong>PDF</strong> são transcritos. Imagens enviadas como
        anexo são aceitas, mas não passam por OCR e ficam sinalizadas como ilegíveis; e, quando os componentes de OCR
        do servidor estão indisponíveis, o documento digitalizado é sinalizado como tal e a análise registra que a
        leitura foi limitada. A conclusão pode apoiar-se em parte das páginas enviadas, e o relatório indica quando
        isso ocorre — razão pela qual a conferência contra os autos é indispensável, na forma do{" "}
        <Link href="/responsabilidade">Aviso de responsabilidade jurídica</Link>.
      </p>
      {/*
        Art. 51, XIII, do CDC: é nula a cláusula que autorize o fornecedor a
        modificar unilateralmente o conteúdo ou a qualidade do contrato. Por isso a
        distinção abaixo — ampliar limite pode ser imediato; REDUZIR o que já foi
        contratado exige aviso prévio e não alcança o período pago, na mesma linha
        da regra de preço da Política de Assinatura.
      */}
      <p>
        Esses limites podem ser ajustados para preservar a estabilidade e a segurança do serviço. Ampliações valem de
        imediato. <strong>Reduções</strong> que restrinjam o uso já contratado são comunicadas com antecedência mínima
        de {DIAS_AVISO_REDUCAO_LIMITE} dias, por e-mail e no painel, e{" "}
        <strong>não retroagem ao período já pago</strong>; discordando, o assinante pode cancelar a assinatura sem
        ônus, na forma da <Link href="/politica-de-assinatura">Política de Assinatura</Link>.
      </p>

      <h2>4. Credenciais, usuários e segurança da conta</h2>
      <ul>
        <li>
          A credencial de acesso é <strong>individual</strong>. É vedado compartilhar login, senha, código de segundo
          fator ou sessão ativa, e é vedado o uso da conta por quem não é usuário cadastrado do plano.
        </li>
        <li>
          Sendo o assinante pessoa jurídica ou sociedade de advogados, cabe a ela indicar o usuário titular do acesso e
          comunicar sua substituição; o acesso permanece vinculado a uma pessoa identificada, não ao cargo.
        </li>
        <li>
          A Plataforma disponibiliza <strong>autenticação em dois fatores</strong>, de ativação opcional pelo próprio
          usuário na área do assinante. A ativação é recomendada, e recomendada com ênfase quando a conta trata
          documentos sob sigilo.
        </li>
        <li>
          O assinante deve comunicar <strong>imediatamente</strong>, pelos canais da seção 15, qualquer indício de
          comprometimento de credencial, acesso indevido ou perda do dispositivo de segundo fator.
        </li>
        <li>Tentar acessar conta, análise ou documento de outro assinante é vedado e será tratado na forma da seção 10.</li>
      </ul>
      {/*
        Presunção RELATIVA, e com ônus de apuração do fornecedor. Escrever que o
        assinante responde por tudo o que ocorra com sua credencial, sem prova e
        sem prazo, criaria inversão do ônus da prova em prejuízo do consumidor —
        nula pelo art. 51, VI, do CDC. Os registros existem e são o que permite
        apurar de verdade, mas não guardam a mesma coisa: a tabela de SESSÕES tem
        IP e navegador de cada acesso; a trilha de AUDITORIA grava autor, ação e
        data, e recebe IP e navegador apenas quando a rota os informa — hoje, nos
        downloads de documento, de relatório e de minuta. Descrever as duas como
        se fossem uma só faria o texto prometer prova que o assinante não
        encontraria ao pedir os registros.
      */}
      <p>
        Presume-se, até prova em contrário, que as operações realizadas com as credenciais da conta foram praticadas
        pelo usuário a quem pertencem. Comunicado o comprometimento, cessa a responsabilidade do assinante pelas
        operações posteriores à comunicação, e o fornecedor apura o ocorrido com base nos{" "}
        <strong>registros de sessão</strong> — que guardam data, endereço IP e identificação do navegador de cada acesso
        — e na <strong>trilha de auditoria das operações</strong>, que registra autor, ação, data e o arquivo ou a
        análise alcançados, com o endereço IP e a identificação do navegador nos downloads de documento, de relatório e
        de minuta. Havendo indício de acesso indevido, o fornecedor pode encerrar as sessões ativas e exigir a
        redefinição de senha, informando o assinante.
      </p>

      <h2>5. Acesso automatizado</h2>
      <p>
        O acesso à Plataforma é feito pela interface web, por pessoa natural. É vedado, sem autorização escrita
        específica do fornecedor:
      </p>
      <ul>
        <li>utilizar robô, script, macro, agente automatizado, extensão ou qualquer rotina que simule uso humano;</li>
        <li>
          realizar coleta automatizada de dados (<em>scraping</em>), rastreamento sistemático de páginas ou reprodução
          em massa de conteúdo da Plataforma;
        </li>
        <li>
          acessar rotinas internas do sistema fora da interface oferecida ao usuário; a Plataforma{" "}
          <strong>não disponibiliza interface de programação (API) pública</strong>, e não há acesso por integração
          oferecido nos planos vigentes;
        </li>
        <li>
          contornar, desativar ou multiplicar contas para escapar de limite técnico, inclusive os da seção 3, ou da cota
          de créditos da seção 2 — que se complementa com crédito avulso, não com uma segunda conta.
        </li>
      </ul>
      <p>
        A vedação não alcança recursos de acessibilidade, gerenciadores de senha ou tecnologia assistiva utilizados pelo
        próprio usuário.
      </p>

      <h2>6. Revenda, sublicenciamento e prestação de serviço a terceiros</h2>
      {/*
        Fronteira comercial mais delicada do documento. O cliente É advogado e
        trabalha para os clientes dele — proibir “uso em benefício de terceiro”
        proibiria o uso normal e esvaziaria o produto. O que se veda é
        intermediação do acesso e comercialização da análise como serviço próprio.
      */}
      <p>
        É <strong>permitido</strong>, porque é exatamente o uso contratado: analisar processos dos clientes do
        assinante, empregar o relatório e a minuta no patrocínio da causa e cobrar do próprio cliente pelos serviços
        advocatícios prestados.
      </p>
      <p>
        É <strong>vedado</strong>:
      </p>
      <ul>
        <li>revender, sublicenciar, ceder, alugar, emprestar ou compartilhar o acesso, a título gratuito ou oneroso;</li>
        <li>
          intermediar o acesso de terceiros — inclusive de outros advogados, escritórios, correspondentes ou empresas —
          operando a conta em nome deles;
        </li>
        <li>
          oferecer a análise automatizada da Plataforma como produto ou serviço próprio, com ou sem marca própria,
          integrando-a a oferta de terceiro;
        </li>
        <li>
          utilizar a conta para prestar a terceiros serviço de análise em volume desvinculado do patrocínio das causas
          pelo próprio assinante.
        </li>
      </ul>
      <p>
        Escritório com mais de um profissional deve contratar uma assinatura por usuário. Havendo interesse em uso
        coletivo, condições específicas podem ser tratadas pelos canais de atendimento antes de qualquer
        compartilhamento.
      </p>

      <h2>7. Outras condutas vedadas</h2>
      <ul>
        <li>
          <strong>Uso ilícito</strong> — empregar a Plataforma para fim contrário à lei, para fraude, para
          constrangimento de terceiro ou para obter vantagem indevida.
        </li>
        <li>
          <strong>Envio sem legitimidade</strong> — submeter documento sobre o qual o assinante não tenha legitimidade
          ou base legal, na forma da seção 8.
        </li>
        <li>
          <strong>Tentativa de burlar segurança ou isolamento</strong> — testar, sondar ou explorar vulnerabilidade,
          tentar acessar dados de outra conta, alterar identificadores para alcançar registro alheio ou interferir na
          disponibilidade do serviço. A conduta pode configurar, ainda, o crime do art. 154-A do Código Penal.
        </li>
        <li>
          <strong>Engenharia reversa</strong> — descompilar, desmontar, extrair código-fonte, replicar a lógica interna
          ou remover marcação de autoria, ressalvadas as hipóteses expressamente permitidas pela legislação de proteção
          de programa de computador.
        </li>
        <li>
          <strong>Uso para treinar modelo concorrente</strong> — empregar relatórios, minutas, textos, respostas ou
          qualquer saída da Plataforma para treinar, ajustar ou avaliar modelo de inteligência artificial destinado a
          serviço concorrente, próprio ou de terceiro.
        </li>
        <li>
          <strong>Extração massiva da base de conhecimento</strong> — provocar, coletar ou reconstituir, de forma
          sistemática, a metodologia, os roteiros de análise ou a base jurídica utilizada pela Plataforma, inclusive por
          submissões repetidas com essa finalidade.
        </li>
        <li>
          <strong>Uso por quem não é advogado para produzir peça em nome alheio</strong> — a Plataforma gera minuta que
          exige revisão e assinatura de advogado(a) habilitado(a). A postulação em juízo é atividade privativa da
          advocacia (art. 1º, I, da Lei nº 8.906/1994) e são nulos os atos privativos praticados por quem não é
          inscrito na Ordem (art. 4º da mesma lei). É vedado utilizar a Plataforma para produzir peça a ser protocolada
          em nome de advogado(a) que não a revisou.
        </li>
        <li>
          <strong>Inserção de conteúdo indevido</strong> — enviar arquivo com programa malicioso, ou instrução destinada
          a alterar o comportamento do sistema de análise.
        </li>
      </ul>

      <h2>8. Documentos de terceiros, legitimidade e sigilo</h2>
      <p>
        Os documentos enviados contêm dados pessoais de terceiros — partes, representantes, servidores — e dados
        fiscais, financeiros e judiciais. Quanto a esses dados, o <strong>assinante é o controlador</strong> e o
        fornecedor atua como <strong>operador</strong>, tratando-os exclusivamente para executar a análise solicitada
        (art. 5º, VI e VII, da LGPD). O detalhamento está na{" "}
        <Link href="/privacidade">Política de Privacidade</Link>.
      </p>
      <p>Ao enviar documentos, o assinante declara e assume que:</p>
      <ul>
        <li>
          atua no processo, ou de outro modo detém <strong>legitimidade e base legal</strong> para tratar aqueles
          documentos e determinar seu envio à Plataforma;
        </li>
        <li>
          observa o princípio da <strong>finalidade e da necessidade</strong> (art. 6º, I e III, da LGPD), enviando
          apenas o que a análise requer;
        </li>
        <li>
          responde pelo <strong>sigilo profissional</strong> que recai sobre o material (art. 7º, II, e art. 34, VII,
          da Lei nº 8.906/1994) e, quando o processo tramitar em segredo de justiça, pela observância do art. 189 do
          Código de Processo Civil;
        </li>
        <li>
          não envia documento de processo em que não atua, nem documento obtido de forma indevida, salvo quando houver
          base legal específica que o autorize.
        </li>
      </ul>
      <p>
        O fornecedor não verifica a legitimidade de cada envio — não teria como fazê-lo sem violar o próprio sigilo que
        se pretende proteger. A declaração acima é, por isso, condição do uso, e o envio irregular é violação desta
        política, sem prejuízo da responsabilidade do controlador perante os titulares e a autoridade (art. 42 da
        LGPD).
      </p>

      <h2>9. Como um uso atípico é identificado</h2>
      {/*
        Núcleo honesto do documento. O sistema mede CRÉDITO para debitar, não volume
        de análises para punir, e a apuração se dá pelos registros de sessão e
        auditoria. Anunciar detecção automática de abuso que não existe seria
        afirmação factual insustentável (arts. 30 e 37 do CDC); somar à cota
        publicada um teto secreto de punição seria oferta obscura. Daí a fórmula, que
        a chegada da cota não muda: volume é INDÍCIO, nunca causa.
      */}
      <p>
        <strong>A única cota é a da seção 2, e ela está publicada.</strong> Além dela, a Plataforma não fixa teto oculto
        de análises: nenhuma quantidade de análises — dentro da cota, ou acima dela com créditos avulsos regularmente
        comprados — caracteriza, isoladamente, infração ou autoriza medida.
      </p>
      <p>A apuração de uso atípico ocorre por dois meios, e nada além deles:</p>
      <ul>
        <li>
          os <strong>limites automáticos da seção 3</strong>, que atuam no momento da operação, recusando-a, sem efeito
          sobre a conta;
        </li>
        <li>
          a <strong>análise dos registros de sessão</strong> — que guardam data, endereço IP e identificação do
          navegador de cada acesso — e da <strong>trilha de auditoria das operações</strong>, que registra autor, ação e
          data, além do endereço IP e do navegador nos downloads de documento, de relatório e de minuta. Essa análise só
          é feita quando houver indício concreto de compartilhamento de credencial, automação ou revenda. A guarda desses
          registros atende também ao dever legal de conservação dos registros de acesso a aplicações de internet
          (art. 15 da Lei nº 12.965/2014).
        </li>
      </ul>
      <p>São exemplos de indício, e apenas de indício:</p>
      <ul>
        <li>sessões simultâneas a partir de endereços IP incompatíveis entre si;</li>
        <li>
          requisições em intervalos regulares, ou por cliente que não é navegador, sugerindo rotina automatizada;
        </li>
        <li>
          volume de análises manifestamente incompatível com o trabalho de {usuariosTexto} — inclusive quando sustentado
          por compra sucessiva de créditos avulsos —, quando somado a outro indício desta lista; a compra de créditos
          avulsos, por si só, não é indício de nada, e é o uso previsto do produto;
        </li>
        <li>
          criação de contas sucessivas com os mesmos dados de contato, após limite técnico atingido ou cota esgotada.
        </li>
      </ul>
      {/*
        A apuração fica restrita a metadados de propósito. Os papéis internos têm
        acesso técnico ao conteúdo (ver Política de Privacidade), e por isso a
        restrição precisa ser dita como COMPROMISSO — é o que impede que “apurar
        abuso” se torne porta de entrada para ler processo de cliente.
      */}
      <p>
        Verificado indício, o primeiro passo é sempre <strong>contato e esclarecimento</strong>, na forma da seção 10. A
        apuração se limita aos registros de acesso e aos metadados da conta: o fornecedor{" "}
        <strong>assume o compromisso de não examinar o conteúdo dos documentos enviados</strong> para apurar uso
        atípico. O compromisso é contratual e organizacional, não uma trava do sistema — perfis internos de
        administração e de revisão têm acesso técnico ao conteúdo, e o que o sistema garante é o{" "}
        <strong>registro de cada acesso a arquivo</strong>, como declara a{" "}
        <Link href="/privacidade">Política de Privacidade</Link>.
      </p>

      <h2>10. Medidas aplicáveis e escalonamento</h2>
      {/*
        O escalonamento é o que torna a cláusula de suspensão válida. Art. 51, IV,
        do CDC (desvantagem exagerada) e XI (cancelamento unilateral sem igual
        direito ao consumidor): como o assinante pode cancelar a qualquer momento,
        o fornecedor pode encerrar — mas só motivadamente, na menor medida útil e
        com reexame. Sem essa gradação a cláusula seria potestativa e nula.
      */}
      <p>
        Constatada violação desta política, as medidas são aplicadas na <strong>menor extensão suficiente</strong> para
        fazê-la cessar, e nesta ordem:
      </p>
      <h3>10.1. Aviso e diálogo</h3>
      <p>
        O fornecedor comunica o assinante, por e-mail e pelo painel, descrevendo o padrão observado e a regra em
        questão, e abre prazo de {DIAS_UTEIS_RESPOSTA_AVISO} dias úteis para esclarecimento ou ajuste. O contato pode
        ser feito também pelo SAC, no número indicado na seção 15. Nenhuma restrição de acesso é aplicada nesta etapa.
      </p>
      <h3>10.2. Limitação temporária</h3>
      <p>
        Não havendo resposta nem ajuste no prazo, o fornecedor pode aplicar <strong>limitação temporária</strong> do
        uso, pelo período necessário e não superior a {DIAS_LIMITACAO_MAXIMA} dias, empregando a medida menos restritiva
        de que dispuser — redução do limite de operações da conta ou bloqueio do envio de novos documentos e da abertura
        de novas análises. Durante a limitação, o{" "}
        <strong>acesso à conta e a consulta ao histórico na tela são mantidos</strong>; a retirada de relatório, de
        minuta e de documentos <strong>depende de assinatura ativa</strong>, na forma dos{" "}
        <Link href="/termos">Termos de Uso</Link>, e pode ficar indisponível nas medidas que alcançam a assinatura,
        tratadas nas seções 10.3 e 10.4 — razão pela qual o aviso da etapa anterior é o momento de exportar o material
        dos processos em curso, e o pedido de exportação apresentado pelos canais da seção 15 é atendido no prazo de{" "}
        {DIAS_ATENDIMENTO_EXPORTACAO} dias, na forma do art. 19, II, da LGPD. Não sendo tecnicamente possível aplicar
        medida parcial, o fornecedor <strong>reitera o aviso</strong> e abre novo prazo igual ao da etapa anterior, em
        vez de passar diretamente à suspensão. A medida é comunicada com sua razão e cessa com o ajuste do uso.
      </p>
      <h3>10.3. Suspensão</h3>
      {/*
        Ponto de honestidade que o dono precisa conhecer: com assinatura em
        SUSPENSA o LOGIN é recusado (src/app/api/auth/login/route.ts), então o
        titular não entra nem para exportar dados. Prometer “exportação durante a
        suspensão” seria falso. A solução redigida é a janela de exportação ANTES
        do corte e o atendimento do pedido por e-mail depois dele — art. 18 e
        art. 19, II, da LGPD.
      */}
      <p>
        Persistindo a violação após a limitação ou após o novo prazo aberto na seção 10.2, ou tratando-se de fraude, uso
        ilícito, conteúdo malicioso, ordem de autoridade competente ou risco iminente à segurança e aos dados de
        terceiros, a assinatura pode ser{" "}
        <strong>suspensa</strong>. A suspensão bloqueia o acesso à conta, inclusive à exportação de dados feita pelo
        próprio usuário. Por isso:
      </p>
      <ul>
        <li>
          fora das hipóteses de risco iminente, a suspensão é <strong>precedida de aviso</strong> com{" "}
          {DIAS_UTEIS_AVISO_SUSPENSAO} dias úteis de antecedência, prazo destinado a que o assinante exporte seus dados
          e organize o material dos processos em curso;
        </li>
        <li>
          havendo suspensão imediata por risco iminente, a motivação é comunicada em seguida e o pedido de exportação
          apresentado pelos canais da seção 15 é atendido no prazo de {DIAS_ATENDIMENTO_EXPORTACAO} dias, na forma do
          art. 19, II, da LGPD;
        </li>
        <li>a suspensão é reversível: cessada a causa, o acesso é restabelecido sem custo de reativação.</li>
      </ul>
      <h3>10.4. Encerramento</h3>
      <p>
        Persistindo a violação depois da suspensão, ou sendo ela de tal gravidade que torne inviável a continuidade, a
        assinatura pode ser <strong>encerrada</strong>, mediante comunicação motivada e{" "}
        <strong>precedida de aviso</strong> com {DIAS_UTEIS_AVISO_ENCERRAMENTO} dias úteis de antecedência, prazo
        destinado à manifestação do assinante e ao pedido de exportação pelos canais da seção 15. Nesse caso:
      </p>
      <ul>
        <li>
          <strong>não havendo fraude nem uso ilícito</strong>, o valor proporcional ao período contratado e não fruído é{" "}
          <strong>devolvido</strong>, monetariamente atualizado, pelo mesmo meio de pagamento quando possível. Esta é a
          regra do encerramento por violação desta política, na mesma linha da{" "}
          <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>;
        </li>
        <li>
          havendo fraude ou uso ilícito comprovado, não há devolução, sem prejuízo do direito de exportar os dados e de
          pedir o reexame previsto na seção 11;
        </li>
        <li>
          a retenção e a eliminação dos dados após o encerramento seguem a{" "}
          <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>.
        </li>
      </ul>
      <p>
        A ordem de devolução é encaminhada à processadora de pagamento em até {DIAS_UTEIS_ORDEM_DEVOLUCAO} dias úteis
        contados da comunicação do encerramento, pelo procedimento e pelos meios descritos na{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>; o prazo de crédito efetivo é o da
        processadora e da instituição financeira envolvidas.
      </p>
      <p>
        As medidas desta seção não se confundem com o bloqueio por inadimplência ou com o encerramento por não
        pagamento, regidos pela <Link href="/politica-de-assinatura">Política de Assinatura</Link>, nem com a suspensão
        decorrente de estorno ou contestação de cobrança, regida pela{" "}
        <Link href="/reembolso">Política de Reembolso</Link>.
      </p>
      <p>
        Quanto às medidas por violação desta política, prevalecem <strong>as etapas e os prazos desta seção</strong>; a{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link> rege a retenção dos dados, a janela de
        reativação e as demais causas de encerramento. Havendo divergência entre os dois documentos sobre a mesma etapa,
        ou silêncio desta seção quanto a ela, aplica-se a disposição <strong>mais favorável ao assinante</strong> ou a
        que descreva com maior precisão o funcionamento efetivo da Plataforma; em nenhum caso a prevalência de um
        documento suprime garantia legal do assinante.
      </p>

      <h2>11. Reexame da medida</h2>
      <p>
        O assinante pode pedir o reexame de qualquer medida desta política no prazo de {DIAS_REEXAME} dias contados da
        comunicação, pelos canais da seção 15, apresentando as razões e os elementos que entender pertinentes. O pedido
        é apreciado por pessoa distinta de quem aplicou a medida, sempre que a estrutura do fornecedor o permitir, e a
        decisão é comunicada por escrito, com motivação, no prazo de {DIAS_DECISAO_REEXAME} dias.
      </p>
      <p>
        O reexame não impede o assinante de recorrer aos órgãos de defesa do consumidor nem ao Poder Judiciário, e a
        adoção de medida indevida obriga o fornecedor a restabelecer o acesso e a reparar o prejuízo comprovado.
      </p>

      <h2>12. Denúncia de abuso</h2>
      <p>
        Suspeita de uso indevido da Plataforma, de credencial compartilhada, de conteúdo ilícito ou de envio de
        documento por quem não tem legitimidade pode ser comunicada pelos canais da seção 15 ou pelo endereço{" "}
        {FORNECEDOR.email}. Para questões relativas a dados pessoais, o canal é o do Encarregado, indicado na{" "}
        <Link href="/privacidade">Política de Privacidade</Link>.
      </p>
      <p>
        A denúncia é apurada no prazo de {DIAS_APURACAO_DENUNCIA} dias, prorrogável uma vez, de forma justificada,
        quando a apuração depender de informação de terceiro. O denunciante é informado do resultado no que lhe diz
        respeito, preservados o sigilo profissional, os dados de terceiros e o direito de defesa do denunciado. O
        fornecedor não retalia quem comunica abuso de boa-fé.
      </p>

      <h2>13. Efeitos do descumprimento</h2>
      <p>
        A violação desta política é <strong>inadimplemento contratual</strong> e autoriza as medidas da seção 10, sem
        prejuízo da responsabilidade civil pelos prejuízos causados, da responsabilidade perante terceiros e
        autoridades e das providências judiciais cabíveis. O uso além do contratado — que não é o esgotamento da cota,
        resolvido com crédito avulso ou com a virada do ciclo, mas o compartilhamento de credencial e a operação da
        conta em benefício de terceiros — pode ensejar a cobrança das assinaturas que seriam
        necessárias para os acessos efetivamente utilizados, pelo preço vigente na página de{" "}
        <Link href="/planos">Planos</Link> no período. A cobrança é apurada com base nos registros, comunicada ao
        assinante com a <strong>memória de cálculo</strong> e sujeita ao <strong>reexame da seção 11</strong>; não
        havendo concordância, depende de acordo entre as partes ou de decisão judicial, e nada é lançado em cobrança,
        descontado de valor a devolver ou informado a cadastro de inadimplentes antes disso.
      </p>
      <p>
        Nenhuma disposição desta política afasta os direitos assegurados ao assinante pela legislação de consumo, nem o
        direito de cancelar a assinatura a qualquer momento, na forma da{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>. A tolerância do fornecedor quanto a
        eventual violação não significa renúncia às medidas previstas.
      </p>

      <h2>14. Avisos obrigatórios</h2>
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

      <h2>15. Contato</h2>
      <p>
        Dúvidas sobre esta política, pedidos de esclarecimento, pedidos de reexame e denúncias de abuso podem ser
        dirigidos aos canais abaixo:
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
          Clientes autenticados podem abrir um chamado em <Link href="/suporte">Suporte</Link> dentro da Plataforma,
          com número de protocolo e histórico das mensagens.
        </li>
        <li>Mensagens gerais: {FORNECEDOR.email}.</li>
      </ul>
      <p>
        Documentos relacionados: <Link href="/termos">Termos de Uso</Link>,{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>,{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>,{" "}
        <Link href="/reembolso">Política de Reembolso</Link>,{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>,{" "}
        <Link href="/privacidade">Política de Privacidade</Link>,{" "}
        <Link href="/cookies">Política de Cookies</Link> e{" "}
        <Link href="/responsabilidade">Aviso de responsabilidade jurídica</Link>.
      </p>
    </LegalShell>
  );
}
