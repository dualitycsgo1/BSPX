# Automatic proxy recovery

The main BSPX server automatically supervises these existing local programs:

| Proxy | Local script | Current port |
| --- | --- | --- |
| FC Centralen integration | `ASSETS/templates/eafc/integration/proxy.py` | 8787 |
| Stake odds | `ASSETS/templates/PGL/stake-odds-proxy.py` | 6262 |
| PGL / CITO | `ASSETS/templates/PGL/proxy.py` | 6161 |

No graphics, Python project files, credentials or rundowns are added to GitHub.
The existing root EAFC `proxy.py` is recognized as the integration service's
alternate entry point; the two copies are not started together. Existing saved
proxy selections are also restored. Additional BSPX instances share the main
manager and cannot start a competing supervisor.

## Activate on the Pi

```sh
cd /opt/BSPX &&
git pull --ff-only origin main &&
sudo bash deploy/enable-proxy-supervision.sh &&
sudo systemctl restart bspx
```

The installer adds systemd drop-ins and enables the existing BSPX service and
any installed sidecar that owns an exact critical proxy script. Those sidecars
also become BSPX startup dependencies, with automatic restart after both clean
and unexpected exits. It preserves every existing service command and account. It
does not restart anything until the final command is executed. BSPX itself is
then restarted after unexpected or clean process exit, with a three-second
delay; an explicit `systemctl stop bspx` remains an intentional stop.

## Recovery policy

- Proxy process disappearance, crashes and clean exits trigger a new start.
  The first retry waits three seconds; repeated failures back off to 30 seconds.
- Every ten seconds the supervisor sends `OPTIONS /` to the local loopback
  port. The request has a 2.5-second absolute deadline and does not call CITO,
  Stake or FC Centralen upstream.
- A newly seen process has 30 seconds to start. Three consecutive unsuccessful
  probes after that grace period trigger recovery of that exact proxy process.
  The PID is inspected again before signalling it. A replacement PID is adopted.
- Any HTTP response counts as locally responsive, including an error status.
  An upstream outage does not cause restart loops in a responsive local proxy.
- An existing exact script process is adopted. An unrelated occupied port is
  reported and retried; its listener is never terminated. Existing systemd
  sidecars retain sole launch ownership even while their process is absent;
  BSPX adopts their replacement and never races them to bind the same port.
  A transient systemd query failure does not release confirmed ownership.
- Each proxy has independent state. A slow health request does not block the
  controller event loop or recovery of another proxy.

The **Proxyer** page shows **Automatisk genstart** for a watched program.
**Stop** intentionally disables recovery and automatic startup for that program
until **Start** is selected again. A separate systemd-owned proxy is stopped
through its own service command, as shown by the page's error message.

State is stored atomically in `LOG/proxy-state.json`; the old array format is
read automatically. Logs stay in `LOG/proxies/`. At a maximum check interval of
one minute, logs larger than 5 MiB are copied to one `.log.1` backup and the
active log is truncated without replacing its open append descriptor.

## Verification without interrupting production

The automated tests use temporary projects, fake process tables and local dummy
HTTP servers. They cover crashes, clean exits, missing Python, stalled requests,
manual Stop races, exact PID matching, occupied ports and managed instances.
No live proxy is killed or restarted during these tests.

After activation, confirm the BSPX service using:

```sh
systemctl is-enabled bspx
systemctl is-active bspx
journalctl -u bspx -n 30 --no-pager
```

Open **Proxyer** on the main BSPX server to check the three watched programs.
