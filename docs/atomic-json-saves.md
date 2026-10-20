# Atomic JSON saves

`spx.writeFile()` saves rundown, project profile and configuration JSON through
`utils/spx_atomic_json.js`. It writes a unique temporary file in the destination
directory, flushes and closes it, then renames it over the destination. Readers
continue seeing the previous complete file until that rename succeeds.

Previously, `fs.writeFile()` truncated the active file before completing the save.
Concurrent `GetJsonData()` calls could therefore read an empty or partial file,
trigger “Invalid rundown file” and fail `/gc/saveItemChanges`.

Saves of a resolved destination path are queued in invocation order within each
Node process. Failed saves reject, remove their own temporary file when possible,
and leave the old destination intact. The queue remains usable after failure.
Windows sharing violations are retried briefly without deleting the destination.
Existing permission bits are preserved. Genuine JSON read errors remain visible.

This prevents partial reads during saves through `spx.writeFile()`. It does not
provide read-modify-write transactions, coordinate separate processes, recover
previously corrupt data, preserve hard-link/symlink semantics, or change other
direct JSON writers. Keep independent instances on their own data roots. New
storage call sites should use the common writer rather than truncate active JSON.

Run `node --test test/atomic-json.test.cjs` (Node 20 or later). No package install,
API credentials or production data are required. The GitHub workflow runs the
same regression tests on Linux and Windows. Tests cover concurrent readers and
writers, save ordering, disk/rename errors, recovery, cleanup, metadata, input
errors, POSIX permissions and the existing item-save route.

Deploy both utility files together and restart the BSPX server process during a
suitable production window. Browser reload alone does not activate server code.
Back up the previous utility first. Rollback restores it and restarts BSPX; the
unused helper may remain. No rundown migration is required.
