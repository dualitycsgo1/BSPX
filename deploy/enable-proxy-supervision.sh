#!/bin/bash
# Add restart policy to the existing BSPX service without replacing its command.
# Installation does not restart BSPX or any live proxy.
set -euo pipefail
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run: sudo bash deploy/enable-proxy-supervision.sh" >&2
  exit 1
fi
if ! systemctl cat bspx.service >/dev/null 2>&1; then
  echo "bspx.service was not found; no service configuration was changed." >&2
  exit 1
fi
install -d -m 0755 /etc/systemd/system/bspx.service.d
temporary="$(mktemp /etc/systemd/system/bspx.service.d/.proxy-supervision.XXXXXX)"
trap 'rm -f -- "$temporary"' EXIT
cat > "$temporary" <<'EOF'
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=3
EOF
chmod 0644 "$temporary"
mv -- "$temporary" /etc/systemd/system/bspx.service.d/proxy-supervision.conf
systemctl daemon-reload
systemctl enable bspx.service
echo "BSPX boot/restart policy enabled. Existing service command is unchanged."
echo "No service was restarted. Activate the new code with: sudo systemctl restart bspx"
