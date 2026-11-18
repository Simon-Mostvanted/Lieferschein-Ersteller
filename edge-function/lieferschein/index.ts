// =====================================================================
// Lieferschein-Maske - Zwischenstück zu Lexware
// =====================================================================
// Supabase Edge Function. Sie existiert aus genau einem Grund: Der
// Lexware-Schlüssel darf nicht in die HTML-Datei. Mit ihm käme man an
// die gesamte Buchhaltung - alle Kunden, alle Rechnungen - und könnte
// Belege anlegen. Er liegt deshalb hier als Secret und verlässt den
// Server nie.
//
// Die Maske schickt eine Aktion aus einer festen Liste. Sie kann KEINEN
// beliebigen Lexware-Pfad ansprechen; wer die HTML-Datei manipuliert,
// kommt damit nicht weiter als die Maske selbst.
//
// Secret setzen (Dashboard -> Edge Functions -> Secrets):
//   LEXWARE_API_KEY = <der Schlüssel aus app.lexware.de/addons/public-api>
// =====================================================================

const LEXWARE = "https://api.lexware.io/v1";
const KEY = Deno.env.get("LEXWARE_API_KEY");

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** Belegarten, die als Vorbeleg dienen dürfen -> Lexware-Pfad zum Lesen. */
const VORBELEG_PFAD: Record<string, string> = {
  angebot: "quotations",
  auftragsbestaetigung: "order-confirmations",
  rechnung: "invoices",
  // Lieferscheine werden nur GELESEN, nie fortgeführt: Lexware verknüpft
  // einen Lieferschein nicht mit einem anderen. In der Maske dient er als
  // Vorlage zum Abschreiben, in der Auftragsübersicht als WSA-Beleg.
  lieferschein: "delivery-notes",
};

/**
 * Dieselbe Zuordnung für die Suchliste.
 *
 * Achtung bei Rechnungen: `invoice` ist die in Lexware geschriebene
 * Rechnung an einen Kunden. `salesinvoice` klingt richtiger, ist aber der
 * hochgeladene Beleg in der Buchhaltung - dort standen AOK, Aufbaubank
 * und Arbeitsagentur statt eurer Kunden.
 */
const VORBELEG_TYP: Record<string, string> = {
  angebot: "quotation",
  auftragsbestaetigung: "orderconfirmation",
  rechnung: "invoice",
  lieferschein: "deliverynote",
};


// ---------------------------------------------------------------------
// Lexware ist auf zwei Anfragen je Sekunde begrenzt. Alles läuft
// deshalb durch eine Schlange, die einen Mindestabstand einhält - sonst
// kippt der Artikelabruf (fünf Seiten am Stück) in ein 429.
// ---------------------------------------------------------------------
let letzterRuf = 0;
let schlange: Promise<unknown> = Promise.resolve();

function warte(ms: number) {
  return new Promise((fertig) => setTimeout(fertig, ms));
}

function anstellen<T>(arbeit: () => Promise<T>): Promise<T> {
  const dran = schlange.then(async () => {
    const abstand = Date.now() - letzterRuf;
    if (abstand < 550) await warte(550 - abstand);
    letzterRuf = Date.now();
    return arbeit();
  });
  // Die Schlange darf nicht an einem Fehler zerbrechen.
  schlange = dran.catch(() => {});
  return dran as Promise<T>;
}


/**
 * Ein Aufruf an Lexware, mit Wiederholung bei Überlastung.
 * Gibt die rohe Antwort zurück - das PDF ist keine JSON.
 */
async function lexware(pfad: string, init: RequestInit = {}): Promise<Response> {
  for (let versuch = 0; versuch < 3; versuch++) {
    const antwort = await anstellen(() =>
      fetch(LEXWARE + pfad, {
        ...init,
        headers: {
          Authorization: `Bearer ${KEY}`,
          Accept: "application/json",
          ...(init.headers ?? {}),
        },
      })
    );
    if (antwort.status !== 429) return antwort;
    await warte(1200 * (versuch + 1));
  }
  throw new Error("Lexware ist gerade überlastet. Bitte in einem Moment erneut versuchen.");
}


/**
 * Lexware meldet auch fachliche Fehler als 406, nicht als 400. Die
 * eigentliche Ursache steht in `details` - die holen wir heraus, sonst
 * steht in der Maske nur "Validation failed".
 */
async function fehlerText(antwort: Response): Promise<string> {
  let roh = "";
  try {
    roh = await antwort.text();
  } catch {
    // Ohne Text bleibt uns nur der Statuscode.
  }

  try {
    const daten = JSON.parse(roh);
    const teile: string[] = [];
    for (const detail of daten.details ?? []) {
      const feld = detail.field ? `${detail.field}: ` : "";
      teile.push(feld + (detail.message ?? detail.violation ?? ""));
    }
    if (teile.length) return teile.join(" · ");
    if (daten.message) return daten.message;
  } catch {
    // Keine JSON - dann eben der Rohtext.
  }

  return roh.slice(0, 400) || `Lexware antwortete mit ${antwort.status}.`;
}


async function jsonOderFehler(antwort: Response) {
  if (!antwort.ok) throw new Error(await fehlerText(antwort));
  return antwort.json();
}


// ---------------------------------------------------------------------
// Der Artikelstamm lässt sich bei Lexware NICHT nach Namen durchsuchen -
// es gibt nur exakte Artikelnummer, GTIN und Typ. Bei gut tausend
// Artikeln ist der einfachste Weg, ihn einmal komplett zu holen und im
// Browser zu durchsuchen. Fünf Seiten, etwa drei Sekunden. Danach liegt
// er hier im Speicher; solange die Funktion warm ist, geht es sofort.
// ---------------------------------------------------------------------
type Artikel = { id: string; titel: string; nummer: string | null; einheit: string | null };

let artikelCache: { stand: number; liste: Artikel[] } | null = null;
const CACHE_MINUTEN = 15;

async function artikelListe(): Promise<Artikel[]> {
  if (artikelCache && Date.now() - artikelCache.stand < CACHE_MINUTEN * 60_000) {
    return artikelCache.liste;
  }

  const liste: Artikel[] = [];
  let seite = 0;
  let seiten = 1;

  while (seite < seiten && seite < 20) {
    const daten = await jsonOderFehler(await lexware(`/articles?page=${seite}&size=250`));
    seiten = daten.totalPages ?? 1;
    for (const artikel of daten.content ?? []) {
      // Archivierte Artikel gehören nicht in die Auswahl - der Stamm
      // reicht bis 2019 zurück und ist zu großen Teilen stillgelegt.
      if (artikel.archived) continue;
      liste.push({
        id: artikel.id,
        titel: artikel.title ?? "",
        nummer: artikel.articleNumber ?? null,
        einheit: artikel.unitName ?? null,
      });
    }
    seite++;
  }

  liste.sort((a, b) => a.titel.localeCompare(b.titel, "de"));
  artikelCache = { stand: Date.now(), liste };
  return liste;
}


// ---------------------------------------------------------------------
// Vorbelege. Die Belegliste von Lexware filtert nur nach Belegnummer und
// Kontakt-ID, nicht nach Kundennamen. Eine Suche nach "Fischer" ginge also
// nur über den Umweg Kontaktsuche - und fände nie die Belege mit
// Einmaladresse, die gar keine Kontakt-ID haben. Deshalb wie beim
// Artikelstamm: die Belege der letzten zwei Jahre einmal holen, kurz
// vorhalten, und im Browser durchsuchen.
// ---------------------------------------------------------------------
type Vorbeleg = {
  id: string;
  nummer: string;
  datum: string;
  kontaktId: string | null;
  kunde: string;
};

const vorbelegCache = new Map<string, { stand: number; liste: Vorbeleg[] }>();
const VORBELEG_MINUTEN = 5;
const VORBELEG_MONATE = 24;

async function vorbelegListe(typ: string): Promise<Vorbeleg[]> {
  const gemerkt = vorbelegCache.get(typ);
  if (gemerkt && Date.now() - gemerkt.stand < VORBELEG_MINUTEN * 60_000) {
    return gemerkt.liste;
  }

  const ab = new Date();
  ab.setMonth(ab.getMonth() - VORBELEG_MONATE);
  const abDatum = ab.toISOString().slice(0, 10);

  const liste: Vorbeleg[] = [];
  let seite = 0;
  let seiten = 1;

  while (seite < seiten && seite < 10) {
    const daten = await jsonOderFehler(
      await lexware(
        `/voucherlist?voucherType=${typ}&voucherStatus=any` +
          `&voucherDateFrom=${abDatum}&page=${seite}&size=250`,
      ),
    );
    seiten = daten.totalPages ?? 1;
    for (const beleg of daten.content ?? []) {
      // Entwürfe lassen sich nicht fortführen - Lexware lehnt das
      // Anlegen dann mit 406 ab. Stornierte Belege liefert niemand aus.
      if (beleg.voucherStatus === "draft" || beleg.voucherStatus === "voided") continue;
      liste.push({
        id: beleg.id,
        nummer: beleg.voucherNumber ?? "",
        datum: beleg.voucherDate,
        kontaktId: beleg.contactId ?? null,
        kunde: beleg.contactName ?? "",
      });
    }
    seite++;
  }

  vorbelegCache.set(typ, { stand: Date.now(), liste });
  return liste;
}


// ---------------------------------------------------------------------
// Positionen aufbereiten.
//
// Festlegung: Auf dem Lieferschein stehen KEINE Preise. Das wird hier
// erzwungen und nicht der Maske überlassen - sonst schleppt ein aus
// einem Angebot übernommener Posten seinen Preis mit.
// ---------------------------------------------------------------------
function positionenSaeubern(roh: unknown[]): Record<string, unknown>[] {
  return (roh ?? []).map((eintrag) => {
    const position = eintrag as Record<string, unknown>;
    const typ = String(position.type ?? "custom");

    if (typ === "text") {
      return {
        type: "text",
        name: String(position.name ?? ""),
        description: String(position.description ?? ""),
      };
    }

    const gesaeubert: Record<string, unknown> = {
      type: typ,
      name: String(position.name ?? ""),
      quantity: Number(position.quantity ?? 0),
      unitName: String(position.unitName ?? "Stück"),
      unitPrice: { currency: "EUR", netAmount: 0, grossAmount: 0, taxRatePercentage: 19 },
    };
    if (position.description) gesaeubert.description = String(position.description);
    // Artikel aus dem Lexware-Stamm brauchen ihre Kennung.
    if ((typ === "material" || typ === "service") && position.id) {
      gesaeubert.id = position.id;
    }
    return gesaeubert;
  });
}


// ---------------------------------------------------------------------
// Erreichbarkeit eines Kontakts.
//
// Für die Auftragsübersicht der Werkstatt: Wer am Fahrzeug steht und
// eine Rückfrage hat, soll den Kunden anrufen können, ohne vorher im
// Büro nachzufragen. Auf dem Beleg selbst stehen nur Name und Anschrift
// - Mail und Telefon hängen am Kontakt.
//
// Lexware sortiert beides in Fächer (`business`, `mobile`, `private`,
// ...). Welches gefüllt ist, hängt daran, wer den Kontakt angelegt hat;
// eine verlässliche Rangfolge gibt es nicht. Deshalb werden ALLE
// eingesammelt, Reihenfolge nach Brauchbarkeit für einen Anruf. Was am
// Ende im Auftrag steht, entscheidet die Werkstatt selbst - das Feld
// dort ist ein normales Textfeld.
//
// `fax` bleibt bewusst draußen: Eine Faxnummer im Anruf-Verweis ist
// keine Hilfe, sondern ein Fehlversuch.
// ---------------------------------------------------------------------
type Erreichbarkeit = { emails: string[]; telefone: string[] };

function sammle(faecher: Record<string, unknown> | undefined, reihenfolge: string[]): string[] {
  const gefunden: string[] = [];
  for (const fach of reihenfolge) {
    for (const wert of (faecher?.[fach] as unknown[]) ?? []) {
      const text = String(wert ?? "").trim();
      // Doppelte kommen vor: dieselbe Nummer steht oft in zwei Fächern.
      if (text && !gefunden.includes(text)) gefunden.push(text);
    }
  }
  return gefunden;
}

function erreichbarkeit(kontakt: Record<string, any>): Erreichbarkeit {
  const emails = sammle(kontakt.emailAddresses, ["business", "office", "private", "other"]);
  const telefone = sammle(kontakt.phoneNumbers, ["mobile", "business", "office", "private", "other"]);

  // Bei Firmen ist der Kontakt selbst oft leer und die Erreichbarkeit
  // hängt an der Ansprechperson. Die kommt hinten dran - der direkte
  // Eintrag hat Vorrang.
  for (const person of kontakt.company?.contactPersons ?? []) {
    const mail = String(person?.emailAddress ?? "").trim();
    const tel = String(person?.phoneNumber ?? "").trim();
    if (mail && !emails.includes(mail)) emails.push(mail);
    if (tel && !telefone.includes(tel)) telefone.push(tel);
  }

  return { emails, telefone };
}


// ---------------------------------------------------------------------
// Empfänger auflösen.
//
// Lexware nimmt auf einem Beleg eine `contactId` nur an, wenn der
// Kontakt die Rolle KUNDE hat: "Referenced contact needs to have role
// customer". Ein reiner Lieferant wird abgelehnt - dabei geht gerade an
// ihn regelmäßig Ware raus, Teile zur Bearbeitung etwa.
//
// Deshalb vor dem Anlegen nachsehen, welche Rollen der Kontakt trägt.
// Fehlt die Kundenrolle, wird aus der Verknüpfung eine Einmaladresse:
// Name und Anschrift stehen dann wörtlich auf dem Beleg. Gedruckt sieht
// das gleich aus; es entfällt allein die Verknüpfung in Lexware, die es
// für einen Lieferanten ohnehin nicht geben kann.
// ---------------------------------------------------------------------
async function empfaengerAufloesen(
  adressfeld: Record<string, any>,
): Promise<Record<string, unknown>> {
  const id = String(adressfeld?.contactId ?? "").trim();
  if (!id) return adressfeld;

  const kontakt = await jsonOderFehler(await lexware(`/contacts/${id}`));
  if (kontakt.roles?.customer) return adressfeld;

  // Beim Lieferschein zählt die Lieferanschrift; die Rechnungsanschrift
  // ist der Rückfall. (Dieselbe Reihenfolge wie in der Kontaktsuche,
  // damit Vorschau und Beleg dasselbe zeigen.)
  const anschrift = kontakt.addresses?.shipping?.[0] ??
    kontakt.addresses?.billing?.[0] ?? {};

  const name = String(
    kontakt.company?.name ??
      [kontakt.person?.firstName, kontakt.person?.lastName].filter(Boolean).join(" "),
  ).trim();

  if (!name) {
    throw new Error(
      "Dieser Kontakt ist in Lexware kein Kunde und hat keinen Namen. " +
        "Bitte die Anschrift von Hand eintragen.",
    );
  }

  // `name` und `countryCode` sind bei einer Einmaladresse Pflicht, der
  // Rest ist freiwillig - leere Felder bleiben besser ganz weg.
  const ersatz: Record<string, unknown> = {
    name,
    countryCode: anschrift.countryCode ?? "DE",
  };
  for (const feld of ["supplement", "street", "zip", "city"]) {
    const wert = String(anschrift[feld] ?? "").trim();
    if (wert) ersatz[feld] = wert;
  }
  return ersatz;
}


// ---------------------------------------------------------------------
// Die Aktionen. Alles, was die Maske darf - und nichts darüber hinaus.
// ---------------------------------------------------------------------
async function ausfuehren(aktion: string, daten: Record<string, any>) {
  switch (aktion) {

    // Kontakt suchen. Lexware verlangt mindestens drei Zeichen.
    case "kontakte": {
      const suche = String(daten.suche ?? "").trim();
      if (suche.length < 3) return { treffer: [] };
      /* Ohne `customer=true`: Es wird auch an Lieferanten geliefert -
         Teile zur Bearbeitung, Rücksendungen, beigestelltes Material. */
      const gefunden = await jsonOderFehler(
        await lexware(`/contacts?name=${encodeURIComponent(suche)}&page=0&size=25`),
      );
      return {
        treffer: (gefunden.content ?? []).map((kontakt: any) => {
          const kunde = kontakt.roles?.customer;
          const lieferant = kontakt.roles?.vendor;
          return {
            id: kontakt.id,
            name: kontakt.company?.name ??
              [kontakt.person?.firstName, kontakt.person?.lastName].filter(Boolean).join(" "),
            // Wer beides ist, wird als Kunde geführt - das ist der
            // häufigere Fall beim Lieferschein.
            nummer: kunde?.number ?? lieferant?.number ?? null,
            rolle: kunde ? "Kunde" : lieferant ? "Lieferant" : "",
            // Beim Lieferschein zieht Lexware die Lieferanschrift vor,
            // deshalb hier dieselbe Reihenfolge - sonst zeigte die
            // Vorschau eine andere Anschrift als der gedruckte Beleg.
            adresse: kontakt.addresses?.shipping?.[0] ??
              kontakt.addresses?.billing?.[0] ?? null,
          };
        }),
      };
    }

    // Der ganze aktive Artikelstamm, schlank.
    case "artikel":
      return { artikel: await artikelListe() };

    // Vorbelege zum Auswählen - alle der letzten zwei Jahre, neueste zuerst.
    case "vorbelege": {
      const typ = VORBELEG_TYP[String(daten.typ ?? "")];
      if (!typ) throw new Error("Unbekannte Belegart.");
      return { treffer: await vorbelegListe(typ) };
    }

    // Einen Vorbeleg lesen, um Empfänger und Positionen vorzubelegen.
    // Lexware übernimmt sie beim Verknüpfen NICHT von selbst.
    case "vorbeleg": {
      const pfad = VORBELEG_PFAD[String(daten.typ ?? "")];
      if (!pfad) throw new Error("Unbekannte Belegart.");
      const beleg = await jsonOderFehler(await lexware(`/${pfad}/${daten.id}`));

      // Erreichbarkeit dazuholen, wenn der Beleg an einem Kontakt hängt.
      // Einmaladressen haben keine `contactId` - dann bleibt es leer.
      //
      // Das darf den Import NICHT umwerfen: Scheitert der Abruf, kommen
      // Positionen und Kopfdaten trotzdem an und die Nummer wird von
      // Hand nachgetragen. Ein leerer Telefoneintrag ist ärgerlich, ein
      // verlorener Auftrag wäre schlimmer.
      const kontaktId = beleg.address?.contactId ?? null;
      let kontakt: Erreichbarkeit | null = null;
      if (kontaktId) {
        try {
          kontakt = erreichbarkeit(await jsonOderFehler(await lexware(`/contacts/${kontaktId}`)));
        } catch {
          kontakt = null;
        }
      }

      return {
        nummer: beleg.voucherNumber,
        adresse: beleg.address ?? null,
        kontaktId,
        kontakt,
        positionen: (beleg.lineItems ?? []).map((zeile: any) => ({
          type: zeile.type,
          id: zeile.id ?? null,
          name: zeile.name ?? "",
          description: zeile.description ?? "",
          quantity: zeile.quantity ?? null,
          unitName: zeile.unitName ?? null,
        })),
      };
    }

    // Anlegen. Direkt final - Entwürfe lassen sich nicht drucken.
    case "anlegen": {
      const beleg = daten.beleg ?? {};
      // Entweder ein Lexware-Kontakt (dann reicht dessen Kennung, den
      // Rest setzt Lexware ein) oder eine Einmaladresse mit Namen.
      if (!beleg.address?.contactId && !beleg.address?.name) {
        throw new Error("Der Empfänger fehlt.");
      }

      const positionen = positionenSaeubern(beleg.lineItems ?? []);
      if (!positionen.some((zeile) => zeile.type !== "text")) {
        throw new Error("Der Lieferschein enthält keine Position mit Menge.");
      }

      /* Beleg- und Lieferdatum sind der heutige Tag - der Lieferschein
         entsteht jetzt und die Ware geht jetzt raus. Das gewünschte
         Fertigstellungsdatum aus der Maske ist etwas anderes und steht
         als erste Zeile in den Positionen, nicht hier. */
      const heute = new Date().toISOString();

      /* Lieferanten kennt Lexware auf einem Beleg nicht als Kontakt.
         Fehlt die Kundenrolle, wird aus der Verknüpfung hier eine
         Einmaladresse - siehe empfaengerAufloesen(). */
      const empfaenger = await empfaengerAufloesen(beleg.address);

      const koerper = {
        voucherDate: heute,
        address: empfaenger,
        lineItems: positionen,
        taxConditions: { taxType: "net" },
        shippingConditions: { shippingDate: heute, shippingType: "delivery" },
        title: "Lieferschein",
        introduction: beleg.introduction ?? "",
        remark: beleg.remark ?? "",
      } as Record<string, unknown>;

      /* Lieferbedingungen nur mitschicken, wenn wirklich welche da sind.
         Früher stand hier fest "keine" - das ist aber keine der in
         Lexware hinterlegten Vorlagen und landete wörtlich auf dem
         Beleg. Ohne das Feld bleibt die Zeile leer. */
      const bedingungen = String(beleg.deliveryTerms ?? "").trim();
      if (bedingungen) koerper.deliveryTerms = bedingungen;

      let pfad = "/delivery-notes?finalize=true";
      /* Aus einem Lieferschein entsteht kein Lieferschein: Weiterführen
         kann Lexware nur Angebot, Auftragsbestätigung und Rechnung. Ein
         Lieferschein dient hier allein als Vorlage zum Abschreiben,
         deshalb wird er nicht verknüpft. */
      if (daten.vorbelegId && daten.bezugTyp !== "lieferschein") {
        pfad += `&precedingSalesVoucherId=${encodeURIComponent(String(daten.vorbelegId))}`;
      }

      const angelegt = await jsonOderFehler(
        await lexware(pfad, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(koerper),
        }),
      );

      // Für Protokoll und Anzeige die Belegnummer nachladen - das
      // Anlegen gibt nur die Kennung zurück, und im Büro spricht
      // niemand von einer UUID.
      let nummer: string | null = null;
      try {
        const fertig = await jsonOderFehler(await lexware(`/delivery-notes/${angelegt.id}`));
        nummer = fertig.voucherNumber ?? null;
      } catch {
        // Zur Not reicht die Kennung; der Beleg existiert ja.
      }

      return { id: angelegt.id, nummer };
    }

    // Das PDF. Kommt als Base64 zurück, damit die Maske daraus einen
    // Druckauftrag bauen kann. Es wird nirgends zwischengespeichert.
    case "pdf": {
      const antwort = await lexware(`/delivery-notes/${daten.id}/file`, {
        headers: { Accept: "application/pdf" },
      });
      if (!antwort.ok) throw new Error(await fehlerText(antwort));

      const bytes = new Uint8Array(await antwort.arrayBuffer());
      let roh = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        roh += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      return { pdf: btoa(roh) };
    }

    default:
      throw new Error("Unbekannte Aktion.");
  }
}


Deno.serve(async (anfrage) => {
  if (anfrage.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const antworte = (koerper: unknown, status = 200) =>
    new Response(JSON.stringify(koerper), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  if (anfrage.method !== "POST") return antworte({ fehler: "Nur POST." }, 405);
  if (!KEY) return antworte({ fehler: "Auf dem Server fehlt das Secret LEXWARE_API_KEY." }, 500);

  try {
    const daten = await anfrage.json();
    return antworte(await ausfuehren(String(daten.aktion ?? ""), daten));
  } catch (fehler) {
    return antworte({ fehler: fehler instanceof Error ? fehler.message : String(fehler) }, 400);
  }
});
