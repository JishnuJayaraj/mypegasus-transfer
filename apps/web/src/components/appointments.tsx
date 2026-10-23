import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import {
  appointmentPolicy,
  berlinDate,
  berlinInstant,
  berlinTime,
  bookingCutoffDays,
  isValidIsoDate,
} from "@transfer/domain";
import {
  Add,
  Button,
  ButtonSet,
  DateField,
  Form,
  formatDate,
  InlineNotification,
  Link,
  parseDisplayDate,
  Select,
  SelectItem,
  SimpleTable,
  Stack,
  TextInput,
  useToast,
} from "@transfer/ui";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  entryWavesQuery,
  meQuery,
  projectAppointmentsQuery,
  projectTeamQuery,
  useApi,
} from "../api";

// Appointments in the staff app (process-and-lifecycle.md and data-protection.md, appointments):
// the project tab "Termine" and the form. What the viewer may do comes from the API's
// capabilities; the counts are the API's view (an exact count only where the viewer may list
// every booking, else their own and the seat state).

export type Appointment = components["schemas"]["Appointment"];
type Kind = Appointment["kind"];
type Counts = Appointment["bookings"];
const RouterLink = createLink(Link);

/** `TT.MM.JJJJ, 10:00–12:00 Uhr` in Berlin time. */
export function useWhen() {
  const { t } = useTranslation();
  return ({ startsAt, endsAt }: { startsAt: string; endsAt: string }) =>
    t("appointments.when", {
      date: formatDate(berlinDate(startsAt)),
      from: berlinTime(startsAt),
      to: berlinTime(endsAt),
    });
}

/** "12 von 40" for an exact count, else "davon Ihre: 3 · Plätze frei"; never a remaining count. */
export function useSeats() {
  const { t } = useTranslation();
  return (counts: Counts, capacity: number) => {
    const state = t(`appointments.seats.${counts.availability}`);
    if (counts.scope === "all") {
      return `${t("appointments.seats.all", { booked: counts.booked, capacity })} · ${state}`;
    }
    return counts.scope === "own"
      ? `${t("appointments.seats.own", { own: counts.own })} · ${state}`
      : state;
  };
}

/** A problem's codes, each at its field or for the whole form. */
export function problemCodes(error: unknown): { field: string | null; code: string }[] {
  if (!(error instanceof ApiProblemError)) return [{ field: null, code: "failed" }];
  if (error.status === 403) return [{ field: null, code: "forbidden" }];
  if (error.status === 409) return [{ field: null, code: "conflict" }];
  const errors = [400, 422].includes(error.status) ? (error.problem.errors ?? []) : [];
  return errors.length > 0
    ? errors.map((item) => ({ field: item.pointer?.split("/")[1] || null, code: item.code }))
    : [{ field: null, code: "failed" }];
}

/** The display name of a host from the project's team, else a dash. */
export function useHostName(projectId: string) {
  const { data: team } = useQuery(projectTeamQuery(useApi(), projectId));
  return (staffUserId: string | null) =>
    staffUserId === null
      ? "—"
      : (team?.members.find((member) => member.staffUserId === staffUserId)?.displayName ?? "—");
}

/**
 * "Termine": the project's appointments, upcoming or past, with "Infoveranstaltung anlegen" and
 * "Beratungstermin anlegen" where the viewer may. A 403 reads as "not allowed".
 */
export function AppointmentsTab({ projectId, taTg }: { projectId: string; taTg: boolean }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const when = useWhen();
  const seats = useSeats();
  const hostName = useHostName(projectId);
  const [period, setPeriod] = useState<"upcoming" | "past">("upcoming");
  const [creating, setCreating] = useState<Kind | null>(null);
  const query = useInfiniteQuery(projectAppointmentsQuery(api, projectId, period));
  if (query.isError) {
    const forbidden = query.error instanceof ApiProblemError && query.error.status === 403;
    return <p role="alert">{t(forbidden ? "appointments.forbidden" : "appointments.failed")}</p>;
  }
  if (!query.data) return <p aria-live="polite">{t("appointments.loading")}</p>;
  const capabilities = query.data.pages[0]!.capabilities;
  const items = query.data.pages.flatMap((page) => page.items);
  return (
    <section className="tp-section" aria-labelledby="project-appointments">
      <h2 id="project-appointments">{t("appointments.title")}</h2>
      <p>{t("appointments.intro")}</p>
      {creating ? (
        <AppointmentForm
          projectId={projectId}
          taTg={taTg}
          kind={creating}
          chooseHost={capabilities.chooseHost}
          onCancel={() => setCreating(null)}
          onSaved={async () => {
            await queryClient.invalidateQueries({
              queryKey: ["projects", projectId, "appointments"],
            });
            showToast({ title: t("appointments.created") });
            setCreating(null);
          }}
        />
      ) : (
        <ButtonSet>
          {capabilities.createInfoEvent && (
            <Button renderIcon={Add} onClick={() => setCreating("info_event")}>
              {t("appointments.createInfoEvent")}
            </Button>
          )}
          {capabilities.createConsultation && (
            <Button kind="secondary" renderIcon={Add} onClick={() => setCreating("consultation")}>
              {t("appointments.createConsultation")}
            </Button>
          )}
        </ButtonSet>
      )}
      <Select
        id="appointments-period"
        labelText={t("appointments.periods.label")}
        value={period}
        onChange={(event) => setPeriod(event.target.value as "upcoming" | "past")}
      >
        <SelectItem value="upcoming" text={t("appointments.periods.upcoming")} />
        <SelectItem value="past" text={t("appointments.periods.past")} />
      </Select>
      <SimpleTable
        title={t("appointments.title")}
        columns={(
          ["kind", "when", "venue", "host", "bookings", "status", "resolution", "actions"] as const
        ).map((key) => ({ key, header: t(`appointments.columns.${key}`) }))}
        rows={items.map((item) => ({
          id: item.id,
          kind: [t(`appointments.kinds.${item.kind}`), item.title].filter(Boolean).join(" – "),
          when: when(item),
          venue: item.venue,
          host: hostName(item.hostStaffUserId),
          bookings: seats(item.bookings, item.capacity),
          status: t(`appointments.statuses.${item.status}`),
          resolution: item.needsResolution
            ? t("appointments.resolutionCount", { count: item.needsResolution })
            : "",
          actions: (
            <RouterLink
              to="/projects/$projectId/appointments/$appointmentId"
              params={{ projectId, appointmentId: item.id }}
            >
              {t("appointments.open")}
            </RouterLink>
          ),
        }))}
        emptyState={t("appointments.empty")}
      />
      {query.hasNextPage && (
        <Button
          className="tp-load-more"
          kind="tertiary"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {t("appointments.loadMore")}
        </Button>
      )}
    </section>
  );
}

type Fields = {
  date: string;
  start: string;
  end: string;
  cutoffDays: string;
  capacity: string;
  title: string;
  venue: string;
  host: string;
  audience: string;
};
type FieldKey = keyof Fields;

/** Where an API field's refusal shows in the form. */
const formField: Record<string, FieldKey> = {
  startsAt: "start",
  endsAt: "end",
  bookingCutoffDays: "cutoffDays",
  capacity: "capacity",
  title: "title",
  venue: "venue",
  hostStaffUserId: "host",
  audienceWaveId: "audience",
};

/**
 * Creating an appointment or changing one (with its version). The hint on personal data stands
 * above the texts (Q166). Once booked, times, cutoff and audience are read-only (Q168).
 */
export function AppointmentForm({
  projectId,
  taTg,
  kind,
  chooseHost,
  appointment,
  onSaved,
  onCancel,
}: {
  projectId: string;
  taTg: boolean;
  kind: Kind;
  chooseHost: boolean;
  appointment?: Appointment;
  onSaved: (saved: Appointment) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const { data: me } = useQuery(meQuery(api));
  const { data: team } = useQuery(projectTeamQuery(api, projectId));
  const waves = useQuery({
    ...entryWavesQuery(api, projectId),
    enabled: taTg && kind === "info_event",
  });
  const frozen = appointment?.inUse ?? false;
  const [fields, setFields] = useState<Fields>(() => ({
    date: appointment ? formatDate(berlinDate(appointment.startsAt)) : "",
    start: appointment ? berlinTime(appointment.startsAt) : "",
    end: appointment ? berlinTime(appointment.endsAt) : "",
    cutoffDays: String(
      appointment
        ? bookingCutoffDays(appointment.startsAt, appointment.bookingClosesAt)
        : appointmentPolicy.bookingCutoffDays.default,
    ),
    capacity: String(appointment?.capacity ?? (kind === "consultation" ? 1 : "")),
    title: appointment?.title ?? "",
    venue: appointment?.venue ?? "",
    host: appointment?.hostStaffUserId ?? "",
    audience: appointment?.audienceWaveId ?? "",
  }));
  const [errors, setErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [formError, setFormError] = useState<string>();
  const message = (code: string) =>
    t(`appointments.errors.${code}` as never, { defaultValue: t("appointments.errors.invalid") });
  const set = (key: FieldKey) => (value: string) => setFields({ ...fields, [key]: value });
  const hosts = (team?.members ?? []).filter(
    (member) =>
      !member.deactivated &&
      (member.roles.includes("project_lead") || member.roles.includes("consultant")),
  );

  const save = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      const { data } = appointment
        ? await api.PATCH("/api/v1/appointments/{appointmentId}", {
            params: { path: { appointmentId: appointment.id } },
            body: { expectedVersion: appointment.version, ...body },
          })
        : await api.POST("/api/v1/projects/{projectId}/appointments", {
            params: { path: { projectId } },
            body: body as components["schemas"]["AppointmentInput"],
          });
      if (!data) throw new Error("Appointment was not saved");
      return data;
    },
    onSuccess: onSaved,
    onError: (error) => {
      const next: Partial<Record<FieldKey, string>> = {};
      let whole: string | undefined;
      for (const { field, code } of problemCodes(error)) {
        const key = field ? formField[field] : undefined;
        if (key) next[key] ??= code;
        else whole ??= code;
      }
      setErrors(next);
      setFormError(whole);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    const next: Partial<Record<FieldKey, string>> = {};
    const date = parseDisplayDate(fields.date);
    const day = date.ok && date.value && isValidIsoDate(date.value) ? date.value : null;
    // Once booked, the times aren't shown and never sent.
    if (!day && !frozen) next.date = "invalid_date";
    const startsAt = day ? berlinInstant(day, fields.start.trim()) : null;
    const endsAt = day ? berlinInstant(day, fields.end.trim()) : null;
    if (!frozen && day && !startsAt) next.start = "invalid_time";
    if (!frozen && day && !endsAt) next.end = "invalid_time";
    if (!frozen && startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) {
      next.end = "ends_before_start";
    }
    setErrors(next);
    setFormError(undefined);
    if (Object.keys(next).length > 0) return;
    const values: Record<string, unknown> = {
      startsAt,
      endsAt,
      bookingCutoffDays: Number(fields.cutoffDays),
      capacity: Number(fields.capacity),
      title: fields.title.trim() === "" ? null : fields.title,
      venue: fields.venue,
      audienceWaveId: kind === "info_event" && fields.audience ? fields.audience : null,
    };
    if (!appointment) {
      save.mutate({
        kind,
        ...values,
        hostStaffUserId:
          kind === "consultation" ? (chooseHost ? fields.host || null : me?.id) : null,
      });
      return;
    }
    // A change sends what differs (times, cutoff and audience only while unused).
    const before: Record<string, unknown> = {
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      bookingCutoffDays: bookingCutoffDays(appointment.startsAt, appointment.bookingClosesAt),
      capacity: appointment.capacity,
      title: appointment.title,
      venue: appointment.venue,
      audienceWaveId: appointment.audienceWaveId,
    };
    const same = (key: string) =>
      key === "startsAt" || key === "endsAt"
        ? Date.parse(String(values[key])) === Date.parse(String(before[key]))
        : values[key] === before[key];
    const frozenKeys = ["startsAt", "endsAt", "bookingCutoffDays", "audienceWaveId"];
    const changed = Object.fromEntries(
      Object.entries(values).filter(([key]) => !(frozen && frozenKeys.includes(key)) && !same(key)),
    );
    if (Object.keys(changed).length === 0) setFormError("appointment_unchanged");
    else save.mutate(changed);
  }

  const invalid = (key: FieldKey) =>
    errors[key] ? { invalid: true, invalidText: message(errors[key]) } : {};

  return (
    <Form className="tp-form" onSubmit={submit} noValidate>
      <Stack gap={6}>
        <h3>
          {appointment
            ? t("appointments.form.editTitle")
            : t(`appointments.form.createTitle.${kind}`)}
        </h3>
        <InlineNotification
          kind="info"
          lowContrast
          title={t("appointments.form.personalData")}
          hideCloseButton
        />
        {formError && (
          <InlineNotification kind="error" title={message(formError)} hideCloseButton />
        )}
        {frozen && <p className="tp-hint">{t("appointments.form.frozen")}</p>}
        {!frozen && (
          <>
            <DateField
              id="appointment-date"
              labelText={t("appointments.form.date")}
              defaultValue={fields.date}
              onChange={set("date")}
              invalidText={errors.date ? message(errors.date) : undefined}
            />
            <TextInput
              id="appointment-start"
              labelText={t("appointments.form.start")}
              placeholder="10:00"
              value={fields.start}
              onChange={(event) => set("start")(event.target.value)}
              {...invalid("start")}
            />
            <TextInput
              id="appointment-end"
              labelText={t("appointments.form.end")}
              placeholder="12:00"
              value={fields.end}
              onChange={(event) => set("end")(event.target.value)}
              {...invalid("end")}
            />
            <TextInput
              id="appointment-cutoff"
              type="number"
              min={appointmentPolicy.bookingCutoffDays.min}
              max={appointmentPolicy.bookingCutoffDays.max}
              labelText={t("appointments.form.cutoffDays")}
              value={fields.cutoffDays}
              onChange={(event) => set("cutoffDays")(event.target.value)}
              {...invalid("cutoffDays")}
            />
          </>
        )}
        <TextInput
          id="appointment-capacity"
          type="number"
          min={appointmentPolicy.capacity.min}
          max={appointmentPolicy.capacity.max}
          labelText={t("appointments.form.capacity")}
          value={fields.capacity}
          onChange={(event) => set("capacity")(event.target.value)}
          {...invalid("capacity")}
        />
        <TextInput
          id="appointment-title"
          labelText={t("appointments.form.title")}
          maxLength={appointmentPolicy.titleMax}
          value={fields.title}
          onChange={(event) => set("title")(event.target.value)}
          {...invalid("title")}
        />
        <TextInput
          id="appointment-venue"
          labelText={t("appointments.form.venue")}
          maxLength={appointmentPolicy.venueMax}
          value={fields.venue}
          onChange={(event) => set("venue")(event.target.value)}
          {...invalid("venue")}
        />
        {!appointment && kind === "consultation" && chooseHost && (
          <Select
            id="appointment-host"
            labelText={t("appointments.form.host")}
            value={fields.host}
            onChange={(event) => set("host")(event.target.value)}
            {...invalid("host")}
          >
            <SelectItem value="" text={t("appointments.page.chooseHint")} />
            {hosts.map((member) => (
              <SelectItem
                key={member.staffUserId}
                value={member.staffUserId}
                text={member.displayName}
              />
            ))}
          </Select>
        )}
        {!frozen && kind === "info_event" && taTg && (
          <Select
            id="appointment-audience"
            labelText={t("appointments.form.audience")}
            value={fields.audience}
            onChange={(event) => set("audience")(event.target.value)}
            {...invalid("audience")}
          >
            <SelectItem value="" text={t("appointments.form.wholeProject")} />
            {(waves.data ?? []).map((wave) => (
              <SelectItem
                key={wave.id}
                value={wave.id}
                text={t("appointments.form.wave", { code: wave.code })}
              />
            ))}
          </Select>
        )}
        <ButtonSet>
          <Button kind="secondary" onClick={onCancel}>
            {t("appointments.form.cancel")}
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {t("appointments.form.submit")}
          </Button>
        </ButtonSet>
      </Stack>
    </Form>
  );
}
