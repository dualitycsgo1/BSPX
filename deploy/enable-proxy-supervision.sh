#!/bin/bash
# Add restart policy to the existing BSPX service without replacing its command.
# Installation does not restart BSPX or any live proxy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run: sudo bash deploy/enable-proxy-supervision.sh" >&2
  exit 1
fi
if ! systemctl cat bspx.service >/dev/null 2>&1; then
  echo "bspx.service was not found; no service configuration was changed." >&2
  exit 1
fi
# Discover only sidecars that own an exact critical proxy script. A systemd
# sidecar keeps sole launch ownership; BSPX must never race it for the port.
owners="$(node - "$ROOT" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const { createServiceOwnership } = require(path.join(root, 'utils/spx_proxy_services'));
const services = createServiceOwnership();
const groups = [
  ['ASSETS/templates/eafc/integration/proxy.py', 'ASSETS/templates/eafc/proxy.py'],
  ['ASSETS/templates/PGL/stake-odds-proxy.py'],
  ['ASSETS/templates/PGL/proxy.py']
];
(async () => {
  const units = new Set();
  for (const group of groups) {
    const scripts = group.map(file => path.join(root, file)).filter(file => fs.existsSync(file));
    if (scripts.length) {
      const unit = await services.ownerFor(scripts[0], scripts.slice(1));
      if (unit) units.add(unit);
    }
  }
  for (const unit of units) console.log(unit);
})().catch(() => {
  console.error('Could not verify proxy service ownership; no configuration was changed.');
  process.exitCode = 1;
});
NODE
)"
owner_units=()
if [[ -n "$owners" ]]; then
  mapfile -t owner_units <<< "$owners"
fi
for unit in "${owner_units[@]}"; do
  [[ "$unit" =~ ^[A-Za-z0-9_-]+\.service$ ]] || { echo "Unsafe service name" >&2; exit 1; }
  install -d -m 0755 "/etc/systemd/system/$unit.d"
  temporary="$(mktemp "/etc/systemd/system/$unit.d/.proxy-supervision.XXXXXX")"
  trap 'rm -f -- "$temporary"' EXIT
  cat > "$temporary" <<'EOF'
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=3
EOF
  chmod 0644 "$temporary"
  mv -- "$temporary" "/etc/systemd/system/$unit.d/proxy-supervision.conf"
done
install -d -m 0755 /etc/systemd/system/bspx.service.d
temporary="$(mktemp /etc/systemd/system/bspx.service.d/.proxy-supervision.XXXXXX)"
trap 'rm -f -- "$temporary"' EXIT
cat > "$temporary" <<'EOF'
[Unit]
StartLimitIntervalSec=0
EOF
if [[ "${#owner_units[@]}" -gt 0 ]]; then
  printf 'Wants=%s\nAfter=%s\n' "${owner_units[*]}" "${owner_units[*]}" >> "$temporary"
fi
cat >> "$temporary" <<'EOF'

[Service]
Restart=always
RestartSec=3
EOF
chmod 0644 "$temporary"
mv -- "$temporary" /etc/systemd/system/bspx.service.d/proxy-supervision.conf
systemctl daemon-reload
for unit in "${owner_units[@]}"; do
  systemctl enable "$unit"
done
systemctl enable bspx.service
echo "BSPX boot/restart policy enabled. Existing service command is unchanged."
echo "No service was restarted. Activate the new code with: sudo systemctl restart bspx"
