# Sync the working Pi code with GitHub

The running Pi's BSPX code and its seven local commits are merged into main,
together with the controller rundown fixes. The renderer also includes the
working EAFC fullscreen bridge and PGL/predictions transition routing.

Locally installed templates, media, rundowns, profiles, instance state and
credentials stay on the Pi. No production graphics pack or rundown is added
to GitHub. Existing stock/demo files already tracked upstream are unchanged.

## One-time reconciliation on the Pi

Run these commands from the existing checkout. The script is obtained without
checking out over the running project. Each command must succeed before the
next runs:

```sh
cd /opt/BSPX &&
git fetch origin main &&
git show origin/main:deploy/prepare-pi-sync.py > /tmp/bspx-pi-sync.py &&
python3 /tmp/bspx-pi-sync.py --repo /opt/BSPX --apply --push
```

The script validates the captured code hashes, requires an empty staging area,
and saves the existing ignore file under `.bspx-sync-backup/` before replacing
it. Only six explicitly listed code/ignore paths are eligible for a local
snapshot commit. It then merges origin/main and pushes main normally, retaining
both histories. It does not reset, clean, stash, change runtime configuration,
install dependencies or restart services.

If a code file has changed since inspection, the script stops and lists its
path. Review that newer edit before continuing; do not discard it. It also
stops if the Pi has acquired newer commits not yet included in origin/main.

Without `--apply`, the script performs a read-only preflight. `--push` requires
`--apply`. Backups and local project folders are ignored by Git.

Restart BSPX through the existing service manager when convenient, then reload
controller and renderer browser tabs. Restarting is a separate operator action.

## Subsequent updates

After the one-time reconciliation has been pushed successfully:

```sh
cd /opt/BSPX && git pull --ff-only origin main
```

For future local BSPX code changes, commit and push only the intended source
files. Avoid `git add -A` on a production machine: existing tracked example
files and configuration remain tracked even when a newer ignore rule exists.

## Verification

The controller regression suite exercises 1,205 graphic rows and concurrent
updates. Migration tests use disposable local repositories and verify that
templates, media, private tokens, active rundowns and local configuration stay
byte-identical while both Git histories are retained. No test uses the live
Pi's renderer or sends playout commands.
