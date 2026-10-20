# PGL full-screen transitions

The renderer loads `static/js/pgl_fullscreen_transitions.js` before handling socket
playout messages. It intercepts the six PGL full-screen templates on PROGRAM layer
5: next-match, schedule, swiss, player, h2h and team. Recognized template folder
names are `pgl-masters` and `PGL TEST`. Other packs, layers and preview use the
existing renderer path. Renderer layer restrictions still apply.

## Required graphics package

This renderer integration requires the updated PGL graphics runtime. Its template
window exposes `PGLPlayout.version === 1`, `prepare(serializedFields)`,
`take(options)`, `isOn()` and optional `activate()`. Preparation resolves with
`{ready: true}` after required data, images and fonts are ready. `take()` accepts
`{instant: false}` for the initial IN or `{instant: true, deferVideo: true}` to
draw a staged graphic under the general wipe. `activate()` starts deferred media
at the cut. Normal `update(serializedFields)` and `stop()` remain available.

The graphics package also supplies, relative to each template:

- `assets/video/general-wipe-60.webm`
- `assets/video/general-wipe-cover.png`

The video is the original supplied 1920x1080, 60fps VP9-alpha Bucharest wipe with
Opus audio. The cover is a fully opaque still from the same video. These event
assets and template runtime files are delivered separately with the PGL graphics
package; they are not bundled into the BSPX core repository. Install that updated
package before enabling this integration for an existing PGL folder.

## Behavior

The current graphic stays visible while its successor loads in a hidden iframe.
Only after preparation succeeds does the stinger start. The cut follows displayed
video time at 1.1 seconds, inside the supplied video's opaque frames 62-70 at
60fps. Initial PLAY retains the template's normal IN animation.

Failed preparation keeps the previous graphic on air. A missing or stalled video
falls back to an atomic replacement of the prepared graphic. If decoding skips
the opaque cut window, the extracted still covers the replacement and fades off.

Rapid selections replace the pending preparation; during a wipe only the latest
additional selection is queued. STOP cancels pending work and stops the currently
visible graphic, including after a failed successor. Stale auto-outs cannot stop
a newer selected item. Clear Layer and Clear All cancel work immediately. Other
layers keep their existing frames and animations; the stinger visually overlays
them during the transition. The staged background video starts at the cut.

Audio is enabled by default, with a muted retry if browser autoplay blocks it.
Use renderer query `pglWipeSound=0` to mute or `pglTransitions=0` to bypass the
integration. Retain existing URL parameters when adding these.

Reload renderer/browser inputs after deploying the renderer and graphics package.
Actual vMix/CEF playback should be checked on the production machine. Back up the
renderer view and the previous integration script before deployment.

## Validation

The deployed implementation was exercised in a local Chromium/Edge fixture with
the actual renderer, updated graphics and original alpha video, without sending
playout commands to production or contacting CITO. Checks covered all six graphics,
held frames on slow/failed preparation, the covered cut, queued choices, UPDATE,
STOP before/after the cut, stale auto-out, clear, layer restrictions, preview,
independent ticker/lower-third continuity, missing/stalled video, skipped opaque
frames, deferred background playback and folder names containing spaces.

The browser fixture is external to the core repository because it depends on the
separately delivered event graphics package. Core JSON regression tests run in CI
independently of these graphics assets.
