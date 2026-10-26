import type { Metadata } from "next";
import {
  CREDITOS_MENSAIS,
  LIMITE_MB_ARQUIVO,
  PLANOS,
  VALIDADE_CREDITO_ADICIONAL_DIAS,
  VALOR_UNITARIO_CREDITO_CENTS,
  precoBR,
} from "@/lib/planos";
import { FAIXAS_CUSTO, MAX_PAGINAS_AUTOMATICO } from "@/lib/credits";
import { formatosAceitos } from "@/lib/documents";

export const metadata: Metadata = { title: "Perguntas frequentes" };

/**
 * O limite de arquivo e os formatos são lidos do sistema, não escritos aqui.
 *
 * O FAQ é publicidade e vincula o fornecedor (arts. 30 e 37 do CDC), e era o texto
 * mais desatualizado do site: prometia DOCX e planilhas que a extração não lê,
 * "links temporários autenticados" que não existem, "prioridade do plano" que os dois
 * planos têm igual, e renovação sem a ressalva de que o PIX não renova. Cada resposta
 * abaixo traz, em comentário, o que estava errado — para a próxima edição não
 * reintroduzir.
 *
 * Cota, preço e validade de crédito NÃO são escritos aqui: vêm de `@/lib/planos` e
 * `@/lib/credits`. A oferta já foi sem limite e voltou a ter cota mensal; quando isso
 * mudar de novo, o número muda no catálogo e este texto acompanha sozinho.
 */
const ROTULO_MIME: Record<string, string> = {
  "application/pdf": "PDF",
  "image/png": "PNG",
  "image/jpeg": "JPEG",
};

const FORMATOS = formatosAceitos()
  .map((m) => ROTULO_MIME[m])
  .filter((r): r is string => Boolean(r))
  .join(", ");

const MENSAL = PLANOS.find((p) => p.period === "MENSAL");
const ANUAL = PLANOS.find((p) => p.period === "ANUAL");

const num = (n: number) => n.toLocaleString("pt-BR");

/**
 * A unidade cobrada é o CRÉDITO, não a análise.
 *
 * Enquanto a oferta era sem limite, a faixa de páginas só interessava ao limite
 * técnico. Com cota mensal ela virou preço: anunciar a cota em "análises por mês"
 * sem dizer que processo grande consome mais de um crédito seria promessa de
 * quantidade que o sistema não entrega. As faixas vêm do motor de créditos.
 */
const PRIMEIRA_FAIXA = FAIXAS_CUSTO[0];
const FAIXAS_EM_CREDITOS = FAIXAS_CUSTO.map(
  (f) => `${f.creditos} ${f.creditos === 1 ? "crédito" : "créditos"} até ${num(f.atePaginas)} páginas`,
).join("; ");

const FAQ = [
  {
    // Dizia "links temporários autenticados": não há URL assinada nem expiração. O
    // arquivo é servido por rota que confere o dono e faz stream — descrição
    // verdadeira e igualmente forte.
    q: "Meus documentos ficam seguros?",
    a: "Sim. Os arquivos ficam em armazenamento privado, sem indexação pública e sem URL de acesso direto: o download passa por rota autenticada que confere o dono e a organização antes de entregar o arquivo. Cada acesso é registrado em trilha de auditoria, com autor, data, endereço IP e navegador.",
  },
  {
    q: "Os dados são confidenciais?",
    a: "Sim. Há isolamento por usuário e organização, criptografia em trânsito e dos campos sensíveis do cadastro, autenticação em duas etapas disponível e política de retenção e exclusão publicada. O reconhecimento de texto de documento digitalizado roda no nosso próprio servidor, sem enviar o arquivo a serviço de terceiro.",
  },
  {
    // Prometia DOCX, imagens e "planilhas quando necessário". O envio só aceita o
    // que a extração realmente lê — planilha e DOCX gerariam análise sobre nada.
    q: "Quais formatos de arquivo são aceitos?",
    a: `${FORMATOS}. O processo deve ser enviado em PDF: imagem é aceita como documento complementar, mas não passa por reconhecimento de texto e é sinalizada como ilegível. PDF de cópia digitalizada é processado com reconhecimento óptico automático.`,
  },
  {
    // Dizia que o limite "depende do seu plano e da configuração do administrador".
    // Não depende do plano, e o número vinha de exemplo entre parênteses.
    //
    // O TAMANHO do arquivo continua igual em todos os planos; o que a cota mensal
    // acrescentou é que o número de páginas define quantos créditos a análise
    // consome — por isso a tabela de faixas passou a ser dita aqui.
    q: "Qual o limite de tamanho?",
    a: `Um arquivo PDF de até ${LIMITE_MB_ARQUIVO} MB por análise, com no máximo ${num(MAX_PAGINAS_AUTOMATICO)} páginas — o mesmo limite em todos os planos. O número de páginas define quanto a análise consome da sua cota: ${FAIXAS_EM_CREDITOS}. Processo mais pesado costuma trazer anexos de mídia: exporte o PDF sem eles ou divida o processo em partes. Acima de ${num(MAX_PAGINAS_AUTOMATICO)} páginas o processamento automático é recusado, sem cobrança e sem consumo de crédito, e o caso é tratado como análise especial pelo atendimento.`,
  },
  {
    // "conforme a prioridade do plano": os dois planos vigentes têm a mesma
    // prioridade de processamento. Não há diferencial a anunciar.
    q: "Quanto tempo demora a análise?",
    a: "Em geral poucos minutos, conforme o número de páginas do processo, e você acompanha cada etapa na tela. Não há fila preferencial entre planos: o tempo depende do documento, não do valor pago.",
  },
  {
    q: "Qual a diferença entre prescrição e decadência?",
    a: "Decadência é a perda do direito de o Fisco constituir o crédito (arts. 173 e 150, §4º, do CTN). Prescrição é a perda do direito de cobrar o crédito já constituído (art. 174 do CTN). A prescrição intercorrente é a que corre dentro da execução fiscal já ajuizada (art. 40 da Lei 6.830/1980 e Temas 566 a 571 do STJ).",
  },
  {
    // Pergunta nova. A análise é DIRIGIDA a uma matéria escolhida no envio, e o
    // silêncio do relatório sobre as outras não é conclusão negativa — a confusão
    // mais provável de quem lê o resultado.
    //
    // Dizia "nos planos vigentes, sem custo adicional": era verdade só enquanto a
    // oferta era sem limite. Com cota, a segunda matéria do MESMO processo é uma
    // análise nova e consome crédito como qualquer outra — o cliente precisa saber
    // disso antes de enviar, não depois de ver o saldo cair.
    q: "A análise examina prescrição e decadência de uma vez?",
    a: "Não. Cada análise responde à matéria escolhida no envio: prescrição ordinária, prescrição intercorrente ou decadência. O relatório trata dessa matéria, e o silêncio sobre as demais não significa que foram examinadas e afastadas. Para examinar outra matéria do mesmo processo, faça outra análise: ela consome crédito como qualquer outra, ainda que se trate do mesmo processo já enviado.",
  },
  {
    q: "O resultado substitui o advogado?",
    a: "Não. A ferramenta é de apoio. Toda análise e toda minuta devem ser conferidas contra os autos e revisadas por advogado(a) habilitado(a) antes de qualquer uso processual. A plataforma não controla prazos processuais nem emite alerta de vencimento, e não há garantia de resultado judicial.",
  },
  {
    q: "Como recupero minha senha?",
    a: "Na tela de login, use “Esqueci minha senha”. Você recebe por e-mail um link temporário para redefinir.",
  },
  {
    // Pergunta nova. A oferta foi sem limite por um período e voltou a ter cota, e
    // não havia no FAQ nenhuma resposta que dissesse a quantidade incluída. Os
    // números vêm de `planos.ts` e de `credits.ts`: cota escrita à mão neste texto
    // vincula o fornecedor (arts. 30 e 37 do CDC) mesmo se o sistema disser outra.
    q: "Quantas análises estão incluídas no plano?",
    a: `${CREDITOS_MENSAIS} análises por mês, a mesma cota nos dois planos${
      MENSAL && ANUAL ? ` — ${precoBR(MENSAL.priceCents)} ao mês ou ${precoBR(ANUAL.priceCents)} ao ano` : ""
    }. A unidade cobrada é o crédito: 1 crédito equivale a uma análise de processo de até ${num(PRIMEIRA_FAIXA.atePaginas)} páginas, e processo maior consome mais de um crédito, conforme a faixa de páginas indicada na pergunta sobre limite de tamanho e detalhada na Política de Créditos. A cota não é cumulativa: o saldo do mês que não for usado expira na virada do ciclo. Se a análise falhar por problema técnico, o crédito é devolvido automaticamente. Passada a cota, é possível comprar créditos avulsos a qualquer momento.`,
  },
  {
    // Pergunta nova, e a mais importante desta revisão: anunciar a cota sem dizer
    // que existe avulso faz o teto parecer parede — o cliente entende que ficará
    // parado até a renovação. Preço, validade e a ordem de consumo (mensal primeiro)
    // são os do sistema, não escolhas de redação.
    q: "E se as análises do mês acabarem?",
    a: `Você compra créditos avulsos a ${precoBR(VALOR_UNITARIO_CREDITO_CENTS)} cada, na quantidade que precisar e a qualquer momento, pela área do cliente: a assinatura continua a mesma, sem upgrade nem troca de plano. O crédito avulso vale ${VALIDADE_CREDITO_ADICIONAL_DIAS} dias contados da liberação e atravessa a virada do ciclo, então não expira junto com o saldo mensal — o consumo tira primeiro da cota do mês, e o avulso é o último a ser usado. Quem preferir esperar recebe a cota cheia na renovação, sem custo extra. A cota existe porque cada análise tem custo de processamento: com um teto e o avulso à disposição, o plano continua barato para quem usa dentro da cota, em vez de subir de preço para todos.`,
  },
  {
    // Dizia apenas "a renovação segue a periodicidade do plano" — prometia ao
    // cliente de PIX uma renovação que o meio não permite.
    //
    // A última frase existe porque o plano anual é pago uma vez e a leitura natural
    // seria "recebo o ano inteiro de créditos de uma vez". O sistema libera por
    // ciclo mensal (`liberarCreditosDoCiclo`), inclusive no anual.
    q: "Como funciona a assinatura e a renovação?",
    a: `A compra é feita no ambiente seguro da processadora de pagamento e o acesso é liberado após a confirmação. No cartão e no boleto a assinatura renova a cada ciclo; no boleto, o acesso entra quando o banco confirma o pagamento, o que leva de 1 a 3 dias úteis. No PIX é pagamento único, sem renovação: o acesso vale o período contratado${
      MENSAL && ANUAL ? ` — ${precoBR(MENSAL.priceCents)} ao mês ou ${precoBR(ANUAL.priceCents)} ao ano` : ""
    } e encerra ao fim do prazo. Em qualquer forma de pagamento, os ${CREDITOS_MENSAIS} créditos são liberados por ciclo mensal — no plano anual também mês a mês, e não os doze meses de uma vez.`,
  },
  {
    q: "Posso cancelar?",
    a: "Sim, a qualquer momento, e o acesso é mantido até o fim do período já pago. Nos 7 primeiros dias da contratação há direito de arrependimento com devolução integral. Após estorno ou contestação de cobrança, o acesso à conta é bloqueado enquanto o caso é revisado — nesse período, o pedido de exportação dos seus dados continua sendo atendido.",
  },
  {
    q: "Meus dados podem ser excluídos?",
    a: "Sim. Você pode exportar os dados da conta a qualquer momento e pedir a exclusão pela área do cliente ou pelos canais de atendimento. Registros que a lei obriga a conservar — de pagamento e escrituração, por exemplo — são preservados sem vínculo com você, por anonimização. Os prazos de cada categoria estão na Política de Cancelamento e Retenção.",
  },
  {
    q: "Como são geradas as peças jurídicas?",
    a: "A partir das informações confirmadas na análise, e apenas quando há tese favorável. Os campos não localizados nos documentos ficam sinalizados na minuta com marcador de preenchimento. A minuta exige revisão, complementação e assinatura de advogado(a).",
  },
  {
    // Pergunta nova: é a primeira coisa que um advogado quer saber antes de subir o
    // processo de um cliente, e nenhum texto do site respondia.
    q: "Qual inteligência artificial é usada e para onde vão meus documentos?",
    a: "A análise é produzida por modelo de linguagem executado por provedor externo, com servidores nos Estados Unidos. O conteúdo enviado não é usado para treinar modelo. A Política de Privacidade nomeia o provedor, informa a base legal da transferência internacional e lista todos os operadores que tratam dados da plataforma.",
  },
];

export default function FaqPage() {
  return (
    <div className="container-page py-16">
      <span className="badge bg-marca-50 text-marca-700 dark:bg-marca-500/20 dark:text-marca-200">Dúvidas</span>
      <h1 className="mt-3 text-4xl font-bold">Perguntas frequentes</h1>
      <div className="mt-10 divide-y divide-neutro-200 rounded-2xl border border-neutro-200 bg-white">
        {FAQ.map((item) => (
          <details key={item.q} className="group p-5">
            <summary className="flex cursor-pointer list-none items-center justify-between font-medium text-marinho-700">
              {item.q}
              <span className="ml-4 text-marca-500 transition group-open:rotate-45">+</span>
            </summary>
            {/*
              16px, como nos documentos legais: é a mesma função — texto para ler
              do começo ao fim. Estava em 14px por acidente de composição, não por
              hierarquia, e o site exibia o mesmo papel em dois tamanhos conforme
              a página em que a pessoa entrasse.
            */}
            <p className="mt-3 hyphens-auto text-justify leading-relaxed text-neutro-600">{item.a}</p>
          </details>
        ))}
      </div>
    </div>
  );
}
