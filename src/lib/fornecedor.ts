/**
 * Identificação do fornecedor e versão dos documentos legais.
 *
 * ── Por que isto é uma constante, e não texto escrito em cada página ──────────
 * Oito documentos legais citam quem vende, o CNPJ, o endereço e o canal de
 * privacidade. Escrever isso em cada arquivo garante divergência: o rodapé do site
 * dizia "Leão Amorim Tecnologia" enquanto os Termos e a Política de Privacidade
 * diziam "Leão Amorim Advocacia" — duas pessoas jurídicas diferentes assinando o
 * mesmo contrato de adesão. Num contrato de consumo isso não é detalhe de estilo:
 * o art. 4º do Decreto 7.962/2013 exige a identificação inequívoca do fornecedor
 * em local de destaque, e o art. 46 do CDC afasta a obrigação do consumidor quando
 * o instrumento não permite compreender quem contratou com ele.
 *
 * ── O que significa [DEFINIR] ─────────────────────────────────────────────────
 * Os campos abaixo marcados com `DEFINIR` são dados que só o dono do negócio pode
 * preencher (razão social, CNPJ, endereço, Encarregado). Enquanto existir um só
 * pendente, TODA página legal exibe o aviso de versão preliminar — ver
 * `LegalShell`. Isso é deliberado: documento legal publicado com lacuna vale menos
 * que documento nenhum, porque cria aparência de regularidade.
 */

/** Prefixo que marca dado ainda não fornecido pelo dono do negócio. */
const MARCA_PENDENTE = "[DEFINIR";

export interface DadosFornecedor {
  /** Nome pelo qual o serviço é conhecido pelo público. */
  nomeFantasia: string;
  razaoSocial: string;
  cnpj: string;
  /** Endereço completo, exigido pelo art. 4º, I, do Decreto 7.962/2013. */
  endereco: string;
  /** Domínio oficial, sem barra final. */
  site: string;
  /** E-mail geral de contato — endereço eletrônico exigido no mesmo dispositivo. */
  email: string;
  /** Canal para exercício de direitos do titular (art. 18, §1º, da LGPD). */
  emailPrivacidade: string;
  /** Encarregado pelo tratamento de dados pessoais (art. 41 da LGPD). */
  encarregado: string;
  /** Comarca do foro indicado nos documentos, quando não for o do consumidor. */
  comarca: string;
}

export const FORNECEDOR: DadosFornecedor = {
  nomeFantasia: "Prescrição Pro",
  /**
   * O fornecedor é a empresa de TECNOLOGIA, não a sociedade de advogados.
   *
   * A distinção não é preciosismo: o art. 16 do Estatuto da Advocacia veda à
   * sociedade de advogados objeto estranho à advocacia, e a venda de licença de
   * software é atividade empresarial — mercantilização vedada pelo Código de Ética
   * e pelo Provimento CFOAB 205/2021. Os textos legais diziam "Leão Amorim
   * Advocacia" enquanto o rodapé dizia "Leão Amorim Tecnologia"; o correto, e o que
   * vale para todos os documentos, é este.
   */
  razaoSocial: "Leão Amorim Tecnologia LTDA",
  cnpj: "68.064.461/0001-61",
  endereco:
    "Avenida Mendonça Júnior, 317, Loja A, Gruta de Lourdes, Maceió/AL, CEP 57052-480",
  site: "https://prescricaopro.com.br",
  email: "contato@leaoamorimtecnologia.com.br",
  /**
   * Mesmo endereço do contato geral, por decisão do dono.
   *
   * A LGPD não exige canal separado: o art. 41, §1º, pede que a identidade e as
   * informações de contato do Encarregado sejam divulgadas publicamente e de forma
   * clara — um endereço só para privacidade é boa prática, não obrigação.
   */
  emailPrivacidade: "contato@leaoamorimtecnologia.com.br",
  encarregado: "Luis Thiago Leão Amorim — contato@leaoamorimtecnologia.com.br",
  /**
   * Sede do fornecedor. NÃO é foro de eleição contra o cliente: os documentos
   * preservam o foro do domicílio do consumidor (art. 101, I, do CDC), e cláusula
   * que o afastasse seria nula (art. 51, IV). A comarca aparece apenas para
   * qualificar a empresa e para as hipóteses em que o próprio cliente escolher
   * demandar aqui.
   */
  comarca: "Maceió, Estado de Alagoas",
};

/**
 * Versão e data dos documentos legais.
 *
 * O art. 46 do CDC exige conhecimento prévio do conteúdo; alteração unilateral sem
 * marca de versão impede o cliente de saber o que aceitou. Ao mudar qualquer texto
 * legal, suba a versão E a data — as duas aparecem no topo de cada documento.
 */
/**
 * 2.1 — Política de Créditos §7 passou a descrever a cobrança da DIFERENÇA de faixa
 * quando documentos são acrescentados a uma análise já cobrada. A regra publicada
 * permitia tratar isso como análise nova e cobrar o custo cheio; o sistema cobra só a
 * diferença, e o instrumento tem de dizer o que o sistema faz.
 *
 * 2.2 — Política de Cancelamento §6 passou a distinguir devolução PARCIAL de TOTAL. As
 * consequências automáticas publicadas (encerramento, bloqueio de créditos, acesso
 * interrompido) pressupõem devolução integral; a parcial não desfaz nada. O sistema
 * tratava as duas igual, e devolver dez reais de uma mensalidade derrubava a assinatura.
 *
 * 2.3 — Política de Créditos §10 deixou de oferecer a troca de plano como saída para
 * saldo insuficiente, e perdeu a remissão às regras de alteração de plano. Só existe
 * uma família de plano, e passar do mensal para o anual não aumenta a cota: continuam
 * os mesmos créditos por ciclo. A seção listava um remédio que não remedia nada.
 *
 * 2.4 — O e-mail do fornecedor passou a ser contato@leaoamorimtecnologia.com.br, por
 * decisão do dono, em todas as situações: contato geral, assuntos de dados pessoais e
 * endereço do Encarregado. Muda o endereço eletrônico exigido pelo art. 4º, I, do
 * Decreto 7.962/2013 e o canal do art. 41, §1º, da LGPD — o consumidor precisa saber
 * para onde escrever, então a versão sobe.
 */
export const VERSAO_DOCUMENTOS = "2.4";
export const ATUALIZADO_EM = "2026-08-11";

/** Um dado ainda não preenchido pelo dono? */
export function pendente(valor: string): boolean {
  return valor.startsWith(MARCA_PENDENTE);
}

/** Lista dos campos que faltam preencher, para o aviso e para o checklist. */
export function pendenciasDoFornecedor(): string[] {
  return Object.entries(FORNECEDOR)
    .filter(([, valor]) => typeof valor === "string" && pendente(valor))
    .map(([campo]) => campo);
}

/** Data ISO em formato brasileiro, sem passar por fuso horário. */
export function dataBR(iso: string): string {
  const [a, m, d] = iso.slice(0, 10).split("-");
  return d && m && a ? `${d}/${m}/${a}` : iso;
}

/**
 * Qualificação completa do fornecedor, para a abertura dos contratos.
 *
 * Fica aqui, e não repetida em cada documento, para que a frase de qualificação
 * seja idêntica nos oito textos — divergência entre elas é munição para alegar
 * que o instrumento não identifica a parte.
 */
export function qualificacaoFornecedor(): string {
  return (
    `${FORNECEDOR.razaoSocial}, inscrita no CNPJ sob o nº ${FORNECEDOR.cnpj}, ` +
    `com endereço em ${FORNECEDOR.endereco}, responsável pela plataforma ` +
    `${FORNECEDOR.nomeFantasia} (${FORNECEDOR.site})`
  );
}
