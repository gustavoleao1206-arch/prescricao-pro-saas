-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "canceledByRequestAt" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- Preenchimento das assinaturas JÁ canceladas a pedido.
--
-- Sem isto, a garantia contra cobrança após o cancelamento valeria só para
-- cancelamentos FUTUROS: quem já havia pedido para parar ficaria com o campo nulo, e a
-- próxima cobrança da recorrência ressuscitaria a assinatura exatamente como antes —
-- o defeito seguiria vivo justamente para quem já foi atingido por ele.
--
-- O critério é o texto que as duas rotas de cancelamento gravavam (as constantes
-- MOTIVO_CANCELAMENTO_CLIENTE e MOTIVO_CANCELAMENTO_ADMIN, em src/lib/asaas.ts). É
-- frágil como regra permanente — e foi por isso que deixou de ser regra —, mas é a
-- única evidência que existe sobre o passado.
--
-- `canceledAt` é a data do pedido nesses casos. Onde estiver nula, usa-se a data de
-- atualização do registro: melhor uma data aproximada que nenhuma, porque o que o
-- código pergunta é "existe pedido?", não "de quando é".
-- ---------------------------------------------------------------------------
UPDATE "Subscription"
SET "canceledByRequestAt" = COALESCE("canceledAt", "updatedAt")
WHERE "canceledByRequestAt" IS NULL
  AND "canceledReason" IN ('Cancelamento solicitado pelo cliente', 'Cancelado pelo administrador');
