# Pagamento com Asaas

Integração de assinaturas e crédito avulso via **Asaas**, usando o **Checkout
hospedado** do Asaas. É a ÚNICA forma de pagamento: a integração anterior
(Hotmart) foi removida do projeto em 31/07/2026.

## Como funciona (visão geral)

1. O cliente clica em **Assinar** (plano) ou **Comprar** (crédito avulso).
2. O backend (`/api/assinatura/checkout`) chama a API do Asaas e cria uma
   **sessão de checkout** amarrada à conta pelo campo `externalReference`
   (`plano:<slug>:user:<userId>` ou `pacote:<slug>:user:<userId>`), e devolve o
   link hospedado do Asaas.
3. O cliente informa **CPF/CNPJ e a forma de pagamento na página do Asaas** — por
   isso o sistema não precisa coletar CPF antes. **Exceção: boleto.** Ele não passa
   pelo checkout (ver a tabela abaixo), então o CPF/CNPJ é pedido por nós antes de
   emitir.
4. Ao confirmar o pagamento, o Asaas chama o **webhook**
   `POST /api/webhooks/asaas`. Validamos o header `asaas-access-token` e, no
   evento de pagamento recebido, liberamos o acesso e os créditos — reaproveitando
   o mesmo miolo de créditos da assinatura (`liberarCreditosDoCiclo`, `creditarPacote`).

### As três formas de pagar um plano

| Forma | Caminho técnico | Renova? | Quando o acesso entra |
|---|---|---|---|
| Cartão de crédito | Checkout hospedado, `chargeTypes: RECURRENT` | Sim, o Asaas cobra sozinho | Na aprovação (minutos) |
| Boleto | **API de Assinaturas** (`/customers` + `/subscriptions`) | Sim, novo boleto por ciclo | Na compensação bancária (1 a 3 dias úteis) |
| PIX | Checkout hospedado, `chargeTypes: DETACHED` | **Não** — cobrança única | Na confirmação (minutos) |

O **boleto não passa pelo checkout**: o campo `billingTypes` do Checkout aceita
apenas `CREDIT_CARD` e `PIX` (docs.asaas.com/reference/create-new-checkout). Boleto
existe só na API de Assinaturas, que exige um `customer` criado antes, com
CPF/CNPJ — e é por isso que o boleto tem tela própria
(`/assinatura/contratar?plano=X&metodo=boleto`, rota `POST /api/assinatura/boleto`):
o papel de pedir o documento, que nos outros métodos é da página do Asaas, passa a
ser nosso. O documento é gravado criptografado em `User.documentEnc`.

**Boleto vencido cancela a assinatura**, mas não no primeiro evento de atraso. O
Asaas manda `PAYMENT_OVERDUE` no dia seguinte ao vencimento, e boleto pago no dia
do vencimento só compensa 1 a 3 dias úteis depois — cancelar no evento cortaria
quem pagou em dia. O atraso de boleto grava `canceledReason` = "Boleto vencido sem
pagamento" e `graceUntil` = hoje + `DIAS_COMPENSACAO_BOLETO` (3); a manutenção
diária (`encerrarBoletosVencidos`) encerra depois disso e cancela a recorrência no
Asaas, para o provedor não seguir emitindo boleto a quem perdeu o acesso. Para
cancelamento literal e imediato, `DIAS_COMPENSACAO_BOLETO = 0` em
`src/lib/planos.ts`.

O PIX não renova porque não há mandato de débito em PIX comum: o Asaas não tem como
cobrar de novo. `nextRenewalAt` nulo é o sinal, em todo o sistema, de "vale um ciclo
e encerra".

Crédito avulso é sempre cobrança **única** (PIX ou cartão).

## Variáveis de ambiente (no Render)

| Variável | O que é |
|---|---|
| `ASAAS_ENV` | `sandbox` (teste) ou `production` |
| `ASAAS_API_KEY` | Chave de API do Asaas — **sandbox e produção são diferentes** |
| `ASAAS_WEBHOOK_TOKEN` | Token que você define ao criar o webhook; validado em cada evento |
| `ASAAS_API_BASE_URL` | (opcional) só se o Asaas mudar o domínio da API |

Sem `ASAAS_API_KEY`, o botão de assinatura mostra "pagamento ainda não
configurado" — nada quebra, apenas não há checkout.

## Passo a passo para ativar (comece pelo SANDBOX)

### 1. Pegar a chave de API (sandbox)
No Asaas, troque para o ambiente **Sandbox** e vá em
**Configurações → Integrações → Chave de API** (Access Token). Copie a chave —
ela começa com `$aact_hmlg_...` no sandbox.

### 2. Definir as variáveis no Render
No serviço `prescricao-pro` → **Environment**, adicione:
`ASAAS_ENV=sandbox`, `ASAAS_API_KEY=<a chave>`, e um `ASAAS_WEBHOOK_TOKEN` que
você inventa agora (32+ caracteres). Gere um bom token com:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

### 3. Criar o webhook no Asaas
Ainda no Sandbox, em **Configurações → Integrações → Webhooks → Adicionar**:
- **URL**: `https://prescricaopro.com.br/api/webhooks/asaas`
- **Token de autenticação**: o **mesmo** valor de `ASAAS_WEBHOOK_TOKEN`
- **Eventos**: marque os de cobrança — no mínimo `PAYMENT_CONFIRMED`,
  `PAYMENT_RECEIVED`, `PAYMENT_OVERDUE`, `PAYMENT_REFUNDED`.
- Deixe **ativo**.

### 4. Testar com pagamento de mentira
Entre no site, clique em assinar um plano, e pague no checkout do Asaas com um
**cartão de teste do sandbox** (a doc do Asaas lista números de teste). Confira:
- A conta passou a ter assinatura ATIVA e créditos liberados.
- Em Admin, o pagamento aparece com provider **ASAAS**.

### 5. Virar para produção
Só depois que o sandbox funcionar ponta a ponta: troque `ASAAS_ENV=production`,
`ASAAS_API_KEY` para a chave de **produção**, e crie o webhook de novo no
ambiente de produção (mesma URL e token). A partir daí as cobranças são reais.

## Limitações conhecidas (MVP)

- **Cartão, boleto e PIX** estão implementados para plano (ver a tabela acima).
  O que NÃO existe é PIX recorrente (Pix Automático): no PIX o acesso vale um ciclo
  e encerra. Crédito avulso aceita PIX e cartão.
- **Upgrade e downgrade no meio do ciclo** estão implementados na tela
  `/assinatura/mudar-plano`: o upgrade cobra apenas a diferença proporcional aos
  dias restantes e o downgrade é agendado para a renovação. Ver
  `src/lib/mudanca-plano.ts`.
