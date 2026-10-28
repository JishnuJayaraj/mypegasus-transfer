import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { Button, formatDate, formatTimestamp, SimpleTable } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { entryWavesQuery, participationHistoryQuery, useApi } from "../api";
import { useSelfServiceLabel } from "./self-service-tab";

// The tab "Verlauf" (data-protection.md, audit metadata; Q157): what happened to the
// participation, as far as the viewer's roles may see it. The API returns only that; this tab
// labels it and removes nothing. Names aren't searchable or exportable here.

type Entry = components["schemas"]["HistoryEntry"];

const statusLabels = {
  status: "participants.statuses",
  profiling_status: "participants.profilingStatuses",
  dsv_status: "participants.dsvStatuses",
} as const;

type Detail = string | boolean | string[] | null | undefined;
const text = (value: Detail) => (typeof value === "string" ? value : null);
const list = (value: Detail) => (Array.isArray(value) ? value : []);

export function HistoryTab({
  participationId,
  projectId,
  withWaves,
}: {
  participationId: string;
  projectId: string;
  withWaves: boolean;
}) {
  const { t, i18n } = useTranslation();
  const api = useApi();
  const label = useSelfServiceLabel();
  const query = useInfiniteQuery(participationHistoryQuery(api, participationId));
  // The page's loader has the waves of a `ta_tg` project in the cache already.
  const waves = useQuery({ ...entryWavesQuery(api, projectId), enabled: withWaves });
  if (query.isError) {
    const status = query.error instanceof ApiProblemError ? query.error.status : null;
    return <p role="alert">{status === 403 ? t("history.forbidden") : t("history.failed")}</p>;
  }
  if (!query.data) return <p aria-live="polite">{t("history.loading")}</p>;

  /** A code's label where one exists, else the code itself. */
  const coded = (prefix: string, code: string) =>
    i18n.exists(`${prefix}.${code}`) ? t(`${prefix}.${code}` as never) : code;
  const wave = (id: string | null) =>
    id === null
      ? t("history.noWave")
      : (waves.data?.find((candidate) => candidate.id === id)?.code ?? t("history.unknownWave"));
  const arrow = (from: string | null, to: string) =>
    from === null ? to : t("history.fromTo", { from, to });

  function event(entry: Entry) {
    return entry.type === "status_changed" && entry.change?.field
      ? t(`history.statusChanged.${entry.change.field}`)
      : t(`history.events.${entry.type}`);
  }

  function change(entry: Entry): string {
    const { change: shown, details } = entry;
    if (shown) {
      const name = (code: string) =>
        shown.field ? coded(statusLabels[shown.field], code) : coded("history.reasons", code);
      const value = arrow(shown.from === null ? null : name(shown.from), name(shown.to));
      const deadline = text(details.offerDeadline);
      return deadline ? t("history.withDeadline", { value, date: formatDate(deadline) }) : value;
    }
    switch (entry.type) {
      case "entry_wave_assigned":
        return arrow(wave(text(details.previousWaveId)), wave(text(details.waveId)));
      case "participant_data_changed":
        return list(details.fields).map(label).join(", ");
      case "participation_dates_changed":
        return (["TgStart", "TgEnd"] as const)
          .filter((key) => details[`new${key}`] !== undefined)
          .map((key) =>
            t(`history.dates.${key}`, {
              value: arrow(
                formatDate(text(details[`old${key}`])) || null,
                formatDate(text(details[`new${key}`])),
              ),
            }),
          )
          .join("; ");
      case "document_added":
      case "document_deleted":
        return label(text(details.documentType) ?? "");
      case "document_reviewed": {
        const values = {
          type: label(text(details.documentType) ?? ""),
          decision: coded("history.decisions", text(details.decision) ?? ""),
        };
        // A signed scan's origin and accepted version (data-protection.md, signed scans).
        const origin = text(details.origin);
        if (!origin) return t("history.reviewed", values);
        const version = text(details.formVersion);
        const scan = { ...values, origin: coded("history.origins", origin) };
        return version
          ? t("history.scanReviewed", { ...scan, version: version.replace("-", "/") })
          : t("history.scanRejected", scan);
      }
      case "document_quarantined":
      case "document_quarantine_lifted":
        return label(text(details.documentType) ?? "");
      // The declarations of an accepted signed form by their keys, never a value (Q193).
      case "signed_declaration_recorded":
        return t("history.signedDeclarations", {
          version: (text(details.formVersion) ?? "").replace("-", "/"),
          declarations: list(details.declarations).map(label).join(", "),
        });
      // A message: its kind, the channel, an appointment's start as written then (Q168).
      case "reminder_queued": {
        const kind = coded("reminders.kinds", text(details.kind) ?? "open_items");
        const channel = text(details.channelKind);
        const start = text(details.startsAt);
        return [
          start ? t("history.messageFor", { kind, start: formatTimestamp(start) }) : kind,
          channel ? coded("reminders.channels", channel) : t("reminders.tab.noChannel"),
        ].join(", ");
      }
      case "reminder_delivery": {
        const outcome = coded("history.outcomes", text(details.outcome) ?? "");
        const kind = text(details.kind);
        return kind ? `${coded("reminders.kinds", kind)}: ${outcome}` : outcome;
      }
      case "appointment_notice_followed_up":
        return coded("reminders.followUp.methods", text(details.method) ?? "");
      case "contact_channel_added":
      case "contact_channel_removed":
        return coded("reminders.channels", text(details.kind) ?? "");
      case "activation_code_delivery":
        return coded("history.outcomes", text(details.outcome) ?? "");
      // The appointment's kind and start as written then (Q168), never its title or venue.
      case "appointment_booked":
      case "appointment_booking_cancelled":
      case "attendance_recorded":
      case "attendance_superseded":
      case "information_delivery_confirmed":
      case "attendance_conflict_escalated":
      case "attendance_conflict_resolved":
      case "missed_appointment_resolved": {
        const values = {
          kind: coded("appointments.kinds", text(details.appointmentKind) ?? ""),
          start: details.startsAt ? formatTimestamp(text(details.startsAt) ?? "") : "",
        };
        const origin = text(details.origin);
        const booked = origin
          ? t("history.appointmentBy", { ...values, origin: coded("appointments.origins", origin) })
          : t("history.appointment", values);
        // A consultation booked as a missed one's follow-up (process-and-lifecycle.md).
        const appointment = text(details.followUpOf)
          ? `${booked} · ${t("history.followUp")}`
          : booked;
        // Attendance with the previous value (Q163); the confirmation whether it changed a status.
        const attendance = (code: Detail) => {
          const value = text(code);
          return value === null ? null : coded("appointments.attendance.values", value);
        };
        if (details.attendance !== undefined) {
          const value = arrow(
            attendance(details.previousAttendance),
            attendance(details.attendance) ?? "",
          );
          const closed = details.afterClose === true ? ` ${t("history.afterClose")}` : "";
          return `${appointment}: ${value}${closed}`;
        }
        if (typeof details.statusChanged === "boolean") {
          return `${appointment} ${t(details.statusChanged ? "history.withStatusChange" : "history.asBasis")}`;
        }
        return appointment;
      }
      // A profiling session by its date; the declarations by their keys, never a value (Q193).
      case "profiling_session_changed":
        return t("history.session", {
          action: coded("history.sessionActions", text(details.action) ?? ""),
          date: formatDate(text(details.date)),
        });
      case "profiling_declarations_recorded":
        return list(details.fields).map(label).join(", ");
      // A generated form by its version and Anlage (data-protection.md, generated forms).
      case "form_generated":
        return t(details.anlage === true ? "history.formWithAnlage" : "history.form", {
          version: (text(details.formVersion) ?? "").replace("-", "/"),
        });
      case "placement_agentur_set":
        return arrow(text(details.previousAgenturKey), text(details.agenturKey) ?? "");
      // The ASU record (D19, D22): codes and dates, never the BA-Kundennummer or the knowledge date.
      case "asu_route_set": {
        const previous = text(details.previousChannel);
        return arrow(
          previous === null ? null : coded("asu.channels", previous),
          coded("asu.channels", text(details.channel) ?? ""),
        );
      }
      case "asu_registration_recorded": {
        const source = text(details.attestationSource);
        const registered = t("asu.registration.registeredOn", {
          date: formatDate(text(details.registeredOn)),
          channel: coded("asu.channels", text(details.channel) ?? ""),
        });
        return source ? `${registered}, ${coded("asu.sources", source)}` : registered;
      }
      case "knowledge_date_set":
        return coded("history.knowledgeDateChanges", text(details.change) ?? "");
      default:
        return "";
    }
  }

  function by({ actor }: Entry) {
    if (actor.kind === "participant") return t("history.actor.participant");
    if (actor.kind === "system") return t("history.actor.system");
    const name = actor.name ?? t("history.actor.former");
    return actor.assisted ? t("history.actor.assisted", { name }) : name;
  }

  const items = query.data.pages.flatMap((page) => page.items);
  return (
    <section className="tp-section" aria-labelledby="participant-history">
      <h2 id="participant-history">{t("history.title")}</h2>
      <p>{t("history.intro")}</p>
      <SimpleTable
        title={t("history.title")}
        columns={(["occurredAt", "event", "change", "reason", "effectiveDate", "by"] as const).map(
          (key) => ({ key, header: t(`history.columns.${key}`) }),
        )}
        rows={items.map((entry, index) => ({
          id: `${index}`,
          occurredAt: formatTimestamp(entry.occurredAt),
          event: event(entry),
          change: change(entry),
          reason: entry.reasonCode ? coded("history.reasons", entry.reasonCode) : "",
          effectiveDate: formatDate(entry.effectiveDate),
          by: by(entry),
        }))}
        emptyState={t("history.empty")}
      />
      {query.hasNextPage && (
        <Button
          className="tp-load-more"
          kind="tertiary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t("history.more")}
        </Button>
      )}
    </section>
  );
}
