#!/usr/bin/env bash
#
# GhostChat — one-command .onion launcher.
#
#   ./run.sh              build, start everything (GhostChat + Apache), launch public
#                         Chrome-accessible internet URLs & Tor services, and stay in foreground.
#   ./run.sh --detach     same, but return to the shell once the URLs are live.
#   ./run.sh --no-tunnel  skip public internet tunnel (LAN/Tor only).
#   ./run.sh --no-tor     skip Tor; serve on public tunnel and local network only.
#   ./run.sh --no-apache  start GhostChat only (do not start Apache).
#   ./run.sh --stop       stop everything this script started.
#   ./run.sh --clean      stop, then delete generated state (DB volume, onion keys).
#   ./run.sh --install-deps
#                         apt-get install missing system packages (tor, docker.io, apache2).
#
# Everything it creates lives under ./.ghostchat-state and ./.env. Nothing is
# written outside the repository except the Docker volumes and (optionally) apt
# packages you explicitly approve.
#
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

STATE_DIR="$ROOT/.ghostchat-state"
LOG_DIR="$STATE_DIR/logs"
RUN_DIR="$STATE_DIR/run"
TOR_DIR="$STATE_DIR/tor"
ENV_FILE="$ROOT/.env"

API_PORT="${API_PORT:-4000}"
WEB_PORT="${WEB_PORT:-3000}"
PROXY_PORT="${PROXY_PORT:-8080}"
APACHE_PORT="${APACHE_PORT:-80}"

MODE="foreground"
USE_TOR=1
USE_TUNNEL="${USE_TUNNEL:-1}"
START_APACHE=1
STARTED_APACHE=0
INSTALL_DEPS=0
FORCE_BUILD=0

# ---------------------------------------------------------------------------
# Output helpers & Banner
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  C_RESET=$'\033[0m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
else
  C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_BOLD=""
fi

status_line() {
  if [[ -t 1 ]]; then
    printf '\r\033[K  \033[1;38;2;56;189;248m●\033[0m \033[0;37m%s\033[0m' "$*"
  fi
}

clear_status() {
  if [[ -t 1 ]]; then
    printf '\r\033[K'
  fi
}

log()   { status_line "$*"; }
warn()  { clear_status; printf '%s[warning]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
fail()  { clear_status; printf '\n%s[error]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
dim()   { :; }

print_banner() {
  printf "\n"
  printf "           \033[38;2;230;240;255m███\033[0m                          \033[38;2;230;240;255m███\033[0m                 \033[38;2;230;240;255m███\033[0m                 \033[38;2;230;240;255m███\033[0m\n"
  printf "           \033[38;2;200;225;255m███\033[0m                          \033[38;2;200;225;255m███\033[0m                 \033[38;2;200;225;255m███\033[0m                 \033[38;2;200;225;255m███\033[0m\n"
  printf "    \033[38;2;150;200;255m█████  ███        █████    ██████ ████████       ██████ ███        █████  ████████\033[0m\n"
  printf "   \033[38;2;100;170;255m███████ ███       ███████  ███████   ███         ███████ ███       ███████   ███\033[0m\n"
  printf "  \033[38;2;59;130;246m███   ███ ███ ████ ███   ███ ███   ██   ███        ███   ██ ███ ████      ███   ███\033[0m\n"
  printf "  \033[38;2;37;99;235m███   ███ █████████ ███   ███  █████     ███        ███      █████████   ██████   ███\033[0m\n"
  printf "  \033[38;2;29;78;216m███   ███ ███  ███ ███   ███    █████   ███        ███      ███  ███  ███ ███   ███\033[0m\n"
  printf "   \033[38;2;67;56;202m████████ ███   ███ ███   ███ ██   ███   ███        ███   ██ ███   ███ ███  ███   ███\033[0m\n"
  printf "    \033[38;2;109;40;217m███████ ███   ███  ███████ ████████   ███ ██     ████████ ███   ███ ████████   ███ ██\033[0m\n"
  printf "        \033[38;2;147;51;234m███ ███   ███   █████   ██████     █████      ██████  ███   ███  ███████    █████\033[0m\n"
  printf "   \033[38;2;192;38;211m███████  ███   ███                                         ███   ███\033[0m\n"
  printf "    \033[38;2;217;70;239m█████\033[0m\n"
  printf "  \033[1;38;2;168;85;247m⚡ Developed By Nithin Palegar >\033[0m\n\n"
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --detach)       MODE="detach" ;;
    --foreground)   MODE="foreground" ;;
    --no-tor)       USE_TOR=0 ;;
    --no-tunnel)    USE_TUNNEL=0 ;;
    --no-apache)    START_APACHE=0 ;;
    --install-deps) INSTALL_DEPS=1 ;;
    --force-build)  FORCE_BUILD=1 ;;
    --stop)         MODE="stop" ;;
    --clean)        MODE="clean" ;;
    -h|--help)
      sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) fail "unknown argument: $arg (try --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Process bookkeeping
# ---------------------------------------------------------------------------
mkdir -p "$LOG_DIR" "$RUN_DIR" "$STATE_DIR/media"

declare -a STARTED=()

pid_file() { printf '%s/%s.pid' "$RUN_DIR" "$1"; }
need_cmd() { command -v "$1" >/dev/null 2>&1; }

record_pid() { printf '%s' "$2" > "$(pid_file "$1")"; }

is_running() {
  local name="$1" file
  file="$(pid_file "$name")"
  [[ -f "$file" ]] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

stop_one() {
  local name="$1" file pid
  file="$(pid_file "$name")"
  [[ -f "$file" ]] || return 0
  pid="$(cat "$file" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    log "stopping $name (pid $pid)"
    # SIGTERM first so Nest/Next can close sockets cleanly, then escalate.
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 20); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.25
    done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
}

is_apache_running() {
  (exec 3<>"/dev/tcp/127.0.0.1/$APACHE_PORT") 2>/dev/null
}

start_apache() {
  [[ "$START_APACHE" -eq 1 ]] || return 0
  if is_apache_running; then
    dim "apache is already running on port $APACHE_PORT"
    return 0
  fi

  log "starting apache server on port $APACHE_PORT"
  local started=0

  if [[ "$EUID" -eq 0 ]]; then
    mkdir -p /run/apache2 /var/log/apache2 /run/lock/apache2 2>/dev/null || true
    chown -R www-data:www-data /run/apache2 /var/log/apache2 /run/lock/apache2 2>/dev/null || true
    if need_cmd service; then
      service apache2 start >/dev/null 2>&1 && started=1
    fi
    if [[ "$started" -eq 0 ]] && [[ -x /etc/init.d/apache2 ]]; then
      /etc/init.d/apache2 start >/dev/null 2>&1 && started=1
    fi
    if [[ "$started" -eq 0 ]] && need_cmd apachectl; then
      apachectl start >/dev/null 2>&1 && started=1
    fi
  else
    if need_cmd sudo; then
      if sudo -n true 2>/dev/null; then
        sudo mkdir -p /run/apache2 /var/log/apache2 /run/lock/apache2 2>/dev/null || true
        sudo service apache2 start >/dev/null 2>&1 || sudo /etc/init.d/apache2 start >/dev/null 2>&1 || sudo apachectl start >/dev/null 2>&1 || true
      else
        sudo service apache2 start || sudo /etc/init.d/apache2 start || sudo apachectl start || true
      fi
    elif need_cmd apachectl; then
      apachectl start >/dev/null 2>&1 || true
    fi
  fi

  for _ in $(seq 1 10); do
    if is_apache_running; then
      STARTED_APACHE=1
      return 0
    fi
    sleep 0.5
  done

  if ! is_apache_running; then
    warn "apache did not answer on 127.0.0.1:$APACHE_PORT"
  else
    STARTED_APACHE=1
  fi
}

stop_apache() {
  if [[ "${STARTED_APACHE:-0}" -eq 1 ]]; then
    log "stopping apache"
    if [[ "$EUID" -eq 0 ]]; then
      service apache2 stop >/dev/null 2>&1 || /etc/init.d/apache2 stop >/dev/null 2>&1 || apachectl stop >/dev/null 2>&1 || true
    elif need_cmd sudo; then
      sudo service apache2 stop >/dev/null 2>&1 || sudo /etc/init.d/apache2 stop >/dev/null 2>&1 || sudo apachectl stop >/dev/null 2>&1 || true
    fi
    STARTED_APACHE=0
  fi
}

stop_all() {
  # Reverse start order: tunnels, tor, web, api, proxy, apache.
  stop_one tunnel_ghostchat
  stop_one tunnel_apache
  stop_one tunnel_pinggy
  stop_one tor
  stop_one web
  stop_one api
  stop_one proxy

  if need_cmd fuser; then
    fuser -k "${WEB_PORT}/tcp" "${API_PORT}/tcp" "${PROXY_PORT}/tcp" >/dev/null 2>&1 || true
  fi

  stop_apache

  if [[ -n "${DOCKER:-}" ]]; then
    $DOCKER compose stop postgres redis >/dev/null 2>&1 || true
  fi
}

detect_local_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [[ -z "$ip" ]]; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || true)"
  fi
  echo "${ip:-127.0.0.1}"
}

CLOUDFLARED_BIN=""
GHOSTCHAT_PUBLIC_URL=""
APACHE_PUBLIC_URL=""

ensure_cloudflared() {
  if need_cmd cloudflared; then
    CLOUDFLARED_BIN="$(command -v cloudflared)"
    return 0
  fi

  local local_bin="$STATE_DIR/bin/cloudflared"
  if [[ -x "$local_bin" ]]; then
    CLOUDFLARED_BIN="$local_bin"
    return 0
  fi

  mkdir -p "$STATE_DIR/bin"
  log "downloading cloudflared for public Chrome access..."
  local arch
  arch="$(uname -m)"
  local url=""
  case "$arch" in
    x86_64)        url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
    aarch64|arm64) url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
    armv7l|armhf)  url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm" ;;
    i386|i686)     url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-386" ;;
    *)             url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
  esac

  if curl -fsSL -o "$local_bin" "$url" 2>/dev/null; then
    chmod +x "$local_bin"
    CLOUDFLARED_BIN="$local_bin"
    if [[ "$EUID" -eq 0 ]] && [[ ! -f /usr/local/bin/cloudflared ]]; then
      cp "$local_bin" /usr/local/bin/cloudflared 2>/dev/null || true
    fi
    return 0
  fi

  return 1
}

start_tunnels() {
  [[ "$USE_TUNNEL" -eq 1 ]] || return 0

  if ensure_cloudflared; then
    log "starting Cloudflare Tunnel for GhostChat (public Chrome URL)..."
    "$CLOUDFLARED_BIN" tunnel --url "http://127.0.0.1:$PROXY_PORT" --no-autoupdate > "$LOG_DIR/tunnel-ghostchat.log" 2>&1 &
    record_pid tunnel_ghostchat $!
    STARTED+=("tunnel_ghostchat")

    if [[ "$START_APACHE" -eq 1 ]]; then
      log "starting Cloudflare Tunnel for Apache (public Chrome URL)..."
      "$CLOUDFLARED_BIN" tunnel --url "http://127.0.0.1:$APACHE_PORT" --no-autoupdate > "$LOG_DIR/tunnel-apache.log" 2>&1 &
      record_pid tunnel_apache $!
      STARTED+=("tunnel_apache")
    fi

    for _ in $(seq 1 35); do
      if [[ -z "$GHOSTCHAT_PUBLIC_URL" && -f "$LOG_DIR/tunnel-ghostchat.log" ]]; then
        GHOSTCHAT_PUBLIC_URL="$(grep -o 'https://[-a-zA-Z0-9.]*\.trycloudflare\.com' "$LOG_DIR/tunnel-ghostchat.log" | grep -v 'api.trycloudflare.com' | head -n 1 || true)"
      fi
      if [[ "$START_APACHE" -eq 1 && -z "$APACHE_PUBLIC_URL" && -f "$LOG_DIR/tunnel-apache.log" ]]; then
        APACHE_PUBLIC_URL="$(grep -o 'https://[-a-zA-Z0-9.]*\.trycloudflare\.com' "$LOG_DIR/tunnel-apache.log" | grep -v 'api.trycloudflare.com' | head -n 1 || true)"
      fi
      if [[ -n "$GHOSTCHAT_PUBLIC_URL" && ( "$START_APACHE" -eq 0 || -n "$APACHE_PUBLIC_URL" ) ]]; then
        break
      fi
      sleep 1
    done
  fi

  # Fallback to SSH tunnel (Pinggy) if Cloudflare didn't start and ssh is installed
  if [[ -z "$GHOSTCHAT_PUBLIC_URL" ]] && need_cmd ssh; then
    log "trying Pinggy tunnel fallback for Chrome URL..."
    ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R0:localhost:$PROXY_PORT a.pinggy.io > "$LOG_DIR/tunnel-pinggy.log" 2>&1 &
    record_pid tunnel_pinggy $!
    STARTED+=("tunnel_pinggy")
    for _ in $(seq 1 15); do
      GHOSTCHAT_PUBLIC_URL="$(grep -o 'https://[-a-zA-Z0-9.]*\.pinggy\.link' "$LOG_DIR/tunnel-pinggy.log" | head -n 1 || true)"
      [[ -n "$GHOSTCHAT_PUBLIC_URL" ]] && break
      sleep 1
    done
  fi
}

cleanup_on_exit() {
  local code=$?
  if [[ ${#STARTED[@]} -gt 0 && "$MODE" != "detach" ]]; then
    warn "shutting down (exit $code)"
    stop_all
  fi
}
trap cleanup_on_exit EXIT

handle_interrupt() {
  warn "interrupt received — shutting down"
  stop_all
  trap - EXIT
  exit 130
}
trap handle_interrupt INT
trap handle_interrupt TERM

# ---------------------------------------------------------------------------
# --stop / --clean
# ---------------------------------------------------------------------------
if [[ "$MODE" == "stop" ]]; then
  stop_all
  if need_cmd service; then
    if [[ "$EUID" -eq 0 ]]; then
      service apache2 stop >/dev/null 2>&1 || true
    elif need_cmd sudo; then
      sudo service apache2 stop >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "${DOCKER:-}" ]]; then
    $DOCKER compose stop postgres redis >/dev/null 2>&1 || true
  fi
  log "stopped"
  exit 0
fi

if [[ "$MODE" == "clean" ]]; then
  stop_all
  if need_cmd service; then
    if [[ "$EUID" -eq 0 ]]; then
      service apache2 stop >/dev/null 2>&1 || true
    elif need_cmd sudo; then
      sudo service apache2 stop >/dev/null 2>&1 || true
    fi
  fi
  if [[ -n "${DOCKER:-}" ]]; then
    $DOCKER compose down -v >/dev/null 2>&1 || true
  fi
  rm -rf "$STATE_DIR"
  warn "removed $STATE_DIR (onion keys are gone: the next run has a new address)"
  warn "kept .env — delete it yourself if you want fresh secrets"
  exit 0
fi

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
need_cmd() { command -v "$1" >/dev/null 2>&1; }

print_banner

if ! need_cmd node; then
  fail "node is not installed. Install Node.js >= 20 first."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || fail "Node 20+ required, found $(node -v)"

need_cmd npm || fail "npm is not installed"
need_cmd openssl || fail "openssl is required to generate secrets"
need_cmd curl || fail "curl is required for health checks"

MISSING=()
[[ "$USE_TOR" -eq 1 ]] && ! need_cmd tor && MISSING+=("tor")
if ! docker compose version >/dev/null 2>&1; then
  MISSING+=("docker.io docker-compose-plugin")
fi
if [[ "$START_APACHE" -eq 1 ]] && ! need_cmd apache2 && ! need_cmd apachectl; then
  MISSING+=("apache2")
fi

# Docker needs either group membership or sudo. Resolve that once, here, so the
# rest of the script never has to guess — and so the failure mode is a clear
# instruction instead of a wall of "permission denied" from a backgrounded step.
DOCKER=""
if need_cmd docker; then
  if docker info >/dev/null 2>&1; then
    DOCKER="docker"
  elif sudo -n docker info >/dev/null 2>&1; then
    DOCKER="sudo -n docker"
    dim "docker requires sudo: using 'sudo -n docker'"
  else
    DOCKER=""
  fi
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  if [[ "$INSTALL_DEPS" -eq 1 ]]; then
    need_cmd apt-get || fail "cannot install ${MISSING[*]}: apt-get not available"
    log "installing: ${MISSING[*]}"
    sudo apt-get update -qq
    # shellcheck disable=SC2086
    sudo apt-get install -y --no-install-recommends ${MISSING[*]}
    if [[ "$USE_TOR" -eq 1 ]] && ! need_cmd tor; then
      fail "tor installation did not succeed"
    fi
  else
    warn "missing: ${MISSING[*]}"
    cat >&2 <<EOF

  Install them and re-run:

      sudo apt-get update && sudo apt-get install -y tor docker.io docker-compose-plugin

  Or let this script do it:

      ./run.sh --install-deps

  To run without Tor (LAN/localhost only):

      ./run.sh --no-tor

EOF
    [[ "$USE_TOR" -eq 1 ]] && fail "cannot publish a .onion without tor"
  fi
fi

if [[ -z "$DOCKER" ]]; then
  warn "docker is installed but not usable by this user."
  cat >&2 <<'EOF'
  Either join the docker group (then log out and back in):

      sudo usermod -aG docker "$USER"

  or run this script with sudo, which the datastore step will then use
  automatically:

      sudo -E ./run.sh
EOF
  warn "falling back to already-running Postgres/Redis/MinIO"
fi

# ---------------------------------------------------------------------------
# Secrets / .env
# ---------------------------------------------------------------------------
rand() { openssl rand -base64 36 | tr -d '\n=+/' | cut -c1-40; }

if [[ ! -f "$ENV_FILE" ]]; then
  log "generating $ENV_FILE with fresh secrets"

  PG_PASS="$(rand)"
  REDIS_PASS="$(rand)"

  umask 077
  cat > "$ENV_FILE" <<EOF
# Generated by run.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Contains live secrets. Do not commit.

NODE_ENV=production

POSTGRES_USER=ghostchat
POSTGRES_PASSWORD=$PG_PASS
POSTGRES_DB=ghostchat
DATABASE_URL=postgresql://ghostchat:$PG_PASS@127.0.0.1:5432/ghostchat?schema=public

REDIS_PASSWORD=$REDIS_PASS
REDIS_URL=redis://:$REDIS_PASS@127.0.0.1:6379

SESSION_SECRET=$(rand)
SEALED_SENDER_PEPPER=$(rand)
ADMIN_BOOTSTRAP_KEY=$(rand)

PORT=$API_PORT
CORS_ORIGIN=http://127.0.0.1:$PROXY_PORT
PUBLIC_API_URL=http://127.0.0.1:$PROXY_PORT
COOKIE_DOMAIN=
# Onion service is plain HTTP at the application layer: a Secure cookie would
# never be sent back, so the session would silently never persist.
COOKIE_SECURE=false

SESSION_TTL_SECONDS=43200
SESSION_IDLE_SECONDS=1800
RATE_LIMIT_DISABLED=false

# Media defaults to local disk under .ghostchat-state/media: no external
# object store, no extra container, nothing to pull. Switch to 's3' and set the
# S3_* values below to use AWS S3, Ceph RGW, Garage, SeaweedFS, etc.
MEDIA_DRIVER=local
MEDIA_DIR=$STATE_DIR/media
MEDIA_MAX_BYTES=26214400

S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=ghostchat-media
S3_ACCESS_KEY=
S3_SECRET_KEY=
S3_FORCE_PATH_STYLE=true

# Tor cannot carry UDP, so TURN is unusable over an onion address. Calls fall
# back to direct WebRTC where the network allows it.
TURN_URLS=
TURN_SHARED_SECRET=
TURN_CREDENTIAL_TTL=3600

MEDIASOUP_ENABLED=false

# Same-origin: the browser must never be told to call localhost.
NEXT_PUBLIC_API_URL=/api
NEXT_PUBLIC_WS_URL=
NEXT_PUBLIC_TURN_URLS=
NEXT_TELEMETRY_DISABLED=1
EOF
  umask 022
  log "wrote $ENV_FILE (mode 600)"
else
  dim "using existing $ENV_FILE"
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

# The onion deployment always wants same-origin, whatever the file says.
export NEXT_PUBLIC_API_URL="/api"
# Media lives on local disk unless an operator deliberately switches to S3.
export MEDIA_DRIVER="${MEDIA_DRIVER:-local}"
export MEDIA_DIR="${MEDIA_DIR:-$STATE_DIR/media}"
mkdir -p "$MEDIA_DIR"
export NODE_ENV="${NODE_ENV:-production}"
export NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------------------
# Datastores
# ---------------------------------------------------------------------------
if [[ -n "$DOCKER" ]]; then
  log "starting postgres, redis..."
  # Object storage is intentionally absent: media defaults to local disk, which
  # needs no registry and cannot be pulled out from under a running deployment.
  $DOCKER compose up -d postgres redis >/dev/null 2>&1

  for i in $(seq 1 90); do
    if $DOCKER compose exec -T postgres pg_isready -U "${POSTGRES_USER:-ghostchat}" >/dev/null 2>&1; then
      break
    fi
    [[ "$i" -eq 90 ]] && fail "postgres did not become ready"
    sleep 1
  done

else
  warn "skipping container startup (no docker compose)"
  for port in 5432 6379; do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      fail "nothing listening on 127.0.0.1:$port (start Postgres and Redis, or install docker)"
    fi
  done
fi

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
if [[ ! -d node_modules ]] || [[ "$FORCE_BUILD" -eq 1 ]]; then
  log "installing npm dependencies..."
  npm install --include=dev --no-audit --no-fund > "$LOG_DIR/npm-install.log" 2>&1 || fail "npm install failed — see $LOG_DIR/npm-install.log"
fi

if [[ ! -x node_modules/.bin/tsc ]]; then
  log "installing TypeScript build tools..."
  npm install --include=dev --no-audit --no-fund typescript@^5.7.2 > "$LOG_DIR/npm-install.log" 2>&1 || fail "typescript install failed — see $LOG_DIR/npm-install.log"
fi

log "building shared packages..."
npm run build -w @ghostchat/shared-types >/dev/null 2>&1 || fail "shared-types build failed"
npm run build -w @ghostchat/crypto >/dev/null 2>&1 || fail "crypto build failed"

log "generating prisma client..."
npx prisma generate --schema apps/api/prisma/schema.prisma >/dev/null 2>&1 || fail "prisma generate failed"

log "applying database schema..."
if compgen -G "apps/api/prisma/migrations/*" >/dev/null; then
  npx prisma migrate deploy --schema apps/api/prisma/schema.prisma >/dev/null 2>&1 || fail "prisma migrate failed"
else
  # No migration history yet: push the schema directly. Idempotent.
  npx prisma db push --skip-generate --accept-data-loss --schema apps/api/prisma/schema.prisma >/dev/null 2>&1 || fail "prisma db push failed"
fi

log "building api..."
npm run build -w @ghostchat/api >/dev/null 2>&1 || fail "api build failed"

WEB_NEED_BUILD=0
if [[ "$FORCE_BUILD" -eq 1 ]] || [[ ! -f apps/web/.next/BUILD_ID ]]; then
  WEB_NEED_BUILD=1
else
  if [[ -n "$(find apps/web/src apps/web/next.config.js apps/web/package.json -newer apps/web/.next/BUILD_ID 2>/dev/null | head -n 1)" ]]; then
    WEB_NEED_BUILD=1
  fi
fi

if [[ "$WEB_NEED_BUILD" -eq 1 ]]; then
  log "building web (this takes a minute)..."
  rm -rf apps/web/.next
  ( cd apps/web && npx next build ) > "$LOG_DIR/web-build.log" 2>&1 || {
    tail -n 25 "$LOG_DIR/web-build.log" >&2
    fail "web build failed — see $LOG_DIR/web-build.log"
  }
  [[ -f apps/web/.next/BUILD_ID ]] || fail "web build did not produce a production build"
  if [[ -n "${SUDO_UID:-}" && -n "${SUDO_GID:-}" ]]; then
    chown -R "$SUDO_UID:$SUDO_GID" apps/web/.next 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# Runtime processes
# ---------------------------------------------------------------------------
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# Remove stale child listeners left by a previous interrupted run.
if need_cmd fuser; then
  for port in "$API_PORT" "$WEB_PORT" "$PROXY_PORT"; do
    if port_busy "$port"; then
      fuser -k "$port/tcp" >/dev/null 2>&1 || true
    fi
  done
fi

for port in "$API_PORT" "$WEB_PORT" "$PROXY_PORT"; do
  if port_busy "$port"; then
    fail "port $port is already in use. Stop the other process, or set API_PORT/WEB_PORT/PROXY_PORT."
  fi
done

wait_for_http() {
  local url="$1" name="$2" tries="${3:-120}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      return 0
    fi
    if [[ -n "$name" && "$name" != "proxy" && "$name" != "app" ]] && ! is_running "$name"; then
      warn "$name exited unexpectedly — see $LOG_DIR/$name.log"
      tail -n 15 "$LOG_DIR/$name.log" 2>/dev/null || true
      return 1
    fi
    sleep 1
  done
  warn "$name did not answer at $url"
  return 1
}

log "starting api"
node apps/api/dist/main.js > "$LOG_DIR/api.log" 2>&1 &
record_pid api $!
STARTED+=("api")
wait_for_http "http://127.0.0.1:$API_PORT/api/health" "api" 90 \
  || fail "api failed to start — see $LOG_DIR/api.log"

log "starting web"
( cd apps/web && PORT="$WEB_PORT" npx next start -p "$WEB_PORT" ) \
  > "$LOG_DIR/web.log" 2>&1 &
record_pid web $!
STARTED+=("web")
wait_for_http "http://127.0.0.1:$WEB_PORT/" "web" 90 \
  || fail "web failed to start — see $LOG_DIR/web.log"

log "starting proxy on 127.0.0.1:$PROXY_PORT"
PROXY_PORT="$PROXY_PORT" WEB_TARGET="http://127.0.0.1:$WEB_PORT" API_TARGET="http://127.0.0.1:$API_PORT" \
  node infra/onion-proxy.mjs > "$LOG_DIR/proxy.log" 2>&1 &
record_pid proxy $!
STARTED+=("proxy")
wait_for_http "http://127.0.0.1:$PROXY_PORT/api/health" "proxy" 30 \
  || fail "proxy failed to start — see $LOG_DIR/proxy.log"

# ---------------------------------------------------------------------------
# Apache web server
# ---------------------------------------------------------------------------
start_apache

# ---------------------------------------------------------------------------
# Tor hidden service
# ---------------------------------------------------------------------------
ONION_ADDRESS=""
APACHE_ONION_ADDRESS=""

if [[ "$USE_TOR" -eq 1 ]]; then
  mkdir -p "$TOR_DIR/data" "$TOR_DIR/hs" "$TOR_DIR/hs_apache"
  chmod 700 "$TOR_DIR/data" "$TOR_DIR/hs" "$TOR_DIR/hs_apache"

  TORRC="$TOR_DIR/torrc"
  cat > "$TORRC" <<EOF
# Generated by run.sh — not part of the repository.
DataDirectory $TOR_DIR/data
SocksPort 0
ControlPort 0
RunAsDaemon 0
Log notice file $TOR_DIR/tor.log

# GhostChat Service
HiddenServiceDir $TOR_DIR/hs
HiddenServicePort 80 127.0.0.1:$PROXY_PORT
HiddenServicePort 8080 127.0.0.1:$APACHE_PORT

# Apache Web Server (dedicated onion address on standard port 80)
HiddenServiceDir $TOR_DIR/hs_apache
HiddenServicePort 80 127.0.0.1:$APACHE_PORT

ClientUseIPv6 0
EOF

  log "starting tor hidden services (ghostchat + apache)"
  tor -f "$TORRC" > "$LOG_DIR/tor.out" 2>&1 &
  record_pid tor $!
  STARTED+=("tor")

  for i in $(seq 1 60); do
    if [[ -s "$TOR_DIR/hs/hostname" ]]; then
      ONION_ADDRESS="$(tr -d '[:space:]' < "$TOR_DIR/hs/hostname")"
      ONION_ADDRESS="${ONION_ADDRESS%.onion}"
    fi
    if [[ -s "$TOR_DIR/hs_apache/hostname" ]]; then
      APACHE_ONION_ADDRESS="$(tr -d '[:space:]' < "$TOR_DIR/hs_apache/hostname")"
      APACHE_ONION_ADDRESS="${APACHE_ONION_ADDRESS%.onion}"
    fi
    if [[ -n "$ONION_ADDRESS" && ( "$START_APACHE" -eq 0 || -n "$APACHE_ONION_ADDRESS" ) ]]; then
      break
    fi
    if ! is_running tor; then
      warn "tor exited — see $LOG_DIR/tor.out"
      break
    fi
    sleep 1
  done

  [[ -n "$ONION_ADDRESS" ]] || fail "tor did not publish a hidden service address"
fi

# ---------------------------------------------------------------------------
# Public Internet Tunnels (Chrome / Regular Browser Access)
# ---------------------------------------------------------------------------
start_tunnels

# ---------------------------------------------------------------------------
# Verify the app actually serves through the proxy
# ---------------------------------------------------------------------------
if ! wait_for_http "http://127.0.0.1:$PROXY_PORT/" "app" 30; then
  fail "proxy cannot reach the web app — see $LOG_DIR/web.log"
fi

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
LOCAL_IP="$(detect_local_ip)"
clear_status

printf '\n'
printf '  \033[1;38;2;147;197;253m╭────────────────────────────────────────────────────────────────────────────╮\033[0m\n'
printf '  \033[1;38;2;147;197;253m│\033[0m  \033[1;38;2;52;211;153m🌐 PUBLIC INTERNET ACCESS \033[0;2;37m(Open in Chrome, Safari, Edge, Mobile - No Tor)\033[0m   \033[1;38;2;147;197;253m│\033[0m\n'
printf '  \033[1;38;2;147;197;253m╰────────────────────────────────────────────────────────────────────────────╯\033[0m\n'
if [[ -n "$GHOSTCHAT_PUBLIC_URL" ]]; then
  printf '    \033[1;38;2;56;189;248m● GhostChat App   :\033[0m  \033[1;4;38;2;56;189;248m%s\033[0m\n' "$GHOSTCHAT_PUBLIC_URL"
  printf '    \033[1;38;2;168;85;247m● Admin Portal    :\033[0m  \033[1;4;38;2;168;85;247m%s/admin\033[0m\n' "$GHOSTCHAT_PUBLIC_URL"
fi
if [[ -n "$APACHE_PUBLIC_URL" ]]; then
  printf '    \033[1;38;2;52;211;153m● Apache Server   :\033[0m  \033[1;4;38;2;52;211;153m%s\033[0m\n' "$APACHE_PUBLIC_URL"
fi

if [[ "$LOCAL_IP" != "127.0.0.1" ]]; then
  printf '\n  \033[1;38;2;56;189;248m🏠 LOCAL NETWORK \033[0;2;37m(Same Wi-Fi / LAN in Chrome)\033[0m\n'
  printf '    \033[1;37m● GhostChat LAN   :\033[0m  \033[1;4;38;2;56;189;248mhttp://%s:%s\033[0m\n' "$LOCAL_IP" "$PROXY_PORT"
  if is_apache_running; then
    printf '    \033[1;37m● Apache LAN      :\033[0m  \033[1;4;38;2;52;211;153mhttp://%s:%s\033[0m\n' "$LOCAL_IP" "$APACHE_PORT"
  fi
fi

if [[ -n "$ONION_ADDRESS" ]]; then
  printf '\n  \033[1;38;2;217;70;239m🧅 TOR HIDDEN SERVICE \033[0;2;37m(Tor Browser & Clearnet Web Proxy)\033[0m\n'
  printf '    \033[1;37m● GhostChat Onion :\033[0m  \033[1;38;2;217;70;239mhttp://%s.onion\033[0m\n' "$ONION_ADDRESS"
  printf '    \033[0;2;37m● Chrome Mirror   :\033[0m  \033[4;38;2;168;85;247mhttps://%s.onion.pet\033[0m\n' "$ONION_ADDRESS"
  if [[ -n "$APACHE_ONION_ADDRESS" ]]; then
    printf '    \033[1;37m● Apache Onion    :\033[0m  \033[1;38;2;217;70;239mhttp://%s.onion\033[0m\n' "$APACHE_ONION_ADDRESS"
  fi
fi

printf '\n  \033[1;38;2;129;140;248m⚙️  CONTROLS & STATUS\033[0m\n'
printf '    \033[0;2;37m● Localhost       :\033[0m  http://127.0.0.1:%s (GhostChat) | http://127.0.0.1:%s (Apache)\n' "$PROXY_PORT" "$APACHE_PORT"
printf '    \033[0;2;37m● Stop GhostChat  :\033[0m  \033[1;33m./run.sh --stop\033[0m\n'
printf '    \033[0;2;37m● Logs Directory  :\033[0m  %s\n' "$LOG_DIR"
printf '\n'

if [[ "$MODE" == "detach" ]]; then
  printf '  \033[0;2;37mRunning detached. Use \033[1;33m./run.sh --stop\033[0;2;37m to shut down.\033[0m\n\n'
  STARTED=()   # do not stop on exit
  exit 0
fi

printf '  \033[0;2;37mPress \033[1;37mCtrl-C\033[0;2;37m to stop.\033[0m\n\n'
while true; do
  for name in api web proxy tor tunnel_ghostchat tunnel_apache; do
    if [[ -f "$(pid_file "$name")" ]] && ! is_running "$name"; then
      if [[ "$name" == tunnel* ]]; then
        log_file="$LOG_DIR/${name//_/-}.log"
        warn "$name tunnel disconnected (auto-reconnecting...) — see $log_file"
        rm -f "$(pid_file "$name")"
        if [[ "$USE_TUNNEL" -eq 1 && -n "${CLOUDFLARED_BIN:-}" && -x "${CLOUDFLARED_BIN:-}" ]]; then
          sleep 3
          if [[ "$name" == "tunnel_ghostchat" ]]; then
            "$CLOUDFLARED_BIN" tunnel --url "http://127.0.0.1:$PROXY_PORT" --no-autoupdate > "$LOG_DIR/tunnel-ghostchat.log" 2>&1 &
            record_pid tunnel_ghostchat $!
          elif [[ "$name" == "tunnel_apache" && "$START_APACHE" -eq 1 ]]; then
            "$CLOUDFLARED_BIN" tunnel --url "http://127.0.0.1:$APACHE_PORT" --no-autoupdate > "$LOG_DIR/tunnel-apache.log" 2>&1 &
            record_pid tunnel_apache $!
          fi
        fi
      else
        warn "$name exited unexpectedly — last lines:"
        tail -n 15 "$LOG_DIR/$name.log" 2>/dev/null || true
        exit 1
      fi
    fi
  done
  sleep 5
done
