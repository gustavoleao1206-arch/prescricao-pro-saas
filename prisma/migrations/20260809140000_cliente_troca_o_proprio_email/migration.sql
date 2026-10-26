-- ---------------------------------------------------------------------------
-- Troca de e-mail pelo próprio cliente, com confirmação no endereço novo.
--
-- Por que existe: contratar passou a exigir e-mail confirmado, e trocar o e-mail
-- só era possível pelo atendimento. Com isso, um endereço digitado errado no
-- cadastro virava venda que não se completa até alguém do suporte agir.
--
-- `pendingEmail` guarda o endereço pedido enquanto ele não é confirmado. A troca
-- NÃO é aplicada em `email` na hora, e é essa espera que impede a conta de ser
-- apontada para um endereço que o cliente não controla — o que, num sistema em que
-- recuperação de senha e aviso de cobrança passam pelo e-mail, custaria a ele a
-- conta que pagou.
--
-- Sem UNIQUE: dois pedidos pendentes para o mesmo endereço não podem derrubar o
-- segundo com erro de banco. A unicidade que importa é a de `email`, que já existe
-- e é conferida de novo no momento de aplicar a troca.
-- ---------------------------------------------------------------------------
ALTER TABLE "User" ADD COLUMN "pendingEmail" TEXT;

-- Tipo de token do link enviado ao endereço NOVO. É ele que prova o controle do
-- destino: sem clicar, a troca não vale.
ALTER TYPE "TokenType" ADD VALUE 'TROCA_EMAIL';
