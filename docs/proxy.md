# Proxy-filer

En proxy er et lille Python-program, som grafikken henter data fra. BSPX starter og stopper den fra **Proxyer** i menuen. Følg reglerne herunder, så filen bliver fundet, kan skifte port, og kan nås fra vMix.

## Hvor filen skal ligge

Én af disse to steder:

- `ASSETS/templates/<projekt>/proxy.py`
- `proxies/<projekt>/proxy.py`

Filnavnet skal indeholde ordet `proxy`. `proxy.py` og `DBUproxy.py` bliver fundet. `server.py` bliver ikke.

Læg kun én proxy i hver mappe. To filer i samme mappe, hvor det ene navn indeholder det andet (`proxy.py` inde i `DBUproxy.py`), får BSPX til at tro, at begge kører, selv om det kun er den ene.

## Regler der altid skal holde

1. Programmet skal blive ved med at køre. Det må ikke hente noget én gang og så slutte.
2. Det skal lytte på `0.0.0.0`, ikke på `127.0.0.1`. Ellers kan vMix på en anden PC ikke nå det.
3. Porten skal stå som `port = 5050` med et tal. Knappen **GEM** leder kun efter det, efter `("0.0.0.0", 5050)`, eller efter `.listen(5050)`. Andre måder bliver ikke ændret.
4. Hver proxy har sin egen port. 8080 er BSPX. 8000 er Companion. Brug ikke dem.
5. Svar med JSON og denne header: `Access-Control-Allow-Origin: *`. Uden den bliver kaldet afvist i vMix-browseren.
6. Brug kun Python-standardbiblioteket, eller pakker der allerede er installeret på Pi'en. BSPX kører filen med `python3`, uden et virtuelt miljø.
7. Skriv ikke Pi'ens IP-adresse i filen. Adressen skifter. Lyt på `0.0.0.0`.
8. Lav ikke dit eget baggrundsprogram (`fork`, `nohup`, systemd). BSPX skal eje processen, ellers kan **Stop** ikke slukke den.

## Skabelon

Gem den som `ASSETS/templates/<projekt>/proxy.py` og ret porten, så den ikke støder sammen med en anden proxy.

```python
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json

HOST = "0.0.0.0"
port = 5050

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        self._send(200, {"ok": True})

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

if __name__ == "__main__":
    ThreadingHTTPServer((HOST, port), Handler).serve_forever()
```

`HOST = "0.0.0.0"` gør, at siden viser **netværket**. `port = 5050` er det eneste sted, porten må stå som et tal. Brug variablen `port` alle andre steder.

## Sådan kalder grafikken den

Controlleren henter `itemsUrl` fra Pi'en selv. Den adresse skal være:

```text
http://127.0.0.1:5050/api/...
```

`127.0.0.1` er Pi'en, fordi det er BSPX der henter listen. Den adresse virker stadig, når Pi'en får en ny IP.

vMix kører på en anden PC. Et kald inde i selve grafikken skal derfor være:

```text
http://piserver.local:5050/api/...
```

Skriv aldrig `192.168.x.x` ind i templaten. Den adresse dør, næste gang routeren giver Pi'en en ny IP.

## Når den ikke starter

Loggen ligger i `LOG/proxies/`. Filnavnet er stien med skråstreger byttet ud med `_`. Den sidste linje vises også i proxy-listen, når status er stoppet.
