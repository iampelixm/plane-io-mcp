#!/usr/bin/env bash
# Интерактивная установка: конфиг проекта, токен Plane, глобальный plane-sync,
# запись MCP plane-sync в ~/.cursor/mcp.json (путь к этому клону).
set -euo pipefail

MCP_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCP_ENTRY="$MCP_ROOT/src/index.mjs"
CURSOR_MCP="$HOME/.cursor/mcp.json"
PLANE_ENV="$HOME/.config/plane-mcp.env"
PLANE_GLOBAL_DIR="$HOME/.config/plane-sync"
PLANE_GLOBAL_CFG="$PLANE_GLOBAL_DIR/config.json"
SERVER_NAME="plane-sync"

die() { echo "Ошибка: $*" >&2; exit 1; }

# NVM: без `source nvm.sh` команда `node` часто отсутствует в PATH (скрипт, cron, другой терминал).
load_nvm_if_present() {
  local d="${NVM_DIR:-$HOME/.nvm}"
  [[ -s "$d/nvm.sh" ]] || return 1
  # shellcheck disable=SC1090
  source "$d/nvm.sh"
  return 0
}

resolve_node_bin() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  if load_nvm_if_present && command -v node >/dev/null 2>&1; then
    echo "Подключён NVM ($NVM_DIR/nvm.sh), node: $(command -v node)" >&2
    command -v node
    return 0
  fi
  # Последний resort: явный путь под каталогом версий NVM (без загрузки nvm.sh)
  local root="${NVM_DIR:-$HOME/.nvm}/versions/node"
  if [[ -d "$root" ]]; then
    local best=""
    best="$(find "$root" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | LC_ALL=C sort -V | tail -n 1)"
    if [[ -n "$best" && -x "$best/bin/node" ]]; then
      echo "NVM: node не в PATH; используется $best/bin/node (обновите default: nvm alias default …)" >&2
      echo "$best/bin/node"
      return 0
    fi
  fi
  return 1
}

echo "=== Установка plane-io-mcp для Cursor ==="
echo "Каталог сервера: $MCP_ROOT"
echo

if [[ ! -f "$MCP_ENTRY" ]]; then
  die "не найден $MCP_ENTRY (запускайте скрипт из корня клона plane-io-mcp)."
fi

NODE_BIN=""
if ! NODE_BIN="$(resolve_node_bin)"; then
  die "не найден node. Установите Node.js 18+ или для NVM выполните в shell: source \"\${NVM_DIR:-\$HOME/.nvm}/nvm.sh\""
fi
[[ -x "$NODE_BIN" ]] || die "не исполняемый файл: $NODE_BIN"

read -rp "Путь к node для Cursor [${NODE_BIN}]: " NODE_ANS
NODE_BIN="${NODE_ANS:-$NODE_BIN}"
[[ -x "$NODE_BIN" ]] || die "не исполняемый файл: $NODE_BIN"

if [[ "$NODE_BIN" == *"/.nvm/"* ]] || [[ "$NODE_BIN" == *"/nvm/"* ]]; then
  echo "Подсказка: в mcp.json записан полный путь к node — так Cursor работает без NVM в своём PATH." >&2
fi

read -rp "Корень вашего Git-проекта (где лежит .git) [$(pwd)]: " PROJ_ANS
PROJECT_ROOT="${PROJ_ANS:-$PWD}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
[[ -d "$PROJECT_ROOT/.git" ]] || die "в $PROJECT_ROOT нет каталога .git — укажите корень репозитория."

DEFAULT_API="https://plane.summersite.ru/api/v1/"
read -rp "Базовый URL API Plane (с завершающим /) [${DEFAULT_API}]: " API_ANS
API_BASE="${API_ANS:-$DEFAULT_API}"
API_BASE="${API_BASE%/}/"

# baseUrl (веб-инстанс) — отрезаем хвост /api/v1/ или /api/
BASE_URL="${API_BASE%/}"
BASE_URL="${BASE_URL%/api/v1}"
BASE_URL="${BASE_URL%/api}"
BASE_URL="${BASE_URL%/}"

read -rp "Workspace slug (короткое имя в Plane): " WORKSPACE_SLUG
[[ -n "${WORKSPACE_SLUG// }" ]] || die "workspace slug не может быть пустым."

read -rp "Project ID (из Plane; можно оставить пустым, если ниже укажете slug): " PROJECT_ID
read -rp "Project slug (если Project ID пуст): " PROJECT_SLUG
if [[ -z "${PROJECT_ID// }" && -z "${PROJECT_SLUG// }" ]]; then
  die "нужен либо Project ID, либо Project slug."
fi

DEFAULT_BACKLOG="docs/todo/backlog.md"
read -rp "Путь к файлу беклога относительно корня репо [${DEFAULT_BACKLOG}]: " BL_ANS
BACKLOG_REL="${BL_ANS:-$DEFAULT_BACKLOG}"

echo
read -rsp "Plane API токен (PAT или plane_api_…): " PLANE_TOKEN
echo
[[ -n "${PLANE_TOKEN// }" ]] || die "токен не может быть пустым."

echo
read -rp "Запустить npm install в $MCP_ROOT? [Y/n]: " NPM_ANS
if [[ ! "${NPM_ANS:-y}" =~ ^[Nn]$ ]]; then
  (cd "$MCP_ROOT" && npm install)
fi

# --- Токен только в ~/.config (не в репозитории проекта) ---
mkdir -p "$(dirname "$PLANE_ENV")"
( umask 077; printf 'PLANE_TOKEN=%s\n' "$PLANE_TOKEN" >"$PLANE_ENV" )
chmod 600 "$PLANE_ENV"
echo "Записано: $PLANE_ENV"

# --- Глобальный конфиг plane-sync (без токена) ---
mkdir -p "$PLANE_GLOBAL_DIR"
export PLANE_GLOBAL_CFG
export API_BASE
export BASE_URL
node <<'NODE'
const fs = require("fs");
const p = process.env.PLANE_GLOBAL_CFG;
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(p, "utf8"));
} catch (_) {}
cfg.baseUrl = process.env.BASE_URL;
cfg.apiBaseUrl = process.env.API_BASE;
if (!cfg.auth) cfg.auth = { header: "Authorization", scheme: "Bearer" };
fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
NODE
echo "Записано: $PLANE_GLOBAL_CFG"

# --- .plane-sync.json в проекте ---
REPO_CFG="$PROJECT_ROOT/.plane-sync.json"
export REPO_CFG WORKSPACE_SLUG PROJECT_ID PROJECT_SLUG BACKLOG_REL
node <<'NODE'
const fs = require("fs");
const path = process.env.REPO_CFG;
const workspaceSlug = process.env.WORKSPACE_SLUG.trim();
const projectId = (process.env.PROJECT_ID || "").trim();
const projectSlug = (process.env.PROJECT_SLUG || "").trim();
const backlogFiles = [process.env.BACKLOG_REL.trim()];
const obj = {
  workspaceSlug,
  backlogFiles,
  detailsFile: "docs/todo/task-details.md",
  sections: { inbox: "Inbox", ready: "Ready", doing: "Doing", done: "Done" },
  mapping: { sectionToStateId: {} },
};
if (projectId) obj.projectId = projectId;
else if (projectSlug) obj.projectSlug = projectSlug;
fs.writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
NODE
echo "Записано: $REPO_CFG"

# --- Стартовый беклог ---
BACKLOG_ABS="$PROJECT_ROOT/$BACKLOG_REL"
mkdir -p "$(dirname "$BACKLOG_ABS")"
if [[ ! -f "$BACKLOG_ABS" ]]; then
  cat >"$BACKLOG_ABS" <<'MD'
# Backlog

## Inbox

## Ready

## Doing

## Done

MD
  echo "Создан файл беклога: $BACKLOG_ABS"
else
  echo "Беклог уже есть: $BACKLOG_ABS (не перезаписан)."
fi

GITIGNORE="$PROJECT_ROOT/.gitignore"
LINE_STATE=".plane-sync.state.json"
LINE_ENV=".env"
for line in "$LINE_STATE" "$LINE_ENV"; do
  if [[ -f "$GITIGNORE" ]]; then
    if ! grep -qxF "$line" "$GITIGNORE" 2>/dev/null; then
      printf '\n# plane-sync\n%s\n' "$line" >>"$GITIGNORE"
      echo "Добавлено в .gitignore: $line"
    fi
  else
    printf '# plane-sync\n%s\n%s\n' "$LINE_STATE" "$LINE_ENV" >"$GITIGNORE"
    echo "Создан $GITIGNORE"
  fi
done

# --- Cursor MCP ---
export CURSOR_MCP MCP_ENTRY NODE_BIN PLANE_ENV SERVER_NAME
node <<'NODE'
const fs = require("fs");
const path = require("path");
const mcpPath = process.env.CURSOR_MCP;
const entry = process.env.MCP_ENTRY;
const nodeBin = process.env.NODE_BIN;
const envFile = process.env.PLANE_ENV;
const name = process.env.SERVER_NAME;
let root = { mcpServers: {} };
try {
  root = JSON.parse(fs.readFileSync(mcpPath, "utf8"));
} catch (_) {}
if (!root.mcpServers || typeof root.mcpServers !== "object") root.mcpServers = {};
root.mcpServers[name] = {
  command: nodeBin,
  args: [entry],
  cwd: "${workspaceFolder}",
  envFile,
};
fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
fs.writeFileSync(mcpPath, JSON.stringify(root, null, 2) + "\n");
NODE
echo "Записано: $CURSOR_MCP (сервер «${SERVER_NAME}»)"

echo
echo "Готово. Перезапустите Cursor или отключите/включите MCP."
echo "Проверка: откройте проект $PROJECT_ROOT и вызовите инструмент plane_probe."
unset PLANE_TOKEN
