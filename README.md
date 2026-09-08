# Lieferschein-Maske

Lieferscheine anlegen, ohne eigenen Lexware-Zugang. Die Maske sammelt
Empfänger und Positionen, legt den Beleg **direkt final** in Lexware Office an
und öffnet den Druckdialog des Browsers.

Aufgebaut wie die übrigen Anwendungen der Suite: **eine einzelne HTML-Datei**,
keine Installation, kein Node.js. React, Tailwind und Supabase werden beim
Öffnen über ein CDN nachgeladen.

Der Unterschied zu den anderen Apps: Es gibt ein **zweites Teil**, eine kleine
Funktion bei Supabase. Sie hält den Lexware-Schlüssel. Ohne sie läuft nichts.

## Dateien

| Datei | Zweck |
| --- | --- |
| `index.html` | Die komplette Maske |
| `edge-function/lieferschein/index.ts` | Das Zwischenstück zu Lexware (läuft bei Supabase) |
| `Lieferschein-Supabase-Setup.sql` | Datenbank einrichten (einmalig) |
| `Start-Lieferschein.cmd` | Am PC öffnen |
| `build/serve.ps1` | Der kleine Webserver dahinter |

## Einrichten (einmalig)

**1. Datenbank anlegen.** Supabase-Dashboard → SQL Editor → New query →
Inhalt von `Lieferschein-Supabase-Setup.sql` einfügen → Run.

**2. Schema freischalten.** Project Settings → API → *Exposed schemas* um
`lieferscheine` ergänzen und speichern. **Ohne diesen Schritt funktioniert
nichts** — die Maske meldet dann „Invalid schema: lieferscheine".

**3. Lexware-Schlüssel erzeugen.** Unter <https://app.lexware.de/addons/public-api>
einen Schlüssel mit allen Berechtigungen anlegen. Er wird **nur einmal
angezeigt** — Fenster erst schließen, wenn er kopiert ist. Lexware-Schlüssel
laufen nach längstens 24 Monaten ab; wenn die Maske eines Tages grundlos
„nicht berechtigt" meldet, ist das der erste Verdacht.

**4. Die Funktion einrichten.** Dashboard → Edge Functions → *Deploy a new
function* → Name **`lieferschein`** → den Inhalt von
`edge-function/lieferschein/index.ts` einfügen → Deploy.

Danach unter *Edge Functions → Secrets* eintragen:

```
LEXWARE_API_KEY = <der Schlüssel aus Schritt 3>
```

Der Schlüssel steht damit **nur** dort. Nicht in der HTML-Datei, nicht im Repo.

> Falls die Maske nach dem Einrichten „401" oder „Invalid JWT" meldet: bei der
> Funktion *Verify JWT* abschalten. Die Anwendung hat keinen Login, mit dem
> sich ein gültiges Token erzeugen ließe. Was das bedeutet, steht unten unter
> „Sicherheitshinweis".

**5. Mitarbeiter.** Nichts zu tun. Die Namen kommen aus
`werkstatt.mitarbeiter`, gepflegt über die Auftragsübersicht. Wer dort steht
und `aktiv` ist, erscheint hier.

## Starten

Doppelklick auf `Start-Lieferschein.cmd`. Öffnet
`http://localhost:8781/index.html`.

Das schwarze Fenster muss offen bleiben, solange gearbeitet wird — es *ist* der
Server.

## Bedienung

Beim Öffnen den eigenen Namen wählen. Er wird zu jedem Lieferschein
protokolliert; ohne Namen geht es nicht weiter.

1. **Vorbeleg** (optional) — Angebot, Auftragsbestätigung oder Rechnung
   wählen. Empfänger und Positionen werden übernommen, der Lieferschein wird
   in Lexware mit dem Vorbeleg verknüpft. Die Bezugsnummer erscheint dabei
   **nicht** automatisch auf dem Beleg — wer sie draufhaben will, schreibt sie
   in den Einleitungstext.
2. **Empfänger** — entweder ein Lexware-Kontakt (Suche ab drei Zeichen) oder
   eine Einmaladresse. Die Einmaladresse wird nicht in die Lexware-Kontakte
   zurückgeschrieben.
3. **Positionen** — drei Sorten Zeilen: *Artikel* (Suche im Lexware-Stamm,
   übernimmt Nummer und Bezeichnung), *Frei* (Bezeichnung von Hand) und
   *Überschrift* (Zwischentext ohne Menge). Reihenfolge über ↑ ↓.
4. **Einleitungstext** — hier gehören Kommission und Fahrzeug-ID hinein.
5. **Prüfen und absenden** — die Vorschau ist Pflicht.

**Nach dem Absenden ist keine Änderung mehr möglich.** Lexware kennt für
Lieferscheine keinen Bearbeiten-Aufruf. Ein Entwurf wäre änderbar, ließe sich
aber nicht drucken — deshalb wird direkt final angelegt.

Unter *Zuletzt erstellt* liegen die letzten 50 Belege aus der Maske, jeder
erneut druckbar. Das PDF wird dabei frisch aus Lexware geholt.

## Zwei Dinge, die anders sind als gedacht

**Der Artikelstamm lässt sich bei Lexware nicht nach Namen durchsuchen** — die
Schnittstelle kennt nur exakte Artikelnummer, GTIN und Typ. Die Funktion holt
deshalb einmal den ganzen aktiven Stamm (rund 1.000 Artikel, fünf Aufrufe) und
hält ihn 15 Minuten im Speicher; gesucht wird danach im Browser. Der erste
Artikel eines Tages dauert daher zwei, drei Sekunden.

**Ein Vorbeleg bringt seine Positionen nicht mit.** Die Verknüpfung setzt nur
den Bezug; die Positionen liest die Maske selbst aus dem Vorbeleg und schickt
sie mit.

## Sicherheitshinweis

**Diese Anwendung gehört nicht ins offene Internet — anders als die
Auftragsübersicht.**

Die Auftragsübersicht liegt öffentlich auf GitHub Pages. Das ist dort tragbar:
Wer sie findet, sieht Werkstattaufträge. Hier ist der Einsatz höher. Wer die
Adresse der Funktion kennt, kann darüber

- eure Kontakte und den Artikelstamm lesen,
- die letzten Angebote, Auftragsbestätigungen und Rechnungen auflisten,
- **Lieferscheine in eurem Lexware anlegen**.

Nicht möglich ist: löschen, ändern, Rechnungen im Volltext lesen, den
Lexware-Schlüssel selbst abgreifen. Die Funktion lässt nur eine feste Liste von
Aktionen zu und reicht keinen beliebigen Lexware-Pfad durch.

Trotzdem: Die Maske läuft lokal über `Start-Lieferschein.cmd`, und das Repo
gehört **auf privat** gestellt. Solange es keinen Login gibt, ist die
Geheimhaltung der Funktionsadresse der einzige Schutz.

Der saubere Weg wäre ein echter Login (Supabase Auth) und *Verify JWT* an der
Funktion. Das ist der nächste sinnvolle Ausbauschritt.

## Noch offen

Login statt Namensauswahl · Lieferscheine stornieren oder nachdrucken direkt
aus Lexware · weitere Belegarten · fester Werkstattdrucker ohne Dialog
