import type { components } from "@transfer/api-client";
import { useTranslation } from "react-i18next";

// An appointment's facts in the portal ("Termine" and the start page's next appointment).

type Details = NonNullable<
  components["schemas"]["PortalAppointments"]["invitations"][number]["details"]
>;

/** Time, title and venue: the generic texts the organizer chose. */
export function Facts({ details }: { details: Details }) {
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
export function useFormat() {
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
