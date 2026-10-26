/**
 * Acesso central e tipado às variáveis de ambiente.
 * Não lança em desenvolvimento para não travar o boot; valida o essencial e
 * expõe helpers para integrações opcionais.
 */

/**
 * ⚠️ `server-only` É A TRAVA. Este arquivo NUNCA pode chegar ao navegador.
 *
 * E já chegou: por uma cadeia de imports iniciada num componente de tela, o objeto inteiro de variáveis
 * de ambiente foi empacotado no JavaScript público. Nenhum segredo vazou naquele momento — o Next
 * substitui `process.env` por objeto vazio no navegador —, mas TODO VALOR PADRÃO ESCRITO AQUI vai junto,
 * porque valor padrão é texto no código, não variável de ambiente. Era assim que a chave do DataJud
 * saía no pacote.
 *
 * Com esta linha, qualquer import a partir de código de navegador quebra o build.
 */
import "server-only";

function get(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function requireInProduction(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    // Falha explícita em produção evita subir a app sem segredos essenciais.
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value ?? "";
}

export const env = {
  nodeEnv: get("NODE_ENV", "development"),
  isProd: get("NODE_ENV") === "production",
  appName: get("APP_NAME", "Prescrição Pro"),
  appUrl: get("APP_URL", "http://localhost:3000"),

  /**
   * AGENTE_URL foi REMOVIDA.
   *
   * Apontava para um agente de IA hospedado em serviço de terceiro, linkado na tela de análise
   * manual. Era o único caminho do sistema em que o conteúdo do processo saía da
   * plataforma sem passar pelo nosso tratamento: fora do armazenamento privado, fora
   * da trilha de auditoria e fora do contrato de operador descrito na Política de
   * Privacidade. Removida por decisão do dono; se a variável ainda existir no
   * ambiente, é ignorada.
   */

  databaseUrl: requireInProduction("DATABASE_URL"),

  authSecret: requireInProduction("AUTH_SECRET") || "dev-secret-nao-use-em-producao",
  sessionMaxAge: Number(get("SESSION_MAX_AGE", "604800")),
  /**
   * Minutos de INATIVIDADE que encerram a sessão. Zero desliga a regra.
   *
   * Diferente de `sessionMaxAge`, que é o prazo absoluto (7 dias): este mede quanto tempo
   * faz que ninguém usa. É o que protege a tela logada deixada aberta — o computador do
   * escritório com autos de execução fiscal na frente de quem passar.
   */
  sessionIdleMinutes: Number(get("SESSION_IDLE_MINUTES", "30")),
  /**
   * Idem, para quem é da EQUIPE — administrador, revisor e suporte. Decisão do dono: prazo
   * mais curto que o do cliente.
   *
   * O que separa os dois é de quem são os dados na tela. O cliente vê os PRÓPRIOS processos;
   * a equipe vê os de OUTRAS pessoas — o revisor lê os autos inteiros, o suporte lê o chamado,
   * e do painel de administração se apaga conta, se libera acesso à mão, se ajusta crédito e
   * se encerra caso de dinheiro. Tela de equipe esquecida aberta expõe dado de terceiro
   * coberto por sigilo profissional.
   */
  sessionIdleMinutesEquipe: Number(get("SESSION_IDLE_MINUTES_EQUIPE", "10")),
  fieldEncryptionKey: get("FIELD_ENCRYPTION_KEY", ""),

  ai: {
    provider: get("AI_PROVIDER", "anthropic") as "anthropic" | "openai",
    anthropicKey: get("ANTHROPIC_API_KEY"),
    anthropicModel: get("ANTHROPIC_MODEL", "claude-sonnet-5"),
    openaiKey: get("OPENAI_API_KEY"),
    openaiModel: get("OPENAI_MODEL", "gpt-4o"),
    maxOutputTokens: Number(get("AI_MAX_OUTPUT_TOKENS", "4000")),
    /**
     * Teto de caracteres do que vai no pedido. Existe por causa do limite de
     * tokens por minuto (TPM) do provedor: conta nova na OpenAI entra no Tier 1,
     * com 30 mil TPM, e o pedido inteiro — prompt + base + documento + reserva
     * de saída — tem de caber nisso, senão volta 429 e a análise cai para o
     * modo heurístico.
     *
     * Orçamento com os padrões abaixo, a ~4 caracteres por token:
     *   base de conhecimento  40.000 car. ≈ 10.000 tokens
     *   documento             45.000 car. ≈ 11.250 tokens
     *   prompt + instruções             ≈  2.500 tokens
     *   reserva de saída                =  4.000 tokens
     *                                    ≈ 27.750 tokens  (cabe em 30.000)
     *
     * Ao subir de tier no provedor (a OpenAI aumenta conforme o gasto
     * acumulado), levante estes valores para a IA ler mais do processo.
     */
    maxKnowledgeChars: Number(get("AI_MAX_KNOWLEDGE_CHARS", "40000")),
    maxCorpusChars: Number(get("AI_MAX_CORPUS_CHARS", "45000")),
    /**
     * Cache de prompt (Anthropic). O prompt de sistema (metodologia + base de
     * conhecimento) é idêntico em toda análise, então é cacheável — MAS a
     * gravação do cache custa 1,25x e a validade é de ~5 min. Só compensa
     * quando 2+ análises rodam na mesma janela; com uso esporádico, ENCARECE.
     * Ligue (AI_PROMPT_CACHE=true) após medir o padrão real de uso.
     */
    promptCache: get("AI_PROMPT_CACHE", "false") === "true",
  },

  /**
   * OCR de PDF digitalizado (Ghostscript + Tesseract).
   *
   * Depende de dois binários externos; quando faltam, a extração segue sem OCR
   * e o documento é sinalizado como digitalizado. Instalação no macOS:
   *   brew install ghostscript tesseract tesseract-lang
   */
  ocr: {
    enabled: get("OCR_ENABLED", "true") === "true",
    lang: get("OCR_LANG", "por"),
    dpi: Number(get("OCR_DPI", "300")),
    /** Teto de páginas por documento — cada uma custa ~1-2s de processamento. */
    maxPaginas: Number(get("OCR_MAX_PAGINAS", "200")),
    /**
     * Páginas transcritas em paralelo. O Tesseract é um processo por página;
     * em série, um processo de 166 páginas leva minutos só de OCR. O padrão 4
     * corta esse tempo para ~1/4 sem saturar a máquina.
     */
    concorrencia: Math.max(1, Math.min(8, Number(get("OCR_CONCORRENCIA", "4")))),
    ghostscriptBin: get("OCR_GHOSTSCRIPT_BIN", "gs"),
    tesseractBin: get("OCR_TESSERACT_BIN", "tesseract"),
  },

  storage: {
    driver: get("STORAGE_DRIVER", "local") as "local" | "s3",
    localDir: get("STORAGE_LOCAL_DIR", "./storage"),
    endpoint: get("S3_ENDPOINT"),
    region: get("S3_REGION"),
    bucket: get("S3_BUCKET"),
    accessKeyId: get("S3_ACCESS_KEY_ID"),
    secretAccessKey: get("S3_SECRET_ACCESS_KEY"),
    signedUrlTtl: Number(get("STORAGE_SIGNED_URL_TTL", "300")),
  },

  email: {
    driver: get("EMAIL_DRIVER", "console") as "console" | "resend" | "smtp",
    from: get("EMAIL_FROM", "Prescrição Pro <no-reply@localhost>"),
    /**
     * Destino dos ALERTAS OPERACIONAIS — dinheiro que entrou sem conta
     * identificável, cobrança recebida depois do cancelamento, e o que mais o
     * sistema não pode resolver sozinho.
     *
     * Vazia, o alerta vai para o contato público do fornecedor. Nunca fica sem
     * destino: aviso que não sai da máquina é o mesmo que aviso nenhum, e foi
     * assim que um pagamento real ficou horas sem ninguém saber. Ver
     * src/lib/alerta-operacional.ts.
     */
    operacao: get("OPERACAO_EMAIL"),
    resendKey: get("RESEND_API_KEY"),
    smtp: {
      host: get("SMTP_HOST"),
      port: Number(get("SMTP_PORT", "587")),
      user: get("SMTP_USER"),
      password: get("SMTP_PASSWORD"),
    },
  },

  asaas: {
    // Chave de API (header `access_token` em toda chamada). Sandbox e produção
    // têm chaves diferentes — usar a chave de um ambiente com a URL do outro
    // retorna erro de autenticação.
    apiKey: get("ASAAS_API_KEY"),
    // Token que você define ao criar o webhook no Asaas; o Asaas o reenvia no
    // header `asaas-access-token` de cada evento, e é assim que provamos que a
    // requisição veio mesmo do Asaas. Sem ele, o webhook recusa tudo.
    webhookToken: get("ASAAS_WEBHOOK_TOKEN"),
    // "sandbox" (teste, sem cobrança real) ou "production".
    ambiente: get("ASAAS_ENV", "sandbox") as "sandbox" | "production",
    // URL base da API conforme o ambiente. Override explícito só se o Asaas
    // mudar o domínio — o padrão cobre os dois ambientes atuais.
    apiBaseUrl:
      get("ASAAS_API_BASE_URL") ||
      (get("ASAAS_ENV", "sandbox") === "production"
        ? "https://api.asaas.com/v3"
        : "https://api-sandbox.asaas.com/v3"),
  },

  security: {
    rateLimitMax: Number(get("RATE_LIMIT_MAX", "60")),
    rateLimitWindow: Number(get("RATE_LIMIT_WINDOW_SECONDS", "60")),
    loginMaxAttempts: Number(get("LOGIN_MAX_ATTEMPTS", "5")),
    loginLockMinutes: Number(get("LOGIN_LOCK_MINUTES", "15")),
    // Uso justo do agente (por usuário): generoso para uso humano normal,
    // barra automação/abuso (milhares de requisições). Ver seção "acesso ilimitado".
    agentRateMax: Number(get("AGENT_RATE_MAX", "30")),
    agentRateWindow: Number(get("AGENT_RATE_WINDOW_SECONDS", "60")),
  },

  upload: {
    maxFileMb: Number(get("UPLOAD_MAX_FILE_MB", "25")),
    maxFiles: Number(get("UPLOAD_MAX_FILES", "20")),
    /**
     * Teto de páginas que a leitura de PDF percorre.
     *
     * ── Por que existe ────────────────────────────────────────────────────────
     * A extração em JavaScript (`unpdf`) roda DENTRO do processo Node que serve o site. Enquanto ela
     * percorre um documento, o laço de eventos não atende mais ninguém — nem a página pública, nem o
     * login, nem o webhook do Asaas. E o webhook é o que dói no caixa: a fila do Asaas é interrompida no
     * primeiro evento que falha, então servidor preso significa cliente que pagou e não recebe acesso.
     *
     * Um PDF com muitos milhares de páginas chega a esse estado sem nenhuma falha de segurança — só de
     * tamanho. O caminho do OCR já tinha teto (200 páginas); o caminho JavaScript, que é o mais usado,
     * não tinha nenhum.
     *
     * ── Por que 1.500, e por que é variável ───────────────────────────────────
     * O maior processo real conhecido do projeto tem 166 páginas, e execução fiscal antiga passa de mil.
     * 1.500 fica acima do que se conhece e abaixo do que derruba a máquina. Baixo demais transformaria
     * esta proteção em recusa de serviço a cliente pagante, que é pior do que o problema — então o número
     * é ajustável pelo `render.yaml`, que chega em produção pelo push, sem depender do painel.
     */
    maxPaginas: Number(get("UPLOAD_MAX_PAGINAS", "1500")),
    /**
     * Teto do ENVIO INTEIRO, em MB. Ver `src/lib/corpo-da-requisicao.ts` para o defeito que ele fecha.
     *
     * 60 MB porque a instância tem 512 MB e atende todos os clientes ao mesmo tempo: `UPLOAD_MAX_FILES` ×
     * `UPLOAD_MAX_FILE_MB` daria 500 MB numa requisição só. Com 60 MB cabe a cópia integral de um processo
     * (o maior conhecido do projeto tem 166 páginas) e continua sendo possível enviar em mais de uma vez.
     */
    maxRequestMb: Number(get("UPLOAD_MAX_REQUEST_MB", "60")),
    allowedMime: get(
      "UPLOAD_ALLOWED_MIME",
      "application/pdf,image/png,image/jpeg",
    ).split(","),
  },

  datajud: {
    /**
     * Chave da API Pública do DataJud (CNJ). É publicada pelo próprio CNJ na
     * documentação da API — é pública de fato, não um segredo vazado. Fica em
     * env mesmo assim, porque o CNJ já a rotacionou antes e deixá-la em
     * código obrigaria a um deploy para trocar.
     */
    /**
     * ⚠️ SEM VALOR PADRÃO, e a remoção não é sobre esta chave — é sobre o PADRÃO.
     *
     * A chave do DataJud é publicada pelo próprio CNJ, então tê-la aqui não vazava segredo. O problema é
     * que ela provou o caminho: valor padrão escrito neste arquivo VAI PARA O NAVEGADOR quando algum
     * componente de tela puxa este módulo por uma cadeia de imports — e foi exatamente o que a auditoria
     * encontrou no pacote de produção. No dia em que alguém escrevesse `get("OPENAI_API_KEY", "sk-...")`
     * seguindo este mesmo formato, a chave paga sairia pelo mesmo caminho, em silêncio.
     *
     * Vazia é o estado seguro: `consultarProcesso` recusa antes de chamar o CNJ e diz qual variável
     * falta. Para reativar a consulta, ponha `DATAJUD_API_KEY` no ambiente.
     */
    apiKey: get("DATAJUD_API_KEY"),
  },

  queue: {
    // sync   = processa na requisição (simples/serverless; bloqueia até concluir)
    // async  = fire-and-forget no processo (retorna rápido; exige servidor persistente)
    // bullmq = fila Redis + worker dedicado (recomendado em produção)
    driver: get("QUEUE_DRIVER", "sync") as "sync" | "async" | "bullmq",
    redisUrl: get("REDIS_URL", "redis://localhost:6379"),
    concurrency: Number(get("QUEUE_CONCURRENCY", "2")),
    jobAttempts: Number(get("QUEUE_JOB_ATTEMPTS", "3")),
  },
};
