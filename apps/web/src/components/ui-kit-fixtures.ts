import type { StatusTone, StepState } from "@transfer/ui";

/**
 * The kit page's content (ui-patterns.md, testing): fixed synthetic values, so the page looks the
 * same on every run (the pixel comparison in ui-kit-visual.spec.ts). Sample data, not UI text:
 * nothing here is shown outside `/ui-kit`. No real person, project or date.
 */
export const kitToday = "2027-02-07";

export const kit = {
  title: "UI-Kit",
  metadata: "Personalnummer BSP-0016 · Welle W1",
  crumb: "Projekte",
  primary: "Profilingbogen erzeugen",
  menu: ["Erinnern", "Zuweisen", "Teilnahme beenden"],
  headerFacts: [
    { label: "TG-Beginn", value: "01.03.2027" },
    { label: "Unterschriftsfrist DSV", value: "12.02.2027 · in 5 Tagen" },
    { label: "Beratung", value: "Bernd Beratung" },
    { label: "Nächster Termin", value: "Di 09.02., 10:00" },
    { label: "Portal", value: "Aktiviert" },
  ],
  sections: {
    tiles: "CountTile",
    funnel: "Funnel",
    nextSteps: "NextSteps",
    sectionCard: "SectionCard",
    facts: "Facts",
    stepList: "StepList",
    dataTable: "DataTable",
    buttons: "Button",
  },
  tiles: [
    { count: 7, label: "Überfällig", tone: "danger" },
    { count: 12, label: "In den nächsten 14 Tagen", tone: "warning" },
    { count: 23, label: "Angaben/Unterlagen fehlen", tone: "info" },
    { count: 0, label: "Termine zu klären", tone: "warning" },
  ] satisfies { count: number; label: string; tone: StatusTone }[],
  loading: "Kacheln werden geladen",
  funnel: {
    label: "Verlauf",
    stages: [
      { key: "imported", count: 6, label: "Importiert" },
      { key: "contacted", count: 8, label: "Kontaktiert" },
      { key: "unreachable", count: 3, label: "Nicht erreichbar" },
      { key: "informed", count: 38, label: "Informiert" },
      { key: "active_in_tg", count: 21, label: "In der TG" },
      { key: "withdrawn", count: 5, label: "Ausgeschieden", ended: true },
      { key: "exited", count: 3, label: "Ausgetreten", ended: true },
    ],
  },
  nextSteps: {
    title: "Als Nächstes",
    summary: "3 von 6 offenen Punkten",
    more: "Alle 6 anzeigen",
    emptyTitle: "Als Nächstes (leer)",
    empty: "Keine offenen Punkte.",
    items: [
      {
        id: "asu",
        tone: "danger",
        toneLabel: "Überfällig",
        title: "Arbeitsuchendmeldung fehlt",
        detail: "seit 2 Tagen überfällig · fällig 05.02.2027",
        action: "Meldung erfassen",
      },
      {
        id: "dsv",
        tone: "warning",
        toneLabel: "Bald fällig",
        title: "DSV zurückerwartet",
        detail: "Unterschriftsfrist 12.02.2027 · in 5 Tagen",
        action: "Scan hochladen",
      },
      {
        id: "fields",
        tone: "info",
        toneLabel: "Offen",
        title: "4 Angaben in der Selbstauskunft fehlen",
        detail: "zuletzt erinnert am 03.02.2027",
        action: "Erinnern",
      },
    ] satisfies {
      id: string;
      tone: StatusTone;
      toneLabel: string;
      title: string;
      detail: string;
      action: string;
    }[],
  },
  cards: {
    open: { title: "Stammdaten", action: "Bearbeiten" },
    collapsed: { title: "Welle und Vertragsdaten", summary: "W1 · 01.03.2027 – 29.02.2028" },
    protected: {
      title: "Besonders geschützte Angaben",
      summary: "angegeben",
      body: "Synthetischer Inhalt, erst nach dem Öffnen im Dokument.",
    },
    body: "TG-Beginn 01.03.2027, TG-Ende 29.02.2028, spätester Eintritt 15.03.2027.",
  },
  facts: [
    { label: "Nachname", value: "Normalverbraucher" },
    { label: "Anschrift", value: "Musterstraße 16, 99999 Beispielstadt" },
    { label: "Vorname", value: "Anna" },
    { label: "E-Mail privat", value: "teilnehmer-0016@example.org" },
    { label: "Geburtsdatum", value: "14.05.1984" },
    { label: "Mobil", value: null },
    { label: "Austrittsdatum", value: "28.02.2027" },
    { label: "Telefon", value: null },
  ],
  steps: {
    label: "Profiling",
    items: [
      { id: "check", title: "Angaben prüfen", state: "done", status: "vollständig" },
      { id: "form", title: "Profilingbogen erzeugen", state: "current", status: "bereit" },
      {
        id: "sign",
        title: "Unterschrift einholen",
        state: "blocked",
        status: "wartet auf den Bogen",
      },
      { id: "scan", title: "Scan hochladen", state: "open", status: "" },
      { id: "send", title: "An die Agentur übermitteln", state: "open", status: "" },
    ] satisfies { id: string; title: string; state: StepState; status: string }[],
    body: "Der Bogen TL 407 wird aus den geprüften Angaben erzeugt und auf Papier unterschrieben.",
    action: "Profilingbogen erzeugen",
  },
  table: {
    title: "Dringend",
    loadingTitle: "Dringend (lädt)",
    emptyTitle: "Dringend (leer)",
    filter: "Name oder Personalnummer filtern",
    emptyState: "Keine überfälligen Punkte",
    emptyDescription: "Hier stehen die ältesten überfälligen Punkte des Projekts.",
    noMatches: "Kein Eintrag entspricht dem Filter",
    columns: {
      name: "Teilnehmende",
      step: "Nächster Schritt",
      due: "Fällig",
      consultant: "Beratung",
    },
    rows: [
      {
        id: "1",
        name: "Normalverbraucher, Anna",
        personnelNumber: "BSP-0016",
        step: "Arbeitsuchendmeldung fehlt",
        due: "2027-02-05",
        consultant: "Bernd Beratung",
      },
      {
        id: "2",
        name: "Beispiel, Bruno",
        personnelNumber: "BSP-0031",
        step: "DSV-Angebotsfrist abgelaufen",
        due: "2027-02-06",
        consultant: "",
      },
      {
        id: "3",
        name: "Muster, Carla",
        personnelNumber: "BSP-0042",
        step: "Teilnahme am Termin nicht erfasst",
        due: "2027-02-06",
        consultant: "Bernd Beratung",
      },
    ],
  },
  buttons: {
    primary: "Speichern",
    tertiary: "Scan hochladen",
    ghost: "Bearbeiten",
    danger: "Teilnahme beenden",
    unavailable: "Region ändern",
    unavailableReason: "Erst eine Region wählen.",
  },
};
