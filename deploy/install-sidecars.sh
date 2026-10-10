#!/bin/bash
# Install one systemd service per *.sidecar file under ASSETS and DATAROOT.
# A graphics project can ship its own helper (Python proxy, watcher, and so on)
# by adding a sidecar file next to the program. Re-run this script after adding one.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$(command -v python3 || true)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo $0" >&2
  exit 1
fi

shopt -s nullglob
found=0
while IFS= read -r spec; do
  name=""
  execcmd=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%%#*}"
    line="$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$line" ]] && continue
    case "$line" in
      name=*) name="${line#name=}" ;;
      exec=*) execcmd="${line#exec=}" ;;
    esac
  done < "$spec"

  if [[ -z "$name" || -z "$execcmd" ]]; then
    echo "Skipping $spec (needs name= and exec=)" >&2
    continue
  fi
  if [[ ! "$name" =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "Skipping $spec (unsafe name: $name)" >&2
    continue
  fi

  dir="$(cd "$(dirname "$spec")" && pwd)"
  unit="/etc/systemd/system/${name}.service"
  cat > "$unit" << EOF
[Unit]
Description=BSPX sidecar ${name}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=admin
Group=admin
WorkingDirectory=${dir}
ExecStart=/bin/bash -lc ${execcmd@Q}
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$name.service"
  systemctl restart "$name.service"
  echo "Started ${name} from ${dir}"
  found=1
done < <(find "$ROOT/ASSETS" "$ROOT/DATAROOT" -name '*.sidecar' -type f 2>/dev/null)
if [[ "$found" -eq 0 ]]; then
  echo "No *.sidecar files found under $ROOT"
fi
if [[ -z "$PYTHON" ]]; then
  echo "python3 is not installed. Run: sudo apt install -y python3" >&2
fi
