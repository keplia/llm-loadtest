#!/usr/bin/env bash
# Cetak URL publik yang sedang aktif (Tailscale Funnel atau Cloudflare quick tunnel).
set -euo pipefail

if command -v tailscale >/dev/null 2>&1; then
  if tailscale funnel status 2>/dev/null | grep -q "Funnel on"; then
    tailscale funnel status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1
    exit 0
  fi
fi

journalctl -u cloudflared-quick --no-pager -n 400 2>/dev/null \
  | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 || true
