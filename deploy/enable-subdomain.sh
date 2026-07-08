#!/usr/bin/env bash
# Turnkey final step for the PaycomConnect subdomain (paycom.monitoring-jira.uz).
# Run ON THE VM after the DNS A record exists:
#     paycom.monitoring-jira.uz -> 35.223.106.176
#
# It will:
#   1. verify DNS points at this host,
#   2. expand the existing Let's Encrypt cert to cover the new name,
#   3. enable the nginx site and reload.
#
# Idempotent: safe to re-run. Requires sudo.
set -euo pipefail

DOMAIN="${DOMAIN:-paycom.monitoring-jira.uz}"
BASE_DOMAINS=(monitoring-jira.uz tamada.monitoring-jira.uz)
SITE_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
SITE_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

echo "== 1/4 DNS check for ${DOMAIN} =="
this_ip="$(curl -fsS https://api.ipify.org || hostname -I | awk '{print $1}')"
resolved="$(getent hosts "${DOMAIN}" | awk '{print $1}' | head -1 || true)"
echo "   this host public IP: ${this_ip}"
echo "   ${DOMAIN} resolves to: ${resolved:-<none>}"
if [ -z "${resolved}" ]; then
  echo "!! No DNS record yet. Create an A record ${DOMAIN} -> ${this_ip} and re-run." >&2
  exit 1
fi

echo "== 2/4 Ensure nginx site file is staged =="
if [ ! -f "${SITE_AVAILABLE}" ]; then
  echo "!! ${SITE_AVAILABLE} missing. Copy deploy/nginx/${DOMAIN}.conf there first." >&2
  exit 1
fi

echo "== 3/4 Expand TLS certificate to include ${DOMAIN} =="
domain_args=(-d "${DOMAIN}")
for d in "${BASE_DOMAINS[@]}"; do domain_args+=(-d "${d}"); done
if sudo certbot certificates 2>/dev/null | grep -q "\b${DOMAIN}\b"; then
  echo "   cert already covers ${DOMAIN}; skipping issuance."
else
  email_args=(--register-unsafely-without-email)
  [ -n "${CERTBOT_EMAIL}" ] && email_args=(-m "${CERTBOT_EMAIL}" --no-eff-email)
  sudo certbot --nginx --expand --agree-tos --non-interactive \
    "${email_args[@]}" --cert-name monitoring-jira.uz "${domain_args[@]}"
fi

echo "== 4/4 Enable nginx site and reload =="
[ -L "${SITE_ENABLED}" ] || sudo ln -s "${SITE_AVAILABLE}" "${SITE_ENABLED}"
sudo nginx -t
sudo systemctl reload nginx

echo
echo "Done. Test:"
echo "  curl -s https://${DOMAIN}/api/health"
echo "  Telegram webhook -> https://${DOMAIN}/api/telegram/webhook"
