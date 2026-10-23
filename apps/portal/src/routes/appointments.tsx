import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import { Button, InlineNotification, Stack } from "@transfer/ui";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { problemCode } from "../problem";

export const Route = createFileRoute("/appointments")({ component: Appointments });

type Sections = components["schemas"]["PortalAppointments"];
type Details = NonNullable<Sections["invitations"][number]["details"]>;
type Kind = Sections["bookings"][number]["kind"];

/** The refusals the page explains; anything else is `failed`. */
const errorKeys = [
  "appointment_full",
  "booking_closed",
  "already_booked",
  "info_event_limit",
  "booking_overlap",
  "after_cutoff",
  "appointment_started",
  "appointment_cancelled",
  "booking_cancelled",
  "failed",
] as const;
type ErrorKey = (typeof errorKeys)[number];
const isErrorKey = (code: string | undefined): code is ErrorKey =>
  (errorKeys as readonly (string | undefined)[]).includes(code);

const BOOKABLE = "termine-buchen";

/**
 * "Termine" (data-protection.md, appointments: the portal; Q164, Q165): the participant's
 * invitations (also when full or closed, with the next step; without details once no longer in
 * their audience or host rule), their bookings with "Absagen" until the start, the appointments
 * cancelled by the organizer or the team, and the appointments they may book, each with its seat
 * state and never a count. "Buchen" and "Absagen" ask first. Nothing here sends a message.
 */
function Appointments() {
  const { t } = useTranslation();
  const { api } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey>();
  const [done, setDone] = useState<"booked" | "cancelled">();
  const [expired, setExpired] = useState(false);
  const sections = useQuery({
    queryKey: ["portal-appointments"],
    queryFn: async () => {
      const { data } = await api.GET("/api/v1/portal/appointments");
      if (!data) throw new Error("No portal data");
      return data;
    },
    retry: false,
  });

  async function run(work: () => Promise<unknown>, outcome: "booked" | "cancelled") {
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    try {
      await work();
      setConfirming(undefined);
      setDone(outcome);
    } catch (failure) {
      const code = problemCode(failure);
      if (code === "session_expired") setExpired(true);
      else setError(isErrorKey(code) ? code : "failed");
      setConfirming(undefined);
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ["portal-appointments"] });
    }
  }

  const book = (appointmentId: string) =>
    run(
      () =>
        api.POST("/api/v1/portal/appointments/{appointmentId}/booking", {
          params: { path: { appointmentId } },
          body: {},
        }),
      "booked",
    );
  const cancel = (bookingId: string) =>
    run(
      () =>
        api.POST("/api/v1/portal/appointment-bookings/{bookingId}/cancellation", {
          params: { path: { bookingId } },
          body: {},
        }),
      "cancelled",
    );

  const unauthenticated =
    sections.error instanceof ApiProblemError && sections.error.status === 401;
  if (expired || unauthenticated) {
    return (
      <Stack gap={5}>
        <h1>{t("appointments.title")}</h1>
        <InlineNotification kind="warning" title={t("appointments.expired")} hideCloseButton />
        <Link to="/login">{t("home.login")}</Link>
      </Stack>
    );
  }
  if (sections.isPending) return <p aria-live="polite">{t("status.checking")}</p>;
  if (sections.isError) {
    return (
      <Stack gap={5}>
        <h1>{t("appointments.title")}</h1>
        <p role="alert">{t("appointments.failed")}</p>
        <Link to="/">{t("activate.done.home")}</Link>
      </Stack>
    );
  }
  const { invitations, bookings, cancelled, bookable } = sections.data;

  /** "Buchen" or "Absagen", confirmed first; the item's heading describes the button. */
  const action = (id: string, headingId: string, kind: "book" | "cancel", onConfirm: () => void) =>
    confirming === id ? (
      <fieldset className="tp-appointment-confirm">
        <legend>
          {t(kind === "book" ? "appointments.confirmBook" : "appointments.confirmCancel")}
        </legend>
        <Stack gap={3}>
          <Button
            kind={kind === "book" ? "primary" : "danger"}
            disabled={busy}
            aria-describedby={headingId}
            onClick={onConfirm}
          >
            {t(kind === "book" ? "appointments.yesBook" : "appointments.yesCancel")}
          </Button>
          <Button kind="secondary" onClick={() => setConfirming(undefined)}>
            {t("appointments.back")}
          </Button>
        </Stack>
      </fieldset>
    ) : (
      <Button
        kind={kind === "book" ? "primary" : "tertiary"}
        size="sm"
        aria-describedby={headingId}
        onClick={() => setConfirming(id)}
      >
        {t(kind === "book" ? "appointments.book" : "appointments.cancel")}
      </Button>
    );

  /** Booking isn't possible: "Anderen Termin buchen" when there is one, else the team. */
  const nextStep = (alternative: boolean) =>
    alternative ? (
      <a href={`#${BOOKABLE}`}>{t("appointments.alternative")}</a>
    ) : (
      <p>{t("appointments.contactTeam")}</p>
    );

  return (
    <Stack gap={6}>
      <h1>{t("appointments.title")}</h1>
      <p>{t("appointments.intro")}</p>
      <div aria-live="polite">
        {done && (
          <InlineNotification
            kind="success"
            title={t(done === "booked" ? "appointments.booked" : "appointments.cancelledDone")}
            onClose={() => setDone(undefined)}
            lowContrast
          />
        )}
        {error && (
          <InlineNotification
            kind="error"
            title={t(`appointments.errors.${error}`)}
            onClose={() => setError(undefined)}
            lowContrast
          />
        )}
      </div>

      <Section id="einladungen" title={t("appointments.sections.invitations")}>
        {invitations.length === 0 ? (
          <p>{t("appointments.empty.invitations")}</p>
        ) : (
          <ul className="tp-appointments">
            {invitations.map((item) => {
              const headingId = `invitation-${item.appointmentId}`;
              return (
                <li key={item.appointmentId} className="tp-appointment">
                  <Heading id={headingId} kind={item.kind} details={item.details} />
                  {item.details ? <Facts details={item.details} /> : null}
                  {item.state === "no_longer_valid" ? (
                    <p>{t("appointments.states.noLongerValid")}</p>
                  ) : item.state === "bookable" ? (
                    <>
                      {item.cutoffHint && <p>{t("appointments.cutoffHint")}</p>}
                      {action(
                        item.appointmentId,
                        headingId,
                        "book",
                        () => void book(item.appointmentId),
                      )}
                    </>
                  ) : (
                    <>
                      <p className="tp-appointment-state">
                        {t(`appointments.states.${item.state}`)}
                      </p>
                      <Button kind="primary" size="sm" disabled aria-describedby={headingId}>
                        {t("appointments.book")}
                      </Button>
                      {nextStep(item.alternative)}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section id="meine-termine" title={t("appointments.sections.mine")}>
        {bookings.length === 0 ? (
          <p>{t("appointments.empty.mine")}</p>
        ) : (
          <ul className="tp-appointments">
            {bookings.map((item) => {
              const headingId = `booking-${item.id}`;
              return (
                <li key={item.id} className="tp-appointment">
                  <Heading id={headingId} kind={item.kind} details={item.details} />
                  <Facts details={item.details} />
                  {item.capabilities.cancel &&
                    action(item.id, headingId, "cancel", () => void cancel(item.id))}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section id="abgesagt" title={t("appointments.sections.cancelled")}>
        {cancelled.length === 0 ? (
          <p>{t("appointments.empty.cancelled")}</p>
        ) : (
          <ul className="tp-appointments">
            {cancelled.map((item) => (
              <li key={item.appointmentId} className="tp-appointment">
                <Heading
                  id={`cancelled-${item.appointmentId}`}
                  kind={item.kind}
                  details={item.details}
                />
                {item.details && <Facts details={item.details} />}
                <p className="tp-appointment-state">
                  {t(`appointments.cancelledBy.${item.cancelledBy}`)}
                </p>
                {item.alternative && nextStep(true)}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id={BOOKABLE} title={t("appointments.sections.bookable")}>
        {bookable.length === 0 ? (
          <p>{t("appointments.empty.bookable")}</p>
        ) : (
          <ul className="tp-appointments">
            {bookable.map((item) => {
              const headingId = `bookable-${item.appointmentId}`;
              return (
                <li key={item.appointmentId} className="tp-appointment">
                  <Heading id={headingId} kind={item.kind} details={item.details} />
                  <Facts details={item.details} />
                  <p className="tp-appointment-state">
                    {t(`appointments.availability.${item.availability}`)}
                  </p>
                  {item.cutoffHint && <p>{t("appointments.cutoffHint")}</p>}
                  {item.capabilities.book &&
                    action(
                      item.appointmentId,
                      headingId,
                      "book",
                      () => void book(item.appointmentId),
                    )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>
      <Link to="/">{t("activate.done.home")}</Link>
    </Stack>
  );
}

function Section(props: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="tp-section" aria-labelledby={`${props.id}-title`} id={props.id}>
      <h2 id={`${props.id}-title`}>{props.title}</h2>
      {props.children}
    </section>
  );
}

/** The appointment's kind and, where shown, its Berlin date. */
function Heading(props: { id: string; kind: Kind; details: Details | null }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <h3 id={props.id}>
      {props.details
        ? t("appointments.heading", {
            kind: t(`appointments.kinds.${props.kind}`),
            date: format.date(props.details.startsAt),
          })
        : t(`appointments.kinds.${props.kind}`)}
    </h3>
  );
}

/** Time, title and venue: the generic texts the organizer chose. */
function Facts({ details }: { details: Details }) {
  const { t } = useTranslation();
  const format = useFormat();
  return (
    <dl className="tp-appointment-facts">
      <dt>{t("appointments.time")}</dt>
      <dd>
        {t("appointments.timeRange", {
          start: format.time(details.startsAt),
          end: format.time(details.endsAt),
        })}
      </dd>
      {details.title && (
        <>
          <dt>{t("appointments.subject")}</dt>
          <dd>{details.title}</dd>
        </>
      )}
      <dt>{t("appointments.venue")}</dt>
      <dd>{details.venue}</dd>
    </dl>
  );
}

/** Dates and times in Europe/Berlin, in the page's language. */
function useFormat() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage === "en" ? "en-GB" : "de-DE";
  const date = new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Berlin",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return {
    date: (at: string) => date.format(Date.parse(at)),
    time: (at: string) => time.format(Date.parse(at)),
  };
}
