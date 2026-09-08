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

**Im Betrieb — Handy und PC:**
<https://simon-mostvanted.github.io/Lieferschein-Ersteller/>

Am Telefon einmal öffnen und auf den Startbildschirm legen, dann liegt sie wie
eine App auf dem Gerät. Der gewählte Name wird pro Gerät gemerkt.

**Zum Entwickeln:** Doppelklick auf `Start-Lieferschein.cmd` öffnet
`http://localhost:8781/index.html` mit dem Stand aus diesem Ordner. Das
schwarze Fenster muss offen bleiben — es *ist* der Server.

**Ausliefern:** Änderungen committen und hochladen, GitHub Pages zieht
automatisch nach:

```
git push
```

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

**Der Lexware-Schlüssel liegt sicher.** Er steckt ausschließlich im
Supabase-Secret, die Funktion gibt ihn nie heraus, und im Quelltext der
HTML-Datei steht er nirgends. Daran ändert auch die Veröffentlichung nichts.

**Die Anwendung selbst ist offen.** Sie liegt wie die übrigen Apps öffentlich
auf GitHub Pages, damit die Kollegen sie am Handy öffnen können. Es gibt keinen
Login. Wer die Adresse kennt, kann darüber

- eure Kontakte und den Artikelstamm lesen,
- die letzten Angebote, Auftragsbestätigungen und Rechnungen auflisten,
- **Lieferscheine in eurem Lexware anlegen**.

Nicht möglich ist: löschen, ändern, Rechnungen im Volltext lesen, den
Lexware-Schlüssel abgreifen. Die Funktion lässt nur eine feste Liste von
Aktionen zu und reicht keinen beliebigen Lexware-Pfad durch.

**Das ist eine bewusste Entscheidung** (Simon, 2026-09-08): Die App wird im
Firmenumfeld genutzt, der Zugriff auf Kontaktdaten wird vorerst in Kauf
genommen, und die Erreichbarkeit am Handy hat Vorrang. Der Schutz besteht
derzeit allein darin, dass die Adresse nicht bekannt ist.

Wenn das nicht mehr reicht, gibt es zwei Stufen:

1. **Kennwort beim Absenden** — nur die Aktion „anlegen" wird geschützt, das
   Kennwort steht nicht im Quelltext, sondern wird einmal je Gerät eingegeben.
   Kleiner Eingriff, hält Gelegenheitsfunde ab.
2. **Echter Login** (Supabase Auth) und *Verify JWT* an der Funktion. Dann
   nützt die Adresse ohne Anmeldung gar nichts. Der saubere Weg.

## Noch offen

Login statt Namensauswahl · Lieferscheine stornieren oder nachdrucken direkt
aus Lexware · weitere Belegarten · fester Werkstattdrucker ohne Dialog
