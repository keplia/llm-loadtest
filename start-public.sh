#!/usr/bin/env bash
# Menjalankan dashboard dengan HOST=0.0.0.0 dan kredensial dari .auth.env.
# Dipakai oleh service systemd (lihat install.sh).
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f .auth.env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.auth.env
  set +a
fi

export HOST="${HOST:-0.0.0.0}"
exec node server.js
