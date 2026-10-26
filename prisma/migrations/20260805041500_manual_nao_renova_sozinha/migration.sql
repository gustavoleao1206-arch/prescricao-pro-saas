-- ---------------------------------------------------------------------------
-- Venda MANUAL não se cobra sozinha: apaga a promessa de renovação já gravada.
--
-- Em toda a aplicação `nextRenewalAt` preenchido significa uma coisa só — "esta
-- assinatura se cobra sozinha". MANUAL é o contrário: a venda aconteceu FORA do
-- gateway, não existe mandato de débito, e nada vai cobrar de novo.
--
-- Sem este preenchimento retroativo o conserto valeria só para vendas FUTURAS, e o
-- efeito pior é justamente sobre as que já existem: `encerrarAssinaturasVencidas`
-- encerra quem tem `nextRenewalAt` NULO e deixa em paz quem tem data, porque nesse
-- caso "quem decide o fim dela é o gateway". MANUAL tem data e não tem gateway, então
-- nunca era encerrada — ficava ATIVA para sempre, somando no MRR e em "Assinantes
-- ativos" muito depois de o ciclo pago terminar.
--
-- Nada aqui mexe em acesso: quem concede acesso é `currentPeriodEnd` comparado com
-- hoje, e essa coluna não é tocada. O que muda é (a) o número que o dono usa para
-- conduzir o negócio, que passa a contar só quem de fato paga, e (b) o texto da tela
-- do cliente, que deixa de prometer "renovação automática" a quem não tem nenhuma.
--
-- A varredura diária faz o resto sozinha: as que já venceram passam a VENCIDA na
-- próxima execução, com registro em auditoria.
-- ---------------------------------------------------------------------------
UPDATE "Subscription"
SET "nextRenewalAt" = NULL
WHERE "provider" = 'MANUAL'
  AND "nextRenewalAt" IS NOT NULL;
