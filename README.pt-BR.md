[English](README.md) · **Português (Brasil)**

# Prescrição Pro

SaaS para advogados tributaristas: análise de prescrição e decadência em execuções fiscais.

O advogado envia o PDF da execução fiscal; a plataforma lê o processo (inclusive com OCR), localiza os marcos processuais, faz o cálculo determinístico dos prazos junto com um modelo de linguagem e devolve um relatório estruturado e uma minuta de petição para revisão do advogado. O acesso é vendido em créditos e assinaturas pelo gateway Asaas.

**Situação:** em produção em [prescricaopro.com.br](https://prescricaopro.com.br). Telas, comentários do código e textos jurídicos estão em português.

> A base de conhecimento jurídica e as instruções de IA de produção são proprietárias e **não** estão neste repositório. `knowledge/`, `src/lib/ai/prompts.ts`, `src/lib/ai/prompts-materia.ts`, `src/lib/ai/prompts-peca.ts` e `src/lib/ai/motores/` trazem exemplos curtos e genéricos, com os mesmos exports e a mesma estrutura, para que a aplicação, o seed e a suíte de testes funcionem de ponta a ponta. Os testes desses arquivos conferem a estrutura, não o texto.

---

## O problema

A cobrança judicial de tributos é feita por execução fiscal. Muitas ficam paradas por anos, e a Fazenda perde o direito de cobrar quando certos prazos se esgotam. Demonstrar isso exige ler centenas de páginas dos autos e reconstruir a linha do tempo data por data — trabalho lento e sujeito a erro.

| Termo | Significado |
|---|---|
| **Execução fiscal** | Ação em que a Fazenda (União, estado ou município) cobra judicialmente um crédito inscrito em dívida ativa. |
| **CDA** | Certidão de Dívida Ativa, o título que embasa a execução. |
| **Prescrição** | Prazo para *cobrar* o crédito: cinco anos da constituição definitiva (CTN, art. 174). |
| **Prescrição intercorrente** | Prescrição que corre *dentro* do processo parado (devedor ou bens não localizados): um ano de suspensão mais cinco anos (LEF, art. 40). |
| **Decadência** | Prazo para a Fazenda *constituir* o crédito pelo lançamento (CTN, arts. 150, §4º, e 173). |
| **LEF** | Lei de Execuções Fiscais (Lei nº 6.830/1980). |
| **CTN** | Código Tributário Nacional. |
| **Exceção de pré-executividade** | Defesa que permite alegar, por exemplo, prescrição sem garantir o juízo. É a minuta que a plataforma gera. |
| **LGPD** | Lei Geral de Proteção de Dados. |

## Funcionalidades

- **Envio do processo → leitura → análise → entregáveis.** Upload de PDF e imagem, extração de texto com `unpdf`, OCR de páginas digitalizadas com Ghostscript + Tesseract (português) e citação da página de cada fato.
- **Três matérias**: prescrição intercorrente, prescrição ordinária e decadência, cada uma com checklist de documentos e instruções próprias (`src/lib/ai/motores/`).
- **Motor jurídico determinístico + IA.** Aritmética de datas e regras de prazo ficam no código (`src/lib/legal/`); a IA extrai e argumenta, o servidor confere a conta. Sem chave de IA, a plataforma roda em modo heurístico (só determinístico), rotulado como tal.
- **Relatório e minuta de petição**, versionados por análise, exportáveis em DOCX e PDF, sempre com o aviso de revisão obrigatória por advogado(a).
- **Créditos e assinaturas pelo Asaas:** checkout recorrente no cartão, assinatura por boleto, PIX avulso, compra de crédito unitário, upgrade/downgrade de plano e rotina diária de manutenção de créditos.
- **Multi-inquilino** (organizações) com quatro papéis — cliente, revisor jurídico, suporte e administrador — e painel administrativo de usuários, planos, prompts versionados, base de conhecimento e custo de IA × receita.
- **LGPD:** exportação dos dados, exclusão de conta, pedidos do titular, registro de consentimentos e regras de retenção executadas por código.

## Stack

| Camada | Tecnologia |
|---|---|
| Web | Next.js 15 (App Router, route handlers), React 19, TypeScript, Tailwind CSS |
| Dados | PostgreSQL + Prisma ORM (31 modelos, 14 migrações) |
| IA | API da OpenAI ou da Anthropic, só no servidor, atrás de uma interface única (`src/lib/ai/provider.ts`) |
| Documentos | `unpdf`, OCR com Ghostscript + Tesseract, `docx` e `pdf-lib` na exportação |
| Pagamento | Asaas (checkout hospedado, API de assinaturas, webhooks) |
| Processamento | Fila `sync` / `async` / BullMQ + worker com Redis |
| Arquivos / e-mail | Disco local ou bucket compatível com S3; console ou Resend |
| Testes / CI | Vitest, PostgreSQL 16 embutido, GitHub Actions |
| Deploy | Docker (usuário sem root), Blueprint do Render (`render.yaml`: web, worker, cron, Redis, Postgres) |

## Arquitetura

```mermaid
flowchart LR
    B[Navegador] --> M[Middleware<br/>CSP com nonce, sessão]
    M --> R[Páginas e route handlers<br/>src/app]
    R --> S[Serviços de domínio<br/>src/lib]
    S --> DB[(PostgreSQL<br/>Prisma)]
    S --> FS[(Armazenamento privado<br/>local ou S3)]
    S --> Q{{Fila<br/>sync, async ou BullMQ}}
    Q --> P[Pipeline de análise]
    P --> O[OCR<br/>Ghostscript + Tesseract]
    P --> L[Motor jurídico determinístico<br/>src/lib/legal]
    P --> AI[Provedor de IA<br/>OpenAI ou Anthropic]
    A[Asaas] -- webhook --> R
    R -- checkout --> A
```

Pipeline de análise, na ordem: extração de texto e OCR → checklist de documentos e detecção determinística de eventos-chave → seleção de páginas dentro do orçamento de tokens → chamada à IA com as instruções da matéria → saneamento da resposta e verificação temporal → relatório, linha do tempo e minuta gravados para revisão. Mais detalhes em [ARQUITETURA.md](ARQUITETURA.md), [BANCO_DE_DADOS.md](BANCO_DE_DADOS.md) e [ASAAS.md](ASAAS.md).

## Destaques de engenharia

- **O servidor confere a aritmética da IA.** `src/lib/legal/verificacao-temporal.ts` recalcula a data de consumação a partir dos marcos que o modelo escolheu: um "sim, prescreveu" com consumação no futuro é corrigido para "não", e a contradição inversa dispara uma segunda passada do modelo com a conta do sistema na frente. As duas regras nasceram de casos reais de regressão e estão em `tests/verificacao-temporal.test.ts`.
- **Pré-processamento determinístico alimenta o prompt.** Detecção de eventos processuais por padrão (`src/lib/legal/deteccao-eventos.ts`) e checklist de documentos por matéria rodam antes da IA, para que uma certidão decisiva na página 300 não se perca quando o texto é cortado para caber no orçamento (`src/lib/legal/selecao-paginas.ts`).
- **O caminho do dinheiro é idempotente e testado contra banco real.** Os créditos são uma razão contábil com chave de idempotência única por ciclo: webhook reenviado (ou o par CONFIRMED → RECEIVED do mesmo pagamento) nunca credita em dobro; o token do webhook é comparado em tempo constante. O crédito é debitado antes da chamada à IA e estornado quando o processamento falha — inclusive análises abandonadas por um processo que morreu, que uma varredura marca com erro —, e envio sem nenhuma página legível não é cobrado. Um teste de regressão reproduz o formato real do webhook de cobrança recorrente do Asaas (identificadores anonimizados).
- **Segurança:** autenticação em dois fatores (TOTP) com códigos de backup de uso único guardados como hash; sessões por token opaco guardado como hash, com prazo absoluto e por inatividade (menor para a equipe); bcrypt (custo 12); bloqueio de login e rate limit; Content-Security-Policy estrita com nonce por requisição na área privada; otimizador de imagem do Next desligado; trava `server-only` para o cliente do Prisma e os segredos não chegarem ao navegador (garantida por teste).
- **LGPD desde o desenho:** CPF/CNPJ, segredo do 2FA e o texto integral dos autos enviados são cifrados em repouso com AES-256-GCM (`src/lib/crypto.ts`, `src/lib/pagina-do-processo.ts`); os prazos de retenção têm fonte única, lida pela Política de Privacidade e pela rotina que os executa (`src/lib/retencao.ts`); a trilha de auditoria é saneada.
- **Isolamento entre inquilinos em duas camadas:** toda consulta passa pelo contexto do inquilino (`src/lib/tenant.ts`), e políticas de row-level security para as sete tabelas de conteúdo do processo vêm numa migração, testadas com um papel que não é dono das tabelas (`tests/tranca-do-banco.test.ts`); elas passam a valer quando a aplicação conecta com esse papel (`prisma/rls/usuario-de-aplicacao.sql`).
- **Testes que guardam configuração, não só código:** a suíte falha se o portão de CI for esvaziado, se um ponto de entrada Node rodar sem a trava do `server-only`, se a configuração do worker no Render divergir da do web, ou se o `docker-compose.yml` publicar porta fora de `127.0.0.1`.
- **Portão de qualidade no CI** (`.github/workflows/portao.yml`): tipos, lint, a suíte inteira contra PostgreSQL e build de produção em todo pull request.

## Como rodar localmente

Requisitos: Node.js 20+ e um PostgreSQL 16. Docker é opcional: o `docker-compose.yml` sobe Postgres, Redis e MinIO em `127.0.0.1`, e `npm run db:teste` sobe um PostgreSQL 16 embutido e descartável em `127.0.0.1:55432`, sem Docker.

```bash
npm ci
npx prisma generate
cp .env.example .env
# Edite o .env: DATABASE_URL, AUTH_SECRET, FIELD_ENCRYPTION_KEY (openssl rand -base64 32),
# SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD e SEED_DEMO_PASSWORD.
npx prisma migrate deploy
npx prisma db seed   # roda prisma/seed.ts com as variáveis do .env
npm run dev          # http://localhost:3000
```

O seed recusa rodar sem `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` e recusa criar as contas de demonstração (cliente, revisor e suporte) sem `SEED_DEMO_PASSWORD` — nenhuma senha fica escrita no código. Com `NODE_ENV=production` ele não cria dado de demonstração nenhum e recusa senha de administrador fraca ou conhecida.

Sem `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`, a análise roda em modo heurístico; sem `ASAAS_API_KEY`, o checkout informa que o pagamento não está configurado. `ASAAS_ENV` vem como `sandbox`.

## Como rodar os testes

```bash
npm test                 # suíte inteira; sobe sozinho um PostgreSQL 16 descartável
npm run test:sem-banco   # só os testes que não precisam de banco
npm run typecheck
npm run lint
# build de produção em .next-check; as duas variáveis são de fachada, como no CI
DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build?schema=public" \
AUTH_SECRET="valor-de-fachada-do-build-substituido-em-execucao" npm run build:check
```

O `npm test` baixa pelo npm os binários oficiais do PostgreSQL 16 para `C:/Users/Public/ptp-pgtest` no Windows (ou para a pasta temporária do sistema nos demais), sobe o servidor na porta 55432 e aplica as migrações. `PTP_PG_BASE` e `PTP_PG_PORT` trocam a pasta e a porta. Rode dentro de um clone Git: alguns testes usam `git grep`.

Última execução: **985 testes em 81 arquivos, todos passando** — 524 deles (40 arquivos) contra o PostgreSQL de verdade, sem mock, porque a idempotência que protege os pagamentos vive em transações e chaves únicas, e 461 (41 arquivos) sem banco.

## Estrutura

```
prisma/        schema, migrações, scripts de row-level security, seed
knowledge/     base de conhecimento de exemplo (um arquivo por matéria; a real é proprietária)
scripts/       banco de teste, manutenção de créditos, reconciliação de pagamentos, verificação de backup
src/app/       (marketing) site e textos jurídicos · (auth) · (app) área do cliente
               (admin) painel administrativo · api/ route handlers
src/lib/       autenticação, 2FA, créditos, Asaas, armazenamento, OCR, inquilino, retenção, CSP
src/lib/ai/    provedor, orquestração da análise, instruções por matéria
src/lib/legal/ motor determinístico de prazos, detecção de eventos, verificação temporal
tests/         suíte Vitest
```

## Licença

O código-fonte é distribuído sob a [licença MIT](LICENSE). Os nomes "Prescrição Pro" e "Leão Amorim", os logotipos, a arte em `public/` e os textos jurídicos e comerciais do site não estão cobertos por essa licença e permanecem reservados.

Este software é ferramenta de apoio ao advogado. Não substitui o juízo profissional de advogado(a) habilitado(a) nem garante resultado judicial.
