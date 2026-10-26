-- Padrão da coluna `provider` passa de HOTMART para ASAAS.
--
-- A integração com a Hotmart foi removida e o Asaas é o único meio de pagamento.
-- Deixar HOTMART como padrão era uma armadilha: qualquer linha criada sem informar
-- o provedor nasceria marcada como uma origem que não existe mais, e a conferência
-- financeira passaria a mentir sobre de onde veio o dinheiro.
--
-- Só o DEFAULT muda. Nada de dado é alterado e o valor HOTMART continua no enum de
-- propósito: assinaturas e pagamentos antigos podem estar gravados com ele, e
-- remover o valor do enum faria a migração falhar — além de apagar a informação
-- verdadeira sobre a origem daquelas vendas.

-- AlterTable
ALTER TABLE "Payment" ALTER COLUMN "provider" SET DEFAULT 'ASAAS';

-- AlterTable
ALTER TABLE "Subscription" ALTER COLUMN "provider" SET DEFAULT 'ASAAS';
