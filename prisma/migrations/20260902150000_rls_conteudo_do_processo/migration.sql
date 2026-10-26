-- ============================================================================
-- Tranca no banco (Row Level Security) para o CONTEÚDO DOS PROCESSOS.
--
-- POR QUE: hoje o isolamento entre escritórios existe só na aplicação — toda
-- consulta filtra por organizationId na mão. Basta uma rota nova esquecer o
-- filtro, ou uma consulta crua mal escrita, para um cliente ler os autos de
-- outro. A tranca no banco é a segunda linha: mesmo que a aplicação erre, o
-- Postgres recusa a linha.
--
-- ⚠️ ESTA MIGRAÇÃO NÃO MUDA NADA EM PRODUÇÃO HOJE, DE PROPÓSITO.
-- Usa ENABLE, e não FORCE. O Postgres ignora política para o DONO da tabela, e
-- a aplicação conecta como dona (prescricao_pro). Portanto: as políticas ficam
-- instaladas e inertes, e só passam a valer quando a aplicação passar a conectar
-- com um usuário próprio — que é um passo separado, no painel do Render.
--
-- Isso é deliberado: migração de RLS roda no boot, encadeada ao start do site
-- com `&&`. Uma que falhe não derruba um recurso, derruba o site inteiro. Sem
-- FORCE, o pior caso aqui é "nada acontece".
--
-- COMO A TRANCA SABE QUEM ESTÁ CONSULTANDO: por duas variáveis de sessão que a
-- aplicação define dentro da transação (ver src/lib/inquilino.ts):
--   app.organizacao -> id do escritório dono das linhas
--   app.papel       -> 'servico' para os fluxos que NÃO têm inquilino
--
-- O papel de serviço não é conveniência: o webhook de pagamento do Asaas DESCOBRE
-- de quem é a cobrança consultando o banco, ou seja, ele não pode saber o
-- inquilino antes de consultar. Sem essa porta, a consulta voltaria vazia e o
-- cliente pagaria sem receber acesso — falha silenciosa, no dinheiro.
-- ============================================================================

-- ⚠️ À PROVA DE FALHA, e o motivo é cicatriz: esta migração roda no BOOT do
-- contêiner, encadeada ao start do site com `&&`. Uma migração que falhe não
-- derruba um recurso — derruba o site, com a mensagem inútil "Exited with status
-- 1 while running your code". Foi assim que a produção ficou 22 dias servindo um
-- build antigo (ver src/lib/db.ts).
--
-- `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` e `CREATE POLICY` exigem ser o DONO
-- da tabela. A aplicação conecta como `prescricao_pro`, que criou as tabelas e
-- portanto as possui — mas isso eu não consigo VERIFICAR daqui, e "deve estar
-- certo" é o que custou os 22 dias.
--
-- Então: erro de PERMISSÃO é capturado e vira aviso, e o deploy segue. O pior
-- caso passa a ser "a tranca não foi instalada" em vez de "o site caiu". Para o
-- silêncio não ser confortável, `npm run backup:verificar` confere se as sete
-- tabelas realmente têm a tranca ligada e acusa se não tiverem.
--
-- Qualquer OUTRO erro continua interrompendo: erro de sintaxe ou tabela ausente
-- é defeito meu, e tem de aparecer.

DO $migracao$
BEGIN
  -- Sem inquilino definido, devolve NULL: a comparação falha e nada é visível.
  CREATE OR REPLACE FUNCTION app_inquilino() RETURNS text
    LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.organizacao', true), '') $$;

  CREATE OR REPLACE FUNCTION app_e_servico() RETURNS boolean
    LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('app.papel', true), '') = 'servico' $$;

  -- ── Tabelas que carregam o dono direto ──────────────────────────────────────
  ALTER TABLE "Analysis" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY inquilino_analysis ON "Analysis" FOR ALL
    USING (app_e_servico() OR "organizationId" = app_inquilino())
    WITH CHECK (app_e_servico() OR "organizationId" = app_inquilino());

  ALTER TABLE "Document" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY inquilino_document ON "Document" FOR ALL
    USING (app_e_servico() OR "organizationId" = app_inquilino())
    WITH CHECK (app_e_servico() OR "organizationId" = app_inquilino());

  -- ── Tabelas que dependem do documento ───────────────────────────────────────
  -- DocumentPage não tem organizationId. Acrescentar a coluna exigiria reescrever
  -- a tabela inteira sob trava, num banco de 256 MB; a subconsulta custa uma busca
  -- por chave primária, que é barata, e não arrisca o acervo.
  ALTER TABLE "DocumentPage" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY inquilino_document_page ON "DocumentPage" FOR ALL
    USING (
      app_e_servico() OR EXISTS (
        SELECT 1 FROM "Document" d
        WHERE d.id = "DocumentPage"."documentId" AND d."organizationId" = app_inquilino()
      )
    )
    WITH CHECK (
      app_e_servico() OR EXISTS (
        SELECT 1 FROM "Document" d
        WHERE d.id = "DocumentPage"."documentId" AND d."organizationId" = app_inquilino()
      )
    );

  -- ── Tabelas que dependem da análise ─────────────────────────────────────────
  ALTER TABLE "Report" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY inquilino_report ON "Report" FOR ALL
    USING (
      app_e_servico() OR EXISTS (
        SELECT 1 FROM "Analysis" a
        WHERE a.id = "Report"."analysisId" AND a."organizationId" = app_inquilino()
      )
    )
    WITH CHECK (
      app_e_servico() OR EXISTS (
        SELECT 1 FROM "Analysis" a
        WHERE a.id = "Report"."analysisId" AND a."organizationId" = app_inquilino()
      )
    );

  ALTER TABLE "Petition" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY inquilino_petition ON "Petition" FOR ALL
    USING (
      app_e_servico() OR EXISTS (
        SELECT 1 FROM "Analysis" a
        WHERE a.id = "Petition"."analysisId" AND a."organizationId" = app_inquilino()
      )
    )
    WITH CHECK (
      app_e_servico() OR EXISTS (
        SELECT 1 FROM "Analysis" a
        WHERE a.id = "Petition"."analysisId" AND a."organizationId" = app_inquilino()
      )
    );

  ALTER TABLE "TimelineEvent" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY inquilino_timeline ON "TimelineEvent" FOR ALL
    USING (
      app_e_servico() OR EXISTS (
        SELECT 1 FROM "Analysis" a
        WHERE a.id = "TimelineEvent"."analysisId" AND a."organizationId" = app_inquilino()
      )
    )
    WITH CHECK (
      app_e_servico() OR EXISTS (
        SELECT 1 FROM "Analysis" a
        WHERE a.id = "TimelineEvent"."analysisId" AND a."organizationId" = app_inquilino()
      )
    );

  ALTER TABLE "LegalReview" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY inquilino_legal_review ON "LegalReview" FOR ALL
    USING (
      app_e_servico() OR EXISTS (
        SELECT 1 FROM "Analysis" a
        WHERE a.id = "LegalReview"."analysisId" AND a."organizationId" = app_inquilino()
      )
    )
    WITH CHECK (
      app_e_servico() OR EXISTS (
        SELECT 1 FROM "Analysis" a
        WHERE a.id = "LegalReview"."analysisId" AND a."organizationId" = app_inquilino()
      )
    );
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING 'RLS NAO INSTALADO: o usuario % nao tem permissao para ligar a tranca nas tabelas. O deploy segue; rode `npm run backup:verificar` para confirmar o estado.', current_user;
END
$migracao$;
