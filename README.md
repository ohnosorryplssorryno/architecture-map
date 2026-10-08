# Formatlas

Interaktive Weltkarte (Deutsch und Englisch) mit den wichtigsten Bauten von elf prägenden Architekten und Büros: Antoni Gaudí, Frank Lloyd Wright, Ludwig Mies van der Rohe, Le Corbusier, Oscar Niemeyer, Frank Gehry, Foster + Partners, Renzo Piano, OMA / Rem Koolhaas, Herzog & de Meuron und Zaha Hadid Architects. Insgesamt 216 Bauten von 1882 bis 2025.

**Live:** https://ohnosorryplssorryno.github.io/architecture-map/

## Starten

Statische Seite ohne Build-Schritt. Lokal reicht ein beliebiger Webserver, zum Beispiel der mitgelieferte ohne Browser-Cache:

```bash
python tools/serve.py 5173
```

Dann http://localhost:5173 öffnen.

## Hosting

Die Seite läuft über GitHub Pages direkt aus dem Branch `main` (Ordner `/`). Jeder Push auf `main` ist nach etwa einer Minute live. Die Datei `.nojekyll` sorgt dafür, dass GitHub die Dateien unverändert ausliefert.

Nach Änderungen an `assets/app.js`, `assets/app.css`, `assets/i18n.js`, `assets/map-style.js` oder `data/buildings.js` die Versionsnummer `?v=…` an diesen Dateien in `index.html` hochsetzen. GitHub Pages erlaubt Browsern, Dateien 10 Minuten zwischenzuspeichern; ohne neue Nummer könnte ein Besucher die neue Seite mit einem alten Skript bekommen.

Daten aktualisieren: `node tools/build-data.mjs` lokal ausführen, Änderungen committen und pushen. Bei jedem Push prüft eine GitHub Action die Daten (`tools/check-data.mjs`), siehe Reiter „Actions“ im Repository. Das Vorschaubild für geteilte Links (`assets/og-image.png`) erzeugt `tools/og-image.html` neu.

Vor dem Livegang in Deutschland: Die Platzhalter in `impressum.html` durch eigene Angaben ersetzen. `impressum.html` und `datenschutz.html` sind Vorlagen und keine Rechtsberatung.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `index.html` | Gerüst der Karte |
| `impressum.html`, `datenschutz.html` | Rechtstexte (Vorlagen) |
| `assets/map-style.js` | Eigener dunkler Kartenstil (OpenMapTiles-Schema, Globus, 3D-Gebäude ab Zoom 15) |
| `assets/app.js` | Karte, Infokarte (Fotos, Grundriss, verwandte Bauten), große Fotoansicht, Hinflug, Rundflug und Rundgang, Verzeichnis nach Bauten, Städten oder als Galerie, Suche mit Vorschlägen, Filter, Ansicht im Link, Sprachwechsel, Hinweise bei Ladeproblemen |
| `assets/i18n.js` | Texte der Oberfläche auf Deutsch und Englisch |
| `assets/app.css`, `assets/legal.css` | Gestaltung der Karte und der Textseiten |
| `assets/fonts/`, `assets/vendor/maplibre/` | Schriften und MapLibre GL 5.24, lokal ausgeliefert |
| `data/source.mjs` | **Kuratierte Daten**: Architekten mit Farben und Grundstil, Gebäudetyp-Gruppen, Stilrichtungen, Bauten mit Texten und Wikidata-IDs – hier wird gepflegt |
| `data/i18n-en.mjs` | Englische Namen und Texte der Bauten, Länder, Städte, Typen |
| `data/buildings.js` | Generiert: Koordinaten, Fotos mit Urheber und Lizenz, Gebäudegröße, Grundriss als SVG-Pfad, englische Fassung |
| `data/footprints.json`, `data/photos.json` | Zwischenspeicher für Grundrisse und Fotoauswahl |
| `tools/build-data.mjs` | Erzeugt `buildings.js` aus Wikidata, OpenStreetMap und Wikimedia Commons und prüft das Ergebnis |
| `tools/check-data.mjs` | Datenprüfung: Pflichtfelder, IDs, Typen, Jahre, Fotos, Lage innerhalb der Stadt; mit `--online` Abgleich von Land und Koordinaten mit Wikidata |
| `tools/footprints.mjs` | Sucht Gebäudegrundrisse und Höhen in OpenStreetMap |
| `tools/photos.mjs` | Wählt zwei weitere Fotos pro Bau aus Wikimedia Commons |
| `tools/serve.py` | Lokaler Server ohne Cache |
| `tools/og-image.html` | Vorlage für das Vorschaubild beim Teilen |

## Architekten oder Bauten ergänzen

1. In `data/source.mjs` einen Eintrag in `architects` anlegen: `color` (hell genug für den dunklen Grund, deutlich verschieden von den anderen) und `match` (Suchmuster für das architect-Tag in OpenStreetMap).
2. Bauten mit `architect: '<id>'`, Wikidata-ID (`qid`), Name, Ort, Jahr, Typ und Kurztext hinzufügen, dazu in `data/i18n-en.mjs` den englischen Text (und Namen, falls er anders lautet). Weicht die Stilrichtung vom Grundstil des Architekten ab: `style`. Optional: `image` (erstes Foto), `photos` (Foto 2 und 3, auch `[]` für „nur das erste“), `skipPhotos` (Dateien, die die automatische Auswahl auslassen soll), `coord`, `osm`, `zoom`.
3. `node tools/build-data.mjs` ausführen (Node 18+). Am Ende prüft das Skript die Daten und meldet Fehler (Abbruch mit Exit-Code 1) und Warnungen, z. B. doppelte Fotos, fehlende Lizenzangaben, Bauten weit weg von ihrer Stadt oder ein anderes Land als in Wikidata. Einzeln: `node tools/check-data.mjs` bzw. `node tools/check-data.mjs --online`.

Das Skript holt Koordinaten, Grundrisse und Fotos automatisch und speichert Zwischenergebnisse, sodass ein erneuter Lauf nur Neues abfragt. Wikimedia Commons drosselt anonyme Zugriffe; die Fotosuche fragt deshalb langsam nacheinander ab (rund 5 Sekunden pro Bau). Mit `--refresh-footprints` bzw. `--refresh-photos` wird alles neu geladen.

Gebäudetypen werden für den Filter zu Gruppen zusammengefasst (`typeGroups` in `data/source.mjs`). Ein neuer Typ muss dort einer Gruppe zugeordnet und in `data/i18n-en.mjs` übersetzt werden, sonst meldet die Prüfung einen Fehler. Stilrichtungen stehen unter `styles`; Wikidata kennt sie nur für knapp die Hälfte der Bauten, daher sind sie von Hand gepflegt (Grundstil je Architekt, Abweichungen am Bau).

### Fotos

Das erste Foto stammt aus Wikidata (oder `image`), die beiden weiteren wählt `tools/photos.mjs` automatisch aus der Commons-Kategorie, einer „Exterior“-Unterkategorie und Dateien, die den Bau laut Commons zeigen. Bevorzugt werden ausgezeichnete Fotos im Querformat von verschiedenen Fotografen; Pläne, Schilder, Modelle und Ähnliches werden über den Dateinamen aussortiert. Die automatische Auswahl ist eine Vorauswahl – unpassende Treffer mit `skipPhotos` ausschließen oder mit `photos` fest vorgeben.

Für Bauten in Frankreich, deren Architekt noch urheberrechtlich geschützt ist (z. B. Le Corbusier bis 2035), gibt es auf Commons kaum freie Fotos, weil Frankreich keine Panoramafreiheit kennt. Diese Bauten haben weniger als drei Fotos; die Villa Savoye zeigt einen Platzhalter.

## Bedienung

- Hover über einen Punkt oder Listeneintrag: Vorschau mit drei Fotos, die nacheinander überblenden
- Klick: Hinflug (herauszoomen, hinüberfliegen, hineinzoomen), danach steht die Infokarte am Rand und eine Linie zeigt auf das Gebäude. Anschließend kreist die Kamera langsam um das Gebäude, bis die Karte bedient wird; der Schalter unten rechts schaltet den Rundflug ab (wird im Browser gemerkt)
- Klick aufs Foto der Infokarte: große Fotoansicht mit Pfeiltasten, Wischen und `Esc`
- Infokarte: Stilrichtung, Grundriss aus OpenStreetMap mit Maßstab und drei verwandte Bauten (gleiche Zeit, in der Nähe, gleicher Typ), die sich direkt anfliegen lassen
- Das Verzeichnis scrollt als Ganzes; die Fußzeile mit Impressum und Datenschutz bleibt unten stehen
- Würfel unten rechts: „Überrasch mich“, ein zufälliger Bau aus der Auswahl
- Filmknopf unten rechts: Rundgang durch die Auswahl (oder die aufgeklappte Stadt), etwa 9 Sekunden je Bau; Pause, Vor, Zurück, Esc beendet. Bedient man die Karte, hält der Rundgang an
- Ab Zoom 14 verschwinden die Punkte, ein Lichtschein in der Farbe des Architekten markiert das Gebäude
- Filter: Architekten (die Chips sind zugleich die Farblegende), Baujahr (Regler oder Klick ins Histogramm) und Gebäudetyp
- Histogramm: Balken je fünf Jahre. Sind Architekten gewählt, zeigen farbige Abschnitte, wie viele Bauten des Zeitraums von ihnen stammen, grau der Rest; der Tooltip nennt die Zahlen
- Schalter unten rechts: nahe Punkte zu Zahlen-Kreisen zusammenfassen oder jeden Bau einzeln zeigen (wird im Browser gemerkt)
- Architekten-Chips: Doppelklick wählt nur diesen Architekten, Alt-Klick alle außer ihm
- Typ & Stil: Gebäudetyp und Stilrichtung (Modernisme bis Parametrismus)
- Verzeichnis nach „Bauten“ (Jahrzehnte), „Städte“ (nach Anzahl) oder als „Galerie“ (Fotoraster): Ein Klick auf eine Stadt klappt ihre Bauten auf und fliegt hin
- Suche mit Vorschlägen (Bauten, Städte, Architekten; Pfeiltasten und Enter) und Tippfehler-Toleranz: Ohne genaue Treffer zeigt sie ähnliche („gugenheim“ findet Guggenheim)
- „EN“/„DE“ oben im Verzeichnis wechselt die Sprache, auch die Ortsnamen der Karte; die Wahl wird im Browser gemerkt
- Rechte Maustaste ziehen: drehen und kippen
- `/` fokussiert die Suche, `Enter` zoomt auf die Treffer, `Esc` schließt
- Fällt der Kartenhintergrund aus, erscheint ein Hinweis mit „Erneut versuchen“; die Bauten bleiben sichtbar. Ohne WebGL oder Kartenbibliothek bleiben Liste, Suche, Filter und Infokarten nutzbar

### Ansicht im Link

Filter, gewählter Bau und Kartenausschnitt stehen in der Adresszeile, der Knopf „Teilen“ kopiert den Link (am Handy öffnet er das Teilen-Menü):

| Parameter | Bedeutung | Beispiel |
| --- | --- | --- |
| `a` | Architekten | `a=zha,gehry` |
| `t` | Typgruppen | `t=kultur,sakral` |
| `st` | Stilrichtungen | `st=brutalismus,dekon` |
| `y` | Baujahre | `y=1990-2010` |
| `q` | Suche | `q=london` |
| `b` | gewählter Bau | `b=heydar-aliyev` |
| `v` | Ausschnitt: Breite, Länge, Zoom, Drehung, Neigung | `v=40.3947,49.868,16.2,-20,60` |
| `l` | Verzeichnisansicht | `l=staedte`, `l=galerie` |
| `c` | aufgeklappte Stadt (mit `l=staedte`) | `c=Barcelona\|Spanien` |
| `lang` | Sprache, nur wenn sie von der des Browsers abweicht | `lang=en` |

Ein Link mit `b` und ohne `v` fliegt zum Bau. Ältere Links der Form `#heydar-aliyev` funktionieren weiter.

## Performance

- Punkte und Lichtscheine sind WebGL-Ebenen (keine DOM-Elemente).
- Kein Framework, kein Build für die Seite selbst.
- Fotos kommen als 500-px-Thumbnails vom Wikimedia-CDN. Auf Geräten mit Maus wird das erste Foto der gerade sichtbaren Bauten in Leerlaufphasen vorgeladen, die beiden weiteren beim Hovern. Bei aktiviertem Datensparmodus entfällt das Vorladen.
- Listen-Thumbnails (120 px) laden per `loading="lazy"`.
- Die große Fotoansicht zeigt sofort die schon geladene 500-px-Fassung (leicht unscharf) und tauscht sie gegen 1280 bzw. 1920 px, sobald diese da ist; das nächste Foto lädt im Hintergrund vor.

## Quellen und Lizenzen

- Code: MIT-Lizenz (`LICENSE`)
- Kartenbibliothek: MapLibre GL JS, BSD-3-Clause
- Schriften: Syne und Instrument Sans, SIL Open Font License
- Karte: [OpenFreeMap](https://openfreemap.org) (kostenlos, ohne API-Key), Daten © OpenStreetMap-Mitwirkende
- Gebäudegrößen: © OpenStreetMap-Mitwirkende (ODbL)
- Fotos: Wikimedia Commons, Urheber und Lizenz stehen auf jeder Infokarte
- Koordinaten: Wikidata (CC0)
- Beschreibungstexte: eigene Kurztexte
