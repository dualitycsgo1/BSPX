# Rundown graphics and controller visibility

The controller has no application-level item-count limit. A project's template
library defines the available graphic types, not the number of instances a
rundown may contain. The same template may be added repeatedly.

## What changed

- The full controller rebuilds its complete list from `templates` on every load.
  Previously serialized `controllerEntries` and stale template indexes cannot
  hide or misidentify later additions. Derived entries are not saved back as a
  second source of truth.
- Graphics without editable fields remain visible in both the full and mini
  controller.
- Adding one or all project templates selects and scrolls to the first new
  graphic after the redirect. It does not play the graphic.
- Add, import, duplicate, remove, reorder, field saves and playout persistence
  serialize changes to the same rundown file. API item edits share this queue.
  Different files can still proceed independently. Generated numeric item IDs
  remain unique when several additions arrive in one millisecond.
- Normal playout reads its requested rundown from disk. A stale cache or another
  open rundown cannot overwrite newer rows during play/stop persistence.
- Reorder requests must include every current graphic and divider exactly once.
  A stale browser receives `409` and a reload message instead of deleting rows
  that were added elsewhere. This applies to the legacy reorder format too.

Existing template paths, item IDs, field values and on-air states are preserved.
There is no data migration, new runtime dependency, background job or renderer
change. Existing request-size and server security settings are unchanged.

## Update on the Pi

1. Keep a backup of local configuration and the production data directory as
   usual. This update contains code only; it does not replace production data.
2. Pull `main` in the existing BSPX checkout. Keep local production changes;
   resolve any Git conflicts without resetting configuration or rundown files.
3. Restart the BSPX server process through the usual service manager when ready
   to load the new server code. This repository change does not restart it.
4. Reload all controller tabs, including mini controllers. The existing renderer
   and browser-source addresses remain the same.
5. Add the required graphic from `+`. The new row is selected and scrolled into
   view. Repeating a graphic type appends another independent instance.

This change does not insert or delete production rundown items automatically.

## Validation

Run `node --test` from the repository root. Tests need no installed application
packages or external services. CI runs them on Linux and Windows with Node22.
Coverage includes 1,205 rows, repeated/concurrent additions, ID collisions,
stale reorder protection, field saves, play/stop persistence against the correct
rundown, atomic disk replacement and automatic selection without playout.

The actual full and mini Handlebars views were also rendered locally with
1,000 rows, including empty/missing field arrays. A separate browser check
confirmed the last row could be selected, edited and reached by scrolling.
No Pi files or production playout were changed during verification.
