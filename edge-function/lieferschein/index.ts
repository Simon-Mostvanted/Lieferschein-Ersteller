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
};

/** Dieselbe Zuordnung für die Suchliste. */
const VORBELEG_TYP: Record<string, string> = {
  angebot: "quotation",
  auftragsbestaetigung: "orderconfirmation",
  rechnung: "salesinvoice",
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
// Die Aktionen. Alles, was die Maske darf - und nichts darüber hinaus.
// ---------------------------------------------------------------------
async function ausfuehren(aktion: string, daten: Record<string, any>) {
  switch (aktion) {

    // Kontakt suchen. Lexware verlangt mindestens drei Zeichen.
    case "kontakte": {
      const suche = String(daten.suche ?? "").trim();
      if (suche.length < 3) return { treffer: [] };
      const gefunden = await jsonOderFehler(
        await lexware(`/contacts?name=${encodeURIComponent(suche)}&customer=true&page=0&size=25`),
      );
      return {
        treffer: (gefunden.content ?? []).map((kontakt: any) => ({
          id: kontakt.id,
          name: kontakt.company?.name ??
            [kontakt.person?.firstName, kontakt.person?.lastName].filter(Boolean).join(" "),
          nummer: kontakt.roles?.customer?.number ?? null,
          adresse: kontakt.addresses?.billing?.[0] ?? null,
        })),
      };
    }

    // Der ganze aktive Artikelstamm, schlank.
    case "artikel":
      return { artikel: await artikelListe() };

    // Vorbelege zum Auswählen.
    case "vorbelege": {
      const typ = VORBELEG_TYP[String(daten.typ ?? "")];
      if (!typ) throw new Error("Unbekannte Belegart.");
      const gefunden = await jsonOderFehler(
        await lexware(`/voucherlist?voucherType=${typ}&voucherStatus=any&page=0&size=25`),
      );
      return {
        treffer: (gefunden.content ?? []).map((beleg: any) => ({
          id: beleg.id,
          nummer: beleg.voucherNumber,
          datum: beleg.voucherDate,
          kontaktId: beleg.contactId ?? null,
          kunde: beleg.contactName ?? "",
        })),
      };
    }

    // Einen Vorbeleg lesen, um Empfänger und Positionen vorzubelegen.
    // Lexware übernimmt sie beim Verknüpfen NICHT von selbst.
    case "vorbeleg": {
      const pfad = VORBELEG_PFAD[String(daten.typ ?? "")];
      if (!pfad) throw new Error("Unbekannte Belegart.");
      const beleg = await jsonOderFehler(await lexware(`/${pfad}/${daten.id}`));
      return {
        nummer: beleg.voucherNumber,
        adresse: beleg.address ?? null,
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

      const heute = new Date().toISOString();
      const koerper = {
        voucherDate: heute,
        address: beleg.address,
        lineItems: positionen,
        taxConditions: { taxType: "net" },
        shippingConditions: { shippingDate: heute, shippingType: "delivery" },
        title: "Lieferschein",
        introduction: beleg.introduction ?? "",
        remark: beleg.remark ?? "",
        deliveryTerms: beleg.deliveryTerms ?? "keine",
      };

      let pfad = "/delivery-notes?finalize=true";
      if (daten.vorbelegId) {
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
