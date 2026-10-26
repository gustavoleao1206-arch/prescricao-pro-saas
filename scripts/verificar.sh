#!/usr/bin/env bash
#
# Verificação inicial — Prescrição Pro
# --------------------------------------------------------------------------
# Executa, na ordem correta, os checks do primeiro build e reporta o que
# precisa de ajuste. Tolerante a falhas: roda todos os passos possíveis e
# imprime um resumo ao final (não aborta no primeiro erro).
#
# Uso:
#   bash scripts/verificar.sh            # checks de código (sem banco)
#   bash scripts/verificar.sh --db       # inclui migração + seed (requer Postgres)
#   npm run verify                       # atalho equivalente
# --------------------------------------------------------------------------
set -uo pipefail

# Cores (desligadas se a saída não for um terminal).
if [ -t 1 ]; then
  RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; BLU=$'\033[34m'; BLD=$'\033[1m'; RST=$'\033[0m'
else
  RED=""; GRN=""; YLW=""; BLU=""; BLD=""; RST=""
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

WITH_DB=0
for arg in "$@"; do
  case "$arg" in
    --db|--with-db) WITH_DB=1 ;;
  esac
done

FAILS=0
WARNS=0
SUMMARY=""

section() { printf "\n${BLD}${BLU}==> %s${RST}\n" "$1"; }
add_ok()   { printf "  ${GRN}✓${RST} %s\n" "$1"; SUMMARY="${SUMMARY}
  ${GRN}✓${RST} $1"; }
add_warn() { printf "  ${YLW}!${RST} %s\n" "$1"; WARNS=$((WARNS+1)); SUMMARY="${SUMMARY}
  ${YLW}!${RST} $1"; }
add_fail() { printf "  ${RED}✗${RST} %s\n" "$1"; FAILS=$((FAILS+1)); SUMMARY="${SUMMARY}
  ${RED}✗${RST} $1"; }

printf "${BLD}Prescrição Pro — verificação inicial${RST}\n"
printf "Diretório: %s\n" "$ROOT"

# --------------------------------------------------------------------------
# 1. Pré-requisitos
# --------------------------------------------------------------------------
section "1. Pré-requisitos"

if ! command -v node >/dev/null 2>&1; then
  add_fail "Node.js não encontrado. Instale Node 20+ (https://nodejs.org) e rode novamente."
  printf "\n${RED}Interrompido: Node.js é obrigatório.${RST}\n"
  exit 1
fi
NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 20 ] 2>/dev/null; then
  add_warn "Node $(node -v) detectado — recomenda-se Node 20+."
else
  add_ok "Node $(node -v)"
fi

if command -v npm >/dev/null 2>&1; then add_ok "npm $(npm -v)"; else add_fail "npm não encontrado."; exit 1; fi
if command -v docker >/dev/null 2>&1; then add_ok "Docker disponível (para Postgres/Redis/MinIO opcionais)"; else add_warn "Docker ausente — use um Postgres próprio para banco/seed."; fi

# --------------------------------------------------------------------------
# 2. Ambiente (.env)
# --------------------------------------------------------------------------
section "2. Variáveis de ambiente (.env)"
if [ -f .env ]; then
  add_ok ".env presente"
else
  if [ -f .env.example ]; then
    cp .env.example .env
    add_warn "Criei .env a partir de .env.example — PREENCHA os segredos (AUTH_SECRET, FIELD_ENCRYPTION_KEY, DATABASE_URL, chave de IA...)."
  else
    add_fail ".env e .env.example ausentes."
  fi
fi
if [ -f .env ] && grep -qE "troque-por|SUA_CHAVE|=$|admin@prescricaopro.local" .env 2>/dev/null; then
  add_warn "Há valores de exemplo/placeholder em .env — revise antes de produção."
fi

# --------------------------------------------------------------------------
# 3. Dependências
# --------------------------------------------------------------------------
section "3. Dependências (npm install)"
if [ -d node_modules ]; then
  add_ok "node_modules presente (use 'npm ci' para reinstalar do zero, se necessário)"
else
  if npm install; then add_ok "npm install concluído"; else add_fail "npm install falhou."; fi
fi

# --------------------------------------------------------------------------
# 4. Prisma — validação e geração do client
# --------------------------------------------------------------------------
section "4. Prisma validate"
if npx --no-install prisma validate; then add_ok "Schema Prisma válido"; else add_fail "prisma validate falhou (corrija prisma/schema.prisma)."; fi

section "5. Prisma generate"
if npx --no-install prisma generate; then add_ok "Prisma Client gerado"; else add_fail "prisma generate falhou (necessário para o typecheck)."; fi

# --------------------------------------------------------------------------
# 6. Typecheck (TypeScript)
# --------------------------------------------------------------------------
section "6. Typecheck (tsc --noEmit)"
if npm run --silent typecheck; then add_ok "Sem erros de tipo"; else add_fail "Erros de tipo — veja a saída acima (esperado alguns ajustes no primeiro build)."; fi

# --------------------------------------------------------------------------
# 7. Testes (Vitest)
# --------------------------------------------------------------------------
section "7. Testes (vitest run)"
if npm run --silent test; then add_ok "Testes passaram (motor jurídico, cripto, RBAC, senha, 2FA, casos)"; else add_fail "Testes falharam — veja a saída acima."; fi

# --------------------------------------------------------------------------
# 8. (Opcional) Banco de dados — migração + seed
# --------------------------------------------------------------------------
if [ "$WITH_DB" -eq 1 ]; then
  section "8. Banco de dados (migração + seed)"
  if npx --no-install prisma migrate deploy; then
    add_ok "Migrações aplicadas"
    if npm run --silent db:seed; then add_ok "Seed de demonstração carregado (inclui base de conhecimento e casos de teste)"; else add_fail "Seed falhou."; fi
  else
    add_fail "prisma migrate deploy falhou — confira DATABASE_URL e se o Postgres está no ar (docker compose up -d)."
  fi
else
  section "8. Banco de dados (pulado)"
  add_warn "Migração/seed não executados. Rode com --db após configurar DATABASE_URL e subir o Postgres."
fi

# --------------------------------------------------------------------------
# Resumo
# --------------------------------------------------------------------------
printf "\n${BLD}${BLU}================ RESUMO ================${RST}"
printf "%b\n" "$SUMMARY"
printf "\n${BLD}Total:${RST} ${RED}%d falha(s)${RST}, ${YLW}%d aviso(s)${RST}\n" "$FAILS" "$WARNS"

printf "\n${BLD}Próximos passos:${RST}\n"
if [ "$FAILS" -eq 0 ]; then
  printf "  ${GRN}Tudo verde.${RST} Suba o ambiente e rode a aplicação:\n"
  printf "    docker compose up -d && npx prisma migrate dev && npm run db:seed && npm run dev\n"
  printf "  Login demo: cliente@prescricaopro.local / senha de SEED_DEMO_PASSWORD\n"
else
  printf "  Corrija os itens marcados com ${RED}✗${RST} acima. Dicas:\n"
  printf "    - typecheck: ajuste os tipos apontados (primeiro build pode exigir pequenos acertos).\n"
  printf "    - prisma:    confira prisma/schema.prisma e DATABASE_URL.\n"
  printf "    - testes:    a saída do vitest indica o caso que falhou.\n"
fi
printf "  Variáveis de produção (credenciais/segredos): veja .env.example\n\n"

# Código de saída: 0 se sem falhas, 1 caso contrário (útil em CI).
[ "$FAILS" -eq 0 ]
