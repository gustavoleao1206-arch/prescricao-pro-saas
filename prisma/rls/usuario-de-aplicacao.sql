-- ============================================================================
-- Cria o usuário próprio da aplicação — o passo que faz a tranca do banco VALER.
--
-- ⚠️ ESTE ARQUIVO NÃO É EXECUTADO POR NINGUÉM AUTOMATICAMENTE.
-- Não é migração e não roda no boot, de propósito: mexer em usuário de banco
-- durante o start do contêiner arriscaria o site inteiro, e o comando de start
-- encadeia a migração ao `node server.js` com `&&`.
--
-- POR QUE PRECISA: o Postgres IGNORA política de RLS para o dono da tabela. A
-- aplicação conecta hoje como `prescricao_pro`, que é o dono. Enquanto isso não
-- mudar, as políticas instaladas ficam inertes — uma fechadura que não fecha.
--
-- COMO USAR (no painel do Render, Database → Connect → PSQL Command, ou pelo
-- Web Shell do serviço):
--
--   1. Gere uma senha forte no SEU gerenciador de senhas. Não reaproveite
--      nenhuma existente e não a cole em conversa nenhuma.
--   2. Substitua SENHA_AQUI abaixo e rode este arquivo.
--   3. Monte a URL nova trocando usuário e senha, mantendo host, porta e banco:
--        postgresql://prescricao_app:<senha>@<host>:<porta>/<banco>
--   4. No render.yaml, DATABASE_URL passa a ser `sync: false` (segredo) e o valor
--      é digitado no painel em DOIS serviços: o web e o cron de créditos.
--      ⚠️ Se for colado só no web, a rotina das 3h para de devolver crédito, de
--      madrugada, sem ninguém olhando.
--   5. Confirme rodando, no serviço, `npm run backup:verificar`: ele consulta o
--      banco com o usuário novo. Se as contagens vierem zeradas, alguma
--      permissão faltou — e é melhor descobrir assim do que pelo cliente.
--
-- O QUE ESTE USUÁRIO **NÃO** PODE: criar tabela, alterar schema, virar dono. É
-- isso que faz a política valer para ele. As migrações continuam rodando com o
-- usuário dono, como hoje.
-- ============================================================================

-- Cria só se faltar. Rodar de novo NÃO reescreve a senha: se o papel já existe e
-- este arquivo redefinisse a senha, a aplicação em produção perderia o acesso ao
-- banco no mesmo instante, com a senha do painel apontando para o valor antigo.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'prescricao_app') THEN
    CREATE ROLE prescricao_app WITH LOGIN PASSWORD 'SENHA_AQUI';
  END IF;
END
$$;

ALTER ROLE prescricao_app NOSUPERUSER NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE prescricao_pro TO prescricao_app;
GRANT USAGE ON SCHEMA public TO prescricao_app;

-- Só manipulação de dado. Nada de estrutura.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO prescricao_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO prescricao_app;

-- Tabelas criadas por migrações futuras já nascem acessíveis ao usuário da
-- aplicação. Sem isto, a primeira migração que criasse tabela derrubaria a
-- aplicação com "permission denied" — em produção, no deploy seguinte.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO prescricao_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO prescricao_app;
