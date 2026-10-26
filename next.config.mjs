/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: "standalone",
  /**
   * Diretório de saída configurável.
   *
   * `next build` escreve em `.next`, o mesmo diretório que `next dev` usa —
   * rodar um build de verificação com o servidor de desenvolvimento no ar
   * substitui os arquivos dele e derruba a aplicação com erro 500. Use
   * `npm run build:check` (NEXT_DIST_DIR=.next-check) para conferir se o
   * projeto compila sem tocar no ambiente em execução.
   */
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Lint roda separadamente (`npm run lint`); não bloqueia o build de produção.
  eslint: { ignoreDuringBuilds: true },
  // Bibliotecas usadas apenas no servidor (geração de PDF/DOCX, parsing). No Next 15 a opção saiu de
  // `experimental.serverComponentsExternalPackages` e passou a se chamar `serverExternalPackages`.
  serverExternalPackages: ["unpdf", "pdf-lib", "docx"],
  /**
   * Otimizador de imagem DESLIGADO: `/_next/image` responde 404.
   *
   * O endpoint vem ligado por padrão mesmo que nenhuma página use `next/image`, e é o componente do Next com
   * o pior histórico recente: execução remota de código sem autenticação (GHSA-2464-fhr4-w9xw, com SVG, e
   * GHSA-2xp9-vwfh-vxw4, com AVIF), negação de serviço e disco enchido pelo cache de imagens. Este sistema
   * não usa `next/image` — as imagens de `public/` são servidas como arquivo estático —, então desligar não
   * muda nada na tela e remove a superfície inteira, inclusive para o próximo advisory que aparecer nela.
   *
   * Com `unoptimized: true` o servidor do Next devolve 404 em `/_next/image` antes de ler qualquer parâmetro
   * (ver `handleNextImageRequest` em next/dist/server/next-server.js). Se um dia `next/image` for adotado,
   * a imagem continua aparecendo — só deixa de ser redimensionada no servidor.
   */
  images: { unoptimized: true },
  async headers() {
    /**
     * Cabeçalhos de segurança ESTÁTICOS de toda a aplicação.
     *
     * ⚠️ A Content-Security-Policy NÃO mora aqui, e não é esquecimento: este arquivo é avaliado UMA vez, no
     * build, então um nonce escrito aqui seria o mesmo para todos os clientes e para sempre — o atacante
     * leria o valor no próprio HTML e o usaria. Ela é emitida em src/middleware.ts, que roda por requisição.
     */
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          {
            /**
             * Nega de graça tudo o que este sistema não usa. Não há iframe, e o pagamento é navegação de
             * página cheia para o Asaas — nada aqui depende da API de pagamento do navegador.
             */
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=(), " +
              "magnetometer=(), accelerometer=(), gyroscope=(), midi=(), serial=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
