#!/usr/bin/env bash
# =============================================================================
#  LLM Load Test — one-click installer untuk Ubuntu / Debian
#
#  Pemakaian:
#    sudo ./install.sh                     # install + jalankan sebagai service
#    sudo ./install.sh --port 9000
#    sudo ./install.sh --no-auth           # tanpa Basic Auth (hati-hati!)
#    sudo ./install.sh --uninstall         # lepas service (data tetap ada)
#    sudo ./install.sh --uninstall --purge # hapus service + semua data
#
#  Bisa juga langsung dari internet:
#    curl -fsSL https://raw.githubusercontent.com/keplia/llm-loadtest/main/install.sh | sudo bash
# =============================================================================
set -euo pipefail

REPO_SLUG="keplia/llm-loadtest"
BRANCH="${BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/llm-loadtest}"
SERVICE_NAME="llm-loadtest"
PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"
AUTH_USER="${AUTH_USER:-admin}"
AUTH_PASS="${AUTH_PASS:-}"
ENABLE_AUTH="${ENABLE_AUTH:-1}"
NO_SERVICE=0
UNINSTALL=0
PURGE=0

# ------------------------------------------------------------------ helpers --
c_reset=$'\033[0m'; c_bold=$'\033[1m'; c_blue=$'\033[38;5;75m'
c_green=$'\033[38;5;78m'; c_yellow=$'\033[38;5;221m'; c_red=$'\033[38;5;203m'

info()  { printf '%s→%s %s\n' "$c_blue" "$c_reset" "$*"; }
ok()    { printf '%s✓%s %s\n' "$c_green" "$c_reset" "$*"; }
warn()  { printf '%s!%s %s\n' "$c_yellow" "$c_reset" "$*"; }
die()   { printf '%s✗%s %s\n' "$c_red" "$c_reset" "$*" >&2; exit 1; }

usage() {
  cat <<EOF
LLM Load Test installer

  --port N          Port dashboard (default: 8787)
  --dir PATH        Direktori instalasi (default: /opt/llm-loadtest)
  --host ADDR       Alamat bind (default: 0.0.0.0)
  --user NAME       Username Basic Auth (default: admin)
  --pass PASS       Password Basic Auth (default: dibuat acak)
  --no-auth         Nonaktifkan Basic Auth
  --no-service      Jangan buat service systemd, cukup siapkan file
  --uninstall       Hentikan & hapus service systemd
  --purge           Saat --uninstall: hapus juga direktori aplikasi
  -h, --help        Tampilkan bantuan ini
EOF
}

# ------------------------------------------------------------------- args ----
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)        PORT="${2:?--port butuh nilai}"; shift 2 ;;
    --dir)         APP_DIR="${2:?--dir butuh nilai}"; shift 2 ;;
    --host)        HOST="${2:?--host butuh nilai}"; shift 2 ;;
    --user)        AUTH_USER="${2:?--user butuh nilai}"; shift 2 ;;
    --pass)        AUTH_PASS="${2:?--pass butuh nilai}"; shift 2 ;;
    --no-auth)     ENABLE_AUTH=0; shift ;;
    --no-service)  NO_SERVICE=1; shift ;;
    --uninstall)   UNINSTALL=1; shift ;;
    --purge)       PURGE=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "Argumen tidak dikenal: $1 (pakai --help)" ;;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT > 0 && PORT < 65536 )) || die "Port tidak valid: $PORT"

# --------------------------------------------------------------- root check --
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  die "Installer harus dijalankan sebagai root. Coba: sudo bash $0 ${*:-}"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  die "Installer ini untuk sistem berbasis apt (Ubuntu/Debian). Untuk distro lain, lihat README (instal manual)."
fi

# ---------------------------------------------------------------- uninstall ---
if [[ "$UNINSTALL" -eq 1 ]]; then
  info "Menghentikan service $SERVICE_NAME…"
  systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload || true
  ok "Service dihapus."
  if [[ "$PURGE" -eq 1 ]]; then
    rm -rf "$APP_DIR"
    ok "Direktori $APP_DIR dihapus."
  else
    info "Data & konfigurasi tetap di $APP_DIR (pakai --purge untuk menghapus)."
  fi
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive

# --------------------------------------------------------------- base tools --
info "Menyiapkan paket dasar…"
apt-get update -qq
apt-get install -y -qq curl ca-certificates tar gzip rsync procps >/dev/null

# --------------------------------------------------------------------- node --
node_ok=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if (( node_major >= 20 )); then node_ok=1; fi
fi
if (( node_ok == 1 )); then
  ok "Node.js $(node -v) sudah terpasang."
else
  info "Memasang Node.js 22 LTS…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  ok "Node.js $(node -v) terpasang."
fi

# ----------------------------------------------------------------------- k6 --
if command -v k6 >/dev/null 2>&1; then
  ok "k6 $(k6 version | awk '{print $2}') sudah terpasang."
else
  info "Memasang k6…"
  case "$(uname -m)" in
    x86_64|amd64) k6_arch="amd64" ;;
    aarch64|arm64) k6_arch="arm64" ;;
    *) die "Arsitektur $(uname -m) belum didukung installer otomatis." ;;
  esac
  k6_ver="$(curl -fsSL https://api.github.com/repos/grafana/k6/releases/latest \
    | grep -m1 '"tag_name"' | sed -E 's/.*"v?([0-9][^"]*)".*/\1/')"
  [[ -n "$k6_ver" ]] || die "Gagal menentukan versi k6 terbaru."
  k6_tmp="$(mktemp -d)"
  curl -fsSL "https://github.com/grafana/k6/releases/download/v${k6_ver}/k6-v${k6_ver}-linux-${k6_arch}.tar.gz" \
    | tar xz -C "$k6_tmp"
  install -m 755 "$k6_tmp/k6-v${k6_ver}-linux-${k6_arch}/k6" /usr/local/bin/k6
  rm -rf "$k6_tmp"
  ok "k6 $(k6 version | awk '{print $2}') terpasang."
fi

# ------------------------------------------------------------- ambil source --
src_dir=""
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  candidate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -f "$candidate/server.js" ]]; then src_dir="$candidate"; fi
fi

cleanup_src=""
if [[ -z "$src_dir" ]]; then
  info "Mengunduh source dari GitHub (${REPO_SLUG})…"
  src_dir="$(mktemp -d)"
  cleanup_src="$src_dir"
  curl -fsSL "https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${BRANCH}" \
    | tar xz -C "$src_dir" --strip-components=1
fi
[[ -f "$src_dir/server.js" ]] || die "Source tidak lengkap: server.js tidak ditemukan."

info "Menyalin aplikasi ke ${APP_DIR}…"
mkdir -p "$APP_DIR"
(cd "$src_dir" && tar cf - \
  --exclude=./runs --exclude=./.git --exclude=./node_modules \
  --exclude=./.auth.env --exclude=./.access.txt .) \
  | (cd "$APP_DIR" && tar xf -)
mkdir -p "$APP_DIR/runs"
chmod +x "$APP_DIR/start-public.sh" 2>/dev/null || true
[[ -n "$cleanup_src" ]] && rm -rf "$cleanup_src"

# ------------------------------------------------------------------- auth ----
if [[ "$ENABLE_AUTH" -eq 1 ]]; then
  if [[ -f "$APP_DIR/.auth.env" ]]; then
    set -a; . "$APP_DIR/.auth.env"; set +a
    AUTH_USER="${AUTH_USER:-admin}"
    ok "Basic Auth sudah ada (user: ${AUTH_USER})."
    generated=0
  else
    if [[ -z "$AUTH_PASS" ]]; then
      AUTH_PASS="$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 14)"
    fi
    printf 'AUTH_USER=%s\nAUTH_PASS=%s\n' "$AUTH_USER" "$AUTH_PASS" > "$APP_DIR/.auth.env"
    chmod 600 "$APP_DIR/.auth.env"
    ok "Basic Auth dibuat (user: ${AUTH_USER})."
    generated=1
  fi
else
  rm -f "$APP_DIR/.auth.env"
  warn "Basic Auth NONAKTIF — siapa pun yang bisa menjangkau port ini dapat memakainya."
  generated=0
fi

# ------------------------------------------------------------------ service --
if [[ "$NO_SERVICE" -eq 1 ]]; then
  info "Melewati pembuatan service (--no-service)."
else
  info "Membuat service systemd ${SERVICE_NAME}…"
  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=LLM Load Test dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/start-public.sh
Environment=PORT=${PORT}
Environment=HOST=${HOST}
Restart=on-failure
RestartSec=3
User=root

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME" >/dev/null 2>&1 || systemctl restart "$SERVICE_NAME"
  ok "Service ${SERVICE_NAME} aktif dan otomatis jalan saat boot."
fi

# ------------------------------------------------------------------ firewall -
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  if ufw allow "${PORT}/tcp" >/dev/null 2>&1; then
    ok "Firewall ufw: port ${PORT}/tcp dibuka."
  fi
fi

# ------------------------------------------------------------- health check --
health_url="http://127.0.0.1:${PORT}/api/health"
curl_auth=()
if [[ "$ENABLE_AUTH" -eq 1 ]]; then curl_auth=(-u "${AUTH_USER}:${AUTH_PASS}"); fi

if [[ "$NO_SERVICE" -eq 1 ]]; then
  info "Jalankan manual dengan: PORT=${PORT} HOST=${HOST} ${APP_DIR}/start-public.sh"
else
  booting=1
  for _ in $(seq 1 40); do
    code="$(curl -s -m 2 -o /dev/null -w '%{http_code}' "${curl_auth[@]}" "$health_url" 2>/dev/null || true)"
    if [[ "$code" == "200" ]]; then booting=0; break; fi
    sleep 0.5
  done
  if [[ "$booting" -eq 0 ]]; then
    ok "Dashboard merespons di http://127.0.0.1:${PORT}"
  else
    warn "Dashboard belum merespons. Cek log: journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
  fi
fi

# ------------------------------------------------------------------ ringkasan -
lan_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -z "$lan_ip" ]] && lan_ip="<ip-server>"

printf '\n%s%s╭──────────────────────────────────────────────────────────────╮%s\n' "$c_bold" "$c_blue" "$c_reset"
printf '%s%s│%s  %sLLM Load Test siap dipakai%s                                %s%s│%s\n' "$c_bold" "$c_blue" "$c_reset" "$c_green" "$c_reset" "$c_bold" "$c_blue" "$c_reset"
printf '%s%s╰──────────────────────────────────────────────────────────────╯%s\n' "$c_bold" "$c_blue" "$c_reset"
printf '  Lokal   : http://localhost:%s\n' "$PORT"
printf '  Jaringan: http://%s:%s\n' "$lan_ip" "$PORT"
if [[ "$ENABLE_AUTH" -eq 1 ]]; then
  printf '\n  Login   : %s / %s\n' "$AUTH_USER" "$AUTH_PASS"
  if [[ "$generated" -eq 1 ]]; then
    printf '  %sSimpan password ini. Bisa diubah di %s/.auth.env%s\n' "$c_yellow" "$APP_DIR" "$c_reset"
  fi
else
  printf '\n  Login   : (tidak aktif)\n'
fi
cat <<EOF

  Perintah berguna:
EOF
if [[ "$NO_SERVICE" -eq 1 ]]; then
  cat <<EOF
    PORT=${PORT} HOST=${HOST} ${APP_DIR}/start-public.sh

  Catatan: bila server berada di belakang NAT (port tidak bisa diakses dari
  internet), gunakan Tailscale Funnel. Lihat bagian "Akses dari internet"
  di README.
EOF
else
  cat <<EOF
    systemctl status ${SERVICE_NAME}
    journalctl -u ${SERVICE_NAME} -f
    sudo bash $0 --uninstall

  Catatan: bila server berada di belakang NAT (port tidak bisa diakses dari
  internet), gunakan Tailscale Funnel. Lihat bagian "Akses dari internet"
  di README.
EOF
fi
