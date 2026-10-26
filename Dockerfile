# --- Estágio 1: dependências --------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# --- Estágio 2: build ---------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

# O Prisma precisa do OpenSSL para identificar qual engine usar. Sem isto ele
# avisa "failed to detect the libssl/openssl version" e assume openssl-1.1.x,
# gerando um engine que não carrega no runtime desta mesma imagem.
RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Valores de fachada, válidos APENAS neste estágio.
#
# `next build` roda com NODE_ENV=production e src/lib/env.ts falha de propósito
# quando falta DATABASE_URL ou AUTH_SECRET em produção. É a proteção correta em
# execução, mas ela também dispara na fase "Collecting page data", em que o Next
# importa cada rota para descobrir se é estática ou dinâmica. Sem isto o build
# morre em /api/admin/prompts/[id]/ativar com "Variável de ambiente obrigatória
# ausente: DATABASE_URL" — e o .env real, corretamente, não entra na imagem.
#
# Nenhuma página consulta o banco em tempo de build (toda rota de API é
# dinâmica), então estes valores não são usados de fato: existem só para o
# módulo carregar. Por serem ENV deste estágio, não chegam à imagem final — o
# estágio `runner` recebe os segredos reais pelas variáveis do Render.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public"
ENV AUTH_SECRET="valor-de-fachada-do-build-substituido-em-execucao"

RUN npx prisma generate && npm run build

# --- Estágio 3: runtime -------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# OCR de PDF digitalizado: Ghostscript rasteriza, Tesseract transcreve (português).
# Sem estes pacotes a aplicação sobe, mas processos escaneados ficam ilegíveis.
# `openssl` é exigido pelo engine do Prisma (linux-musl-openssl-3.0.x).
RUN apk add --no-cache ghostscript tesseract-ocr tesseract-ocr-data-por openssl

RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# node_modules completo (por cima do mínimo do standalone) + fontes: permitem
# rodar `prisma migrate deploy` no boot e o cron de créditos na mesma imagem
# (Render Cron Job com comando `npx tsx --tsconfig tsconfig.scripts.json scripts/manutencao-creditos.ts`).
#
# O --chown importa: sem ele estes caminhos ficam de root, e o contêiner roda
# como `nextjs`. O `npx prisma` no boot precisa escrever em node_modules (cache
# e, se faltar engine, download), e falharia com "Can't write to @prisma/engines"
# — erro que não deixa claro que a causa é permissão.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.json ./tsconfig.json
# ⚠️ Sem este arquivo o contêiner NAO SOBE: o comando de start roda o boot por `tsx`, e e este
# tsconfig que neutraliza o `server-only` fora do Next. Ver src/lib/db.ts.
COPY --from=builder --chown=nextjs:nodejs /app/tsconfig.scripts.json ./tsconfig.scripts.json
COPY --from=builder --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=builder --chown=nextjs:nodejs /app/src ./src
COPY --from=builder --chown=nextjs:nodejs /app/knowledge ./knowledge

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

# Aplica as migrações pendentes, reconcilia a vitrine de planos e sobe o servidor.
# As duas primeiras etapas são idempotentes: reiniciar o serviço não altera um banco
# já migrado nem reescreve plano já existente.
#
# A reconciliação do catálogo entrou aqui porque a página de planos lê o BANCO, e o
# deploy nunca rodava o seed: a oferta virou dois planos no código, o site subiu, e a
# página seguiu vendendo os três planos antigos por dias. Agora, no start, plano do
# catálogo que falta é criado e plano público fora do catálogo sai da vitrine — sem
# tocar em preço de plano existente, que é decisão do administrador. Ela nunca
# derruba o boot: em caso de erro, registra e devolve sucesso.
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx --tsconfig tsconfig.scripts.json scripts/sincronizar-catalogo.ts --boot && node server.js"]
