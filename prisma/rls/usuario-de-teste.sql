-- Usuário de aplicação do BANCO DE TESTE — espelha prisma/rls/usuario-de-aplicacao.sql.
--
-- POR QUE EXISTE: a suíte conecta como superusuário, e superusuário IGNORA RLS
-- sempre. Sem um usuário não-dono, todo teste de política passaria sem provar
-- nada — a pior espécie de teste verde. É criado por scripts/pg-teste.mjs.
--
-- A senha é fixa e pública de propósito: é um banco descartável, na porta 55432,
-- que não guarda dado real.
--
-- ⚠️ NÃO usa DROP ROLE. O Postgres recusa apagar papel que ainda tem permissão
-- concedida, então a segunda execução de `npm test` morria com "privileges for
-- table ..." antes de rodar teste nenhum. Criar só se faltar é idempotente de
-- verdade.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ptp_app') THEN
    CREATE ROLE ptp_app WITH LOGIN PASSWORD 'ptp_app';
  END IF;
END
$$;

-- Reafirma os atributos a cada execução: uma sabotagem de teste que tenha
-- deixado o papel como SUPERUSER faria os testes de RLS passarem sem provar
-- nada, em silêncio.
ALTER ROLE ptp_app NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE postgres TO ptp_app;
GRANT USAGE ON SCHEMA public TO ptp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ptp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ptp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ptp_app;
