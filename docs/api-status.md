# Status API

These calls only read the rundown. They do not play, stop or change a graphic. Use them from Bitfocus Companion or any other HTTP client.

Play and stop by id are unchanged:

```
GET /api/v1/item/play/ITEM_ID
GET /api/v1/item/stop/ITEM_ID
GET /api/v1/item/continue/ITEM_ID
```

If `config.general.apikey` is set, add `?apikey=` to the URL.

The controller must have the rundown open. On-air state is the value last saved by play or stop. A status call does not ask the renderer.

## One item

```
GET /api/v1/item/ITEM_ID
```

```json
{
  "status": 200,
  "itemID": "1234567890",
  "name": "H2H",
  "template": "softpix/html/h2h.html",
  "onair": true,
  "layer": "3",
  "out": "manual",
  "project": "Show",
  "rundown": "Rundown",
  "fields": { "match": "6ac7caf226d5d8faf0141178" }
}
```

`name` is the rundown description. `fields` are the current template values, keyed by field name. Unknown ids return HTTP 404.

## On air only

```
GET /api/v1/item/ITEM_ID/onair
```

```json
{ "status": 200, "itemID": "1234567890", "name": "H2H", "onair": true, "value": true }
```

`value` and `onair` are the same boolean.

## Open rundown

```
GET /api/v1/rundown/items
```

Returns every item in the rundown that is open in the controller: `itemID`, `name`, `onair`, `layer`, `template`.

## Variable list

```
GET /api/v1/variables
```

A flat list, in the same spirit as an OBS variable table. One row per fact:

| name | value |
| --- | --- |
| `rundown.project` | project folder |
| `rundown.name` | rundown name |
| `item.ITEM_ID.onair` | `true` or `false` |
| `item.ITEM_ID.name` | rundown item name |
| `item.ITEM_ID.layer` | web playout layer |

The list only contains the open rundown. It is empty, with HTTP 404, when no controller has a rundown loaded.
