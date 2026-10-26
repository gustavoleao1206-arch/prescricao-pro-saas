import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell } from "@/components/marketing/legal-shell";
import { FORNECEDOR } from "@/lib/fornecedor";
import { ATENDIMENTO, linkWhatsApp } from "@/lib/contato";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Política de Cookies" };

/**
 * O texto anterior desta página anunciava “cookies opcionais”, “analíticos e de
 * preferência” e um “banner de consentimento”. Nada disso existe no sistema: há
 * uma única escrita de cookie em todo o código (`(await cookies()).set` em
 * src/lib/auth.ts) e nenhum script de terceiro. Numa política de cookies isso não
 * é imprecisão de redação — é publicidade enganosa por afirmação falsa sobre o
 * próprio tratamento (arts. 30 e 37 do CDC) e, pior, uma confissão gratuita de
 * que se coleta mais do que se coleta. O texto abaixo descreve o que o código
 * realmente faz, e transforma a ausência de rastreador em argumento.
 */

const SEGUNDOS_POR_MINUTO = 60;
const SEGUNDOS_POR_HORA = 3_600;
const SEGUNDOS_POR_DIA = 86_400;

/**
 * Nomes gravados no navegador, que esta página publica como fato verificável por
 * quem abrir as ferramentas do próprio navegador.
 *
 * ATENÇÃO — a fonte real destes nomes é o código, e ela NÃO é importável daqui:
 * `COOKIE_NAME` é constante privada de src/lib/auth.ts (repetida em
 * src/middleware.ts) e a chave do tema é constante privada de
 * src/components/ui/theme-toggle.tsx, com os valores “escuro”/“claro” também
 * escritos no script inline de src/app/layout.tsx. Renomear o cookie ou a chave é
 * decisão técnica que não quebra teste nem compilação, e deixaria esta política
 * descrevendo nome que o navegador não tem — é o único dado deste documento capaz
 * de divergir do código em silêncio (o prazo de sessão já vem de `env`, e a
 * identificação do fornecedor e os telefones vêm de constantes importadas).
 * Enquanto não existir um módulo único de nomes de armazenamento (módulo folha,
 * sem prisma, para servir também ao middleware no edge) importado por auth.ts,
 * middleware.ts, layout.tsx, theme-toggle.tsx e por estes textos, ao renomear
 * qualquer um deles corrija AQUI e na seção 13 da Política de Privacidade, que
 * repete o nome do cookie.
 */
const COOKIE_SESSAO = "ptp_session";
const CHAVE_TEMA = "ptp-tema";
const TEMA_CLARO = "claro";
const TEMA_ESCURO = "escuro";

/**
 * Prazo contratual criado por ESTA política: o aviso prévio de cookie NÃO
 * essencial e de ampliação de finalidade (seção 10). Não vale para o cookie
 * estritamente necessário exigido por segurança ou por necessidade técnica
 * imediata, que a seção 10 ressalva. Não é medido pelo sistema — é obrigação
 * assumida aqui, no mesmo prazo da seção 14 da Política de Privacidade.
 *
 * ATENÇÃO — o mesmo prazo vive numa segunda constante, `PRAZO_AVISO_ALTERACAO_DIAS`,
 * local de src/app/(marketing)/privacidade/page.tsx (seção 14). As duas não se
 * conhecem: mudar uma sem a outra torna falsa, em silêncio, a remissão “no mesmo
 * prazo … da seção 14”, e nem teste nem compilação avisam. Enquanto não existir um
 * módulo único de prazos legais importado pelas duas páginas, ajuste AQUI e lá.
 */
const DIAS_AVISO_NOVO_COOKIE = 30;

/**
 * Duração do cookie de sessão, derivada de `SESSION_MAX_AGE` (src/lib/env.ts) —
 * exatamente o valor usado no `maxAge` do cookie e na expiração gravada na tabela
 * Session. Prazo digitado no texto divergiria do prazo cobrado do navegador, e o
 * prazo publicado é o que obriga o fornecedor (art. 30 do CDC).
 *
 * Por isso esta página é renderizada em tempo de execução, e não congelada no
 * build: estática, ela publicaria o valor lido no build. `SESSION_MAX_AGE` não
 * está declarada no render.yaml nem no estágio de build do Dockerfile (que define
 * apenas DATABASE_URL e AUTH_SECRET de fachada), de modo que build e execução caem
 * hoje no mesmo padrão de 604800 segundos e coincidem — mas basta defini-la no
 * painel da Render para o texto publicado divergir do prazo que o navegador
 * recebe. Declare-a no render.yaml para que os dois nunca divirjam.
 */
export const dynamic = "force-dynamic";

function duracaoSessaoLegivel(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos <= 0) return "o prazo de sessão configurado na Plataforma";
  if (segundos % SEGUNDOS_POR_DIA === 0) {
    const dias = segundos / SEGUNDOS_POR_DIA;
    return `${dias === 1 ? "1 dia" : `${dias} dias`}, contados do login`;
  }
  if (segundos >= SEGUNDOS_POR_HORA) {
    const horas = Math.round(segundos / SEGUNDOS_POR_HORA);
    return `${horas === 1 ? "1 hora" : `${horas} horas`}, contadas do login`;
  }
  const minutos = Math.max(1, Math.round(segundos / SEGUNDOS_POR_MINUTO));
  return `${minutos === 1 ? "1 minuto" : `${minutos} minutos`}, contados do login`;
}

const DURACAO_SESSAO = duracaoSessaoLegivel(env.sessionMaxAge);

/**
 * Inventário do cookie em formato atributo/valor.
 *
 * A tabela é VERTICAL porque existe um cookie só: uma linha por atributo cabe na
 * largura do texto, imprime bem e permite descrever a finalidade em frase
 * inteira, que é o que a transparência exige. Se um dia houver um segundo cookie,
 * inverta a tabela (uma linha por cookie, uma coluna por atributo) — dois
 * inventários verticais lado a lado ficam ilegíveis.
 */
const ATRIBUTOS_COOKIE: { atributo: string; valor: React.ReactNode }[] = [
  { atributo: "Nome", valor: <code>{COOKIE_SESSAO}</code> },
  {
    atributo: "Finalidade",
    valor:
      "Manter a sessão autenticada depois do login, para que cada página da área do cliente reconheça o usuário sem pedir a senha novamente, e permitir o encerramento e a revogação desse acesso.",
  },
  {
    atributo: "Categoria",
    valor:
      "Estritamente necessário. Sem ele não existe área do cliente: não há como enviar documentos, acompanhar análises nem baixar relatórios.",
  },
  {
    atributo: "Origem",
    valor:
      "Próprio (primeira parte), definido no domínio da Plataforma. Não é cookie de terceiro: nenhum outro site o define, o lê ou o recebe, e ele não alimenta serviço externo algum. É enviado apenas aos nossos servidores, hospedados por operador nos Estados Unidos, na forma da seção 6 da Política de Privacidade.",
  },
  {
    atributo: "Conteúdo",
    valor:
      "Um identificador aleatório, sem significado fora do sistema. Não contém nome, e-mail, CPF/CNPJ, senha, dado de pagamento nem qualquer informação de processo.",
  },
  { atributo: "Duração", valor: `${DURACAO_SESSAO}.` },
  { atributo: "Sinalizadores", valor: "HttpOnly, SameSite=Lax, Path=/ e, em produção, Secure." },
  {
    atributo: "Quando é criado",
    valor:
      "Somente após login bem-sucedido — inclusive a verificação em dois fatores, quando o usuário a tiver ativado. A simples visita ao site público não cria cookie algum.",
  },
  {
    atributo: "Como é removido",
    valor:
      "Ao usar “Sair”, ao expirar o prazo acima, na redefinição da senha (que encerra as sessões abertas) ou apagando os cookies do site no navegador.",
  },
];

export default function CookiesPage() {
  return (
    <LegalShell title="Política de Cookies">
      <p>
        Esta política descreve <strong>integralmente</strong> os cookies e as tecnologias de armazenamento local
        utilizadas pelo Prescrição Pro. Ela integra os <Link href="/termos">Termos de Uso</Link> e complementa a{" "}
        <Link href="/privacidade">Política de Privacidade</Link>, que trata dos demais dados pessoais.
      </p>
      <p>
        O documento é curto no essencial porque o inventário é curto: a Plataforma utiliza{" "}
        <strong>um único cookie</strong>, estritamente necessário à autenticação, e{" "}
        <strong>nenhum cookie analítico, publicitário ou de rastreamento</strong>. É também por isso que não há banner
        de consentimento a exibir — a seção 4 explica a razão jurídica.
      </p>

      <h2>1. O que é um cookie e o que esta política cobre</h2>
      <p>
        Cookie é um pequeno arquivo de texto que o site pede ao navegador para guardar e devolver nas requisições
        seguintes, permitindo que o servidor reconheça a mesma sessão de uso de uma página para outra. Tecnologias como
        o armazenamento local (<code>localStorage</code> e <code>sessionStorage</code>) têm função parecida — guardam
        informação dentro do navegador —, com uma diferença relevante: não são enviadas automaticamente ao servidor a
        cada requisição.
      </p>
      <p>
        Esta política cobre as duas coisas, no site público e na área do cliente, e vale para qualquer navegador ou
        dispositivo pelo qual a Plataforma seja acessada.
      </p>

      <h2>2. O único cookie utilizado</h2>
      <div className="overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Atributo</th>
              <th>Descrição</th>
            </tr>
          </thead>
          <tbody>
            {ATRIBUTOS_COOKIE.map((linha) => (
              <tr key={linha.atributo}>
                <td>
                  <strong>{linha.atributo}</strong>
                </td>
                <td>{linha.valor}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>2.1. O que o cookie guarda, e o que não guarda</h3>
      <p>
        O cookie carrega apenas um <strong>token opaco</strong>: uma sequência aleatória que não revela nada por si.
        No banco de dados não guardamos esse token, e sim o resultado de uma função de resumo criptográfico (SHA-256)
        aplicada a ele — quem obtiver acesso ao banco não obtém, com isso, credenciais utilizáveis.
      </p>
      <p>
        O token corresponde a um <strong>registro de sessão</strong> que guarda data de criação, prazo de expiração,
        endereço IP e identificação do navegador (<em>user agent</em>). Esse registro é dado pessoal e está descrito na{" "}
        <Link href="/privacidade">Política de Privacidade</Link>, inclusive quanto ao prazo de conservação. A seção 9
        indica as bases legais.
      </p>
      <p>
        A existência do cookie não é, por si, autorização de acesso: a cada requisição o servidor verifica se a sessão
        existe, se não expirou, se não foi revogada e se a conta tem permissão para a operação pedida. Cada novo login
        cria uma sessão própria; a sessão de outro dispositivo continua válida até expirar ou ser revogada.
      </p>

      <h3>2.2. Proteções aplicadas ao cookie</h3>
      <ul>
        <li>
          <strong>HttpOnly</strong> — o cookie não é acessível a JavaScript na página, o que reduz o risco de furto do
          acesso por injeção de script.
        </li>
        <li>
          <strong>SameSite=Lax</strong> — o cookie não é enviado nas requisições que outros sites disparam em segundo
          plano (scripts, imagens e chamadas embutidas, entre outras), nem no envio de formulário partido de outro site,
          o que mitiga requisição forjada entre sites (CSRF): partindo a requisição de outro site, o cookie só a
          acompanha quando ela é a navegação de topo que leva você diretamente ao nosso domínio. Nas páginas do próprio
          domínio, ele acompanha as requisições normalmente — é assim que cada página reconhece a sessão.
        </li>
        <li>
          <strong>Secure em produção</strong> — no ambiente publicado o cookie só é transmitido por conexão cifrada
          (HTTPS).
        </li>
        <li>
          <strong>Revogação</strong> — o encerramento pelo botão “Sair” e a redefinição da senha invalidam a sessão no
          servidor, e não apenas no navegador.
        </li>
      </ul>

      <h2>3. O que a Plataforma não utiliza</h2>
      <p>Declaramos expressamente que a Plataforma não emprega:</p>
      <ul>
        <li>cookie analítico, de audiência ou de medição de comportamento de navegação;</li>
        <li>cookie de publicidade, de remarketing ou de mensuração de campanha;</li>
        <li>cookie de rastreamento entre sites ou entre dispositivos, nem identificador publicitário;</li>
        <li>cookie ou plugin de rede social, botão de compartilhamento com rastreamento, nem pixel de conversão;</li>
        <li>
          impressão digital de dispositivo (<em>fingerprinting</em>) ou qualquer técnica de identificação que substitua
          cookie;
        </li>
        <li>ferramenta de análise de sessão, mapa de calor ou gravação de tela.</li>
      </ul>
      <p>
        Não há script, pixel ou fonte tipográfica carregados de servidor de terceiro nas páginas da Plataforma: as
        fontes são hospedadas no próprio domínio, de modo que abrir uma página não gera requisição a terceiro capaz de
        registrar o seu endereço IP por esse caminho. <strong>Não vendemos dados pessoais</strong> e não os
        compartilhamos com terceiro para finalidade publicitária ou de perfilamento comercial.
      </p>
      <p>
        Como não existe rastreamento, sinais de preferência do navegador do tipo <em>Do Not Track</em> ou{" "}
        <em>Global Privacy Control</em> não têm coleta a suprimir — não há o que desativar.
      </p>
      {/*
        Ressalva deliberada: “não usar rastreador” é frequentemente lido pelo
        cliente como “nada é registrado”, o que seria falso — o login e o
        formulário de contato gravam IP. Dizer isso aqui, em vez de deixar o
        cliente descobrir na Política de Privacidade, evita a alegação de
        informação parcial (art. 6º, VI, da LGPD).
      */}
      <p>
        Registro de segurança não é rastreamento publicitário, mas também não é nada: o <strong>login</strong> é
        registrado com endereço IP e identificação do navegador (<em>user agent</em>), assim como{" "}
        <strong>cada download de documento, de relatório e de peça</strong>; e o envio do{" "}
        <strong>formulário público de contato</strong> é registrado com o endereço IP, sem a identificação do navegador,
        para conter abuso do formulário. Esses e os demais registros da trilha de auditoria, com suas finalidades e seus
        prazos, constam da <Link href="/privacidade">Política de Privacidade</Link>.
      </p>

      <h2>4. Por que não há banner de consentimento</h2>
      <p>
        O cookie da seção 2 é <strong>necessário à prestação do serviço que o próprio titular pediu</strong>: sem ele
        não há autenticação e a área do cliente não funciona. O tratamento se apoia na{" "}
        <strong>execução do contrato</strong> (art. 7º, V, da LGPD) e, quanto à proteção da sessão contra uso indevido,
        no <strong>legítimo interesse</strong> (art. 7º, IX, combinado com o art. 10 da LGPD). Nenhuma dessas
        hipóteses depende de consentimento.
      </p>
      <p>
        Exibir banner pedindo consentimento para cookie sem o qual o serviço não existe seria pior que inútil. O
        consentimento tem de ser <strong>livre, informado e para finalidade determinada</strong> (art. 8º da LGPD), e
        autorização genérica é nula (art. 8º, §4º). Onde a recusa não é opção real, não há liberdade — o “aceito”
        colhido nessas condições não produz efeito jurídico e apenas induz o titular a acreditar que decidiu algo que
        não decidiu.
      </p>
      <p>
        Dispensa de consentimento, porém, não é dispensa de informação: os arts. 6º, VI, e 9º da LGPD e o art. 7º,
        VIII, da Lei 12.965/2014 (Marco Civil da Internet) exigem informação clara e de acesso facilitado sobre o
        tratamento. É exatamente a função desta página, e a razão de ela publicar um inventário completo em vez de uma
        caixa de aviso. Esse desenho acompanha a orientação da Autoridade Nacional de Proteção de Dados sobre cookies:
        os necessários dispensam consentimento; os demais exigem consentimento prévio — e destes não temos nenhum.
      </p>

      <h2>5. Armazenamento local no navegador</h2>
      <p>
        A Plataforma guarda <strong>uma</strong> informação em <code>localStorage</code>: a chave{" "}
        <code>{CHAVE_TEMA}</code>, com o valor <code>{TEMA_CLARO}</code> ou <code>{TEMA_ESCURO}</code>, correspondente
        ao tema escolhido pelo usuário no botão de alternância. Ela existe para aplicar o tema antes da primeira pintura
        da página, evitando a troca visível de cores no carregamento.
      </p>
      <ul>
        <li>
          <strong>Não é cookie</strong> e <strong>não é enviada ao servidor</strong>: fica no seu navegador e não chega
          aos nossos sistemas.
        </li>
        <li>Não identifica ninguém, nem sozinha nem combinada com outro dado, e não registra navegação.</li>
        <li>
          Permanece até que você limpe os dados do site no navegador. Em janela privativa, ou quando o armazenamento
          local está indisponível, a escolha vale apenas naquela janela.
        </li>
        <li>
          Não utilizamos <code>sessionStorage</code>, banco de dados no navegador (<code>IndexedDB</code>) nem
          armazenamento em Flash ou equivalente.
        </li>
      </ul>
      <p>
        Quando não há preferência salva, o navegador é consultado sobre o tema do sistema operacional para escolher
        entre claro e escuro. Essa consulta ocorre no seu dispositivo, não é transmitida à Plataforma e não é
        registrada — não a usamos para identificar você.
      </p>

      <h2>6. Cookies de serviços de terceiros acessados a partir da Plataforma</h2>
      <p>
        A Plataforma não insere cookie de terceiro em suas próprias páginas. Alguns passos do serviço, porém, levam
        você a domínio de terceiro, onde valem os cookies e a política desse terceiro, não esta:
      </p>
      <ul>
        <li>
          o <strong>ambiente de pagamento da processadora</strong>, no qual os dados de pagamento são informados
          diretamente a ela e não transitam pela Plataforma (ver a{" "}
          <Link href="/politica-de-assinatura">Política de Assinatura</Link>);
        </li>
        <li>
          os <strong>canais de atendimento por WhatsApp</strong> indicados na seção 11 e na página de{" "}
          <Link href="/contato">Contato</Link>;
        </li>
        <li>qualquer outro site externo eventualmente indicado por link na Plataforma.</li>
      </ul>
      {/*
        O link para um agente de IA hospedado em serviço de terceiro, que existia na tela de análise
        manual, foi removido — com ele foi embora o único caminho em que o assinante
        levaria conteúdo de processo a serviço de terceiro. Os dois primeiros itens
        acima são os que restam, e ambos são inevitáveis: pagamento e atendimento.
        O terceiro item fica como regra geral, não como anúncio de funcionalidade.
      */}
      <p>
        Não recebemos, não lemos e não cruzamos o que esses terceiros armazenem no seu navegador. A ida a esses
        domínios acontece por ação sua, e a política aplicável é a de cada um deles.
      </p>

      <h2>7. Como bloquear, apagar ou encerrar</h2>
      <p>
        Todos os navegadores atuais (Chrome, Firefox, Safari e Edge, entre outros) permitem, na área de privacidade das
        configurações, bloquear cookies de um site, apagar os cookies já gravados e limpar o armazenamento local. Essa
        decisão é sua e não depende de pedido a nós.
      </p>
      <p>
        <strong>Consequência do bloqueio:</strong> com o cookie <code>{COOKIE_SESSAO}</code> bloqueado ou recusado,{" "}
        <strong>não é possível permanecer autenticado</strong>. A senha é aceita, mas a página seguinte já não
        reconhece a sessão e devolve à tela de acesso. Não oferecemos alternativa a esse mecanismo: transportar
        identificador de sessão no endereço da página o exporia no histórico do navegador, em registros de servidor e
        em qualquer link compartilhado, o que seria menos seguro para você.
      </p>
      <p>
        O <strong>site público</strong> — páginas institucionais, planos, documentos legais e o formulário de contato —
        funciona integralmente com cookies bloqueados. Em janela privativa ou anônima, o cookie é descartado ao fechar
        a janela: cada uso exige novo login, e a preferência de tema não persiste.
      </p>
      <p>
        Apagar o cookie no navegador remove a credencial <em>daquele</em> dispositivo, mas não encerra a sessão no
        servidor, que segue válida até o prazo da seção 2. Para encerrá-la de fato, use <strong>“Sair”</strong> na área
        do cliente — recomendação que vale sobretudo em computador compartilhado. Suspeita de acesso indevido deve ser
        comunicada de imediato pelos canais da seção 11, para revogação das sessões e troca de senha.
      </p>

      <h2>8. Compromisso quanto a cookies não essenciais</h2>
      <p>
        Enquanto esta versão estiver publicada, o inventário da seção 2 é <strong>exaustivo</strong>: não há outro
        cookie em uso, ativo ou inativo. Se um dia a Plataforma adotar cookie ou tecnologia semelhante não essencial —
        analítico, de personalização não indispensável, publicitário ou de qualquer outra natureza —, assumimos, desde
        já, que:
      </p>
      <ul>
        <li>
          nada será ativado antes de <strong>consentimento prévio, livre, específico e destacado</strong>, colhido por
          mecanismo próprio e nunca por aceitação presumida, rolagem de página ou silêncio;
        </li>
        <li>
          <strong>nenhum cookie não essencial vem habilitado por padrão</strong>, e recusar não restringirá o acesso ao
          serviço contratado: não usaremos bloqueio de conteúdo condicionado à aceitação;
        </li>
        <li>
          o consentimento poderá ser <strong>revogado a qualquer momento</strong>, por procedimento gratuito e
          facilitado, com a mesma facilidade com que foi concedido (art. 8º, §5º, da LGPD);
        </li>
        <li>
          esta política será atualizada <strong>antes</strong> da ativação, com nova versão, nova data e o inventário
          ampliado, na forma da seção 10.
        </li>
      </ul>

      <h2>9. Base legal, dados pessoais e direitos do titular</h2>
      <p>
        O cookie em si não identifica você fora do sistema, mas o registro de sessão a que ele corresponde é dado
        pessoal. As bases legais são:
      </p>
      <ul>
        <li>
          <strong>execução de contrato</strong> (art. 7º, V, da LGPD), para criar e manter a sessão autenticada;
        </li>
        <li>
          <strong>legítimo interesse</strong> (art. 7º, IX, e art. 10 da LGPD), para segurança do acesso, detecção de
          uso indevido e prevenção a fraude;
        </li>
        <li>
          <strong>cumprimento de obrigação legal</strong> (art. 7º, II, da LGPD) quanto à guarda de registros de
          acesso, que o art. 15 da Lei 12.965/2014 impõe pelo prazo mínimo de seis meses, sob sigilo.
        </li>
      </ul>
      <p>
        Você pode exercer os direitos do art. 18 da LGPD — confirmação da existência de tratamento, acesso, correção,
        anonimização, bloqueio ou eliminação de dado desnecessário ou excessivo, portabilidade e informação sobre
        compartilhamento — pelos canais da seção 11. O procedimento, os prazos de resposta e as hipóteses em que a
        conservação é obrigatória estão na <Link href="/privacidade">Política de Privacidade</Link>.
      </p>
      {/*
        Ressalva necessária: o encerramento da sessão é imediato, mas o REGISTRO
        da sessão (data, IP, user agent) é log de segurança e permanece pelos
        prazos da Política de Privacidade. Prometer eliminação imediata do
        registro junto com o cookie criaria obrigação que o sistema não cumpre.
      */}
      <p>
        Encerrar a sessão apaga o cookie e invalida o acesso; o registro correspondente, por ser log de segurança e
        objeto de guarda obrigatória, é conservado pelos prazos indicados na Política de Privacidade.
      </p>

      <h2>10. Alterações desta política</h2>
      <p>
        A versão e a data de vigência aparecem no início desta página, para que se possa saber a qualquer momento qual
        texto está em vigor e o que foi aceito (art. 46 do CDC). A inclusão de cookie não essencial ou de outra
        tecnologia de armazenamento não essencial, bem como a ampliação da finalidade do cookie da seção 2,{" "}
        <strong>é comunicada previamente</strong>, por aviso na área do cliente ou por e-mail, com antecedência mínima de{" "}
        {DIAS_AVISO_NOVO_COOKIE} dias em relação à sua vigência — no mesmo prazo e pelos mesmos canais da seção 14 da{" "}
        <Link href="/privacidade">Política de Privacidade</Link> — e por publicação desta nova versão nesta página, com a
        mesma antecedência, para quem não é assinante. Quando a hipótese depender de consentimento, nada é ativado antes
        de colhê-lo na forma da seção 8. Cookie estritamente necessário exigido por segurança ou por necessidade técnica
        imediata — um token de proteção contra requisição forjada entre sites, por exemplo — pode entrar em uso a partir
        da publicação desta página com o inventário da seção 2 já atualizado, sem a antecedência acima, sendo a inclusão
        comunicada em seguida pelos canais deste parágrafo. Correção de redação e esclarecimento que não altere o
        tratamento passam a valer na publicação.
      </p>
      <p>
        A continuidade do uso <strong>não supre</strong> a comunicação prévia exigida acima. Discordando da nova versão,
        o assinante pode cancelar a assinatura na forma da{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>, sem ônus adicional pelo cancelamento, e
        pedir a exclusão dos dados na forma da <Link href="/privacidade">Política de Privacidade</Link>. Conservamos as
        versões anteriores desta política e as fornecemos a pedido, pelo canal da seção 11.
      </p>

      <h2>11. Contato</h2>
      <p>Dúvidas sobre esta política, sobre o cookie descrito na seção 2 ou sobre o exercício de direitos:</p>
      <ul>
        <li>
          <strong>Canal de privacidade:</strong> {FORNECEDOR.emailPrivacidade}.
        </li>
        <li>
          <strong>Encarregado pelo tratamento de dados pessoais</strong> (art. 41, §1º, da LGPD):{" "}
          {FORNECEDOR.encarregado}.
        </li>
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
        Documentos relacionados: <Link href="/privacidade">Política de Privacidade</Link>,{" "}
        <Link href="/termos">Termos de Uso</Link> e{" "}
        <Link href="/politica-de-assinatura">Política de Assinatura</Link>.
      </p>
    </LegalShell>
  );
}
