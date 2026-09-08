-- =====================================================================
-- Lieferschein-Maske - Supabase-Setup
-- =====================================================================
-- Einmal komplett im Supabase SQL-Editor ausführen
-- (Dashboard -> SQL Editor -> New query -> einfügen -> Run).
--
-- Danach zwingend: Project Settings -> API -> "Exposed schemas"
-- um `lieferscheine` ergänzen und speichern. Ohne diesen Schritt
-- antwortet die Datenbank auf jede Anfrage der App mit 404.
-- (Derselbe Stolperstein wie seinerzeit bei `werkstatt`.)
--
-- Läuft im selben Supabase-Projekt wie die Auftragsübersicht, damit die
-- Mitarbeiterliste nicht doppelt gepflegt werden muss.
--
-- Die Datei ist wiederholbar - erneutes Ausführen schadet nicht.
-- =====================================================================


-- =====================================================================
-- 1. Schema
-- =====================================================================
-- Eigenes Schema statt `public`: die Lieferschein-Maske ist eine eigene
-- Anwendung mit eigenem Lebenszyklus. Sie greift lesend auf die
-- Mitarbeiter der Werkstatt zu, hat aber sonst nichts mit ihr zu tun.

create schema if not exists lieferscheine;


-- =====================================================================
-- 2. Mitarbeiter - bewusst KEINE eigene Tabelle
-- =====================================================================
-- Die Namensliste existiert bereits in `werkstatt.mitarbeiter`, gepflegt
-- über die Auftragsübersicht. Eine zweite Liste würde auseinanderlaufen:
-- Wer dort ausscheidet, stünde hier weiter im Dropdown.
--
-- Stattdessen eine Sicht. Spalten sind einzeln aufgeführt und nicht als
-- `m.*` - sonst friert Postgres die heutige Spaltenliste ein und eine
-- später ergänzte Spalte fehlt still (der Fallstrick aus
-- v_auftrag_uebersicht, siehe Auftragsübersicht/docs/entscheidungen.md).

drop view if exists lieferscheine.mitarbeiter;
create view lieferscheine.mitarbeiter as
  select m.id,
         m.name,
         m.bereich
    from werkstatt.mitarbeiter m
   where m.aktiv;

alter view lieferscheine.mitarbeiter set (security_invoker = on);


-- =====================================================================
-- 3. Protokoll
-- =====================================================================
-- Beantwortet die Frage, die Lexware nicht beantworten kann: WER hat den
-- Beleg über die Maske erstellt, aus welchem Vorbeleg, mit welchen
-- Positionen im Moment des Absendens.
--
-- Das PDF wird NICHT hier abgelegt. Es lebt in Lexware und wird bei
-- Bedarf über `lexware_id` frisch geholt. Eine Kopie könnte nur
-- veralten.

create table if not exists lieferscheine.lieferschein_log (
  id               uuid primary key default gen_random_uuid(),
  erstellt_am      timestamptz not null default now(),

  -- Wer. Zeigt auf die echte Mitarbeitertabelle, nicht auf die Sicht.
  ersteller_id     uuid not null references werkstatt.mitarbeiter(id),

  -- Was in Lexware entstanden ist. Die Belegnummer wird mitgeschrieben,
  -- weil im Gespräch niemand von einer UUID spricht, sondern von
  -- "LS-26698".
  lexware_id       uuid,
  lexware_beleg_nr text,

  -- Vorbeleg, falls einer gewählt wurde.
  bezug_typ        text not null default 'keiner'
                     check (bezug_typ in ('angebot','auftragsbestaetigung','rechnung','keiner')),
  bezug_lexware_id uuid,
  bezug_beleg_nr   text,

  -- Empfänger: entweder ein Lexware-Kontakt oder eine Einmaladresse.
  -- Der Name wird in beiden Fällen mitgeschrieben, damit sich eine Liste
  -- anzeigen lässt, ohne für jede Zeile bei Lexware nachzufragen.
  empfaenger_typ       text not null
                         check (empfaenger_typ in ('kontakt','einmaladresse')),
  empfaenger_name      text not null,
  empfaenger_kontakt_id uuid,
  empfaenger_adresse   jsonb,

  -- Abzug der Positionen zum Zeitpunkt des Absendens.
  positionen       jsonb not null default '[]'::jsonb,
  kopftext         text,

  status           text not null default 'erstellt'
                     check (status in ('erstellt','fehler')),
  fehler_text      text,

  -- Ein Vorbeleg braucht eine Kennung, "kein Vorbeleg" darf keine haben.
  constraint bezug_stimmig check (
    (bezug_typ = 'keiner' and bezug_lexware_id is null) or
    (bezug_typ <> 'keiner' and bezug_lexware_id is not null)
  ),

  -- Je nach Empfängerart muss das passende Feld gefüllt sein.
  constraint empfaenger_stimmig check (
    (empfaenger_typ = 'kontakt'       and empfaenger_kontakt_id is not null) or
    (empfaenger_typ = 'einmaladresse' and empfaenger_adresse    is not null)
  ),

  -- Ein geglückter Beleg hat eine Lexware-Kennung, ein gescheiterter
  -- einen Grund.
  constraint status_stimmig check (
    (status = 'erstellt' and lexware_id is not null) or
    (status = 'fehler'   and fehler_text is not null)
  )
);

-- Die Liste zeigt immer das Neueste zuerst.
create index if not exists lieferschein_log_erstellt_idx
  on lieferscheine.lieferschein_log (erstellt_am desc);

-- Nachschlagen über die Belegnummer, wenn jemand im Büro danach fragt.
create index if not exists lieferschein_log_beleg_nr_idx
  on lieferscheine.lieferschein_log (lexware_beleg_nr);


-- =====================================================================
-- 4. Rechte
-- =====================================================================
-- Ohne diese GRANTs ist das Schema über die API nicht erreichbar.

grant usage on schema lieferscheine to anon, authenticated, service_role;

grant all on all tables    in schema lieferscheine to anon, authenticated, service_role;
grant all on all sequences in schema lieferscheine to anon, authenticated, service_role;
grant all on all functions in schema lieferscheine to anon, authenticated, service_role;

alter default privileges in schema lieferscheine
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema lieferscheine
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema lieferscheine
  grant all on functions to anon, authenticated, service_role;


-- =====================================================================
-- 5. Row Level Security
-- =====================================================================
-- Wie in der Auftragsübersicht (E-03): RLS ist aktiv, die Regeln sind im
-- MVP offen, weil es keinen Anmelde-Kontext gibt, an dem eine Regel
-- ansetzen könnte.
--
-- WICHTIG, und hier ernster als in der Werkstatt: Der Lexware-Schlüssel
-- liegt NICHT in dieser Datenbank und nicht in der HTML-Datei, sondern
-- als Secret in der Edge Function. Wer Projekt-URL und Schlüssel dieser
-- Datenbank hat, kann also das Protokoll lesen - aber keine Belege in
-- Lexware anlegen.

alter table lieferscheine.lieferschein_log enable row level security;

drop policy if exists lieferschein_log_mvp_offen on lieferscheine.lieferschein_log;
create policy lieferschein_log_mvp_offen on lieferscheine.lieferschein_log
  for all to anon, authenticated using (true) with check (true);

comment on schema lieferscheine is
  'Lieferschein-Maske. Protokoll der über die Maske erstellten Lexware-Lieferscheine. MVP ohne Login - RLS aktiv, Regeln offen.';
