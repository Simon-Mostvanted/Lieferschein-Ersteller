-- =====================================================================
-- Update-01: Lieferschein als Bezugsart zulassen
-- =====================================================================
-- Im Supabase SQL-Editor ausführen. Wiederholbar.
--
-- Die Maske bietet jetzt auch Lieferscheine als Vorbeleg an - praktisch,
-- wenn eine ähnliche Lieferung noch einmal rausgeht. Die Prüfregel auf
-- `bezug_typ` kannte diesen Wert nicht und hätte den Protokolleintrag
-- abgelehnt. Der Lieferschein in Lexware wäre trotzdem entstanden; es
-- fehlte nur die Spur, wer ihn woraus erstellt hat.
--
-- In Lexware wird ein solcher Beleg NICHT verknüpft - ein Lieferschein
-- lässt sich nicht aus einem Lieferschein fortführen. Er dient allein
-- als Vorlage. Im Protokoll wird er trotzdem festgehalten, damit
-- nachvollziehbar bleibt, woher die Positionen stammen.
-- =====================================================================

alter table lieferscheine.lieferschein_log
  drop constraint if exists lieferschein_log_bezug_typ_check;

alter table lieferscheine.lieferschein_log
  add constraint lieferschein_log_bezug_typ_check
  check (bezug_typ in ('angebot','auftragsbestaetigung','rechnung','lieferschein','keiner'));


-- Kontrolle: Woraus wurden die bisherigen Lieferscheine erstellt?
-- select bezug_typ, count(*) from lieferscheine.lieferschein_log group by 1;
