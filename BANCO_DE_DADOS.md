# Banco de Dados — Prescrição Pro

Banco relacional **PostgreSQL**, modelado com **Prisma ORM**. Schema completo em [`prisma/schema.prisma`](prisma/schema.prisma). Princípios: **segregação multi-tenant** (por `Organization`), **trilha de auditoria**, **versionamento** (prompts, relatórios, peças) e **idempotência** de eventos de pagamento.

## Como aplicar

```bash
npx prisma migrate dev --name init   # cria/atualiza o schema em desenvolvimento
npx prisma migrate deploy            # aplica migrações em produção
npm run db:seed                      # dados de demonstração (NÃO usar em produção)
npx prisma studio                    # navegador visual do banco
```

## Entidades (visão geral)

### Identidade e acesso
| Modelo | Descrição |
|--------|-----------|
| `User` | Usuário (papel `Role`: ADMIN/CLIENTE/REVISOR/SUPORTE), status, dados de login, CPF/CNPJ criptografado (`documentEnc`), controles de bloqueio, 2FA (campos preparados). |
| `Organization` | Escritório/empresa. Dono (`ownerId`, 1-1) e membros (1-N). Unidade de **isolamento** de dados. |
| `Session` | Sessões persistidas (hash do token); permite expiração e **revogação** individual/global. |
| `AuthToken` | Tokens de uso único: verificação de e-mail, recuperação/criação de senha, convite. |

### Planos, assinaturas e pagamentos
| Modelo | Descrição |
|--------|-----------|
| `Plan` | Plano comercial: preço, período, limites (análises, usuários, armazenamento, tamanho de arquivo), recursos. Configurável pelo admin. |
| `Subscription` | Assinatura de uma organização a um plano; status, período, cota e consumo. |
| `Payment` | Pagamentos vinculados à assinatura (provedor, status, valor, `raw`). |
| `HotmartEvent` | **LEGADO.** Eventos brutos do gateway anterior. A integração foi removida e nada mais lê ou escreve nesta tabela; ela é preservada porque pode conter histórico financeiro. |

### Análises e processos
| Modelo | Descrição |
|--------|-----------|
| `Analysis` | Análise jurídica: dados processuais, `facts` (JSON de datas informadas), tipo, status, confiança, `promptVersionId` usado. |
| `Document` | Documento enviado: `storageKey` (armazenamento privado), `checksum` (dedup), status, contagem de páginas. |
| `DocumentPage` | Texto extraído por página (para análise e citação de página). |
| `TimelineEvent` | Evento da linha do tempo: tipo, natureza (fato/hipótese), efeito jurídico, origem. **Versionamento não destrutivo** via `supersededBy`. |

### Resultados
| Modelo | Descrição |
|--------|-----------|
| `Report` | Relatório **versionado** (`@@unique([analysisId, version])`): conteúdo estruturado (JSON) + markdown. |
| `Petition` | Minuta jurídica **versionada** por tipo; campos pendentes destacados. |
| `LegalReview` | Revisão jurídica humana (status, notas, riscos, divergências). |
| `ConsumptionRecord` | Registro **auditável** de consumo (análises, tokens de IA, armazenamento). |

### Conhecimento e IA
| Modelo | Descrição |
|--------|-----------|
| `KnowledgeDocument` | Base de conhecimento por categoria (CTN, LEF, súmulas, temas, modelos…), versão, status, origem. |
| `KnowledgeRevision` | Histórico de revisões dos documentos da base. |
| `PromptVersion` | **Instruções da IA versionadas** (kind + version), ativáveis/desativáveis e auditáveis. |

### Suporte, conteúdo e sistema
| Modelo | Descrição |
|--------|-----------|
| `SupportTicket` / `SupportMessage` | Chamados de suporte e mensagens. |
| `Notification` | Notificações ao usuário. |
| `Consent` | Consentimentos LGPD versionados (termos, privacidade, IA, cookies) com data/IP. |
| `SystemSetting` | Configurações chave/valor (JSON) editáveis pelo admin. |
| `ContentBlock` | Blocos editáveis do site (home, FAQ, e-mails) como slug/JSON. |

### Auditoria e segurança
| Modelo | Descrição |
|--------|-----------|
| `AuditLog` | Trilha de auditoria de ações (ator, ação, entidade, metadados **não sensíveis**). |
| `SecurityEvent` | Eventos de segurança (login_failed, rate_limited, account_locked, webhook_invalid). |

## Enums principais

- `Role`, `UserStatus`, `OrgRole`
- `BillingPeriod`, `SubscriptionStatus`, `PaymentProvider`, `PaymentStatus`, `HotmartEventStatus` (os dois últimos
  valores de `PaymentProvider` e o enum `HotmartEventStatus` são legado: `HOTMART` é preservado porque
  assinaturas antigas podem estar gravadas com ele)
- `AnalysisType`, `AnalysisStatus`, `ConfidenceLevel`
- `DocumentStatus`, `TimelineEventType`, `FactNature`
- `PetitionType`, `ReviewStatus`
- `TicketStatus`, `TicketPriority`, `ConsentType`, `KnowledgeCategory`, `PromptKind`, `TokenType`

## Relacionamentos e integridade

- **Isolamento**: `Analysis`, `Document`, `Subscription` pertencem a uma `Organization`; o acesso é sempre filtrado por `organizationId`/`ownerId` na camada de aplicação (`src/lib/tenant.ts`).
- **Cascatas**: exclusão de `Analysis` remove em cascata `Document`, `DocumentPage`, `TimelineEvent`, `Report`, `Petition`, `LegalReview`. Exclusão de `Organization` remove suas análises/documentos/assinaturas.
- **Índices**: em chaves estrangeiras e campos de busca frequente (status, papel, `action`, `createdAt`, `checksum`, `externalId`).
- **Idempotência**: `CreditLedger.idempotencyKey @unique` (chave do ciclo `ciclo:<assinatura>:<AAAA-MM>` — é o que impede crédito em dobro no reenvio de webhook); `Payment` deduplicado por `(externalId + status)`; `Report`/`Petition` únicos por `(analysisId, version[, type])`; `PromptVersion` único por `(kind, version)`.
- **Versionamento não destrutivo**: `TimelineEvent.supersededBy` preserva o histórico ao corrigir eventos.

## Dados sensíveis

- CPF/CNPJ são armazenados **criptografados** (AES-256-GCM, campos `*Enc`) e exibidos com máscara.
- `AuditLog`/`SecurityEvent` **não** armazenam senhas, tokens ou documentos completos (sanitização em `src/lib/audit.ts`).
- Documentos ficam em **armazenamento privado**; o banco guarda apenas a `storageKey`.

## Diagrama textual (resumo)

```
Organization 1─N User
Organization 1─N Subscription N─1 Plan
Subscription 1─N Payment
Subscription 1─N ConsumptionRecord
Organization 1─N Analysis 1─N Document 1─N DocumentPage
Analysis 1─N TimelineEvent
Analysis 1─N Report
Analysis 1─N Petition
Analysis 1─1 LegalReview
User 1─N Session / AuthToken / Consent / Notification / AuditLog
PromptVersion 1─N Analysis
KnowledgeDocument 1─N KnowledgeRevision
SupportTicket 1─N SupportMessage
```
