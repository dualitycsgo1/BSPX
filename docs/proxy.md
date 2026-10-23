# Proxy og dropdowns

De tre produktionsproxyer startes og overvåges nu automatisk sammen med
BSPX-hovedserveren. Se [automatisk genstart og aktivering](proxy-supervision.md).

En proxy er et Python-program, som BSPX starter fra **Proxyer**. Controllerens dropdowns henter deres valg gennem den. Grafikken i vMix kan kalde den samme proxy. Byg filen og svaret som beskrevet her, så begge dele virker uden særtilfælde.

## 1. Filen

Læg den ét af disse steder:

- `ASSETS/templates/<projekt>/proxy.py`
- `proxies/<projekt>/proxy.py`

Filnavnet skal indeholde ordet `proxy`. `server.py` bliver ikke fundet. Flere
proxyer kan ligge i samme mappe; processen genkendes på den præcise scriptsti.

Regler:

1. Programmet skal blive ved med at køre. Det må ikke hente noget én gang og slutte.
2. Lyt på `0.0.0.0`. `127.0.0.1` kan kun nås fra Pi'en, ikke fra vMix.
3. Porten skal stå som `port = 5050` med et tal. **GEM** leder kun efter det, efter `("0.0.0.0", 5050)`, eller efter `.listen(5050)`.
4. Egen port pr. proxy. 8080 er BSPX. 8000 er Companion.
5. Svar med JSON og `Access-Control-Allow-Origin: *`. Uden den bliver kaldet afvist i vMix.
6. Brug kun Pythons standardbibliotek, eller pakker der allerede er installeret på Pi'en. BSPX kører `python3 filen.py` uden et virtuelt miljø.
7. Skriv ikke Pi'ens IP i filen. Adressen skifter.
8. Start den ikke selv i baggrunden. Så kan **Stop** ikke slukke den.

```python
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from urllib.parse import urlparse, parse_qs

HOST = "0.0.0.0"
port = 5050

def matches_for(query):
    # Byt dette ud med det rigtige opslag.
    # Returner altid en liste i formatet længere nede.
    return []

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = b"" if code == 204 else json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, None)

    def do_GET(self):
        parsed = urlparse(self.path)
        query = {key: values[0] for key, values in parse_qs(parsed.query).items()}
        rows = matches_for(query)
        self._send(200, rows)

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

if __name__ == "__main__":
    ThreadingHTTPServer((HOST, port), Handler).serve_forever()
```

`HOST = "0.0.0.0"` gør, at siden viser **netværket**. `port = 5050` er det eneste sted, porten står som et tal.

## 2. To adresser

Controlleren og vMix er ikke den samme maskine.

| Hvem kalder | Adresse | Hvorfor |
| --- | --- | --- |
| Dropdown i controlleren (`itemsUrl`) | `http://127.0.0.1:5050/...` | BSPX på Pi'en henter listen. `127.0.0.1` er Pi'en. |
| Grafikken i vMix | `http://piserver.local:5050/...` | Browseren kører på vMix-pc'en. `127.0.0.1` dér er pc'en, ikke Pi'en. |

Skriv aldrig `192.168.x.x` i templaten. Den dør, når Pi'en får en ny IP.

`{feltnavn}` i `itemsUrl` bliver erstattet med feltets værdi, og værdien bliver URL-kodet. Brug det til et id eller et rundenummer, ikke til en hel adresse. `http://127.0.0.1:5050` i et felt bliver til `http%3A%2F%2F127.0.0.1%3A5050` og virker ikke.

## 3. Det svar dropdownen forstår

Controlleren kalder ikke proxyen direkte. Den beder BSPX om at hente `itemsUrl`. Svaret skal være JSON.

Enten en liste:

```json
[
  {
    "id": "6ac7caf226d5d8faf0141178",
    "round": 6,
    "status": "completed",
    "homePlayer": { "id": "abc", "name": "MahdiFC" },
    "awayPlayer": { "id": "def", "name": "Nimand_95V" }
  }
]
```

Eller et objekt, hvor listen ligger i `matches`, `data`, `items`, `results` eller `docs`. Andre nøgler, for eksempel `games`, bliver afvist, og menuen viser **Kunne ikke hente kampe**.

Hver række skal have `id`, `_id` eller `matchId`. Uden id bliver rækken sprunget over.

Proxyen må også sende færdige valg. Så bruger BSPX teksten, som den er, og sorterer ikke om:

```json
[
  { "text": "10:00  FUT Esports vs TYLOO", "value": "seed-1" },
  { "text": "13:00  MOUZ vs Team Liquid", "value": "seed-4" }
]
```

`text` og `value` skal begge være med. En liste, der kun har `id` og holdnavne, bliver stadig bygget om til `R6 · hold vs hold · status`.

Teksten i menuen bygger BSPX selv, når svaret ikke allerede har `text` og `value`.

```text
R6 · MahdiFC vs Nimand_95V · spillet
```

| Del | Hvor den kommer fra |
| --- | --- |
| Runde | `round` eller `roundNumber`. Højest runde først. |
| Hjemme | `homePlayer.name`, ellers `displayName`, `username`, `home.name`, `home` som tekst, eller `homeName`. Mangler den, står der **afventer**. |
| Ude | Samme, med `awayPlayer` / `away` / `awayName`. |
| Status | `completed` = spillet, `scheduled` = planlagt, `pending` = afventer, `extract-incomplete` = udtræk. Alt andet vises som det står. |

Spring ikke `completed` over. Der er intet loft under 200. BSPX tilføjer selv `limit=200`, hvis adressen ikke allerede har `limit`, `per_page` eller `pageSize`. Er svaret et objekt med `next`, `pages` eller `total`, hentes de næste sider, højst 10. En ren liste bliver ikke bladret i. Lever alt i første svar.

Sorteringen klarer BSPX: runde faldende, derefter hjemmeholdets navn. Det valgte id bliver stående, hvis det findes i det nye svar. Findes det ikke, beholdes den gamle værdi. Fejler kaldet, bliver de gamle valg stående.

**Update** og **Play** sender det valgte id, ikke teksten.

Et andet spil end FIFA skal stadig levere denne form. Omskriv i proxyen. Dropdownen har ikke et andet format.

## 4. Felterne i templaten

Felterne står i template-definitionen, ikke i HTML-grafikken. Åbn controlleren igen efter en ændring. Eksisterende punkter i rundownet får de nye felter. De skal ikke slettes og tilføjes igen.

```json
{
  "field": "round",
  "ftype": "dropdown",
  "title": "Runde",
  "value": "6",
  "items": [{ "text": "Runde 6", "value": "6" }]
}
```

```json
{
  "field": "match",
  "ftype": "dropdown",
  "title": "Opgør",
  "value": "",
  "itemsUrl": "http://127.0.0.1:5050/api/matches?round={round}&status={status}"
}
```

`{round}` og `{status}` er feltnavne i samme punkt. Listen hentes, når editoren åbnes, når et felt i adressen ændres, og når en knap med `refresh` trykkes.

```json
{
  "field": "pull",
  "ftype": "button",
  "title": "Hent kampe",
  "refresh": "match"
}
```

`refresh` er feltnavnet på dropdownen. Flere felter adskilles med komma: `"refresh": "m1,m2,m3,m4"`. Knappen spiller ikke grafikken ud eller ind.

Proxyen læser `round` og `status` fra query-strengen og returnerer kun de rækker. `status=all` eller tom `status` betyder alle.

## 5. Skriv til andre grafikker

Knappen skriver kun, når der trykkes på den. Save, Update og Play skriver ikke. Grafikken behøver ikke være på luft. Render-vinduet skal være åbent.

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

`globalKey` er nøglen. Brug en ny nøgle pr. projekt. `globalFrom` er dropdownen. Den valgte id slås op i det sidste svar fra `itemsUrl`. `globalMap` kopierer felter fra den række. `homePlayer.id` læser den egenskab. Mangler `id`, bruges `_id`, `playerId`, `userId` eller `uuid`. `{feltnavn}` læser et andet felt i punktet. `now` er tidspunktet. `ts` sættes altid til et nyt `Date.now()`.

```json
{"p1":"<spiller-id>","p2":"<spiller-id>","match":"<kamp-id>","ts":1710000000000}
```

Uden `globalMap` gemmes punktets felter plus `ts`.

Grafikken læser på samme origin som templaten. Tjek i render-vinduets konsol, ikke i controllerens.

```javascript
function readPair() {
  try { return JSON.parse(localStorage.getItem('fcc-live-pair') || 'null'); }
  catch (e) { return null; }
}

function apply(payload) {
  if (!payload || !payload.ts) return;
  // payload.p1, payload.p2, payload.match
}

window.addEventListener('storage', function (event) {
  if (event.key === 'fcc-live-pair' && event.newValue) apply(JSON.parse(event.newValue));
});

window.addEventListener('message', function (event) {
  if (event.data && event.data.spxGlobalKey === 'fcc-live-pair') apply(event.data.spxGlobal);
});

apply(readPair());
```

## 6. Når det fejler

| Det man ser | Årsag |
| --- | --- |
| Filen er ikke i **Proxyer** | Navnet indeholder ikke `proxy`, eller den ligger et andet sted. |
| **kun denne maskine** | Filen lytter på `127.0.0.1`. Skift til `0.0.0.0`. |
| **Kunne ikke hente kampe** | Adressen svarer ikke, eller JSON ikke er en liste i de tilladte nøgler. |
| Menuen mangler kampe | Proxyen filtrerer dem fra, eller de har intet `id`. |
| vMix får tomt svar | Grafikken kalder `127.0.0.1` eller en gammel IP. Brug `piserver.local`. |
| Global rammer ikke grafikken | Render-vinduet er lukket, eller grafikken lytter på en anden nøgle. |

Loggen ligger i `LOG/proxies/`. Filnavnet er stien med skråstreger byttet til `_`.
