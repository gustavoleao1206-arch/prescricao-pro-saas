import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/marketing/legal-shell";
import { ATUALIZADO_EM, FORNECEDOR, VERSAO_DOCUMENTOS, dataBR, qualificacaoFornecedor } from "@/lib/fornecedor";
import { ATENDIMENTO, SAC, linkWhatsApp } from "@/lib/contato";
import { AVISO_REVISAO, CREDITOS_MENSAIS, PLANOS } from "@/lib/planos";
import { MAX_PAGINAS_AUTOMATICO } from "@/lib/credits";
import { rotulosDosFormatos } from "@/lib/documents";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Termos de Uso" };

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
 * Contrato principal de adesão. Os demais documentos legais são anexos dele.
 *
 * ── Aviso ao dono do negócio, que não vai no corpo do texto ───────────────────
 * A razão social a preencher em `src/lib/fornecedor.ts` deve ser a da EMPRESA DE
 * TECNOLOGIA, não a da sociedade de advogados. O art. 16 da Lei 8.906/1994 veda à
 * sociedade de advogados objeto estranho à advocacia, e a venda de licença de
 * software por assinatura é atividade empresarial — enquadramento reforçado pela
 * vedação à mercantilização da profissão (Código de Ética e Disciplina da OAB e
 * Provimento CFOAB 205/2021). Assinar este contrato de adesão como escritório de
 * advocacia expõe a inscrição do titular a processo disciplinar e, ainda, deixa o
 * cliente com um fornecedor que não pode legalmente vender o que vendeu.
 *
 * ── Nada de número escrito à mão ──────────────────────────────────────────────
 * Preço, cota, prazo de tolerância, telefone e qualificação do fornecedor vêm de
 * constante. Onde este texto precisa de um limite técnico (páginas, MB, formatos,
 * requisições por minuto), o número é lido de `env`/catálogo: contrato que anuncia
 * limite diferente do que o sistema aplica é publicidade que vincula o fornecedor
 * (arts. 30 e 37 do CDC) e obriga a entregar o que está escrito, não o que roda.
 *
 * ── Uma afirmação deste texto exigiu conserto no código ───────────────────────
 * A seção 1 diz que o aceite é registrado com a VERSÃO do documento. Não era
 * verdade: `src/app/api/auth/cadastro/route.ts` gravava a versão fixa em "1.0",
 * número que ficou para trás quando estes documentos foram reescritos. Registro de
 * consentimento que aponta para a versão errada não prova nada (art. 8º, §1º, da
 * LGPD). As DUAS rotas que gravam aceite passaram a ler `VERSAO_DOCUMENTOS` — o
 * cadastro e a definição de senha das contas provisionadas pela compra
 * (`src/app/api/auth/redefinir-senha/route.ts`, bloco CRIACAO_SENHA), que é o
 * percurso principal de entrada —, e só por isso a frase pôde ficar. Mudar qualquer
 * uma delas de volta para número escrito à mão torna a seção 1 falsa.
 */

/**
 * Nomes comerciais dos formatos que o sistema aceita no envio E consegue processar.
 *
 * A lista vem de `rotulosDosFormatos()` (src/lib/documents.ts), que é a fonte única:
 * lá ela nasce da INTERSEÇÃO entre `UPLOAD_ALLOWED_MIME` e o que a extração realmente
 * lê — exatamente o filtro que o `validateUpload` aplica no envio — e o rótulo mora ao
 * lado da lista, no arquivo em que a leitura de cada formato é escrita. Este arquivo
 * mantinha o próprio mapa de rótulos, com filtro que descartava o MIME desconhecido:
 * bastava a extração passar a ler um formato novo, e ninguém acrescentar o rótulo aqui,
 * para a seção 3.4 anunciar menos formatos do que o envio aceita, sem erro de build nem
 * de tipo. Não se lê a variável crua nem se imprime MIME técnico: o `.env` deste projeto
 * admite DOCX e XLSX, formatos cuja extração de texto não está implementada (o extrator
 * devolve "Extração de DOCX pendente" e "Tipo ... não processado"). Publicar a
 * configuração crua anunciaria formato que a Plataforma não analisa — oferta que vincula
 * o fornecedor (arts. 30 e 37 do CDC) — e ainda jogaria o MIME técnico no meio do
 * contrato.
 */
const FORMATOS = rotulosDosFormatos();

/**
 * Todos os planos vigentes vendem o mesmo número de acessos (hoje 1). O texto só
 * afirma um número único quando ele vale para todo o catálogo; havendo divergência,
 * remete à Política de Assinatura em vez de publicar número que deixou de ser
 * verdade para algum plano.
 */
const ACESSOS_POR_PLANO = [...new Set(PLANOS.filter((p) => !p.contactOnly).map((p) => p.maxUsers))];
const ACESSOS_UNICO = ACESSOS_POR_PLANO.length === 1 ? ACESSOS_POR_PLANO[0] : null;

/**
 * Prazos criados por ESTE contrato, que não existem em código.
 *
 * Ficam em constante pelo mesmo motivo que a Política de Uso Aceitável reuniu os
 * prazos do escalonamento no topo do arquivo: dois "30 dias" digitados à mão em
 * cláusulas diferentes divergem na primeira revisão, e aviso de reajuste com prazo
 * diferente do aviso de alteração é convite a discussão sobre qual vale.
 */
/** Antecedência mínima de comunicação de reajuste e de alteração relevante destes Termos. */
const DIAS_AVISO_ALTERACAO = 30;

/** Janela de faturamento considerada no teto de indenização da seção 10.4. */
const MESES_TETO_INDENIZACAO = 12;

const num = (n: number) => n.toLocaleString("pt-BR");

const listar = (itens: string[]) =>
  itens.length <= 1 ? (itens[0] ?? "") : `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;

/**
 * Declarado depois de `listar` de propósito: `const` não é içado, e compor este
 * rótulo antes da declaração da função quebraria a página em tempo de execução.
 */
const FORMATOS_ROTULO = FORMATOS.length > 0 ? listar(FORMATOS) : "os indicados na tela de envio";

export default function TermosPage() {
  return (
    <LegalShell title="Termos de Uso">
      <p>
        Estes Termos de Uso regem o acesso e a utilização da plataforma {FORNECEDOR.nomeFantasia}, fornecida por{" "}
        {qualificacaoFornecedor()}. Leia o texto integralmente antes de se cadastrar ou contratar: ao fazê-lo, o
        contratante adere às condições abaixo.
      </p>
      <p>
        Integram estes Termos, como partes indissociáveis, a <Link href="/privacidade">Política de Privacidade</Link>,
        a <Link href="/cookies">Política de Cookies</Link>, o{" "}
        <Link href="/responsabilidade">Aviso de responsabilidade jurídica</Link>, a{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>, a{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>, a{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>, a{" "}
        <Link href="/reembolso">Política de Reembolso</Link> e a{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>. Havendo divergência entre este
        instrumento e um documento específico, prevalece o documento específico quanto à matéria que ele regula,{" "}
        <strong>salvo</strong> quando outro instrumento (i) assegurar ao Assinante condição mais favorável, ou (ii)
        descrever com maior precisão o funcionamento efetivo da Plataforma — hipóteses em que prevalece a disposição
        mais favorável ou mais precisa. Em nenhum caso a prevalência de um documento suprime garantia legal do
        Assinante.
      </p>

      <h2>1. Identificação do fornecedor e aceitação</h2>
      <p>
        <strong>Fornecedor:</strong> {qualificacaoFornecedor()}. Endereço eletrônico de contato:{" "}
        {FORNECEDOR.email}. Canal de atendimento ao consumidor: {SAC.numero}, {SAC.horario.toLowerCase()}. A
        identificação, o CNPJ e o endereço constam também do rodapé das páginas públicas do site, em local de destaque,
        na forma do art. 2º, incisos I e II, do Decreto 7.962/2013, e o atendimento eletrônico exigido pelo art. 4º,
        inciso V, do mesmo Decreto é prestado pelos canais da seção 17.
      </p>
      <p>
        Estes Termos ficam permanentemente disponíveis nesta página, em linguagem acessível e antes de qualquer
        contratação, para que o contratante possa tomar conhecimento prévio de seu conteúdo, como exige o art. 46 do
        Código de Defesa do Consumidor, e permanecem acessíveis após a contratação em meio que permite sua conservação e
        reprodução, na forma do art. 4º, inciso IV, do Decreto 7.962/2013.
      </p>
      <p>O aceite é manifestado, de forma expressa e inequívoca, por qualquer destes atos:</p>
      <ul>
        <li>
          <strong>cadastro</strong> na Plataforma, com marcação da concordância com estes Termos, com a Política de
          Privacidade, com as condições de assinatura e com o uso de inteligência artificial;
        </li>
        <li>
          <strong>contratação</strong> de plano ou de créditos avulsos; e
        </li>
        <li>
          <strong>utilização</strong> da Plataforma com credenciais próprias.
        </li>
      </ul>
      {/*
        Só se afirma o que o sistema grava — e aqui a frase custou um conserto: o
        cadastro gravava a versão fixa em "1.0". Ver o comentário no topo do arquivo.
      */}
      <p>
        Cada aceite é registrado pela Plataforma com <strong>data, hora, endereço IP</strong> de origem e a{" "}
        <strong>versão do documento aceito</strong>, por finalidade e para prova do consentimento. A versão vigente e a
        data de vigência aparecem no topo desta página; a versão atual é a {VERSAO_DOCUMENTOS}, em vigor desde{" "}
        {dataBR(ATUALIZADO_EM)}.
      </p>
      <p>
        Quem não concordar com qualquer condição destes Termos deve deixar de utilizar a Plataforma e, tendo contratado,
        pode exercer o direito de arrependimento na forma da{" "}
        <Link href="/reembolso">Política de Reembolso</Link>.
      </p>

      <h2>2. Definições</h2>
      <ul>
        <li>
          <strong>Plataforma:</strong> o sistema {FORNECEDOR.nomeFantasia}, acessível em {FORNECEDOR.site}, incluindo
          suas telas, funcionalidades, banco de conhecimento jurídico e documentos gerados.
        </li>
        <li>
          <strong>Fornecedor:</strong> a pessoa jurídica identificada na seção 1, titular da Plataforma.
        </li>
        <li>
          <strong>Assinante:</strong> a pessoa natural ou jurídica que contrata o acesso e responde pelo pagamento e
          pelo cumprimento destes Termos.
        </li>
        <li>
          <strong>Usuário:</strong> a pessoa natural que efetivamente acessa a Plataforma com credenciais vinculadas à
          conta do Assinante.
        </li>
        <li>
          <strong>Conta:</strong> o ambiente isolado do Assinante, ao qual se vinculam as credenciais, as análises, os
          documentos e o histórico.
        </li>
        <li>
          <strong>Documento:</strong> o arquivo enviado pelo Usuário para análise — tipicamente peças e autos de
          execução fiscal — e o texto dele extraído pela Plataforma.
        </li>
        <li>
          <strong>Análise:</strong> o processamento automatizado de um conjunto de Documentos e informações, do qual
          resultam a linha do tempo dos atos, o relatório fundamentado com grau de confiança e, havendo tese favorável,
          a minuta de exceção de pré-executividade.
        </li>
        <li>
          <strong>Crédito:</strong> a unidade de consumo de Análise, na forma da{" "}
          <Link href="/politica-de-creditos">Política de Créditos</Link>. Cada plano vigente inclui uma{" "}
          <strong>cota de {CREDITOS_MENSAIS} créditos por ciclo mensal</strong>, não cumulativa; esgotada a cota, o
          Assinante pode adquirir <strong>créditos avulsos</strong> a qualquer momento, sem alterar a assinatura. Um
          Crédito corresponde a uma Análise de processo da primeira faixa de páginas daquela Política — processo maior
          consome mais de um.
        </li>
        <li>
          <strong>Ciclo:</strong> o período de vigência do pagamento — mensal ou anual, conforme a periodicidade
          contratada — ao fim do qual ocorre, ou não, a renovação, nos termos da{" "}
          <Link href="/politica-de-assinatura">Política de Assinatura</Link>.
        </li>
      </ul>

      <h2>3. Objeto e natureza do serviço</h2>
      <h3>3.1. O que é contratado</h3>
      <p>
        O objeto destes Termos é a <strong>licença de uso de software por assinatura</strong>, em ambiente na nuvem
        (<em>software as a service</em>), destinada a apoiar a apuração de prescrição ordinária, prescrição
        intercorrente e decadência tributária em execuções fiscais, a partir dos Documentos enviados pelo próprio
        Usuário.
      </p>
      <h3>3.2. O que não é contratado</h3>
      <p>
        A contratação <strong>não constitui</strong> prestação de serviço de advocacia, consultoria jurídica
        individualizada, parecer jurídico definitivo, patrocínio de causa, representação processual, acompanhamento de
        processo ou controle de prazos. O Fornecedor não figura como procurador, não pratica atos processuais e não
        assume dever de vigilância sobre os autos do Assinante.
      </p>
      <p>{AVISO_REVISAO}</p>
      <p>
        As limitações técnicas e jurídicas do resultado estão detalhadas no{" "}
        <Link href="/responsabilidade">Aviso de responsabilidade jurídica</Link>, que integra estes Termos.
      </p>
      <h3>3.3. Como a Análise é produzida</h3>
      <ul>
        <li>
          O processamento é <strong>automatizado</strong>. O texto dos Documentos é extraído no próprio servidor da
          Plataforma, inclusive o reconhecimento óptico de caracteres de arquivos digitalizados, que{" "}
          <strong>não é enviado a serviço de terceiro</strong>.
        </li>
        <li>
          O conteúdo textual selecionado é submetido a <strong>provedor de inteligência artificial contratado</strong>,
          identificado na <Link href="/privacidade">Política de Privacidade</Link>, que também informa o país de
          processamento e a base da transferência internacional. As credenciais de acesso ao provedor são do Fornecedor
          e não trafegam pelo navegador do Usuário.
        </li>
        <li>
          <strong>A Análise pode não abranger todas as páginas do processo.</strong> Há teto de tamanho no pedido
          enviado ao provedor de inteligência artificial e, alcançado esse teto, são submetidas as páginas apuradas como
          mais relevantes para a matéria. Em consequência, <strong>a ausência de um ato no relatório não prova a
          ausência do ato nos autos</strong>, e a conferência contra os autos é indispensável.
        </li>
        <li>
          Estando o provedor de inteligência artificial indisponível ou não configurado, a Análise pode ser produzida em{" "}
          <strong>modo heurístico local</strong>, sem envio de conteúdo a terceiro: nesse modo o sistema apenas aplica o
          cálculo de prazos às datas identificadas, sem interpretar o conteúdo das peças. O relatório e a minuta
          produzidos nesse modo trazem a indicação destacada dessa condição e grau de confiança baixo.
        </li>
        <li>
          O relatório e a minuta são convertidos em PDF e DOCX pelo próprio servidor da Plataforma, sem intermediação de
          terceiro na conversão.
        </li>
      </ul>
      <h3>3.4. Limites técnicos do serviço</h3>
      <p>
        Além da cota de Créditos de cada plano, que é limite CONTRATUAL, aplicam-se os limites TÉCNICOS abaixo, que são
        condição de funcionamento do serviço e são informados ao Usuário no momento do envio:
      </p>
      <ul>
        <li>
          formatos aceitos: {FORMATOS_ROTULO}. Imagens são aceitas, porém{" "}
          <strong>não passam por reconhecimento óptico de caracteres</strong> e são sinalizadas como ilegíveis: para que
          o conteúdo seja lido, o envio deve ser em PDF;
        </li>
        <li>
          até {num(env.upload.maxFiles)} arquivos por Análise e {num(env.upload.maxFileMb)} MB por arquivo, observado
          ainda o limite de tamanho por faixa de páginas previsto na{" "}
          <Link href="/politica-de-creditos">Política de Créditos</Link>;
        </li>
        <li>
          até {num(env.ocr.maxPaginas)} páginas transcritas por documento digitalizado; e
        </li>
        <li>
          acima de {num(MAX_PAGINAS_AUTOMATICO)} páginas o <strong>processamento automático é recusado</strong>, sem
          consumo de Crédito.
        </li>
      </ul>
      <p>
        O quadro completo dos limites em vigor, com o efeito de cada um, está na{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>. Exceder limite técnico{" "}
        <strong>não é infração</strong>: a operação é recusada com mensagem na tela e nenhuma medida decorre disso.
      </p>
      <p>
        A <strong>análise especial</strong> de processos acima do teto de páginas não está incluída em nenhum plano:
        depende de proposta específica, com preço, prazo e escopo acordados por escrito antes da execução, solicitada
        pelos canais da seção 17.
      </p>
      <h3>3.5. Ferramentas de terceiros acessadas por link</h3>
      <p>
        A Plataforma pode exibir link para assistente ou ferramenta hospedada <strong>fora</strong> do ambiente do
        Fornecedor. O uso é facultativo e se submete integralmente aos termos e à política de privacidade do respectivo
        titular. O conteúdo que o Usuário inserir nesse ambiente externo <strong>não é tratado pela Plataforma</strong>,
        não está coberto por estes Termos nem pelas garantias de sigilo da seção 8, e o Usuário deve avaliar, antes de
        utilizá-lo, a compatibilidade com o sigilo profissional a que está obrigado.
      </p>

      <h2>4. Quem pode contratar. Conta e credenciais</h2>
      <h3>4.1. Capacidade e qualificação</h3>
      <p>
        A contratação é destinada a <strong>uso profissional</strong> e pressupõe pessoa natural maior de 18 anos e
        civilmente capaz (art. 5º do Código Civil) ou pessoa jurídica regularmente constituída, representada por quem
        tenha poderes para obrigá-la.
      </p>
      <p>
        Ao contratar, o Assinante <strong>declara</strong> ser advogado(a) regularmente inscrito(a) na Ordem dos
        Advogados do Brasil, ou atuar sob supervisão de advogado(a) habilitado(a) responsável pelo caso. A declaração é
        exigência contratual porque todo resultado da Plataforma depende de revisão profissional; o Fornecedor{" "}
        <strong>não verifica</strong> a inscrição declarada e não se substitui a ela.
      </p>
      <p>
        Sendo o Assinante pessoa jurídica, ela responde solidariamente com o Usuário por todos os atos praticados na
        Conta, inclusive pelo conteúdo enviado e pelos valores devidos.
      </p>
      <h3>4.2. Veracidade dos dados</h3>
      <p>
        O Usuário se obriga a fornecer dados <strong>verdadeiros, completos e atualizados</strong> no cadastro e a
        mantê-los atualizados, em especial o endereço de e-mail, que é o canal de comunicação previsto na seção 13. Dados
        inexatos que impeçam a emissão de cobrança, a verificação da conta ou a entrega de comunicações não geram
        responsabilidade do Fornecedor.
      </p>
      <h3>4.3. Individualidade do acesso</h3>
      <p>
        O acesso é <strong>pessoal e individual</strong>.{" "}
        {ACESSOS_UNICO !== null ? (
          <>
            Cada plano dá direito a {ACESSOS_UNICO} acesso, e a Plataforma não comercializa acesso adicional: a Conta
            não deve ser utilizada como acesso compartilhado de escritório.
          </>
        ) : (
          <>
            O número de acessos incluídos consta da{" "}
            <Link href="/politica-de-assinatura">Política de Assinatura</Link>.
          </>
        )}{" "}
        É <strong>vedado</strong> compartilhar credenciais, cedê-las, revendê-las, permitir o uso por quem não seja o
        Usuário identificado no cadastro ou operar a Conta por interposta pessoa.
      </p>
      <h3>4.4. Deveres de segurança do Usuário</h3>
      <ul>
        <li>guardar a senha em sigilo, não reutilizá-la em outros serviços e não a transmitir por qualquer meio;</li>
        <li>
          ativar, quando julgar necessário, a <strong>verificação em duas etapas</strong>, disponível na Plataforma e de
          ativação facultativa pelo próprio Usuário, mantendo em local seguro os códigos de recuperação;
        </li>
        <li>
          <strong>comunicar imediatamente</strong> ao Fornecedor, pelos canais da seção 17, a perda, o extravio ou
          qualquer suspeita de acesso indevido às credenciais; e
        </li>
        <li>
          responder pelos atos praticados com as próprias credenciais até a comunicação de que trata o item anterior,
          salvo se o acesso indevido decorrer de falha de segurança imputável ao Fornecedor.
        </li>
      </ul>
      {/*
        Presunção RELATIVA, e não responsabilidade objetiva do Usuário: cláusula que
        o fizesse responder por tudo o que acontecesse com sua credencial, sem prova
        e sem apuração, inverteria o ônus da prova em seu prejuízo — nula pelo
        art. 51, VI, do CDC. Os registros de sessão e de auditoria existem e são o
        que permite apurar de fato.
      */}
      <p>
        Presume-se, <strong>até prova em contrário</strong>, que as operações realizadas com as credenciais da Conta
        foram praticadas pelo Usuário a quem pertencem. Comunicado o comprometimento, cessa a responsabilidade do
        Assinante pelas operações posteriores, e o Fornecedor apura o ocorrido com base nos registros de sessão e de
        auditoria, na forma da <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>.
      </p>

      <h2>5. Licença de uso e propriedade intelectual</h2>
      <h3>5.1. Licença concedida ao Assinante</h3>
      <p>
        O Fornecedor concede ao Assinante licença <strong>onerosa, pessoal, não exclusiva, intransferível, não
        sublicenciável e revogável</strong>, limitada à vigência da assinatura e ao uso da Plataforma conforme sua
        destinação, para a atividade profissional própria do Assinante. Nenhuma disposição destes Termos transfere
        titularidade de software, de código-fonte ou de base de dados.
      </p>
      <h3>5.2. O que pertence ao Fornecedor</h3>
      <p>
        São de titularidade exclusiva do Fornecedor, protegidos pela Lei 9.610/1998 e pela Lei 9.609/1998: o software da
        Plataforma e seu código-fonte, a identidade visual, a marca e o nome {FORNECEDOR.nomeFantasia}, a metodologia de
        apuração, as instruções e os modelos de prompt, a base de conhecimento jurídico, os modelos de relatório e de
        peça, a estrutura das telas e a documentação. É vedada a reprodução, a descompilação, a engenharia reversa, a
        extração sistemática de conteúdo e a criação de obra derivada, ressalvadas as hipóteses legais.
      </p>
      <h3>5.3. O que pertence ao Assinante</h3>
      <ul>
        <li>
          Os <strong>Documentos enviados</strong> permanecem integralmente sob a titularidade e a responsabilidade do
          Assinante.
        </li>
        <li>
          O <strong>relatório, a linha do tempo e a minuta</strong> produzidos sobre os casos do Assinante são
          entregues para uso livre e ilimitado na atividade profissional dele. <strong>O Assinante pode juntar,
          adaptar e utilizar esse material em juízo e fora dele</strong>, inclusive após o encerramento da assinatura —
          essa é a finalidade do produto —, assumindo, na forma da seção 10, a revisão e a responsabilidade técnica pelo
          que protocolar.
        </li>
        <li>
          O Fornecedor não reivindica autoria sobre a peça protocolada, nem exige menção à Plataforma nos autos.
        </li>
      </ul>
      {/*
        Ressalva de honestidade, e não de estilo: sem assinatura ativa o sistema
        permite CONSULTAR a análise, mas bloqueia o download do relatório, da peça e
        dos documentos (assertActiveSubscription nas rotas de download). Afirmar uso
        livre do material "após o encerramento" sem esta advertência prometeria
        acesso que o sistema recusa.
      */}
      <p>
        <strong>Recomendação prática:</strong> exporte e arquive o relatório, a minuta e os Documentos de cada Análise
        concluída enquanto a assinatura estiver ativa. A consulta ao histórico permanece disponível, mas a{" "}
        <strong>exportação de arquivos depende de assinatura ativa</strong>, na forma da seção 11.4.
      </p>
      <h3>5.4. Licença concedida ao Fornecedor sobre os Documentos</h3>
      <p>
        O Assinante autoriza o Fornecedor, <strong>exclusivamente para executar o serviço contratado</strong>, a
        armazenar, extrair texto, processar e apresentar os Documentos enviados e os resultados deles derivados. A
        autorização é limitada a essa finalidade e <strong>não abrange</strong> uso comercial próprio, cessão a
        terceiros estranhos à execução do serviço, divulgação, nem <strong>treinamento ou aperfeiçoamento de modelo de
        inteligência artificial</strong> — próprio ou de terceiro. As condições contratadas com os operadores que
        participam da execução constam da <Link href="/privacidade">Política de Privacidade</Link>.
      </p>

      <h2>6. Planos, preço, pagamento e reajuste</h2>
      <p>
        Os planos vigentes, a periodicidade, os limites, os meios de pagamento aceitos, as regras de renovação por
        cartão, boleto e PIX, a alteração de plano, a inadimplência e o cancelamento estão na{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>. O consumo, a validade e o estorno de
        Créditos estão na <Link href="/politica-de-creditos">Política de Créditos</Link>. O arrependimento e as
        hipóteses de devolução estão na <Link href="/reembolso">Política de Reembolso</Link>.
      </p>
      {/*
        Não se escreve preço aqui de propósito, e não é só para evitar divergência
        de texto: a autoridade em tempo de execução é o BANCO, e o administrador pode
        alterar preço pelo painel sem tocar em código. O contrato vincula-se ao preço
        exibido na contratação, e garante que o ciclo pago não muda — que é o que o
        art. 51, X e XIII, do CDC exige.
      */}
      <p>
        O preço aplicável é o <strong>exibido na página de <Link href="/planos">Planos</Link> no momento da
        contratação</strong>, com a periodicidade ali indicada. O valor contratado{" "}
        <strong>não é alterado unilateralmente durante o Ciclo já pago</strong>, e alteração de preço não retroage a
        período já quitado: aplica-se somente a Ciclos futuros, mediante comunicação prévia ao Assinante antes da
        renovação seguinte.
      </p>
      <p>
        Nos contratos de duração continuada, o valor da assinatura pode ser <strong>reajustado</strong> pela variação
        acumulada do <strong>IPCA/IBGE</strong> — ou do índice que oficialmente o substituir — observada a{" "}
        <strong>periodicidade mínima de 12 meses</strong> imposta pelo art. 2º, § 1º, da Lei 10.192/2001 e comunicação
        com pelo menos {num(DIAS_AVISO_ALTERACAO)} dias de antecedência da renovação. Não concordando com o reajuste, o
        Assinante pode cancelar antes da renovação, sem multa e sem ônus, mantendo o acesso até o fim do Ciclo já pago.
      </p>
      <p>
        A cobrança, a recorrência e o reembolso são operados por <strong>processadora de pagamento contratada</strong>.
        Os dados de pagamento são informados diretamente no ambiente dela e{" "}
        <strong>não transitam pela Plataforma</strong>, que não coleta nem armazena número de cartão.
      </p>

      <h2>7. Uso aceitável e uso justo</h2>
      <p>
        As regras completas de uso — limites técnicos em vigor, acesso automatizado, revenda, apuração de uso atípico,
        escalonamento das medidas e pedido de reexame — estão na{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>, que integra estes Termos. Esta seção fixa as
        vedações centrais e o efeito contratual do descumprimento.
      </p>
      <h3>7.1. Condutas vedadas</h3>
      <p>É vedado ao Usuário, além do que a lei já proíbe:</p>
      <ul>
        <li>
          compartilhar, ceder, alugar, revender, sublicenciar ou disponibilizar a terceiros o acesso, as credenciais ou
          a própria Plataforma, ainda que sem cobrança;
        </li>
        <li>
          utilizar a Plataforma para prestar a terceiros serviço concorrente, ou operá-la como retaguarda de produto
          próprio;
        </li>
        <li>
          acessar a Plataforma por meio automatizado não autorizado — robôs, coletores, scripts, integrações não
          documentadas ou interfaces de programação não publicadas —, extrair conteúdo em massa ou reproduzir a base de
          conhecimento;
        </li>
        <li>
          tentar burlar limites de uso, cotas, controle de acesso, isolamento entre Contas, verificação de pagamento ou
          qualquer medida de segurança, bem como investigar vulnerabilidade sem autorização escrita;
        </li>
        <li>
          descompilar, decompor ou submeter a engenharia reversa qualquer parte da Plataforma, ressalvadas as hipóteses
          legais;
        </li>
        <li>
          enviar Documento sobre o qual não detenha legitimidade para tratamento, conteúdo obtido de forma ilícita,
          conteúdo malicioso ou arquivo alheio à finalidade jurídica do serviço; e
        </li>
        <li>
          apresentar o resultado da Análise a cliente, a juízo ou ao público como parecer, decisão ou trabalho humano
          revisado, quando não o for.
        </li>
      </ul>
      <h3>7.2. Uso justo e ritmo de processamento</h3>
      {/*
        Sem esta cláusula o sistema bloqueava por rate limit sem nenhuma base
        publicada: o cliente comprava "sem limite", batia num limite invisível e o
        contrato não o previa. Publicar o número torna o bloqueio legítimo (art. 46
        do CDC) — e é o número que o código aplica de fato.

        A agregação também precisa ser a do código: `agentRateAllowed` monta a chave
        `agent:${action}:${userId}` (src/lib/rate-limit.ts), então a cota é POR TIPO
        de operação, não um orçamento único. Escrever "operações por período" sem essa
        ressalva publicaria limite mais estreito que o aplicado — quem fizesse 25
        envios e 25 downloads no mesmo minuto estaria fora do uso justo pelo contrato
        e dentro dele pelo sistema.
      */}
      <p>
        Além da cota de Créditos, que é limite CONTRATUAL, existe um limite de RITMO — e os dois são independentes: ter
        crédito disponível não autoriza consumi-lo em rajada. Para preservar a estabilidade do serviço para todos os
        assinantes, aplica-se <strong>limite de uso justo</strong> de{" "}
        {num(env.security.agentRateMax)} operações por período de {num(env.security.agentRateWindow)} segundos{" "}
        <strong>para cada tipo de operação</strong> — criação de Análise, envio de Documento, processamento, geração de
        relatório e geração de minuta —, apurado por Usuário. Excedido o limite, novas solicitações desse tipo são
        recusadas temporariamente e voltam a ser aceitas na janela seguinte, sem perda de Análise em andamento.
      </p>
      <p>
        <strong>Não existe cota oculta de Análises</strong> além da cota contratada e publicada: quantidade,
        isoladamente, não caracteriza infração. Volume
        manifestamente incompatível com o uso profissional de um único Usuário só é relevante como{" "}
        <strong>indício</strong>, somado a outro indício de automação, de compartilhamento de credencial ou de revenda, e
        a apuração observa a <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>.
      </p>
      <h3>7.3. Consequência do descumprimento</h3>
      <p>
        O descumprimento desta seção é <strong>inadimplemento contratual</strong> e sujeita o Assinante, conforme a
        gravidade e na menor extensão suficiente para fazer cessar a conduta, a aviso, a limitação temporária do uso, à
        suspensão do acesso e ao encerramento da assinatura, sem prejuízo da responsabilidade civil e criminal. O
        escalonamento dessas medidas, os prazos de aviso e de resposta e o direito a reexame estão na{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>. Nas hipóteses de compartilhamento de acesso ou de
        uso por quem não seja o Usuário cadastrado, o Fornecedor pode exigir a contratação regular dos acessos
        efetivamente utilizados, pelo preço vigente no período.
      </p>

      <h2>8. Dados pessoais, sigilo profissional e decisão automatizada</h2>
      <h3>8.1. Papéis das partes (LGPD)</h3>
      <p>
        A divisão de papéis é a seguinte, e ela é determinante para as obrigações de cada parte:
      </p>
      <ul>
        <li>
          quanto aos <strong>dados de cadastro, cobrança e uso da Plataforma</strong>, o Fornecedor é{" "}
          <strong>controlador</strong> (art. 5º, VI, da Lei 13.709/2018), pois decide as finalidades: prestar o serviço,
          cobrar, prevenir fraude e cumprir obrigações legais;
        </li>
        <li>
          quanto aos <strong>Documentos e aos dados pessoais de terceiros neles contidos</strong> — executados,
          representantes, servidores e demais participantes do processo —, o <strong>Assinante é o controlador</strong> e
          o <strong>Fornecedor atua como operador</strong> (art. 5º, VII, da mesma Lei), tratando esses dados
          exclusivamente para executar a Análise determinada pelo Assinante.
        </li>
      </ul>
      <h3>8.2. Declarações e obrigações do Assinante</h3>
      <ul>
        <li>
          declara ter <strong>base legal e legitimidade</strong> para submeter os Documentos à Plataforma, na condição de
          advogado(a) da causa ou de responsável autorizado, e responde perante os titulares e perante a autoridade
          nacional por essa decisão;
        </li>
        <li>
          reconhece que o conteúdo pode estar coberto por <strong>sigilo profissional</strong> (arts. 7º, II, e 34, VII,
          da Lei 8.906/1994) ou por <strong>segredo de justiça</strong> (art. 189 do Código de Processo Civil), e que a
          decisão de submetê-lo a ambiente de terceiro é dele;
        </li>
        <li>
          obriga-se a não enviar dado pessoal desnecessário à finalidade da Análise; e
        </li>
        <li>
          responde pelo atendimento dos direitos dos titulares desses dados, com o auxílio do Fornecedor previsto no
          item seguinte.
        </li>
      </ul>
      <h3>8.3. Obrigações do Fornecedor como operador</h3>
      <p>
        Na qualidade de operador, e na forma do art. 39 da Lei 13.709/2018, o Fornecedor se obriga a: tratar os
        Documentos <strong>somente conforme as instruções</strong> do Assinante e para a execução do serviço; manter
        confidencialidade, extensiva a empregados e prestadores; adotar as medidas de segurança descritas na{" "}
        <Link href="/privacidade">Política de Privacidade</Link>; auxiliar o Assinante no atendimento de requisições de
        titulares e da Autoridade Nacional de Proteção de Dados; comunicar incidente de segurança relevante na forma da
        Política de Privacidade; e eliminar ou devolver os dados na forma da{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>, ressalvadas as retenções impostas por
        lei, inclusive a guarda de registros de acesso a aplicações de internet exigida pelo art. 15 do Marco Civil da
        Internet.
      </p>
      {/*
        Compromisso ORGANIZACIONAL, não característica técnica. ADMIN e REVISOR têm
        acesso técnico irrestrito ao conteúdo (tenant.ts: privileged) e o que existe é
        REGISTRO do acesso em AuditLog, não trava. Redigir "não acessamos" seria
        afirmação falsa sobre o sistema — e a primeira a cair numa auditoria.
      */}
      <p>
        O acesso de pessoal do Fornecedor ao conteúdo de Documento de Assinante é{" "}
        <strong>restrito por compromisso contratual e organizacional</strong> às hipóteses de suporte solicitado pelo
        Assinante, de apuração de incidente de segurança, de revisão técnica da qualidade da Análise e de cumprimento de
        determinação legal ou judicial. Todo download de Documento e de relatório é{" "}
        <strong>registrado em trilha de auditoria</strong> com autor, data e hora. O Fornecedor informa, com
        transparência, que esse registro é <strong>medida de rastreabilidade, e não impedimento técnico</strong>: perfis
        internos de administração e de revisão possuem, por necessidade operacional, capacidade de acesso ao conteúdo.
      </p>
      <h3>8.4. Decisão automatizada e revisão (art. 20 da LGPD)</h3>
      <p>
        A Análise é produzida por <strong>tratamento automatizado</strong> e conclui sobre a existência ou não de tese
        de prescrição ou decadência, com indicação de fundamento legal, marcos e{" "}
        <strong>grau de confiança</strong>. Nenhuma decisão jurídica é tomada pela Plataforma: a conclusão é{" "}
        <strong>insumo</strong>, e a decisão de alegar, de deixar de alegar ou de peticionar é do advogado(a)
        responsável.
      </p>
      <p>
        O Assinante e o titular de dados podem solicitar <strong>explicação sobre os critérios</strong> utilizados e{" "}
        <strong>revisão</strong> do resultado pelos canais da seção 17 e pelo canal de privacidade indicado na{" "}
        <Link href="/privacidade">Política de Privacidade</Link>. A revisão consiste em reexame do caso por pessoa
        natural do Fornecedor, com esclarecimento do método e, sendo apurada falha técnica, reprocessamento sem novo
        consumo de Crédito. Não se compreende como revisão a emissão de opinião jurídica sobre o caso, que constituiria
        atividade de advocacia estranha ao objeto contratado.
      </p>
      <h3>8.5. Demais informações</h3>
      <p>
        As categorias de dados tratados, as finalidades, os operadores envolvidos, as transferências internacionais, os
        prazos de retenção, os direitos do titular e os prazos de atendimento estão na{" "}
        <Link href="/privacidade">Política de Privacidade</Link>. As tecnologias de armazenamento no navegador estão na{" "}
        <Link href="/cookies">Política de Cookies</Link>.
      </p>

      <h2>9. Disponibilidade, manutenção e suporte</h2>
      <p>
        O Fornecedor emprega <strong>esforços técnicos diligentes</strong> para manter a Plataforma disponível e íntegra,
        mas <strong>não garante disponibilidade ininterrupta ou isenta de falhas</strong>, condição inerente a serviços
        prestados pela internet e dependentes de infraestrutura de terceiros. Não há, nestes Termos, nível de serviço
        contratado com metas de disponibilidade medidas.
      </p>
      <ul>
        <li>
          <strong>Manutenção programada:</strong> quando exigir interrupção perceptível, é comunicada previamente pelo
          painel ou por e-mail e, quando possível, executada em horário de menor uso.
        </li>
        <li>
          <strong>Manutenção emergencial e correção de segurança:</strong> podem ser executadas de imediato, com
          comunicação posterior.
        </li>
        <li>
          <strong>Dependência de terceiros:</strong> indisponibilidade do provedor de inteligência artificial, do serviço
          de armazenamento, do provedor de e-mail ou da processadora de pagamento pode impedir temporariamente a
          conclusão de Análises. Nessa hipótese, a Análise interrompida por falha técnica não
          consome Crédito, e o Crédito eventualmente debitado é estornado na forma da{" "}
          <Link href="/politica-de-creditos">Política de Créditos</Link>.
        </li>
        <li>
          <strong>Tempo de processamento:</strong> os prazos divulgados são estimativas apuradas em uso normal e variam
          com o tamanho do processo, com a necessidade de reconhecimento óptico de caracteres e com a fila do provedor
          de inteligência artificial. Não constituem prazo contratual.
        </li>
      </ul>
      <p>
        O suporte é prestado pelos canais da seção 17. Clientes autenticados podem abrir chamado numerado em{" "}
        <strong>Suporte</strong>, com histórico de mensagens.
      </p>

      <h2>10. Responsabilidade</h2>
      <h3>10.1. Do que o Fornecedor responde</h3>
      <p>
        O Fornecedor responde, nos termos da lei e sem exclusão das garantias legais, pelo{" "}
        <strong>defeito na prestação do serviço contratado</strong>, notadamente pela indisponibilidade injustificada e
        prolongada da Plataforma, pela perda de Documento ou de Análise causada por falha sua, pela cobrança indevida e
        pela falha de segurança que lhe seja imputável. Aplicam-se, quando a relação for de consumo, os arts. 14, 20 e
        26 do Código de Defesa do Consumidor, cabendo ao consumidor, à sua escolha, a reexecução do serviço, a
        restituição do valor pago ou o abatimento proporcional do preço.
      </p>
      <p>
        Reclamação por vício aparente ou de fácil constatação deve ser apresentada nos prazos do art. 26 do Código de
        Defesa do Consumidor, contados da execução do serviço; tratando-se de vício oculto, do momento em que ficar
        evidenciado o defeito. A reclamação suspende esse prazo até a resposta negativa do Fornecedor, transmitida de
        forma inequívoca.
      </p>
      <h3>10.2. Do que o Fornecedor não responde</h3>
      <p>
        Por decorrerem de ato, omissão ou decisão profissional do Assinante, e não de defeito do serviço, o Fornecedor
        não responde por:
      </p>
      <ul>
        <li>
          <strong>perda de prazo processual</strong>, preclusão, prescrição ou decadência do direito do cliente do
          Assinante: <strong>a Plataforma não monitora prazos, não emite alertas de vencimento e não pratica atos
          processuais</strong>;
        </li>
        <li>
          <strong>conclusão apoiada em documentação incompleta, ilegível, desordenada ou parcialmente submetida</strong>,
          quando a insuficiência decorrer do material enviado ou dos limites informados na seção 3.3;
        </li>
        <li>
          <strong>decisão judicial desfavorável</strong>, rejeição da tese, não conhecimento da exceção de
          pré-executividade ou qualquer resultado do processo: a indicação favorável não representa garantia de êxito, e
          resultado desfavorável não caracteriza defeito do serviço;
        </li>
        <li>
          utilização do relatório ou da minuta <strong>sem a revisão profissional</strong> exigida por estes Termos,
          inclusive protocolo de peça sem conferência dos marcos e sem preenchimento dos campos sinalizados;
        </li>
        <li>
          conteúdo dos Documentos enviados, licitude da sua obtenção e consequências do envio de dados de terceiros sem
          legitimidade; e
        </li>
        <li>
          uso de ferramenta externa acessada por link, na forma da seção 3.5, e indisponibilidade de serviço de terceiro
          fora do seu controle, bem como caso fortuito e força maior.
        </li>
      </ul>
      <h3>10.3. Dever de conferência do Assinante</h3>
      <p>
        O Assinante se obriga, <strong>antes de qualquer uso processual</strong>, a conferir nos autos cada data, cada
        marco interruptivo ou suspensivo e cada citação da linha do tempo e do relatório, a completar os campos
        sinalizados na minuta e a submeter o material a revisão de advogado(a) habilitado(a). Esse dever é elemento
        essencial do contrato: a Plataforma foi contratada como apoio à conferência, não como substituta dela.
      </p>
      <h3>10.4. Limite de indenização</h3>
      {/*
        Teto COM ressalvas. Exoneração total, e mesmo atenuação do dever de
        indenizar, é nula pelos arts. 25 e 51, I, do CDC — e cláusula nula não
        protege ninguém, só garante derrota. O teto vale onde a lei admite, e as
        exceções abaixo são justamente o que impede a nulidade.

        A ressalva alcança as DUAS coisas do parágrafo anterior: o teto quantitativo
        e a exclusão de categorias de dano. Ressalvar apenas "o limite deste item"
        deixava de pé, no vazamento e no dolo, a exclusão de lucros cessantes e de
        perda de chance — que é exatamente o dano típico desse cenário, e a parte
        indefensável da cláusula.
      */}
      <p>
        Na medida máxima admitida pela legislação aplicável, a responsabilidade do Fornecedor por perdas e danos
        decorrentes destes Termos fica limitada ao{" "}
        <strong>
          valor efetivamente pago pelo Assinante nos {num(MESES_TETO_INDENIZACAO)} meses anteriores
        </strong>{" "}
        ao fato gerador, e não abrange lucros cessantes, perda de chance, dano de imagem, dano reflexo ou perda de
        receita do Assinante ou de clientes dele.
      </p>
      <p>
        <strong>O teto e as exclusões do parágrafo anterior não se aplicam</strong>, em nenhuma hipótese: (i) a dolo ou
        culpa grave do Fornecedor ou de seus prepostos; (ii) a dano decorrente de falha de segurança imputável ao
        Fornecedor, inclusive vazamento ou acesso não autorizado a Documentos; (iii) a violação por ele do dever de
        sigilo da seção 8; (iv) a dano à integridade física ou moral; e (v) às hipóteses em que a lei vede ou restrinja a
        limitação, notadamente quando incidir o Código de Defesa do Consumidor, cujos arts. 25 e 51, I, vedam cláusula
        que exonere ou atenue o dever de indenizar. Em qualquer dessas hipóteses a responsabilidade do Fornecedor
        observa <strong>integralmente o regime legal</strong>, inclusive quanto a lucros cessantes e perda de chance.
        Nenhuma disposição destes Termos afasta garantia legal ou direito indisponível do Assinante.
      </p>

      <h2>11. Suspensão e encerramento</h2>
      <h3>11.1. Por iniciativa do Assinante</h3>
      <p>
        O cancelamento pode ser solicitado a qualquer momento, sem multa e sem fidelidade, pelos canais da seção 17: ele
        interrompe as renovações futuras e o acesso é mantido até o fim do Ciclo já pago, na forma da{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>. O direito de arrependimento em 7 dias está
        na <Link href="/reembolso">Política de Reembolso</Link>.
      </p>
      <h3>11.2. Por inadimplência, estorno ou contestação de cobrança</h3>
      {/*
        A ressalva verdadeira sobre a exportação valia só para o encerramento (11.4),
        e a inadimplência — cenário muito mais frequente — ficava remetida à Política
        de Assinatura, que promete manter o histórico sem reserva. No sistema, vencida
        a tolerância `subscriptionGrantsAccess` devolve false (src/lib/consumption.ts)
        e `assertActiveSubscription` recusa o download de relatório, de peça e de
        documento, o envio de novos e também a CRIAÇÃO e o PROCESSAMENTO de análises
        (src/app/api/analises/route.ts, .../automatica/route.ts e .../[id]/processar).
        A visualização segue livre. Dizer menos que isso prometeria, justamente na
        hora em que o cliente vai salvar seu material, o que o sistema recusa
        (art. 30 do CDC).

        Duas ressalvas que a primeira redação omitiu e o código impõe:
        — vindo a assinatura a SUSPENSA, o próprio login é recusado com 403
          (src/app/api/auth/login/route.ts), e a SUSPENSA é o destino anunciado da
          inadimplência persistente; então nem a consulta ao histórico sobra, e a via
          real do material é o pedido de exportação;
        — o restabelecimento automático pelo pagamento é o do caminho de renovação
          (src/lib/asaas.ts grava ATIVA e limpa graceUntil). No BOLETO não há o que
          pagar depois da tolerância: `encerrarBoletosVencidos` grava CANCELADA e
          cancela a recorrência no provedor, e a retomada é nova contratação.
      */}
      <p>
        A suspensão e o encerramento por falta de pagamento seguem a{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>, com período de tolerância e aviso prévio, e o
        tratamento de estorno e <em>chargeback</em> segue a <Link href="/reembolso">Política de Reembolso</Link>.{" "}
        <strong>Durante a tolerância o acesso permanece o mesmo.</strong> Vencida a tolerância sem regularização, a{" "}
        <strong>consulta ao histórico permanece disponível</strong>, mas passam a{" "}
        <strong>depender de assinatura ativa</strong>, entre outras operações, a{" "}
        <strong>exportação de arquivos</strong> — download de relatório, de minuta e de Documentos —, o envio de novos
        Documentos e a <strong>criação e o processamento de novas Análises</strong>, na forma da seção 11.4.
        Regularizado o pagamento, o acesso e essas operações são restabelecidos automaticamente,{" "}
        <strong>salvo no pagamento por boleto</strong>: nele, vencida a tolerância, a assinatura é encerrada, e a
        retomada depende de nova contratação, na forma da{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>. Vindo a assinatura a ser{" "}
        <strong>suspensa</strong> por inadimplência persistente, a entrada na Conta passa a ser recusada, inclusive
        para consulta ao histórico, e o material é obtido pelo <strong>pedido de exportação</strong> dirigido aos canais
        da seção 17 ou ao canal de privacidade indicado na <Link href="/privacidade">Política de Privacidade</Link>,
        atendido independentemente do estado da assinatura.
      </p>
      {/*
        Transparência desconfortável, mas necessária: com assinatura em ESTORNADA ou
        SUSPENSA o LOGIN é recusado (403), então o titular não entra nem para o
        histórico nem para a exportação. Omitir isso e ao mesmo tempo prometer
        exercício de direitos criaria contradição com o art. 18 da LGPD; declarado, o
        canal de privacidade é a via alternativa — e o dono pode decidir mudar o
        comportamento do código.

        A privação de acesso precisa ter TERMO FINAL: suspensão por tempo
        indeterminado, cujo fim depende só da diligência do fornecedor, é vantagem
        exagerada (art. 51, IV, do CDC) e esvazia o prazo do art. 19, §2º, da LGPD. O
        prazo não é digitado aqui — ele mora na Política de Cancelamento e Retenção,
        e repeti-lo neste texto criaria dois números para a mesma coisa. A REGRA da
        prorrogação também não é reescrita aqui: escrita nos dois documentos, ela era
        somada na leitura literal (10 + 10 pela Política, mais uma por estes Termos).

        ── Esta cláusula ganhou mecanismo ─────────────────────────────────────────
        O restabelecimento por decurso do prazo era promessa sem implementação: nada
        media o prazo, e a única ferramenta do painel ("reativar") gravava ATIVA e
        ESTENDIA o período por um ciclo inteiro — usá-la aqui daria ao cliente um mês
        de graça e faria a data da próxima cobrança mentir. Agora existe
        `src/lib/revisao-contestacao.ts`: a manutenção diária mede o prazo em dias
        úteis e restabelece o acesso sozinha quando ele vence sem decisão, sem tocar em
        `currentPeriodEnd`; o painel mostra a data do vencimento na linha da assinatura
        e oferece "Restabelecer acesso" e "Prorrogar revisão". O prazo desta cláusula e
        o que o sistema aplica saem da MESMA constante.
      */}
      <p>
        Recebido evento de estorno ou de contestação de cobrança, a assinatura é suspensa e{" "}
        <strong>o acesso à Conta fica indisponível durante a revisão administrativa</strong>, inclusive para consulta ao
        histórico. A revisão observa o <strong>prazo máximo</strong> previsto na{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>, inclusive a prorrogação que ela admite;{" "}
        <strong>esgotado o prazo sem decisão comunicada, o acesso é restabelecido</strong> até que a decisão seja
        proferida, ressalvada a hipótese de fraude apurada. Nessa
        situação, o exercício de direitos sobre dados pessoais — inclusive o pedido de cópia dos dados — permanece
        assegurado pelo canal de privacidade indicado na <Link href="/privacidade">Política de Privacidade</Link>,
        independentemente do acesso ao sistema.
      </p>
      <h3>11.3. Por uso vedado, fraude, conteúdo ilícito ou ordem judicial</h3>
      <p>
        O Fornecedor pode suspender ou encerrar o acesso quando verificar violação da seção 7, fraude, tentativa de
        burlar controles de segurança ou de pagamento, envio de conteúdo manifestamente ilícito, uso que comprometa a
        estabilidade do serviço para os demais assinantes, ou por determinação legal ou judicial. O{" "}
        <strong>procedimento e os prazos</strong> de apuração, aviso, limitação, suspensão e reexame estão na{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>; os{" "}
        <strong>efeitos sobre os dados</strong> — exportação antes do corte, retenção, anonimização e eliminação — e as
        hipóteses de descontinuação do serviço ou de plano estão na{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>. Havendo prazos diferentes entre as duas
        para a mesma medida, <strong>prevalece o mais favorável ao Assinante</strong>. São condições de validade de
        qualquer dessas medidas:
      </p>
      <ul>
        <li>
          <strong>comunicação motivada</strong> ao Assinante, por e-mail e pelo painel, com descrição objetiva da conduta
          apurada e prazo para manifestação e para correção, quando a correção for possível;
        </li>
        <li>
          <strong>gradação</strong> das medidas, da menos restritiva à mais grave, aplicando-se a suspensão imediata sem
          aviso prévio apenas quando houver risco atual à segurança, aos dados de outros assinantes ou à integridade do
          serviço, ou quando a lei ou a ordem judicial assim exigir — hipótese em que a motivação é comunicada em
          seguida;
        </li>
        <li>
          <strong>oportunidade de exportar</strong> os dados e os arquivos das Análises antes do corte de acesso, salvo
          vedação legal ou judicial, e atendimento do pedido de cópia dos dados pelo canal de privacidade quando o corte
          já tiver ocorrido;
        </li>
        <li>
          <strong>reversibilidade</strong>: cessada a causa ou não confirmada a violação, o acesso é restabelecido sem
          custo de reativação; e
        </li>
        <li>
          <strong>direito a reexame</strong> da medida, apreciado com motivação escrita, sem prejuízo do acesso aos
          órgãos de defesa do consumidor e ao Poder Judiciário.
        </li>
      </ul>
      {/*
        Consequência patrimonial alinhada à Política de Uso Aceitável (§10.4): sem
        fraude, devolve-se o período não fruído. Retê-lo seria enriquecimento por
        rescisão de iniciativa do próprio fornecedor — desvantagem exagerada,
        art. 51, IV, do CDC.
      */}
      <p>
        Não havendo fraude nem uso ilícito comprovado, o encerramento por iniciativa do Fornecedor{" "}
        <strong>devolve ao Assinante o valor proporcional ao período contratado e não fruído</strong>, monetariamente
        atualizado. Havendo fraude ou uso ilícito comprovado, não há devolução, permanecendo assegurados a exportação dos
        dados e o pedido de reexame. <strong>Esta disposição prevalece</strong> sobre previsão em contrário dos
        documentos anexos, por ser mais favorável ao Assinante.
      </p>
      <h3>11.4. Efeitos do encerramento</h3>
      <ul>
        <li>
          cessam as renovações e o acesso a novas Análises; a <strong>consulta ao histórico</strong> segue as regras da{" "}
          <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>, que define os prazos de preservação e a
          janela de reativação;
        </li>
        <li>
          a <strong>exportação de arquivos</strong> — download de relatório, de minuta e de Documentos — depende de
          assinatura ativa, motivo pelo qual a recomendação da seção 5.3 é relevante;
        </li>
        <li>
          permanecem em vigor, após o encerramento, as cláusulas de propriedade intelectual, sigilo, proteção de dados,
          responsabilidade, foro e as demais cuja natureza pressuponha sobrevivência; e
        </li>
        <li>
          a exclusão de dados, o que é anonimizado e o que é retido por obrigação legal — inclusive registros fiscais,
          contábeis e de pagamento — seguem a{" "}
          <Link href="/cancelamento">Política de Cancelamento e Retenção</Link> e a{" "}
          <Link href="/privacidade">Política de Privacidade</Link>.
        </li>
      </ul>

      <h2>12. Vigência, alteração destes Termos e comunicação</h2>
      <p>
        Estes Termos vigoram por prazo indeterminado, a partir do aceite, enquanto houver Conta ativa ou dados do
        Assinante em tratamento. A versão vigente é a {VERSAO_DOCUMENTOS}, em vigor desde {dataBR(ATUALIZADO_EM)}, e as
        versões seguintes serão identificadas por número e data no topo desta página.
      </p>
      <p>
        O Fornecedor pode alterar estes Termos e as políticas anexas para adequação legal, evolução do serviço ou
        correção. Tratando-se de <strong>alteração relevante</strong> — a que restringe direito do Assinante, amplia
        obrigação sua, altera o objeto ou o preço aplicável a Ciclos futuros — a comunicação é feita por{" "}
        <strong>e-mail e aviso no painel, com antecedência mínima de {num(DIAS_AVISO_ALTERACAO)} dias</strong> da
        entrada em vigor.
      </p>
      <ul>
        <li>A alteração <strong>não retroage</strong> ao Ciclo já pago nem a Análises já realizadas.</li>
        <li>
          O Assinante que não concordar pode <strong>rescindir sem ônus</strong> até a entrada em vigor da nova versão,
          mantendo o acesso e as condições anteriores até o fim do Ciclo já pago.
        </li>
        <li>
          Permanecendo o uso da Plataforma após a entrada em vigor, presume-se a concordância com a nova versão, sem
          prejuízo do direito de rescindir a qualquer momento.
        </li>
        <li>
          Assinaturas em <strong>planos descontinuados</strong> conservam o preço, a cota e as condições vigentes na data
          da contratação, na forma da <Link href="/politica-de-creditos">Política de Créditos</Link>: regra nova não é
          aplicada retroativamente a quem contratou sob regra anterior.
        </li>
      </ul>

      <h2>13. Comunicações</h2>
      <p>
        O <strong>e-mail cadastrado</strong> é canal válido e suficiente para todas as comunicações destes Termos,
        inclusive avisos de cobrança, de renovação, de atraso, de alteração de documento legal, de manutenção e de
        incidente de segurança. Cabe ao Usuário mantê-lo atualizado e acessível, e verificar as pastas de spam e de
        promoções do seu provedor.
      </p>
      <ul>
        <li>
          As mensagens transacionais são enviadas por <strong>provedor de e-mail contratado</strong>, identificado na{" "}
          <Link href="/privacidade">Política de Privacidade</Link>.
        </li>
        <li>
          Avisos de cobrança podem ser enviados <strong>diretamente pela processadora de pagamento</strong>, conforme as
          regras dela.
        </li>
        <li>
          Comunicações do Assinante ao Fornecedor devem ser dirigidas aos canais da seção 17; pedidos relativos a dados
          pessoais, ao canal de privacidade da <Link href="/privacidade">Política de Privacidade</Link>.
        </li>
      </ul>

      <h2>14. Lei aplicável, solução amigável e foro</h2>
      <p>
        Estes Termos são regidos pela <strong>legislação brasileira</strong>, em especial pelo Código Civil, pelo Código
        de Defesa do Consumidor (Lei 8.078/1990), pela Lei Geral de Proteção de Dados (Lei 13.709/2018), pelo Marco Civil
        da Internet (Lei 12.965/2014), pelo Decreto 7.962/2013 e pelas Leis 9.609/1998 e 9.610/1998.
      </p>
      {/*
        Não se nega a incidência do CDC. O assinante é advogado usando insumo
        profissional, o que pela teoria finalista afastaria a qualidade de consumidor
        — mas há mitigação jurisprudencial pela vulnerabilidade técnica, e o serviço é
        ofertado publicamente. Cláusula que tentasse excluir o CDC seria nula se ele
        incidisse; assegurar as proteções como PISO CONTRATUAL vale nas duas hipóteses
        e é comercialmente melhor.
      */}
      <p>
        Independentemente da qualificação jurídica da relação, o Fornecedor assegura ao Assinante, como{" "}
        <strong>condição contratual mínima</strong>, as seguintes garantias, ainda que se venha a entender que o Código
        de Defesa do Consumidor não incide sobre a contratação por profissional no exercício da sua atividade: direito de
        arrependimento em 7 dias, informação clara e prévia, atendimento por SAC, vedação de alteração unilateral do
        preço do Ciclo pago e as limitações de responsabilidade da seção 10 apenas na extensão ali admitida.
      </p>
      <p>
        <strong>Solução amigável.</strong> As partes se comprometem a tentar resolver qualquer divergência,
        preferencialmente, pelo <strong>SAC</strong> e pelo chamado de <strong>Suporte</strong>, antes de recorrer ao
        Judiciário. A mediação é facultativa e depende de concordância de ambas as partes; a tentativa de solução
        amigável <strong>não é condição</strong> para o acesso à Justiça, que permanece franqueado a qualquer momento.
      </p>
      {/*
        Foro: o do domicílio do consumidor é irrenunciável (art. 101, I, do CDC) e
        cláusula que o afaste é abusiva. A comarca do fornecedor é indicada apenas
        como supletiva, para a hipótese de a relação ser empresarial — e a ressalva
        impede que a cláusula seja lida como renúncia.
      */}
      <p>
        <strong>Foro.</strong> Fica assegurado ao Assinante que se qualifique como consumidor o{" "}
        <strong>foro do seu domicílio</strong>, na forma do art. 101, inciso I, do Código de Defesa do Consumidor, sem
        possibilidade de renúncia. Apenas nas hipóteses em que a relação não se caracterize como de consumo, elege-se o
        foro da comarca de {FORNECEDOR.comarca}, sem prejuízo das regras legais de competência que não admitam
        derrogação por acordo entre as partes.
      </p>

      <h2>15. Disposições finais</h2>
      <ul>
        <li>
          <strong>Nulidade parcial.</strong> A eventual nulidade ou ineficácia de qualquer cláusula não invalida as
          demais, que continuam produzindo efeitos, na forma do art. 51, § 2º, do Código de Defesa do Consumidor. A
          cláusula inválida será substituída, mediante integração, por disposição que preserve a finalidade legítima
          pretendida, sem ônus excessivo a qualquer das partes.
        </li>
        <li>
          <strong>Tolerância.</strong> A tolerância com o descumprimento de qualquer obrigação não implica novação,
          renúncia, alteração do contrato ou precedente exigível: constitui liberalidade isolada, e a obrigação
          permanece exigível.
        </li>
        <li>
          <strong>Cessão.</strong> O Assinante não pode ceder sua posição contratual sem anuência escrita do Fornecedor.
          O Fornecedor pode cedê-la em caso de reorganização societária, incorporação, fusão ou transferência do
          negócio, <strong>com preservação integral das condições contratadas</strong> — preço, periodicidade, limites e
          histórico — e comunicação prévia ao Assinante, que pode rescindir sem ônus se não concordar, na forma da seção
          12.
        </li>
        <li>
          <strong>Independência das partes.</strong> Estes Termos não criam sociedade, associação, mandato, vínculo
          empregatício, representação ou responsabilidade solidária entre as partes além da expressamente prevista.
        </li>
        <li>
          <strong>Integralidade.</strong> Estes Termos e os documentos que os integram constituem o acordo integral entre
          as partes quanto ao objeto, e prevalecem sobre entendimentos anteriores, ressalvadas as informações
          publicitárias veiculadas pelo Fornecedor, que o vinculam na forma do art. 30 do Código de Defesa do
          Consumidor.
        </li>
        <li>
          <strong>Títulos.</strong> Os títulos das seções servem apenas para organizar a leitura e não limitam o
          conteúdo das cláusulas.
        </li>
      </ul>

      <h2>16. Avisos obrigatórios</h2>
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

      <h2>17. Contato</h2>
      <p>Dúvidas sobre estes Termos, sobre a contratação e sobre o uso da Plataforma:</p>
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
          <strong>E-mail:</strong> {FORNECEDOR.email}.
        </li>
        <li>
          <strong>Assuntos de dados pessoais:</strong> {FORNECEDOR.emailPrivacidade} — Encarregado:{" "}
          {FORNECEDOR.encarregado}.
        </li>
        <li>
          Clientes autenticados podem abrir um chamado em <strong>Suporte</strong> dentro da Plataforma.
        </li>
      </ul>
      <p>
        Documentos relacionados: <Link href="/privacidade">Política de Privacidade</Link>,{" "}
        <Link href="/cookies">Política de Cookies</Link>,{" "}
        <Link href="/responsabilidade">Aviso de responsabilidade jurídica</Link>,{" "}
        <Link href="/uso-aceitavel">Política de Uso Aceitável</Link>,{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>,{" "}
        <Link href="/politica-de-creditos">Política de Créditos</Link>,{" "}
        <Link href="/reembolso">Política de Reembolso</Link> e{" "}
        <Link href="/cancelamento">Política de Cancelamento e Retenção</Link>.
      </p>
    </LegalShell>
  );
}
