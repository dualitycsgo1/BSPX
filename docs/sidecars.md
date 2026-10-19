# Project helpers (sidecars)

For a Python proxy that should be started and stopped from the BSPX menu, follow [proxy.md](proxy.md). That is the normal way. A sidecar is only for a program that must start at boot even when nobody has opened BSPX.


`ASSETS/templates/eafc/eafc.sidecar`:

```
name=eafc-proxy
exec=python3 proxy.py
```

`name` becomes the service name. `exec` runs in the folder that contains the sidecar file. After the file is on the Pi:

```bash
sudo apt install -y python3
sudo /opt/BSPX/deploy/install-sidecars.sh
```

The service starts at boot, as the user `admin`, and restarts if it crashes. Another sport adds its own file, for example `ASSETS/templates/cs2/cs2.sidecar`, and the same script installs it. Nothing else in BSPX has to change.

The browser that opens the controller is not the Pi. `http://127.0.0.1:8787` on the Windows PC is the Windows PC. Point `itemsUrl`, and any fetch inside a template, at `http://<pi-ip>:8787`. The proxy must listen on all interfaces, not only localhost.

Check it on the Pi with `systemctl status eafc-proxy`. A failed start is in `journalctl -u eafc-proxy -n 40`.
