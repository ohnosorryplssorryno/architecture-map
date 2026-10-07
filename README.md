# Formatlas

Interaktive Weltkarte mit den wichtigsten Bauten von elf prägenden Architekten und Büros: Antoni Gaudí, Frank Lloyd Wright, Ludwig Mies van der Rohe, Le Corbusier, Oscar Niemeyer, Frank Gehry, Foster + Partners, Renzo Piano, OMA / Rem Koolhaas, Herzog & de Meuron und Zaha Hadid Architects. Insgesamt 216 Bauten von 1882 bis 2025.

**Live:** https://ohnosorryplssorryno.github.io/architecture-map/

## Starten

Statische Seite ohne Build-Schritt. Lokal reicht ein beliebiger Webserver, zum Beispiel der mitgelieferte ohne Browser-Cache:

```bash
python tools/serve.py 5173
```

Dann http://localhost:5173 öffnen.

## Hosting

Die Seite läuft über GitHub Pages direkt aus dem Branch `main` (Ordner `/`). Jeder Push auf `main` ist nach etwa einer Minute live. Die Datei `.nojekyll` sorgt dafür, dass GitHub die Dateien unverändert ausliefert.

Daten aktualisieren: `node tools/build-data.mjs` lokal ausführen, Änderungen committen und pushen. Das Vorschaubild für geteilte Links (`assets/og-image.png`) erzeugt `tools/og-image.html` neu.

Vor dem Livegang in Deutschland: Die Platzhalter in `impressum.html` durch eigene Angaben ersetzen. `impressum.html` und `datenschutz.html` sind Vorlagen und keine Rechtsberatung.

## Aufbau

| Datei | Inhalt |
| --- | --- |
| `index.html` | Gerüst der Karte |
| `impressum.html`, `datenschutz.html` | Rechtstexte (Vorlagen) |
| `assets/map-style.js` | Eigener dunkler Kartenstil (OpenMapTiles-Schema, Globus, 3D-Gebäude ab Zoom 15) |
| `assets/app.js` | Karte, Infokarte mit Fotowechsel, Hinflug, Verzeichnis, Suche, Filter |
| `assets/app.css`, `assets/legal.css` | Gestaltung der Karte und der Textseiten |
| `assets/fonts/`, `assets/vendor/maplibre/` | Schriften und MapLibre GL 5.24, lokal ausgeliefert |
| `data/source.mjs` | **Kuratierte Daten**: Architekten mit Farben, Bauten mit Texten und Wikidata-IDs – hier wird gepflegt |
| `data/buildings.js` | Generiert: Koordinaten, Fotos mit Urheber und Lizenz, Gebäudegröße |
| `data/footprints.json`, `data/photos.json` | Zwischenspeicher für Grundrisse und Fotoauswahl |
| `tools/build-data.mjs` | Erzeugt `buildings.js` aus Wikidata, OpenStreetMap und Wikimedia Commons |
| `tools/footprints.mjs` | Sucht Gebäudegrundrisse und Höhen in OpenStreetMap |
| `tools/photos.mjs` | Wählt zwei weitere Fotos pro Bau aus Wikimedia Commons |
| `tools/serve.py` | Lokaler Server ohne Cache |
| `tools/og-image.html` | Vorlage für das Vorschaubild beim Teilen |

## Architekten oder Bauten ergänzen

1. In `data/source.mjs` einen Eintrag in `architects` anlegen: `color` (hell genug für den dunklen Grund, deutlich verschieden von den anderen) und `match` (Suchmuster für das architect-Tag in OpenStreetMap).
2. Bauten mit `architect: '<id>'`, Wikidata-ID (`qid`), Name, Ort, Jahr, Typ und Kurztext hinzufügen. Optional: `image` (erstes Foto), `photos` (Foto 2 und 3, auch `[]` für „nur das erste“), `skipPhotos` (Dateien, die die automatische Auswahl auslassen soll), `coord`, `osm`, `zoom`.
3. `node tools/build-data.mjs` ausführen (Node 18+).

Das Skript holt Koordinaten, Grundrisse und Fotos automatisch und speichert Zwischenergebnisse, sodass ein erneuter Lauf nur Neues abfragt. Wikimedia Commons drosselt anonyme Zugriffe; die Fotosuche fragt deshalb langsam nacheinander ab (rund 5 Sekunden pro Bau). Mit `--refresh-footprints` bzw. `--refresh-photos` wird alles neu geladen.

Gebäudetypen werden für den Filter zu Gruppen zusammengefasst (`GROUPS` in `assets/app.js`).

### Fotos

Das erste Foto stammt aus Wikidata (oder `image`), die beiden weiteren wählt `tools/photos.mjs` automatisch aus der Commons-Kategorie, einer „Exterior“-Unterkategorie und Dateien, die den Bau laut Commons zeigen. Bevorzugt werden ausgezeichnete Fotos im Querformat von verschiedenen Fotografen; Pläne, Schilder, Modelle und Ähnliches werden über den Dateinamen aussortiert. Die automatische Auswahl ist eine Vorauswahl – unpassende Treffer mit `skipPhotos` ausschließen oder mit `photos` fest vorgeben.

Für Bauten in Frankreich, deren Architekt noch urheberrechtlich geschützt ist (z. B. Le Corbusier bis 2035), gibt es auf Commons kaum freie Fotos, weil Frankreich keine Panoramafreiheit kennt. Diese Bauten haben weniger als drei Fotos; die Villa Savoye zeigt einen Platzhalter.

## Bedienung

- Hover über einen Punkt oder Listeneintrag: Vorschau mit drei Fotos, die nacheinander überblenden
- Klick: Hinflug (herauszoomen, hinüberfliegen, hineinzoomen), danach steht die Infokarte am Rand und eine Linie zeigt auf das Gebäude; ein Klick aufs Foto blättert weiter
- Ab Zoom 14 verschwinden die Punkte, ein Lichtschein in der Farbe des Architekten markiert das Gebäude
- Filter: Architekten (die Chips sind zugleich die Farblegende), Baujahr (Regler oder Klick ins Histogramm) und Gebäudetyp
- Rechte Maustaste ziehen: drehen und kippen
- `/` fokussiert die Suche, `Enter` zoomt auf die Treffer, `Esc` schließt
- Direktlinks: `index.html#heydar-aliyev`

## Performance

- Punkte und Lichtscheine sind WebGL-Ebenen (keine DOM-Elemente).
- Kein Framework, kein Build für die Seite selbst.
- Fotos kommen als 500-px-Thumbnails vom Wikimedia-CDN. Auf Geräten mit Maus wird das erste Foto der gerade sichtbaren Bauten in Leerlaufphasen vorgeladen, die beiden weiteren beim Hovern. Bei aktiviertem Datensparmodus entfällt das Vorladen.
- Listen-Thumbnails (120 px) laden per `loading="lazy"`.

## Quellen und Lizenzen

- Code: MIT-Lizenz (`LICENSE`)
- Kartenbibliothek: MapLibre GL JS, BSD-3-Clause
- Schriften: Syne und Instrument Sans, SIL Open Font License
- Karte: [OpenFreeMap](https://openfreemap.org) (kostenlos, ohne API-Key), Daten © OpenStreetMap-Mitwirkende
- Gebäudegrößen: © OpenStreetMap-Mitwirkende (ODbL)
- Fotos: Wikimedia Commons, Urheber und Lizenz stehen auf jeder Infokarte
- Koordinaten: Wikidata (CC0)
- Beschreibungstexte: eigene Kurztexte
