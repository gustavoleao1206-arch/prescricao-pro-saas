import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/marketing/legal-shell";
import { FORNECEDOR, qualificacaoFornecedor } from "@/lib/fornecedor";
import { ATENDIMENTO, SAC, linkWhatsApp } from "@/lib/contato";
import { AVISO_REVISAO } from "@/lib/planos";
import { rotulosDosFormatos } from "@/lib/documents";
import { env } from "@/lib/env";
import { activeModel } from "@/lib/ai/provider";
/**
 * Prazo de resposta ao titular (art. 19, II, da LGPD) — IMPORTADO, não digitado.
 *
 * O número estava escrito aqui e também na Política de Cancelamento e Retenção, e agora um
 * terceiro lugar depende dele: a varredura que vigia o prazo praticado
 * (`vigiarPrazosDoTitular`). Documento e sistema anunciando prazos diferentes seria pior que
 * qualquer um dos dois errado sozinho — e divergência interna em contrato de adesão é o que
 * o art. 46 do CDC pune com a inexigibilidade da cláusula.
 */
import { PRAZO_RESPOSTA_TITULAR_DIAS } from "@/lib/pedido-do-titular";
import { RETENCAO } from "@/lib/retencao";

export const metadata: Metadata = { title: "Política de Privacidade" };

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
 * O provedor de IA em uso é LIDO DO AMBIENTE, não escrito no texto.
 *
 * O padrão do código é "anthropic", mas o blueprint de produção define openai.
 * Uma política que nomeasse o provedor à mão apontaria o operador ERRADO na
 * cláusula de transferência internacional (arts. 33 a 36 da LGPD) — e é
 * exatamente essa a informação que o assinante advogado precisa para decidir se
 * pode subir o processo de um cliente.
 *
 * Os DOIS provedores aparecem na tabela em qualquer configuração: se o ambiente
 * de build divergir do de execução, o pior resultado possível é um rótulo de
 * situação desatualizado — nunca um operador omitido, que é o erro grave.
 */
const PROVEDORES_IA = [
  { chave: "openai", nome: "OpenAI", pais: "Estados Unidos" },
  { chave: "anthropic", nome: "Anthropic PBC", pais: "Estados Unidos" },
] as const;

const IA_EM_USO = env.ai.provider === "anthropic" ? "anthropic" : "openai";
const MODELO_EM_USO = activeModel();

/**
 * Formatos de arquivo citados na seção 2.5, lidos de `rotulosDosFormatos()`
 * (src/lib/documents.ts) — a fonte única, que devolve a interseção entre a
 * configuração de envio e o que a extração realmente lê. Escrito à mão, o texto
 * anunciaria formato que a Plataforma não processa (arts. 30 e 37 do CDC).
 */
const FORMATOS_DO_ARQUIVO = rotulosDosFormatos();
const FORMATOS_ROTULO =
  FORMATOS_DO_ARQUIVO.length === 0
    ? "formatos indicados na tela de envio"
    : FORMATOS_DO_ARQUIVO.length === 1
      ? (FORMATOS_DO_ARQUIVO[0] ?? "")
      : `${FORMATOS_DO_ARQUIVO.slice(0, -1).join(", ")} ou ${FORMATOS_DO_ARQUIVO[FORMATOS_DO_ARQUIVO.length - 1] ?? ""}`;

/**
 * Prazos de retenção e de resposta — os números canônicos da Política de
 * Cancelamento e Retenção, reproduzidos aqui uma única vez.
 *
 * A seção 9 desta Política e a tabela daquela tratam da MESMA matéria, e os Termos
 * de Uso remetem ora a um documento, ora ao outro (o §8.3 manda eliminar "na forma
 * da Política de Cancelamento e Retenção"; o §8.5 diz que "os prazos de retenção
 * estão na Política de Privacidade"). Dois textos do mesmo contrato de adesão
 * anunciando prazos diferentes para autos cobertos por sigilo profissional é
 * exatamente o defeito que o art. 46 do CDC pune com a inexigibilidade da cláusula
 * — por isso nenhum destes números é digitado no meio do texto.
 *
 * A pendência que este bloco anunciava foi cumprida (set/2026): os valores agora
 * vêm de `@/lib/retencao` — o MESMO módulo que a manutenção diária usa para
 * executar a parte executável dos prazos. Documento e rotina leem a mesma
 * constante; não há como prometer um número e aplicar outro.
 */

// O prazo de resposta ao titular vem de `@/lib/pedido-do-titular` — ver o import no topo.

/**
 * Aviso prévio de alteração desta Política (seção 14). É prazo criado por este
 * documento, não lido do código — por isso vira constante no topo do arquivo.
 */
const PRAZO_AVISO_ALTERACAO_DIAS = 30;

/**
 * ── Nota ao dono, que não vai no texto ────────────────────────────────────────
 * Três compromissos desta política dependem de ato seu, não de código:
 *
 * 1. Contrato com garantias (seção 6). Assine o adendo de proteção de dados de
 *    cada operador internacional (hospedagem, armazenamento de arquivo, provedor
 *    de IA, provedor de e-mail) e confira a razão social exata de cada um antes
 *    de tratar esta lista como definitiva. Aqui vão nomes comerciais e país,
 *    que é o que a LGPD exige informar; o instrumento é que fixa a garantia.
 *    A seção 6 foi reescrita justamente para não afirmar o que ainda não existe:
 *    ela invoca como BASE apenas o art. 33, IX (execução do contrato), e trata as
 *    cláusulas-padrão da Resolução CD/ANPD nº 19/2024 como COMPROMISSO de adoção
 *    com quem as aceite — os adendos padrão de Render, Cloudflare, OpenAI e
 *    Resend usam cláusulas europeias, não o modelo da ANPD. Quando você assinar um
 *    instrumento que adote o modelo brasileiro, aí sim a base do art. 33, II, "b",
 *    pode ser afirmada como fato para aquele operador.
 * 2. Localização do bucket. O armazenamento de arquivos aceita região automática
 *    (S3_REGION=auto no blueprint), e por isso a seção 5 declara "sem garantia de
 *    território determinado" em vez de nomear país. Se a residência do dado
 *    importar para algum cliente seu, fixe a região no painel do provedor e
 *    atualize a coluna "Onde está" da seção 5 e a primeira frase da seção 6.
 * 3. Retenção do conteúdo no provedor de IA. A seção 4.4 diz que o provedor pode
 *    retê-lo por período curto para monitoramento de abuso — é o padrão de API
 *    hoje. Se você contratar retenção zero, atualize a frase; se o provedor
 *    mudar a regra, a frase precisa mudar antes dele.
 *
 * ── Duas divergências apontadas na redação, já corrigidas NO CÓDIGO ───────────
 * Valem registro porque o texto só pôde afirmar o que afirma depois delas:
 *  • `apagarConta` não removia os arquivos do armazenamento. A cascata apagava a
 *    linha `Document` — e com ela a `storageKey` — deixando cópias integrais de
 *    execução fiscal guardadas sem registro de quem eram. Para a LGPD isso não é
 *    eliminação (art. 16 e art. 18, VI); é perda de rastreio. A função passou a
 *    apagar os objetos ANTES do banco.
 *  • O pedido de exclusão feito pelo cliente notificava apenas ele mesmo: nenhum
 *    administrador era avisado, e o prazo que esta política promete só seria
 *    cumprido se alguém fosse ler a auditoria por conta própria. O pedido agora
 *    entra na fila dos administradores e vai por e-mail ao canal de privacidade.
 */
export default function PrivacidadePage() {
  return (
    <LegalShell title="Política de Privacidade">
      <p>
        Esta Política descreve como o Prescrição Pro trata dados pessoais: quais dados, para quê, com qual base legal,
        com quem são compartilhados, para onde vão, por quanto tempo ficam guardados e como o titular exerce seus
        direitos. Ela dá cumprimento ao dever de informação clara, adequada e ostensiva do art. 9º da Lei nº
        13.709/2018 (LGPD) e integra os <Link href="/termos">Termos de Uso</Link>.
      </p>
      <p>
        Publica esta Política, na qualidade de responsável pela Plataforma, {qualificacaoFornecedor()}.
      </p>
      <p>Ela se aplica a três grupos de pessoas:</p>
      <ul>
        <li>
          <strong>o assinante</strong> — o advogado ou a sociedade de advogados que contrata e usa a Plataforma;
        </li>
        <li>
          <strong>o visitante</strong> do site, inclusive quem apenas usa o formulário de contato;
        </li>
        <li>
          <strong>o terceiro</strong> cujos dados pessoais constam de documento enviado por um assinante — em regra, as
          partes e os demais interessados de uma execução fiscal.
        </li>
      </ul>

      {/*
        Esta seção é o coração do documento. O texto anterior dizia que o
        fornecedor era controlador de tudo, inclusive dos documentos processuais.
        Isso é errado e caro nos dois sentidos: atrai para o fornecedor a
        responsabilidade por dados de terceiros que ele não decide tratar, e
        deixa o assinante sem o instrumento do art. 39 de que ele precisa para
        cumprir a própria LGPD — que os três outros documentos legais exigem
        dele.
      */}
      <h2>1. Quem responde pelo quê: controlador e operador</h2>
      <p>
        A LGPD distingue o <strong>controlador</strong>, a quem competem as decisões sobre o tratamento (art. 5º, VI),
        do <strong>operador</strong>, que trata dados em nome do controlador (art. 5º, VII). Na Plataforma os dois
        papéis coexistem, e a distinção não é formalidade: ela define quem decide o destino do dado e quem responde
        perante o titular.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Conjunto de dados</th>
              <th>Quem decide as finalidades</th>
              <th>Papel do Prescrição Pro</th>
              <th>Exemplos</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Cadastro, conta, cobrança, suporte, segurança e registros de uso</td>
              <td>O Prescrição Pro</td>
              <td>
                <strong>Controlador</strong> (art. 5º, VI)
              </td>
              <td>Nome, e-mail, telefone, CPF/CNPJ, sessões, pagamentos, trilha de auditoria</td>
            </tr>
            <tr>
              <td>
                Documentos processuais enviados, o texto extraído deles e os dados processuais informados pelo
                assinante
              </td>
              <td>O assinante</td>
              <td>
                <strong>Operador</strong> (art. 5º, VII)
              </td>
              <td>
                Autos e certidões, nome e CPF/CNPJ do executado, exequente, número do processo, número da CDA, valores
              </td>
            </tr>
            <tr>
              <td>Dados de contato de visitante do site</td>
              <td>O Prescrição Pro</td>
              <td>
                <strong>Controlador</strong> (art. 5º, VI)
              </td>
              <td>Nome, e-mail, telefone e mensagem enviados no formulário de contato</td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>1.1 O que o assinante declara e assume</h3>
      <p>
        Ao enviar documentos, o assinante determina o tratamento — o envio é, em si, a instrução ao operador (art. 39).
        Nesse ato o assinante declara e assume que:
      </p>
      <ul>
        <li>
          atua na causa ou detém autorização para tratar aqueles documentos, e possui <strong>base legal própria</strong>{" "}
          para o tratamento, em regra o exercício regular de direitos em processo judicial, administrativo ou arbitral
          (art. 7º, VI, e art. 11, II, “d”, da LGPD);
        </li>
        <li>
          envia <strong>somente o necessário</strong> à análise pretendida, observando o princípio da necessidade (art.
          6º, III) — peça estranha à matéria não melhora o resultado e amplia o dado exposto;
        </li>
        <li>
          é o <strong>controlador</strong> perante os titulares dos dados contidos nos documentos, inclusive quanto aos
          pedidos do art. 18, cabendo à Plataforma auxiliá-lo (seção 10.2);
        </li>
        <li>
          os documentos enviados devem ter <strong>finalidade jurídica legítima</strong>. O usuário é responsável por
          observar a LGPD e o sigilo profissional em relação aos dados que submete à Plataforma.
        </li>
      </ul>

      <h3>1.2 O que assumimos como operador</h3>
      <ul>
        <li>
          tratar os documentos <strong>exclusivamente para executar a análise solicitada</strong>, nos limites das
          instruções do assinante;
        </li>
        <li>
          <strong>não usar o conteúdo para finalidade própria</strong>: não o incorporamos à nossa base de
          conhecimento, não o usamos como exemplo comercial, não o utilizamos em benefício de outro assinante e não o
          usamos para treinar modelo (seção 4.4);
        </li>
        <li>manter nossos prepostos vinculados a dever de confidencialidade;</li>
        <li>manter as medidas de segurança da seção 7 e o registro das operações de tratamento (art. 37);</li>
        <li>
          <strong>auxiliar o assinante</strong> no atendimento a pedidos de titular e a requisições da ANPD, fornecendo
          as informações e executando as operações técnicas necessárias;
        </li>
        <li>comunicar ao assinante incidente de segurança que alcance seus documentos (seção 11);</li>
        <li>eliminar os documentos e o texto extraído quando o assinante o determinar (seção 9);</li>
        <li>
          não admitir novo operador com acesso a conteúdo de documento sem informar previamente (seção 5.3).
        </li>
      </ul>

      {/*
        Ressalva de honestidade exigida pelo código: `privileged = ADMIN ||
        REVISOR` em src/lib/tenant.ts dá acesso técnico ao conteúdo de qualquer
        conta, e o gate de assinatura é dispensado para esses perfis. Descrever a
        divisão de papéis como se fosse trava técnica seria afirmação falsa sobre
        o funcionamento — art. 30 do CDC. O que existe é registro do acesso, e é
        isso que a seção 8 promete.
      */}
      <h3>1.3 O limite honesto desta divisão</h3>
      <p>
        A divisão acima é jurídica e organizacional; <strong>não é uma barreira técnica</strong>. Perfis internos de
        administração e de revisão conseguem, tecnicamente, abrir uma análise e baixar um documento de qualquer conta —
        é o que permite dar suporte e apurar incidente. O controle que oferecemos é o <strong>registro</strong>: todo
        download de documento, de relatório e de peça gerada produz registro de auditoria. A seção 8 descreve as
        hipóteses em que esse acesso é admitido e como o assinante pode conferi-lo.
      </p>

      <h2>2. Dados que tratamos</h2>

      <h3>2.1 Cadastro e conta</h3>
      <p>
        Nome, e-mail, telefone, CPF/CNPJ e nome do escritório. A senha <strong>não é guardada</strong>: gravamos apenas
        o resultado de função de derivação criptográfica (bcrypt), que não permite recuperar a senha original. O
        CPF/CNPJ não fica em texto claro no banco: é cifrado em AES-256-GCM, com vetor de inicialização e etiqueta de
        autenticação próprios por registro. Quem ativa a verificação em duas etapas tem o segredo também cifrado e os
        códigos de recuperação guardados apenas como resumo criptográfico de uso único.
      </p>

      <h3>2.2 Autenticação, sessão e segurança</h3>
      <p>
        De cada sessão registramos o identificador em forma de resumo criptográfico (nunca o token em si), a data de
        expiração, o endereço IP e o agente do navegador. Registramos também o último acesso, a contagem de tentativas
        de login malsucedidas e o bloqueio temporário decorrente delas, além de eventos de segurança (tipo do evento,
        e-mail informado, IP e agente).
      </p>

      <h3>2.3 Registro dos aceites</h3>
      <p>
        No cadastro registramos o aceite dos Termos de Uso, desta Política, do aviso de uso de inteligência artificial e
        das condições da assinatura, com o <strong>tipo do aceite, a data, o endereço IP</strong> e a{" "}
        <strong>versão do documento aceito</strong>. A versão importa: é o que permite saber, depois, qual texto foi
        apresentado ao titular naquele momento.
      </p>

      <h3>2.4 Cobrança</h3>
      <p>
        <strong>Nenhum dado de meio de pagamento é digitado na Plataforma.</strong> Não existe campo de cartão em lugar
        algum do sistema: os dados do cartão e a confirmação do PIX ocorrem diretamente no ambiente da processadora,
        que também confere o CPF/CNPJ com o pagador (seção 5). Da cobrança guardamos o identificador do pagamento no provedor, a situação, o valor, o método, as
        datas, o registro da sessão de checkout vinculada ao usuário e o retorno enviado pelo provedor, que pode
        conter nome, e-mail e CPF/CNPJ. <strong>Número de cartão, validade e código de segurança nunca são recebidos
        nem armazenados.</strong>
      </p>

      {/*
        O texto extraído gravado no banco é o dado que a política anterior
        ignorava, e é o mais sensível do sistema: apagar o PDF do armazenamento
        não apaga o conteúdo do processo. Declarar isso é o que torna a seção 9
        verdadeira.
      */}
      <h3>2.5 Documentos, texto extraído e dados processuais</h3>
      <p>Do material que o assinante envia, tratamos três coisas distintas:</p>
      <ul>
        <li>
          <strong>o arquivo</strong> ({FORMATOS_ROTULO}), guardado em armazenamento privado, sem URL pública e sem
          indexação;
        </li>
        <li>
          <strong>o texto de cada página</strong>, extraído do arquivo e gravado no banco de dados como registro
          próprio, página por página, com a indicação de a página ser legível ou não. Consequência prática:{" "}
          <strong>apagar o arquivo não apaga o conteúdo</strong> — os dois precisam ser eliminados, e a exclusão da
          análise elimina ambos (seção 9);
        </li>
        <li>
          <strong>dados processuais em campos estruturados</strong>, fora do arquivo: nome do executado, CPF/CNPJ do
          executado (cifrado), exequente, número do processo, tribunal, vara e comarca, tipo de tributo, ente público,
          número da CDA e da inscrição em dívida ativa, valor aproximado e as datas informadas ou extraídas.
        </li>
      </ul>
      <p>
        Da análise resultam ainda a linha do tempo dos atos, o relatório com grau de confiança e, havendo tese
        favorável, a minuta de exceção de pré-executividade — todos vinculados à conta que os originou.
      </p>
      <p>
        Documento processual pode conter <strong>dado pessoal sensível</strong> (art. 5º, II, da LGPD) — estado de
        saúde, filiação sindical, convicção religiosa, dado biométrico — quando o próprio processo o contiver. O regime
        aplicável está na seção 3.2.
      </p>

      <h3>2.6 Uso da Plataforma e suporte</h3>
      <p>
        Análises realizadas e sua situação, extrato de créditos com saldo anterior e posterior de cada lançamento,
        registro técnico de cada chamada ao provedor de inteligência artificial (provedor, modelo, quantidade de tokens
        e custo estimado — <strong>sem o conteúdo enviado</strong>), chamados de suporte com assunto e histórico de
        mensagens, e notificações da conta.
      </p>

      <h3>2.7 Trilha de auditoria</h3>
      <p>
        Registramos autor, ação, entidade afetada, data e hora e metadados não sensíveis das operações
        relevantes: login, cadastro, envio de documento, download de documento, de relatório e de peça, criação,
        alteração e exclusão de análise, exportação de dados, pedido de exclusão de conta, ajuste de crédito, eventos de
        pagamento e conclusão de revisão.
      </p>
      <p>
        <strong>Endereço IP e identificação do navegador não acompanham todas essas operações</strong>, e a distinção
        importa porque é dela que depende o extrato de acessos da seção 8. Eles são registrados na{" "}
        <strong>entrada na conta</strong> e em <strong>cada download de documento, de relatório e de peça</strong> — que
        são justamente os acessos a conteúdo sob sigilo. No cadastro, nos pedidos de recuperação e de redefinição de
        senha e no envio do formulário público de contato registramos o{" "}
        <strong>endereço IP, sem identificação do navegador</strong>. Nas demais operações da trilha fica o registro de
        autor, data e hora, sem IP e sem navegador. IP e navegador constam do registro de sessão e dos eventos de
        segurança (2.2).
      </p>
      <p>
        Duas regras do sistema importam aqui: a auditoria <strong>nunca registra senha, token, chave ou o conteúdo
        integral de documento</strong>, e chaves de metadado com nome sensível são substituídas por marca de redação.
        Para ser exato: o que fica registrado são <strong>operações e acessos a arquivo e a documento gerado</strong> —
        não cada leitura de tela.
      </p>

      <h3>2.8 Visitantes</h3>
      <p>
        Quem usa o <Link href="/contato">formulário de contato</Link> sem ser assinante informa nome, e-mail, telefone
        e a mensagem; registramos também o endereço IP do envio, para conter abuso do formulário. Esses dados são
        usados para responder ao contato e não geram cadastro nem comunicação de marketing.
      </p>

      <h3>2.9 Acervo do provedor de pagamento anterior</h3>
      <p>
        A Plataforma utilizou anteriormente outra processadora. Os eventos recebidos dela foram preservados como
        registro histórico da venda e podem conter e-mail do comprador e o retorno bruto da transação. Esse acervo está
        sujeito às regras de retenção da seção 9 e não é usado para nenhuma finalidade nova.
      </p>

      <h3>2.10 O que não tratamos</h3>
      <ul>
        <li>número, validade ou código de segurança de cartão;</li>
        <li>dados de geolocalização precisa;</li>
        <li>
          perfil comportamental ou publicitário. <strong>Não há cookie de terceiro, pixel, rastreador ou ferramenta de
          analítica</strong> na Plataforma, e as fontes tipográficas são servidas pelo próprio domínio — de modo que a
          simples visita ao site não gera requisição a servidor de terceiro (seção 13);
        </li>
        <li>
          dados obtidos de base de terceiro: não compramos cadastro, não enriquecemos o seu com fonte externa e{" "}
          <strong>não vendemos nem cedemos dados pessoais</strong>;
        </li>
        <li>
          conteúdo de documento para qualquer finalidade comercial, inclusive prospecção — o que consta dos autos que
          você envia não é usado para lhe vender nada nem para falar com quem quer que seja.
        </li>
      </ul>

      <h2>3. Finalidades e bases legais</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Finalidade</th>
              <th>Dados envolvidos</th>
              <th>Base legal</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                Criar e manter a conta, autenticar, executar a análise, entregar relatório e minuta, prestar suporte
              </td>
              <td>Cadastro, documentos e texto extraído, dados processuais, uso</td>
              <td>Execução de contrato — art. 7º, V</td>
            </tr>
            <tr>
              <td>Cobrar, renovar, alterar plano, estornar e emitir documento fiscal</td>
              <td>Cadastro e dados de cobrança</td>
              <td>Execução de contrato (art. 7º, V) e obrigação legal (art. 7º, II)</td>
            </tr>
            <tr>
              <td>Conservar registro de pagamento e escrituração</td>
              <td>Dados de cobrança</td>
              <td>Obrigação legal — art. 7º, II, e art. 16, I</td>
            </tr>
            <tr>
              <td>Guardar registros de acesso à aplicação</td>
              <td>IP, data e hora, agente do navegador</td>
              <td>Obrigação legal — art. 7º, II, c/c art. 15 da Lei nº 12.965/2014</td>
            </tr>
            <tr>
              <td>
                Proteger a conta, prevenir fraude e abuso, limitar requisições, apurar incidente e manter a auditoria
              </td>
              <td>Autenticação, sessão, eventos de segurança, auditoria</td>
              <td>Legítimo interesse — art. 7º, IX (ver 3.1)</td>
            </tr>
            <tr>
              <td>
                Enviar comunicações transacionais: verificação de e-mail, senha, confirmação de renovação, aviso de
                atraso, cancelamento, estorno e avisos de chamado
              </td>
              <td>Nome e e-mail</td>
              <td>Execução de contrato — art. 7º, V</td>
            </tr>
            <tr>
              <td>Responder ao visitante que nos procura pelo formulário de contato</td>
              <td>Nome, e-mail, telefone, mensagem, IP</td>
              <td>Procedimento preliminar a contrato, a pedido do titular — art. 7º, V</td>
            </tr>
            <tr>
              <td>Defender-se em processo judicial, administrativo ou arbitral e cumprir ordem de autoridade</td>
              <td>O estritamente necessário ao caso</td>
              <td>Exercício regular de direitos (art. 7º, VI) e obrigação legal (art. 7º, II)</td>
            </tr>
            <tr>
              <td>Executar a análise sobre os documentos e os dados de terceiros neles contidos</td>
              <td>Documentos, texto extraído, dados processuais</td>
              <td>
                Instrução do controlador-assinante (art. 39); a base legal do tratamento desses dados é definida por
                ele (seção 1.1)
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h3>3.1 Legítimo interesse e o balanceamento que fizemos</h3>
      <p>
        Invocamos legítimo interesse apenas para as finalidades de segurança e prevenção a fraude e abuso indicadas na
        tabela, a partir de situação concreta, como exige o art. 10 da LGPD. O balanceamento é este:{" "}
        <strong>finalidade legítima</strong> — proteger contas que guardam processo judicial de terceiro sob sigilo;{" "}
        <strong>necessidade</strong> — sem registro de IP, de tentativa de acesso e de download não há como detectar
        uso indevido de credencial nem responder a incidente; <strong>minimização</strong> — registramos o evento, não
        o conteúdo; <strong>expectativa legítima</strong> — quem contrata ferramenta que guarda autos espera controle
        de acesso e rastreabilidade; <strong>salvaguardas</strong> — retenção limitada (seção 9), redação de campos
        sensíveis e acesso restrito.
      </p>
      <p>
        Não usamos legítimo interesse para publicidade, perfilamento, enriquecimento de base ou qualquer finalidade
        estranha à segurança. O titular pode <strong>opor-se</strong> ao tratamento fundado nessa base (art. 18, §2º)
        pelo canal da seção 12; a oposição é apreciada e, quando o registro for indispensável à segurança ou a
        obrigação legal, respondemos com a recusa fundamentada. Havendo requisição da ANPD, elaboramos relatório de
        impacto à proteção de dados pessoais (art. 38).
      </p>

      <h3>3.2 Dados sensíveis nos documentos</h3>
      <p>
        Quando um documento processual contiver dado pessoal sensível, o tratamento se apoia no{" "}
        <strong>exercício regular de direitos em processo judicial, administrativo ou arbitral</strong> (art. 11, II,
        “d”), determinado pelo assinante-controlador. Não tratamos dado sensível para finalidade própria, não o
        utilizamos para segmentar nem para decidir nada sobre ninguém, e não o extraímos deliberadamente: ele é tratado
        apenas na medida em que já consta da peça juntada. Se a finalidade puder ser alcançada sem juntar a peça que
        contém o dado sensível, o assinante deve deixá-la de fora.
      </p>

      {/*
        Correção material do texto anterior, que dizia "o uso de IA depende de
        consentimento específico". Fazer o serviço depender de consentimento é
        pior para as duas partes: o consentimento é revogável a qualquer tempo
        (art. 8º, §5º) e a revogação interromperia a execução do contrato no
        meio. O aceite registrado no cadastro é prova de informação, não base
        legal.
      */}
      <h3>3.3 O aceite registrado não é a base legal do serviço</h3>
      <p>
        O aceite registrado no cadastro (seção 2.3) é <strong>prova de que a informação foi prestada</strong>, em
        cumprimento aos princípios da transparência e do livre acesso (art. 6º, VI, e art. 9º). Ele{" "}
        <strong>não é a base legal</strong> do tratamento: a base é a execução do contrato. A distinção protege as duas
        partes — não fazemos a prestação depender de consentimento revogável, que poderia interromper uma análise em
        curso, e não usamos um aceite genérico para autorizar tratamento que a execução do contrato não pede. Onde
        houver tratamento realmente opcional, o consentimento será pedido de forma destacada e poderá ser revogado a
        qualquer momento, sem prejuízo do serviço contratado.
      </p>

      <h2>4. Análise automatizada e inteligência artificial</h2>

      <h3>4.1 O que o sistema faz</h3>
      <p>
        O sistema lê o texto das páginas, organiza a cronologia dos atos, aplica a metodologia de prescrição,
        prescrição intercorrente e decadência e produz uma conclusão sobre a existência de tese, com grau de confiança,
        fundamentação legal e, havendo tese favorável, minuta de exceção de pré-executividade.
      </p>

      <h3>4.2 O que o sistema não faz</h3>
      <p>
        <strong>Nenhuma decisão com efeito jurídico é tomada pela Plataforma.</strong> O resultado é insumo de trabalho:
        a decisão de peticionar, o conteúdo final da peça, a conferência das datas contra os autos e o protocolo são do
        advogado. Por isso o resultado não constitui, por si, decisão automatizada que afete interesses de titular no
        sentido do art. 20 da LGPD — o que não nos impede de assegurar, como obrigação contratual, os direitos de
        explicação e de revisão descritos em 4.5.
      </p>

      <h3>4.3 Para onde o texto vai</h3>
      <p>
        A geração da análise depende de modelo de linguagem executado por provedor externo. Para que ninguém se engane
        sobre o que sai daqui, o pedido enviado ao provedor contém, além dos identificadores internos da análise, três
        coisas:
      </p>
      <ul>
        <li>
          <strong>o texto selecionado das páginas</strong> dos documentos da análise;
        </li>
        <li>
          <strong>o título e o objetivo</strong> que o assinante escreveu para a análise — consequência prática: se o
          título for o nome do cliente, esse nome vai no pedido;
        </li>
        <li>
          <strong>os dados processuais informados no formulário</strong> — número do processo, tribunal, exequente,
          nome do executado, tipo de tributo e as datas e informações complementares preenchidas —, submetidos ao
          modelo como dados a conferir contra os documentos.
        </li>
      </ul>
      <p>
        <strong>Não vão:</strong> o arquivo em si, o nome do arquivo, o CPF/CNPJ do executado (que permanece cifrado e
        não é decifrado para esta finalidade), o seu nome, o seu e-mail, o seu CPF/CNPJ de cadastro e nenhum dado de
        cobrança.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Provedor</th>
              <th>Situação</th>
              <th>O que recebe</th>
              <th>País</th>
            </tr>
          </thead>
          <tbody>
            {PROVEDORES_IA.map((p) => (
              <tr key={p.chave}>
                <td>{p.nome}</td>
                <td>
                  {p.chave === IA_EM_USO ? (
                    <>
                      <strong>Em uso</strong> (modelo {MODELO_EM_USO})
                    </>
                  ) : (
                    "Alternativa técnica; nada lhe é enviado enquanto não estiver em uso"
                  )}
                </td>
                <td>
                  Texto selecionado das páginas, título e objetivo da análise e os dados processuais informados no
                  formulário (lista acima)
                </td>
                <td>{p.pais}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        A seleção é <strong>parcial por limite técnico</strong>: as páginas mais relevantes para a matéria são enviadas
        até um teto de caracteres, e quando parte do processo fica de fora o próprio relatório registra isso.
        Consequência que o assinante precisa conhecer: <strong>a ausência de um ato no relatório não prova a ausência
        do ato nos autos</strong>. A conferência da cronologia contra o processo é do advogado.
      </p>

      <h3>4.4 Não usamos o conteúdo para treinar modelo</h3>
      <p>
        Não utilizamos o conteúdo enviado para treinar, ajustar ou avaliar modelo próprio ou de terceiro. Do provedor
        de inteligência artificial exigimos o compromisso de não utilizar o conteúdo recebido por sua interface de
        programação para treinamento de seus modelos — condição hoje prevista nos termos de uso de interface dos
        provedores da tabela acima. Conforme esses termos, o conteúdo pode ficar retido por{" "}
        <strong>período limitado</strong> no provedor, para monitoramento de abuso, e depois é descartado. Se essa
        condição deixar de valer, trocamos o provedor ou informamos previamente, na forma da seção 14.
      </p>

      <h3>4.5 Explicação e revisão</h3>
      <p>
        O assinante e o titular podem pedir <strong>informação clara sobre os critérios e os procedimentos</strong>{" "}
        utilizados na análise, observados os segredos comercial e industrial (art. 20, §1º), e podem pedir a{" "}
        <strong>revisão do resultado</strong>. O canal é o chamado de suporte na área do cliente ou os canais da seção
        12.
      </p>
      <p>
        Sobre o alcance dessa revisão, para não criar expectativa falsa: a revisão jurídica registrada no sistema é a
        do <strong>próprio assinante</strong>, que é o advogado da causa — não existe equipe nossa que substitua o
        exame profissional dele. O que oferecemos é a revisão do <strong>processamento</strong>: conferência da leitura
        dos documentos, verificação das páginas efetivamente consideradas, reprocessamento e correção de erro técnico,
        além da explicação dos critérios.
      </p>

      <h3>4.6 Modo de contingência sem provedor de IA</h3>
      <p>
        Se a credencial do provedor não estiver ativa, <strong>ou se o provedor falhar</strong> — recusa de
        autenticação, limite de uso, tempo esgotado ou crédito encerrado junto a ele —, a análise é produzida por{" "}
        <strong>rotina heurística local</strong>, executada no próprio servidor e <strong>sem envio de conteúdo a
        terceiro</strong>; o registro da análise identifica que o resultado veio desse modo e, quando a causa é falha do
        provedor, a própria conclusão exibe o aviso. É contingência, não a entrega ordinária: havendo dúvida sobre
        resultado obtido assim, o reprocessamento pode ser pedido ao suporte, sem novo consumo de crédito, nos termos da{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>.
      </p>

      {/*
        Esta seção descrevia um link para agente hospedado em serviço de terceiro, na
        tela de análise manual — o único caminho em que o conteúdo do processo saía da
        Plataforma sem passar pelo nosso tratamento. O link FOI REMOVIDO por decisão do
        dono, e a seção virou o compromisso positivo: não há caminho desses. Se algum
        dia houver, esta é a seção que precisa voltar a existir, e a lista de
        operadores da seção 5 precisa ganhar mais uma linha.
      */}
      <h3>4.7 Não há caminho de análise fora da Plataforma</h3>
      <p>
        Todo tratamento do conteúdo enviado ocorre dentro da Plataforma e pelos operadores relacionados na seção 5.{" "}
        <strong>Não oferecemos, não indicamos e não linkamos serviço externo</strong> para o qual o assinante devesse
        levar o processo — nem em fluxo alternativo, nem em ferramenta conversacional de terceiro. Existiu um link desse
        tipo na tela de análise manual; ele foi removido justamente porque o conteúdo enviado lá ficaria fora do
        armazenamento privado, fora da trilha de auditoria e fora das garantias desta Política.
      </p>

      <p>{AVISO_REVISAO}</p>
      <ul>
        <li>
          A <strong>responsabilidade pelo protocolo e pelo uso da petição</strong> gerada é exclusivamente do usuário.
        </li>
      </ul>

      <h2>5. Com quem compartilhamos</h2>
      <p>
        Compartilhamos dados apenas com operadores contratados para operar a Plataforma, no limite do necessário a cada
        função. A lista abaixo é completa na data desta versão.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Operador</th>
              <th>O que recebe</th>
              <th>Para quê</th>
              <th>Onde está</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Asaas (processadora de pagamento)</td>
              <td>
                Nome, e-mail, CPF/CNPJ e valor da cobrança; o meio de pagamento é informado pelo próprio cliente no
                ambiente da processadora
              </td>
              <td>
                Emitir e processar cobrança, recorrência e estorno, e enviar ao próprio cliente os avisos de cobrança
              </td>
              <td>Brasil</td>
            </tr>
            <tr>
              <td>Render (hospedagem da aplicação e do banco de dados)</td>
              <td>
                Todo dado gravado no banco, inclusive o texto extraído das páginas e os dados processuais estruturados
              </td>
              <td>Executar a aplicação e manter o banco de dados</td>
              <td>Estados Unidos (região Oregon)</td>
            </tr>
            <tr>
              <td>Cloudflare (armazenamento de arquivos, R2)</td>
              <td>
                Os arquivos enviados pelo assinante — isto é, o <strong>conteúdo integral</strong> dos documentos —, em
                repositório privado
              </td>
              <td>Guardar os documentos com durabilidade, fora do disco efêmero da aplicação</td>
              <td>
                Fora do Brasil, em infraestrutura global: o serviço não trabalha com região geográfica fixa e a
                localização do depósito é atribuída pelo provedor, <strong>sem garantia de território determinado</strong>
              </td>
            </tr>
            <tr>
              <td>Provedor de modelo de linguagem</td>
              <td>Texto selecionado das páginas e os dados processuais informados — detalhe em 4.3</td>
              <td>Gerar a análise, o relatório e a minuta</td>
              <td>Estados Unidos — identificação e situação de uso na seção 4.3</td>
            </tr>
            <tr>
              <td>Resend (envio de e-mail transacional)</td>
              <td>
                Nome, e-mail e o conteúdo da mensagem enviada; no aviso de abertura de chamado dirigido à nossa equipe,
                também o texto escrito pelo cliente
              </td>
              <td>Entregar os e-mails da seção 3</td>
              <td>Estados Unidos</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        <strong>Duas etapas que poderiam envolver terceiros e não envolvem.</strong> O reconhecimento óptico de
        caracteres de documento digitalizado roda <strong>no próprio servidor</strong> (Ghostscript e Tesseract):
        documento digitalizado não é enviado a serviço de OCR de terceiro. A conversão do relatório e da minuta para
        DOCX e PDF também é feita no próprio servidor.
      </p>

      <h3>5.1 Autoridades e ordem judicial</h3>
      <p>
        Atendemos requisição de autoridade competente quando houver fundamento legal e a ordem for específica.{" "}
        <strong>Antes de entregar conteúdo de documento processual, opomos o sigilo profissional</strong> que o protege
        (seção 8) e exigimos ordem judicial fundamentada; quanto a registros de acesso, a disponibilização depende de
        ordem judicial (art. 10, §1º, da Lei nº 12.965/2014). Informamos o assinante-controlador sobre a requisição,
        salvo quando a lei ou a própria ordem vedar a comunicação. Não atendemos pedido genérico, informal ou que não
        identifique a base legal.
      </p>

      <h3>5.2 O que não fazemos com dados</h3>
      <p>
        Não vendemos, não alugamos e não cedemos dados pessoais. Não os compartilhamos para publicidade, para
        prospecção ou com terceiros que não estejam na tabela acima. Dados de um assinante não são usados em benefício
        de outro.
      </p>

      <h3>5.3 Mudança de operador e sucessão</h3>
      <p>
        A inclusão ou substituição de operador com acesso a <strong>conteúdo de documento</strong> é informada
        previamente, na forma da seção 14, com atualização desta Política. Em reorganização societária ou transferência
        do negócio, a base de dados pode ser transferida ao sucessor, que fica vinculado a esta Política; alteração
        relevante é comunicada com a mesma antecedência.
      </p>

      <h2>6. Transferência internacional de dados</h2>
      <p>
        Parte dos operadores está fora do Brasil: a hospedagem da aplicação e do banco de dados está nos Estados Unidos
        (região Oregon), e o provedor de modelo de linguagem e o provedor de e-mail também estão nos Estados Unidos. O
        armazenamento dos arquivos está fora do Brasil em infraestrutura global, sem região geográfica fixa (seção 5).
        Isso significa, sem rodeio, que{" "}
        <strong>dado pessoal — inclusive o texto de documentos processuais — é tratado fora do território nacional</strong>.
      </p>
      <p>
        A ANPD <strong>não editou decisão de reconhecimento de grau de proteção adequado</strong> para os países
        envolvidos. Não invocamos, portanto, a hipótese do art. 33, I, da LGPD. A base utilizada é a{" "}
        <strong>necessidade da transferência para a execução do contrato</strong> celebrado com o assinante — art. 33,
        IX, combinado com o art. 7º, V, da LGPD.
      </p>
      <p>
        Sobre garantias, dizemos o que é verificável. A garantia de cada operador internacional é o{" "}
        <strong>adendo de proteção de dados que integra o contrato firmado com ele</strong>, e assumimos dois
        compromissos: (i) só manter operador internacional cujo instrumento assegure os itens abaixo; e (ii){" "}
        <strong>adotar as cláusulas-padrão contratuais aprovadas pela Resolução CD/ANPD nº 19/2024</strong> (art. 33,
        II, “b”, da LGPD) com todo operador que as aceite, substituindo o adendo próprio dele. Os itens exigidos são:
      </p>
      <ul>
        <li>finalidade limitada à execução do serviço, sem uso próprio do conteúdo;</li>
        <li>confidencialidade e medidas de segurança compatíveis com a seção 7;</li>
        <li>restrição à subcontratação e responsabilidade pelo subcontratado;</li>
        <li>comunicação de incidente de segurança;</li>
        <li>cooperação no atendimento a pedidos de titular e a requisições da ANPD;</li>
        <li>eliminação ou devolução dos dados ao término da relação.</li>
      </ul>
      <p>
        O titular pode solicitar, pelo canal da seção 12, informação sobre as garantias vigentes com cada operador
        internacional.
      </p>
      <p>
        <strong>Ressalva prática, para não induzir ninguém a erro:</strong> quando o assinante não puder admitir
        tratamento fora do Brasil — por determinação do cliente dele, de órgão público ou de decisão judicial — deve
        deixar de enviar o documento à Plataforma. Não oferecemos, hoje, opção de processamento restrito ao território
        nacional.
      </p>

      <h2>7. Segurança</h2>
      <p>
        As medidas abaixo estão implementadas. Estão listadas por dever de informação e como compromisso de manutenção
        (art. 46 da LGPD):
      </p>
      <ul>
        <li>tráfego cifrado em trânsito, e cifra de campo (AES-256-GCM) para CPF/CNPJ e para o segredo do segundo fator;</li>
        <li>senha guardada apenas como resultado de derivação criptográfica, com política mínima de complexidade;</li>
        <li>
          sessão em cookie <code>httpOnly</code>, restrito ao domínio, marcado como seguro em produção, contendo apenas
          token opaco cujo resumo criptográfico é o que fica no banco — o cookie não carrega dado pessoal;
        </li>
        <li>
          <strong>verificação em duas etapas por aplicativo autenticador disponível</strong>, de ativação opcional pelo
          assinante, com códigos de recuperação de uso único;
        </li>
        <li>bloqueio temporário da conta após tentativas de login malsucedidas e limitação de requisições;</li>
        <li>
          isolamento entre contas: cada leitura é filtrada no servidor pela organização do usuário, e o pertencimento é
          verificado antes de qualquer entrega de arquivo;
        </li>
        <li>
          documentos em <strong>repositório privado, sem URL pública e sem indexação</strong>; o download ocorre apenas
          por rota autenticada que confere a titularidade, lê o objeto no servidor e registra o acesso;
        </li>
        <li>
          <strong>OCR local</strong> (seção 5) — documento sob sigilo não sai da nossa infraestrutura para ser
          transcrito;
        </li>
        <li>trilha de auditoria com as regras de não registro e de redação descritas em 2.7;</li>
        <li>ausência de rastreadores e de recursos de terceiro carregados no navegador (seção 13).</li>
      </ul>
      <p>
        <strong>Nenhuma medida elimina integralmente o risco</strong>, e não prometemos inviolabilidade. Assumimos o
        dever de manter e revisar essas medidas, de apurar incidentes e de comunicá-los na forma da seção 11. Esta
        Política não exclui nem limita responsabilidade que a lei nos atribua.
      </p>
      <p>
        <strong>O que depende de você.</strong> Use senha exclusiva desta Plataforma, ative a verificação em duas
        etapas, não compartilhe suas credenciais — cada plano dá acesso a um usuário — e comunique imediatamente pelos
        canais da seção 12 qualquer suspeita de acesso indevido. <strong>Não presumimos contra você a autoria de
        operação contestada</strong>: comunicada a suspeita, suspendemos as sessões abertas, apuramos o caso com os
        registros de auditoria e de segurança e informamos o resultado; a demonstração da regularidade da operação é
        nossa, na forma do art. 14 do Código de Defesa do Consumidor. Responde pelos prejuízos quem compartilhar
        voluntariamente a credencial ou deixar de comunicar a suspeita depois de conhecê-la.
      </p>

      {/*
        Sigilo do art. 7º, II (inviolabilidade de arquivos e comunicações do
        advogado) e do art. 34, VII (violação de sigilo é infração disciplinar)
        da Lei 8.906/1994, mais o art. 189 do CPC. O compromisso é contratual e
        organizacional; a característica técnica verificável é o REGISTRO do
        acesso, não o impedimento — ver comentário da seção 1.3.
      */}
      <h2>8. Sigilo profissional</h2>
      <p>
        Os documentos que o assinante envia costumam estar cobertos pelo sigilo profissional do advogado (art. 7º, II,
        e art. 34, VII, da Lei nº 8.906/1994) e, quando o processo tramitar em segredo de justiça, pela restrição do
        art. 189 do Código de Processo Civil. Tratamos esse material como conteúdo sigiloso, e não como dado
        operacional comum.
      </p>
      <p>Nossos compromissos:</p>
      <ul>
        <li>prepostos e prestadores vinculados a dever de confidencialidade que sobrevive ao fim do vínculo;</li>
        <li>
          acesso ao <strong>conteúdo</strong> de documento de cliente admitido apenas em três hipóteses: (i) pedido
          registrado do assinante, para suporte; (ii) determinação legal ou ordem judicial específica, observada a
          seção 5.1; (iii) apuração de incidente de segurança ou de violação grave dos{" "}
          <Link href="/termos">Termos de Uso</Link>, limitada ao estritamente necessário;
        </li>
        <li>
          <strong>registro de todo acesso</strong>: o download de documento, de relatório e de peça gerada produz
          registro de auditoria com autor, papel interno, data e hora, identificação do item acessado, endereço IP e
          identificação do navegador (2.7);
        </li>
        <li>
          <strong>extrato de acessos a pedido</strong>: o assinante pode solicitar, pelo canal da seção 12, a relação
          dos acessos internos ao conteúdo da sua conta.
        </li>
      </ul>
      <p>
        <strong>A natureza desse compromisso, dita com precisão:</strong> ele é contratual e organizacional, não uma
        impossibilidade técnica (seção 1.3). Por isso o controle oferecido é a rastreabilidade, e por isso insistimos na
        recomendação de enviar apenas as peças necessárias à análise.
      </p>

      <h2>9. Retenção e eliminação</h2>
      <p>
        A tabela abaixo reproduz os prazos fixados na{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>, que é o documento que os governa: havendo
        divergência de leitura, prevalece o que está lá — <strong>salvo</strong> quando outro instrumento (i) assegurar
        ao assinante condição mais favorável, ou (ii) descrever com maior precisão o funcionamento efetivo da
        Plataforma, hipóteses em que prevalece a disposição mais favorável ou mais precisa. Em nenhum caso a prevalência
        de um documento suprime garantia legal do assinante.
      </p>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Categoria</th>
              <th>Por quanto tempo</th>
              <th>Depois</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Cadastro e conta</td>
              <td>Enquanto a conta existir</td>
              <td>
                Conservados após o encerramento pelo prazo da{" "}
                <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>, que também fixa a janela de
                reativação
              </td>
            </tr>
            <tr>
              <td>Arquivos enviados</td>
              <td>
                Até o assinante excluir a análise e, não havendo exclusão, até {RETENCAO.conteudoMeses} meses contados
                do encerramento da conta — ou de imediato, a pedido do assinante
              </td>
              <td>Removidos do repositório privado</td>
            </tr>
            <tr>
              <td>Texto extraído das páginas e dados processuais estruturados</td>
              <td>O mesmo prazo dos arquivos</td>
              <td>
                Apagados junto com a análise — a exclusão alcança em cascata documentos, páginas, linha do tempo,
                relatórios e minutas
              </td>
            </tr>
            <tr>
              <td>Análises, linha do tempo, relatórios e minutas gerados</td>
              <td>
                Até o assinante excluir a análise e, não havendo exclusão, até {RETENCAO.conteudoMeses} meses contados
                do encerramento — mesmo prazo dos arquivos e da janela de reativação com histórico
              </td>
              <td>Apagados do banco de dados, na forma de 9.1</td>
            </tr>
            <tr>
              <td>Registro de pagamento e escrituração</td>
              <td>
                Até a prescrição dos créditos tributários das operações a que se referem (art. 195, parágrafo único, e
                art. 174 do CTN), e o prazo de defesa em eventual cobrança (art. 206, §5º, I, do Código Civil)
              </td>
              <td>Conservados ainda que a conta seja encerrada — ver 9.2</td>
            </tr>
            <tr>
              <td>Registros de acesso à aplicação</td>
              <td>
                No mínimo {RETENCAO.logAcessoMeses} meses, sob sigilo (art. 15 da Lei nº 12.965/2014)
              </td>
              <td>Conservados além disso apenas para segurança e defesa, pelo tempo necessário</td>
            </tr>
            <tr>
              <td>Trilha de auditoria e eventos de segurança</td>
              <td>{RETENCAO.auditoriaAnos} anos</td>
              <td>
                Sobrevivem à exclusão da conta com o <strong>vínculo com a pessoa desfeito</strong>
              </td>
            </tr>
            <tr>
              <td>Extrato de créditos e registros de consumo</td>
              <td>{RETENCAO.fiscalAnos} anos contados do encerramento</td>
              <td>Conservado como prova da execução do contrato e da regularidade da cobrança</td>
            </tr>
            <tr>
              <td>Chamados de suporte: assunto, mensagens e situação</td>
              <td>{RETENCAO.fiscalAnos} anos contados do encerramento do chamado</td>
              <td>Conservados como prova do atendimento prestado</td>
            </tr>
            <tr>
              <td>Registro dos aceites (seção 2.3)</td>
              <td>{RETENCAO.cadastroAnos} anos contados do encerramento</td>
              <td>Conservado como prova do cumprimento da LGPD (art. 37)</td>
            </tr>
            <tr>
              <td>Acervo do provedor de pagamento anterior (seção 2.9)</td>
              <td>Pelo prazo de guarda dos registros de pagamento</td>
              <td>Conservado como registro histórico, sem finalidade nova</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/*
        Ponto em que a política se recusa a mentir. Não existe rotina de expurgo:
        a manutenção diária expira crédito e encerra assinatura, e nada apaga
        documento, texto de página, análise ou log. Prometer "eliminação ao fim
        do tratamento" seria promessa que o sistema não cumpre (art. 30 do CDC).

        A quarta via da lista — o decurso do prazo — é obrigação assumida, não
        rotina descrita: os prazos da tabela acima estão publicados na Política de
        Cancelamento e Retenção e por isso VINCULAM, ainda que sejam cumpridos por
        procedimento humano do Encarregado. Omiti-la aqui seria pior: deixaria esta
        Política dizendo que os autos ficam até alguém apagá-los enquanto o outro
        documento do mesmo contrato promete seis meses.
      */}
      <h3>9.1 Como a eliminação acontece de fato</h3>
      <p>
        <strong>Não há rotina que apague dados automaticamente pelo decurso do prazo.</strong> A eliminação decorre de
        ato, e as vias são quatro:
      </p>
      <ul>
        <li>
          <strong>o assinante exclui a análise</strong> — nesse momento os arquivos saem do repositório privado e o
          texto extraído, a linha do tempo, o relatório e a minuta são apagados do banco de dados;
        </li>
        <li>
          <strong>o titular pede a exclusão da conta</strong>, pela própria área do cliente ou pelos canais da seção
          12 — o pedido é registrado e executado no prazo da seção 10.1;
        </li>
        <li>
          <strong>a administração executa a exclusão</strong> ou a anonimização, na forma de 9.2;
        </li>
        <li>
          <strong>o prazo de retenção se esgota</strong> — vencidos os prazos da tabela acima, a eliminação é executada
          por procedimento conduzido pelo Encarregado, e não por rotina automática: é obrigação nossa cumpri-los, e o
          titular pode nos cobrar o cumprimento pelo canal da seção 12.
        </li>
      </ul>
      <p>
        Dizemos isso expressamente porque anunciar expurgo automático seria falso. Nas hipóteses acima, a exclusão
        alcança <strong>também os arquivos no repositório privado</strong>, e não apenas os registros do banco de
        dados: a exclusão da conta remove os objetos antes de apagar os registros que apontam para eles. Ainda assim
        fica a <strong>recomendação prática a quem vai sair</strong>: exclua primeiro as análises que não quiser
        conservar — a remoção é imediata e verificável por você — e só depois peça a exclusão da conta.
      </p>

      <h3>9.2 A trava da exclusão de conta com pagamento aprovado</h3>
      <p>
        Conta com pagamento aprovado <strong>não é apagada por simples comando</strong>: apagar destruiria o registro
        fiscal e contábil da venda, cuja conservação é obrigação legal (art. 7º, II, e art. 16, I, da LGPD). Nessa
        hipótese a via é a <strong>eliminação com anonimização do que sobra</strong>: os elementos que identificam o
        titular são removidos ou substituídos e permanecem apenas os registros financeiros exigidos por lei, sem
        vínculo com a pessoa — conservação amparada no art. 16, I, da LGPD, e dado anonimizado deixa de ser dado
        pessoal para os efeitos do art. 12. Informamos ao titular, ao concluir, <strong>o que foi eliminado, o que foi
        anonimizado e o que ficou retido, com o motivo de cada parte</strong>. Enquanto o procedimento não estiver
        integralmente automatizado, ele é executado de forma assistida pelo Encarregado, no prazo da seção 10.1.
      </p>
      <p>
        A exclusão da conta é <strong>irreversível</strong> e não gera, por si, devolução de valores: as hipóteses de
        devolução estão na <Link href="/reembolso">Política de Reembolso</Link>, e os efeitos do encerramento sobre o
        histórico, na <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>.
      </p>

      <h2>10. Direitos do titular</h2>
      <p>Nos termos do art. 18 da LGPD, o titular pode obter, a qualquer momento:</p>
      <ul>
        <li>confirmação da existência de tratamento e acesso aos dados (incisos I e II);</li>
        <li>correção de dado incompleto, inexato ou desatualizado (inciso III);</li>
        <li>
          anonimização, bloqueio ou eliminação de dado desnecessário, excessivo ou tratado em desconformidade com a lei
          (inciso IV);
        </li>
        <li>portabilidade a outro fornecedor, mediante requisição expressa (inciso V);</li>
        <li>
          eliminação dos dados tratados com base em consentimento (inciso VI), ressalvadas as hipóteses de conservação
          do art. 16 — como nossas bases são a execução do contrato e a obrigação legal,{" "}
          <strong>a eliminação não alcança o que é indispensável ao contrato em vigor nem o que a lei manda guardar</strong>{" "}
          (seções 9 e 9.2);
        </li>
        <li>informação sobre com quem compartilhamos dados (inciso VII) — é a seção 5;</li>
        <li>
          informação sobre a possibilidade de não fornecer consentimento e sobre as consequências da negativa (inciso
          VIII) — ver 3.3;
        </li>
        <li>revogação do consentimento, onde houver consentimento (inciso IX);</li>
        <li>oposição a tratamento fundado em dispensa de consentimento (art. 18, §2º) — ver 3.1.</li>
      </ul>

      <h3>10.1 Como exercer, e em quanto tempo respondemos</h3>
      <ul>
        <li>
          <strong>Exportação imediata</strong>, na área do cliente: um arquivo eletrônico com o perfil (nome, e-mail,
          telefone e CPF/CNPJ mascarado), os registros de aceite, a lista das análises (identificador, título, situação
          e data) e os chamados de suporte. Para não haver engano sobre o alcance: esse arquivo{" "}
          <strong>não inclui</strong> os documentos enviados, o texto das páginas, os relatórios, as minutas, o extrato
          de créditos nem os registros de pagamento — esses são fornecidos <strong>a pedido</strong>, pelo canal do
          Encarregado, por meio eletrônico seguro (art. 19, §2º, I).
        </li>
        <li>
          <strong>Pedido de exclusão</strong>, pela própria área do cliente: o pedido é registrado e processado
          conforme 9.1 e 9.2.
        </li>
        <li>
          <strong>Demais pedidos</strong>: pelo canal do Encarregado indicado na seção 12, pelo SAC, ou por chamado em{" "}
          <strong>Suporte</strong> dentro da Plataforma.
        </li>
      </ul>
      <p>
        <strong>Prazos.</strong> Confirmação da existência de tratamento e acesso: imediatamente, em formato
        simplificado, ou em até {PRAZO_RESPOSTA_TITULAR_DIAS} dias por meio de declaração clara e completa (art. 19, I e
        II). Para os demais pedidos do art. 18 adotamos, por opção, o mesmo prazo de {PRAZO_RESPOSTA_TITULAR_DIAS} dias.
        Quando o atendimento depender de operação sobre grande volume de dados, de terceiro ou de exame jurídico,
        informamos <em>dentro</em> desse prazo o motivo e o novo prazo. O atendimento é <strong>gratuito</strong>.
      </p>
      <p>
        <strong>Identificação.</strong> O pedido deve partir do titular ou de representante legalmente constituído
        (art. 18, §3º). Para não entregar dado a quem não é o titular, pedimos que o requerimento venha do e-mail
        cadastrado ou acompanhado de dados que já constam do cadastro; havendo dúvida razoável, pedimos confirmação
        adicional. <strong>Não exigimos documento novo que ainda não tenhamos</strong>, e nada do que for enviado para
        essa conferência é usado para outra finalidade.
      </p>
      <p>
        <strong>Acesso à conta indisponível.</strong> Se a conta estiver bloqueada — por exemplo, durante a apuração de
        contestação de pagamento —, o exercício dos direitos não fica prejudicado: o pedido pode ser feito pelo canal do
        Encarregado ou pelo SAC, e nós executamos a exportação e entregamos o arquivo por meio eletrônico seguro.
      </p>

      {/*
        Situação previsível e não trivial: o executado descobre que seu processo
        foi analisado e escreve para nós. Como operadores, não podemos entregar
        nem apagar o dado por conta própria, e confirmar a existência de análise
        específica poderia revelar estratégia coberta por sigilo profissional.
      */}
      <h3>10.2 Pedido de titular cujo dado está em documento enviado por assinante</h3>
      <p>
        Nessa hipótese <strong>não somos o controlador</strong> (seção 1): não decidimos o que se faz com aquele dado e
        não podemos, por conta própria, entregá-lo, corrigi-lo ou eliminá-lo. Ao receber o pedido:
      </p>
      <ul>
        <li>confirmamos o recebimento e explicamos a divisão de papéis;</li>
        <li>
          <strong>encaminhamos o pedido ao assinante-controlador</strong>, a quem cabe responder, e o auxiliamos com as
          informações e as operações técnicas necessárias (art. 39);
        </li>
        <li>
          <strong>não revelamos conteúdo de documento</strong> nem confirmamos a existência de análise específica a
          quem não seja o assinante — fazê-lo poderia violar o sigilo profissional e, se for o caso, o segredo de
          justiça;
        </li>
        <li>
          a identificação do assinante-controlador é fornecida quando não houver sigilo que a impeça e, em qualquer
          caso, à autoridade competente ou por determinação judicial;
        </li>
        <li>
          se o assinante-controlador não responder, comunicamos o requerente, que pode peticionar contra o controlador
          perante a ANPD (art. 18, §1º).
        </li>
      </ul>

      <h2>11. Incidente de segurança</h2>
      <p>
        Havendo incidente de segurança que possa acarretar risco ou dano relevante aos titulares, comunicamos a{" "}
        <strong>ANPD e os titulares afetados</strong> no prazo fixado pela regulamentação vigente — atualmente 3 (três)
        dias úteis contados da ciência do fato, na forma da Resolução CD/ANPD nº 15/2024 —, com os elementos exigidos
        pelo art. 48, §1º, da LGPD: natureza dos dados afetados, informações sobre os titulares envolvidos, medidas
        técnicas e de segurança utilizadas, riscos envolvidos, motivo de eventual demora e medidas adotadas para
        reverter ou mitigar os efeitos.
      </p>
      <p>
        Quando o incidente alcançar <strong>documentos processuais</strong>, comunicamos também o
        assinante-controlador, de imediato e antes de qualquer comunicação pública, para que ele possa cumprir os seus
        próprios deveres — inclusive perante o cliente dele e, se for o caso, perante o juízo.
      </p>
      <p>
        Mantemos registro interno dos incidentes, inclusive dos que não exijam comunicação, com a avaliação de risco e
        as medidas adotadas. Suspeita de acesso indevido a uma conta deve ser comunicada por quem a titulariza, na
        forma da seção 7.
      </p>

      <h2>12. Encarregado, contato e ANPD</h2>
      <p>
        <strong>Controlador:</strong> {qualificacaoFornecedor()}.
      </p>
      <p>
        <strong>Encarregado pelo tratamento de dados pessoais</strong> (art. 41 da LGPD): {FORNECEDOR.encarregado}.
        Canal para exercício de direitos e para qualquer assunto de privacidade:{" "}
        <strong>{FORNECEDOR.emailPrivacidade}</strong>. A identificação e o contato do Encarregado são divulgados aqui
        em cumprimento ao art. 41, §1º.
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
          Clientes autenticados podem abrir um chamado em <strong>Suporte</strong> dentro da Plataforma, com número e
          histórico de mensagens.
        </li>
        <li>
          Visitantes podem usar o <Link href="/contato">formulário de contato</Link>.
        </li>
      </ul>
      <p>
        O titular pode <strong>peticionar em relação aos seus dados perante a Autoridade Nacional de Proteção de Dados
        (ANPD)</strong> (art. 18, §1º) e recorrer aos órgãos de defesa do consumidor. Preferimos resolver diretamente e
        por isso mantemos o {SAC.rotulo} e o canal do Encarregado, mas{" "}
        <strong>não condicionamos o acesso a essas vias a tentativa prévia de solução com a Plataforma</strong>.
      </p>

      <h2>13. Cookies e armazenamento no navegador</h2>
      <p>
        Utilizamos <strong>um único cookie</strong>, estritamente necessário à autenticação (<code>ptp_session</code>),
        com atributo <code>httpOnly</code>, restrito ao nosso domínio e marcado como seguro em produção. Não há cookie
        analítico, de publicidade ou de terceiro; não há pixel nem rastreador — e por isso não há banner de
        consentimento a exibir. O navegador também guarda localmente a sua preferência de tema visual, que não
        identifica ninguém e não é enviada a terceiro. O detalhamento — nome, finalidade, duração e natureza — está na{" "}
        <Link href="/cookies">Política de Cookies</Link>.
      </p>

      <h2>14. Alterações desta Política</h2>
      <p>
        Esta Política é versionada: a versão e a data de vigência aparecem no topo da página. Alteração que{" "}
        <strong>reduza direito do titular, amplie finalidade de tratamento ou inclua operador com acesso a conteúdo de
        documento</strong> é comunicada previamente, por aviso na área do cliente ou por e-mail, com antecedência
        mínima de {PRAZO_AVISO_ALTERACAO_DIAS} (trinta) dias em relação à sua vigência. Correção de redação, atualização
        de contato e esclarecimento que não altere o tratamento passam a valer na publicação.
      </p>
      <p>
        Conservamos as versões anteriores e as fornecemos a pedido, pelo canal da seção 12. Discordando da nova versão,
        o assinante pode cancelar a assinatura na forma da{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>, sem ônus adicional pelo cancelamento, e
        pedir a exclusão dos dados na forma da seção 9. A continuidade do uso após a vigência{" "}
        <strong>não supre</strong> a comunicação prévia exigida acima.
      </p>
      <p>
        Documentos relacionados: <Link href="/termos">Termos de Uso</Link>,{" "}
        <Link href="/responsabilidade">Limites de Responsabilidade</Link>,{" "}
        <Link href="/cookies">Política de Cookies</Link>,{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>,{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>,{" "}
        <Link href="/reembolso">Política de Reembolso</Link> e{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>.
      </p>
    </LegalShell>
  );
}
