#!/usr/bin/env bash
#
# Configura a chave de IA no .env sem que ela passe pela tela ou pelo histórico.
#
# Uso:  ./scripts/configurar-chave.sh
#
# O provedor é deduzido do prefixo da chave:
#   sk-ant-...  -> Anthropic (Claude)
#   sk-...      -> OpenAI
#
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Erro: .env não encontrado em $(pwd)" >&2
  exit 1
fi

echo "Cole a chave e tecle Enter. Ela não aparece enquanto você digita."
printf "Chave: "

# Lê do terminal de controle (/dev/tty), não da entrada padrão. Sem isto, um
# terminal cuja stdin não é interativa — janela de IDE, execução com a entrada
# redirecionada — faz o read receber fim-de-arquivo na hora e o script sai
# calado, parecendo que nunca pediu a chave.
CHAVE=""
# Testa ABRIR o /dev/tty, não apenas a permissão: em terminal sem terminal de
# controle o arquivo existe e é legível, mas a abertura falha com
# "Device not configured".
if exec 3</dev/tty 2>/dev/null; then
  IFS= read -r -s CHAVE <&3 || true
  exec 3<&-
else
  IFS= read -r -s CHAVE || true
fi
echo

CHAVE="$(printf '%s' "$CHAVE" | tr -d '[:space:]')"

if [ -z "$CHAVE" ]; then
  echo "Nada foi colado. Nenhuma alteração feita." >&2
  exit 1
fi

case "$CHAVE" in
  sk-ant-*) PROVEDOR="anthropic"; CAMPO="ANTHROPIC_API_KEY" ;;
  sk-*)     PROVEDOR="openai";    CAMPO="OPENAI_API_KEY" ;;
  *)
    echo "Chave não reconhecida: deve começar com 'sk-ant-' (Anthropic) ou 'sk-' (OpenAI)." >&2
    echo "Nenhuma alteração feita." >&2
    exit 1
    ;;
esac

if [ ${#CHAVE} -lt 20 ]; then
  echo "A chave parece incompleta (${#CHAVE} caracteres). Nenhuma alteração feita." >&2
  exit 1
fi

# Backup antes de mexer, para nada se perder se algo der errado.
cp .env ".env.backup-$(date +%Y%m%d-%H%M%S)"

CHAVE="$CHAVE" CAMPO="$CAMPO" PROVEDOR="$PROVEDOR" python3 - <<'PY'
import os, re

chave = os.environ["CHAVE"]
campo = os.environ["CAMPO"]
provedor = os.environ["PROVEDOR"]

txt = open(".env").read()

def definir(texto, chave_env, valor):
    padrao = rf"^{re.escape(chave_env)}=.*$"
    if re.search(padrao, texto, flags=re.M):
        # lambda evita que \ ou & no valor sejam interpretados como escape.
        return re.sub(padrao, lambda _: f"{chave_env}={valor}", texto, flags=re.M)
    return texto.rstrip("\n") + f"\n{chave_env}={valor}\n"

txt = definir(txt, campo, chave)
txt = definir(txt, "AI_PROVIDER", provedor)
open(".env", "w").write(txt)

print(f"  ✓ {campo} gravada ({len(chave)} caracteres)")
print(f"  ✓ AI_PROVIDER = {provedor}")
PY

echo
echo "Pronto. Reinicie o servidor de desenvolvimento para a mudança valer."
