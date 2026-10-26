-- Adiciona o Asaas como provedor de pagamento.
--
-- Migração escrita à mão (o ambiente de build não tem banco para gerar via
-- `prisma migrate dev`). É aditiva e idempotente: `ADD VALUE IF NOT EXISTS`
-- não falha se rodar duas vezes, e no PostgreSQL 16 pode rodar dentro da
-- transação da migração porque o novo valor só é USADO em migrações
-- posteriores, nunca nesta.
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'ASAAS';
