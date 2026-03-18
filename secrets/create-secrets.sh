#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  NanoOrch — Docker Secrets Setup Helper
#
#  Creates all required secret files in the secrets/ directory.
#  Run this script once before starting with docker-compose.secrets.yml.
#
#  Usage:
#    chmod +x secrets/create-secrets.sh
#    ./secrets/create-secrets.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
SECRETS_DIR="$(cd "$(dirname "$0")" && pwd)"

info()  { echo "  [+] $*"; }
warn()  { echo "  [!] $*"; }
prompt(){ read -rp "  > $1: " "$2"; }

echo ""
echo "NanoOrch Docker Secrets Setup"
echo "==============================="
echo "Secret files will be created in: $SECRETS_DIR/"
echo ""

# ── session_secret ────────────────────────────────────────────────────────────
if [[ -f "$SECRETS_DIR/session_secret.txt" ]]; then
  warn "session_secret.txt already exists — skipping (delete it to regenerate)"
else
  openssl rand -hex 32 > "$SECRETS_DIR/session_secret.txt"
  info "Generated session_secret.txt"
fi

# ── encryption_key ────────────────────────────────────────────────────────────
if [[ -f "$SECRETS_DIR/encryption_key.txt" ]]; then
  warn "encryption_key.txt already exists — skipping"
else
  openssl rand -hex 32 > "$SECRETS_DIR/encryption_key.txt"
  info "Generated encryption_key.txt"
fi

# ── admin_password ────────────────────────────────────────────────────────────
if [[ -f "$SECRETS_DIR/admin_password.txt" ]]; then
  warn "admin_password.txt already exists — skipping"
else
  prompt "Enter admin password (or press Enter to auto-generate)" ADMIN_PASS
  if [[ -z "$ADMIN_PASS" ]]; then
    ADMIN_PASS=$(openssl rand -base64 16 | tr -dc 'A-Za-z0-9!@#$%' | head -c 20)
    echo "  → Auto-generated: $ADMIN_PASS"
    echo "  → SAVE THIS PASSWORD — it will only be shown once."
  fi
  printf '%s' "$ADMIN_PASS" > "$SECRETS_DIR/admin_password.txt"
  info "Created admin_password.txt"
fi

# ── database_url ─────────────────────────────────────────────────────────────
if [[ -f "$SECRETS_DIR/database_url.txt" ]]; then
  warn "database_url.txt already exists — skipping"
else
  echo ""
  echo "  Database URL format: postgres://<user>:<password>@<host>:5432/<dbname>"
  echo "  For the default docker-compose setup use:"
  echo "    postgres://nanoorch:<POSTGRES_PASSWORD>@postgres:5432/nanoorch"
  prompt "Enter DATABASE_URL" DB_URL
  printf '%s' "$DB_URL" > "$SECRETS_DIR/database_url.txt"
  info "Created database_url.txt"
fi

# ── AI provider keys ──────────────────────────────────────────────────────────
echo ""
echo "  AI provider API keys (press Enter to skip a provider)"

for PROVIDER in openai anthropic gemini; do
  FILE="$SECRETS_DIR/${PROVIDER}_api_key.txt"
  if [[ -f "$FILE" ]]; then
    warn "${PROVIDER}_api_key.txt already exists — skipping"
  else
    prompt "${PROVIDER} API key (blank to skip)" API_KEY
    printf '%s' "${API_KEY:-}" > "$FILE"
    if [[ -z "$API_KEY" ]]; then
      info "Created ${PROVIDER}_api_key.txt (empty — provider disabled)"
    else
      info "Created ${PROVIDER}_api_key.txt"
    fi
  fi
done

# ── Permissions ───────────────────────────────────────────────────────────────
chmod 400 "$SECRETS_DIR"/*.txt 2>/dev/null || true
info "Set permissions to 0400 on all *.txt files"

echo ""
echo "Done! Start NanoOrch with Docker secrets:"
echo ""
echo "  docker compose -f docker-compose.secrets.yml up -d"
echo ""
