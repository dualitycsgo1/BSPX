# Editor buttons and live dropdowns

These fields belong in the template definition (`DataFields` in the show `profile.json`). They are not part of the HTML graphic. A button never plays or stops the graphic. The vMix browser source must be the SPX renderer (`/renderer`) on the same origin as the templates.

Open the controller again after changing the template. New buttons are shown on existing rundown items. Items do not have to be deleted and added again.

## Live dropdown

A dropdown with `itemsUrl` loads its choices from that URL.

```json
{
  "field": "round",
  "ftype": "dropdown",
  "title": "Round",
  "value": "6",
  "items": [{ "text": "Round 6", "value": "6" }]
}
```

```json
{
  "field": "match",
  "ftype": "dropdown",
  "title": "Match",
  "value": "",
  "itemsUrl": "http://127.0.0.1:8787/api/v1/tournaments/TOURNAMENT_ID/matches?round={round}"
}
```

`{round}` is the name of another field in the same item. The placeholder is replaced before the request. The list is fetched when the editor opens, when a referenced field changes, and when a button with `refresh` is pressed. Requests use `cache: no-store` and ask for `limit=200`. Wrapped responses (`matches`, `data`, `items`, `results`, `docs`) and extra pages are followed. There is no cap below 200, and `completed` records are kept.

Each record becomes one choice:

| Choice | Source |
| --- | --- |
| Value | `id`, or `_id` / `matchId` |
| Text | `R{round} · {home} vs {away} · {status}` |

Home and away names come from `homePlayer.name` and `awayPlayer.name`. A missing name is `afventer`. Status labels: `completed` = spillet, `scheduled` = planlagt, `pending` = afventer, `extract-incomplete` = udtræk. Any other status is shown as returned. Choices are sorted by round descending, then by home name.

The selected id stays selected when it is still in the new list. If it is not, the stored value is left unchanged. Update still sends that value to the template. If the request fails, the old choices stay and the editor shows a short error.

This list builder expects match-shaped records. Another sport can use the same dropdown when its API returns `id`, `round`, `homePlayer`, `awayPlayer` and `status`. Other response shapes should be mapped to that, or the template can use a function button instead.

## Function buttons

`ftype: "button"` is a function button. Set any of these properties. If several are set, they run in this order: refresh, then `call` / `fcall`, then global. Nothing is played.

### Refresh a dropdown

```json
{
  "field": "pull",
  "ftype": "button",
  "title": "Hent kampe",
  "refresh": "match"
}
```

`refresh` is the field name of the dropdown.

### Call a function in the controller page

```json
{
  "field": "score",
  "ftype": "button",
  "title": "Opdater score",
  "call": "pushScore"
}
```

`call` must be the name of a function on `window`. It is called as `pushScore(button, values)`. `values` is an object of the current fields in the item, keyed by field name. The function is not called inside the render iframe.

`fcall` still works for templates that already use it. It runs as a function body with `button` and `values` in scope. Prefer `call` for new templates.

### Write a value other graphics can read

```json
{
  "field": "publish",
  "ftype": "button",
  "title": "Skriv til Global",
  "globalKey": "fcc-live-pair",
  "globalFrom": "match",
  "globalMap": {
    "p1": "homePlayer.id",
    "p2": "awayPlayer.id",
    "match": "id"
  }
}
```

The write happens only when the button is pressed. Save, Update and Play do not write it. The graphic does not need to be on air. The renderer window does need to be open.

`globalKey` is the localStorage key. Use a different key per project (`fcc-live-pair`, `cs2-live-veto`, and so on). `globalFrom` is the dropdown whose selected id is looked up in the last `itemsUrl` response. `globalMap` copies values off that record. A path such as `homePlayer.id` reads that property (`id`, `_id`, `playerId`, `userId` or `uuid` on the same object). `{fieldname}` reads another field in the item. `now` is the current time. `ts` is always set to a new `Date.now()`, even when the map omits it. Graphics that ignore a repeated `ts` will see each click.

The value stored for the example above:

```json
{"p1":"<homePlayer.id>","p2":"<awayPlayer.id>","match":"<match.id>","ts":1710000000000}
```

`p1` and `p2` are player ids, not names. Without `globalMap`, the button stores the item's current field values plus `ts`.

The renderer writes `localStorage` on its own origin and sends this to every open template iframe, including a graphic that is already on air:

```js
iframe.contentWindow.postMessage({ spxGlobalKey: "fcc-live-pair", spxGlobal: payload }, "*")
```

A template reads it on the same origin. Read the key on load, and listen for later clicks:

```javascript
function readPair() {
  try { return JSON.parse(localStorage.getItem('fcc-live-pair') || 'null'); }
  catch (e) { return null; }
}

function apply(payload) {
  if (!payload || !payload.ts) return;
  // use payload.p1, payload.p2, payload.match
}

window.addEventListener('storage', function (event) {
  if (event.key === 'fcc-live-pair' && event.newValue) apply(JSON.parse(event.newValue));
});

window.addEventListener('message', function (event) {
  if (event.data && event.data.spxGlobalKey === 'fcc-live-pair') apply(event.data.spxGlobal);
});

apply(readPair());
```

Check it in the renderer console, not the controller console. `localStorage.getItem("fcc-live-pair")` must show the new ids. A write made only in the controller tab is not visible to a vMix browser source, because that is another process.
