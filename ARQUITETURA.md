# Arquitetura — Prescrição Pro

> **Prescrição Pro** é uma plataforma web SaaS de **apoio jurídico** à análise de prescrição e decadência tributária em execuções fiscais.
> Marca: **Leão Amorim Advocacia**.
> Identidade visual: azul-marinho `#1E2D5A` e dourado `#C4962A`.

---

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Diagrama de camadas](#2-diagrama-de-camadas)
3. [Decisões técnicas e justificativas](#3-decisões-técnicas-e-justificativas)
4. [Estrutura de pastas](#4-estrutura-de-pastas)
5. [Fluxo de requisição](#5-fluxo-de-requisição)
6. [Fluxo de análise](#6-fluxo-de-análise)
7. [Multi-tenancy](#7-multi-tenancy)
8. [Escalabilidade](#8-escalabilidade)
9. [Ambientes](#9-ambientes)
10. [Limitações conhecidas](#10-limitações-conhecidas)
11. [Ressalvas importantes](#11-ressalvas-importantes)

---

## 1. Visão geral

O **Prescrição Pro** é uma aplicação SaaS que auxilia advogados e escritórios na
avaliação de prescrição e decadência tributária a partir de documentos de execuções fiscais.
A plataforma recebe os documentos do caso, extrai o texto, executa uma análise (por IA ou por
cálculo determinístico) e produz três artefatos principais:

- **Linha do tempo** dos eventos processuais/tributários (`TimelineEvent`);
- **Relatório** técnico versionado (`Report`);
- **Minuta** de peça jurídica (`Petition`).

O produto é, por definição, uma **ferramenta de apoio**: todo resultado exige revisão por
advogado(a) e não substitui o julgamento profissional (ver [Ressalvas importantes](#11-ressalvas-importantes)).

### Stack tecnológica

| Camada | Tecnologia |
|---|---|
| Framework web | **Next.js 15** (App Router) |
| Linguagem | **TypeScript** |
| UI | **React 19** + **TailwindCSS** |
| ORM | **Prisma** |
| Banco de dados | **PostgreSQL** (imagem `postgres:16`) |
| Armazenamento de arquivos | Local ou **S3** (MinIO em desenvolvimento) |
| Testes | **Vitest** |
| Containerização | **Docker** (`docker-compose`) |
| Runtime | **Node.js >= 20** |

---

## 2. Diagrama de camadas

O sistema segue uma arquitetura em camadas, com o provedor de IA e o armazenamento de arquivos
tratados como dependências externas isoladas.

```
┌─────────────────────────────────────────────────────────────────────┐
│                          NAVEGADOR (Cliente)                          │
│         Server Components  +  Client Components (React 19)            │
└───────────────────────────────┬─────────────────────────────────────┘
                                │  HTTP
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    ROUTE HANDLERS  (src/app/api)                      │
│      Validação de entrada (Zod) · Autenticação · RBAC · Rate limit    │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      SERVIÇOS  (src/lib)                              │
│  auth · rbac · tenant · audit · consumption · analysis-runner ·      │
│  documents · storage · email · asaas · export · legal/prescricao ·  │
│  ai/provider · ai/analysis · ai/prompts                              │
└───────┬──────────────────────────┬──────────────────────┬───────────┘
        │                          │                       │
        ▼                          ▼                       ▼
┌───────────────┐         ┌─────────────────┐     ┌──────────────────┐
│   PRISMA ORM  │         │  ARMAZENAMENTO  │     │   PROVEDOR DE IA │
│      ▼        │         │   DE ARQUIVOS   │     │  (externo, só no │
│  PostgreSQL   │         │  (local | S3)   │     │     servidor)    │
└───────────────┘         └─────────────────┘     └──────────────────┘
```

**Regras de fronteira entre camadas:**

- O **Frontend** nunca fala diretamente com o banco ou com o provedor de IA.
- As **chaves de IA** existem apenas no servidor (serviços em `src/lib`), nunca no cliente.
- O **armazenamento de arquivos** é uma camada separada, com driver intercambiável (`local` ou `s3`).
- Toda leitura de dados do domínio passa pelo **contexto multi-tenant** (`src/lib/tenant.ts`).

---

## 3. Decisões técnicas e justificativas

| Decisão | Justificativa |
|---|---|
| **Next.js 15 (App Router)** | Unifica frontend e backend (Route Handlers) em um único projeto TypeScript; permite Server Components para renderização segura de dados sensíveis no servidor. |
| **TypeScript em toda a base** | Tipagem estática ponta a ponta, reduzindo erros e facilitando manutenção. |
| **Prisma ORM + PostgreSQL** | Modelagem tipada do schema e migrações versionadas; PostgreSQL como banco relacional robusto. Cliente Prisma exposto como **singleton** (`src/lib/db.ts`) para evitar múltiplas conexões em ambiente serverless/dev. |
| **Sessões por token opaco** | `src/lib/auth.ts` gera um token opaco, armazenado no banco **como hash** (tabela `Session`), entregue ao cliente em cookie `httpOnly` chamado `ptp_session`. Sessões são **revogáveis**. Evita expor dados sensíveis em tokens auto-contidos. |
| **Senhas com bcrypt (custo 12)** | `src/lib/password.ts` usa bcrypt com fator de custo 12, equilíbrio entre segurança e desempenho. |
| **Criptografia de campos sensíveis** | `src/lib/crypto.ts` provê AES-256-GCM para campos sensíveis, além de `sha256` e `hmac`. |
| **RBAC por matriz de permissões** | `src/lib/rbac.ts` centraliza a matriz de permissões por papel, mantendo a autorização consistente entre rotas. |
| **Validação com Zod** | `src/lib/validation.ts` valida entradas de forma declarativa e tipada. |
| **Auditoria e eventos de segurança** | `src/lib/audit.ts` grava `AuditLog` e `SecurityEvent`, provendo trilha de auditoria. |
| **Provedor de IA agnóstico** | `src/lib/ai/provider.ts` abstrai Anthropic e OpenAI, permitindo trocar de provedor por configuração de ambiente. |
| **Fallback heurístico** | Quando não há chave de IA configurada, `src/lib/ai/analysis.ts` recorre aos cálculos determinísticos de `src/lib/legal/prescricao.ts`, sem inventar informações. |
| **Prompts versionados** | Prompts default embutidos em `src/lib/ai/prompts.ts` e versionáveis via banco (`PromptVersion`), permitindo governança de mudanças. |
| **Exportação em DOCX e PDF** | `src/lib/export.ts` usa a biblioteca `docx` para DOCX e `pdf-lib` para PDF. |
| **Extração de texto de PDF** | `src/lib/documents.ts` usa `unpdf` (pdf.js atual) para extrair texto dos documentos. |
| **Rate limit em memória (MVP)** | `src/lib/rate-limit.ts` implementa limitação em memória; em produção recomenda-se Redis (ver [Limitações](#10-limitações-conhecidas)). |
| **Multi-tenancy por `organizationId`/`ownerId`** | Isolamento lógico garantido em `src/lib/tenant.ts`, validando propriedade, organização e papel em cada leitura. |
| **Integração Asaas com idempotência** | `src/lib/asaas.ts` processa webhooks com deduplicação de `Payment` por (externalId + status) e liberação de créditos idempotente pela chave do ciclo, para o reenvio do gateway — ou o par CONFIRMED→RECEIVED do mesmo pagamento — nunca creditar em dobro. |

---

## 4. Estrutura de pastas

```
prescricao-tributaria-pro/
├── src/
│   ├── app/                         # Rotas (Next.js App Router)
│   │   ├── (marketing)/             # Páginas públicas / institucionais
│   │   ├── (auth)/                  # Autenticação (login, cadastro, etc.)
│   │   ├── (app)/                   # Área do cliente (autenticada)
│   │   ├── (admin)/                 # Painel administrativo
│   │   └── api/                     # Route Handlers (backend HTTP)
│   │
│   ├── lib/                         # Serviços de domínio e infraestrutura
│   │   ├── env.ts                   # Leitura/validação de variáveis de ambiente
│   │   ├── db.ts                    # Singleton do cliente Prisma
│   │   ├── crypto.ts                # AES-256-GCM (campos sensíveis), sha256, hmac
│   │   ├── password.ts              # Hash de senha (bcrypt, custo 12)
│   │   ├── auth.ts                  # Sessões por token opaco (cookie ptp_session)
│   │   ├── rbac.ts                  # Matriz de permissões por papel
│   │   ├── rate-limit.ts            # Rate limit em memória (produção: Redis)
│   │   ├── audit.ts                 # AuditLog + SecurityEvent
│   │   ├── validation.ts            # Schemas Zod
│   │   ├── storage.ts               # Driver de armazenamento (local | s3)
│   │   ├── email.ts                 # Envio de e-mail (console | resend | smtp)
│   │   ├── asaas.ts                # Checkout + webhook Asaas + idempotência
│   │   ├── documents.ts             # Extração de texto (unpdf)
│   │   ├── consumption.ts           # Controle de cota do plano
│   │   ├── analysis-runner.ts       # Pipeline de processamento da análise
│   │   ├── tenant.ts                # Contexto multi-tenant
│   │   ├── export.ts                # Exportação DOCX (docx) e PDF (pdf-lib)
│   │   ├── api.ts                   # Utilitários de API
│   │   ├── format.ts                # Formatação (datas, valores, etc.)
│   │   ├── ai/
│   │   │   ├── provider.ts          # Abstração de provedor (Anthropic | OpenAI)
│   │   │   ├── analysis.ts          # Orquestração + fallback heurístico
│   │   │   └── prompts.ts           # Prompts default versionados
│   │   └── legal/
│   │       └── prescricao.ts        # Cálculos determinísticos de prescrição/decadência
│   │
│   └── components/                  # Componentes React
│       ├── ui/                      # Componentes de UI base
│       ├── marketing/               # Componentes de páginas públicas
│       ├── app/                     # Componentes da área do cliente
│       └── admin/                   # Componentes do painel administrativo
│
└── prisma/
    ├── schema.prisma                # Modelo de dados
    └── seed.ts                      # Carga inicial de dados
```

---

## 5. Fluxo de requisição

O caminho típico de uma requisição autenticada percorre as camadas descritas na
[seção 2](#2-diagrama-de-camadas):

1. **Cliente** (Server/Client Component) dispara uma requisição HTTP para uma rota em `src/app/api`.
2. O **Route Handler** executa os controles transversais:
   - **Rate limit** (`rate-limit.ts`);
   - **Autenticação** de sessão via cookie `ptp_session` (`auth.ts`);
   - **Validação** do payload com Zod (`validation.ts`);
   - **Autorização** por papel (`rbac.ts`);
   - **Contexto multi-tenant** (`tenant.ts`).
3. O handler chama os **serviços** em `src/lib`, que concentram a lógica de domínio.
4. Os serviços acessam o **PostgreSQL** via **Prisma** (`db.ts`), o **armazenamento de arquivos**
   (`storage.ts`) e/ou o **provedor de IA** (`ai/provider.ts`), conforme necessário.
5. Ações relevantes são registradas em **auditoria** (`audit.ts`).
6. A resposta retorna ao cliente.

---

## 6. Fluxo de análise

O pipeline de análise vive em `src/lib/analysis-runner.ts` e, **no MVP, é executado de forma
síncrona** dentro da requisição de processamento.

```
   ┌──────────────────────┐
   │  Criar análise       │  status: RASCUNHO
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │  Upload de documentos│  armazenamento PRIVADO (local | s3)
   └──────────┬───────────┘
              │
              ▼
   POST /api/analises/[id]/processar        (maxDuration = 300)
              │
              ▼
   ┌──────────────────────┐
   │  1. Validar          │
   ├──────────────────────┤
   │  2. Extrair texto    │  documents.ts (unpdf)     
   ├──────────────────────┤
   │  3. Rodar IA OU      │  ai/analysis.ts
   │     heurística       │  → fallback: legal/prescricao.ts
   ├──────────────────────┤
   │  4. Persistir:       │
   │     • TimelineEvent  │  (linha do tempo)
   │     • Report         │  (relatório, versionado)
   │     • Petition       │  (minuta de peça)
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │  status:             │
   │  AGUARDANDO_REVISAO  │
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │  Registrar consumo   │  consumption.ts (ConsumptionRecord)
   └──────────────────────┘
```

**Detalhes:**

- A rota de processamento define `maxDuration = 300` (segundos) para acomodar a execução síncrona.
- Ao final do pipeline, a análise fica com status **`AGUARDANDO_REVISAO`**, sinalizando que o
  resultado deve ser revisado por um profissional antes de qualquer uso.
- O **consumo** é registrado ao final (cota do plano em `consumption.ts`).
- **Em produção, recomenda-se uma fila assíncrona** (por exemplo, BullMQ/Redis) no lugar da
  execução síncrona — ver [Escalabilidade](#8-escalabilidade) e [Limitações](#10-limitações-conhecidas).

---

## 7. Multi-tenancy

O isolamento entre clientes/escritórios é feito por **`organizationId`** (tabela `Organization`)
e **`ownerId`**.

- Toda leitura de dados de domínio passa por `src/lib/tenant.ts`, que expõe funções como
  `getAppContext` e `getAnalysisForContext`.
- Essas funções **validam propriedade, organização e papel** antes de retornar dados, garantindo
  que um cliente jamais acesse recursos de outro.
- Os documentos são mantidos em **armazenamento privado** (não público), reforçando o isolamento.

---

## 8. Escalabilidade

A arquitetura foi desenhada para evoluir dos padrões de MVP para produção sem reescrita estrutural:

| Componente | MVP (atual) | Produção (recomendado) |
|---|---|---|
| **Pipeline de análise** | Síncrono, dentro da requisição (`maxDuration = 300`) | Fila **assíncrona** (ex.: **BullMQ/Redis**), desacoplando processamento da requisição |
| **Rate limit** | Em memória (`rate-limit.ts`) | Baseado em **Redis** (compartilhado entre instâncias) |
| **Armazenamento de arquivos** | Local ou MinIO (dev) | **S3** (driver `s3` de `storage.ts`) |
| **Provedor de IA** | Chamado no servidor, síncrono | Mesmo modelo, com controle de custo por `AI_MAX_OUTPUT_TOKENS` e monitoramento de consumo |

**Princípios que favorecem a escala horizontal:**

- Estado de sessão no **banco** (não em memória de processo), o que permite múltiplas instâncias.
- Armazenamento de arquivos **externo** ao processo web.
- Provedor de IA **externo** e isolado, chamado apenas no servidor.

> A migração do rate limit e da fila para Redis é o principal passo para operar múltiplas instâncias
> com segurança.

---

## 9. Ambientes

O projeto usa **Docker** (via `docker-compose`) com os serviços de apoio `postgres:16` e **MinIO**.

| Ambiente | Objetivo | Observações |
|---|---|---|
| **Desenvolvimento (dev)** | Desenvolvimento local | `docker-compose` sobe PostgreSQL (`postgres:16`) e MinIO; armazenamento pode usar driver `local`; e-mail pode usar driver `console`; IA pode operar em **modo heurístico** (sem chave). |
| **Homologação (homolog)** | Validação pré-produção | Recomenda-se aproximar a configuração de produção (S3, provedor de e-mail real, chave de IA). |
| **Produção (prod)** | Operação real | Armazenamento em **S3**; e-mail via `resend` ou `smtp`; provedor de IA configurado; **Redis** para rate limit e fila assíncrona; segredos fora de commit/log. |

### Configuração base (exemplos de comando)

```bash
# Subir serviços de apoio (PostgreSQL + MinIO)
docker compose up -d

# Instalar dependências
npm install

# Aplicar o schema / migrações do Prisma
npx prisma migrate deploy   # ou: npx prisma db push (conforme fluxo do projeto)

# Popular dados iniciais
npx prisma db seed

# Rodar em desenvolvimento
npm run dev

# Executar a suíte de testes (Vitest)
npm test
```

> Requisitos: **Node.js >= 20**.

### Variáveis de ambiente

As variáveis são lidas/validadas em `src/lib/env.ts`. Todas as chaves (IA, banco, storage,
e-mail, Asaas) estão descritas em `.env.example` e `render.yaml`.

---

## 10. Limitações conhecidas

- **Pipeline síncrono no MVP**: o processamento roda dentro da requisição
  (`POST /api/analises/[id]/processar`, `maxDuration = 300`). Cargas maiores ou volume elevado
  pedem **fila assíncrona** (ex.: BullMQ/Redis). Limitação **documentada e intencional** para o MVP.
- **Rate limit em memória**: `rate-limit.ts` mantém contadores em memória do processo; não é
  compartilhado entre instâncias. **Produção deve usar Redis.**
- **Dependência de provedor externo de IA**: quando configurado, o resultado depende de um serviço
  externo (Anthropic ou OpenAI). Sem chave, o sistema opera em **modo heurístico** (determinístico),
  com confiança baixa/indeterminada.
- **A IA pode errar**: o produto é ferramenta de **apoio** e separa fato de hipótese, indicando grau
  de confiança — ver [Ressalvas importantes](#11-ressalvas-importantes).

---

## 11. Ressalvas importantes

- **Ferramenta de apoio**: o Prescrição Pro **auxilia** a análise, mas **exige revisão
  por advogado(a)** e **não garante resultado judicial**.
- **A IA pode errar**: o sistema é projetado para **separar fato de hipótese** e **indicar o grau de
  confiança** de cada conclusão.

---

*Documento de arquitetura — Prescrição Pro · Leão Amorim Advocacia.*
