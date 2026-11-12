import { useQuery } from "@tanstack/react-query";
import { createFileRoute, createLink, Link } from "@tanstack/react-router";
import {
  progressCount,
  type PortalMe,
  type PortalProgress,
  type PortalTask,
  type SelfServicePage,
} from "@transfer/domain";
import { SELF_SERVICE_NAMESPACE } from "@transfer/self-service-ui";
import {
  ArrowRight,
  Button,
  Calendar,
  Card,
  CheckmarkFilled,
  CircleDash,
  EmptyState,
  Grid,
  Loading,
  Stack,
} from "@transfer/ui";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Facts, useFormat } from "../components/appointment";
import { meQuery } from "../session";

export const Route = createFileRoute("/")({ component: Home });

const ButtonLink = createLink(Button);

/**
 * The start page. Its job: "What do I still have to do?" Logged in: the checklist with the
 * progress, the next appointment, then the participant's areas. Logged out: log in or activate.
 */
function Home() {
  const { api } = Route.useRouteContext();
  const me = useQuery(meQuery(api));
  if (me.isPending) return <Loading />;
  return me.data ? <Participant me={me.data} /> : <Welcome />;
}

/** One clear choice: log in with an activated access, or start with the letter's code. */
function Welcome() {
  const { t } = useTranslation();
  return (
    <Stack gap={6}>
      <Stack gap={3}>
        <h1>{t("home.title")}</h1>
        <p>{t("home.intro")}</p>
      </Stack>
      <Grid columns={2}>
        <Card title={t("home.loginTitle")} description={t("home.loginText")}>
          <div>
            <ButtonLink to="/login" kind="primary" renderIcon={ArrowRight}>
              {t("home.login")}
            </ButtonLink>
          </div>
        </Card>
        <Card title={t("home.activateTitle")} description={t("home.activateText")}>
          <div>
            <ButtonLink to="/activate" kind="tertiary" renderIcon={ArrowRight}>
              {t("home.activate")}
            </ButtonLink>
          </div>
        </Card>
      </Grid>
    </Stack>
  );
}

function Participant({ me }: { me: PortalMe }) {
  const { t } = useTranslation();
  return (
    <Stack gap={7}>
      <h1>{t("home.greeting", { name: me.firstName })}</h1>
      <Checklist />
      <NextAppointment />
      <nav aria-label={t("home.areas")}>
        <Grid columns={3}>
          <AreaLink
            to="/self-service"
            title={t("home.selfService")}
            text={t("home.selfServiceText")}
          />
          <AreaLink
            to="/appointments"
            title={t("home.appointments")}
            text={t("home.appointmentsText")}
          />
          <AreaLink to="/consents" title={t("home.consents")} text={t("home.consentsText")} />
        </Grid>
      </nav>
    </Stack>
  );
}

/**
 * "Das fehlt noch" (ui-patterns.md, C5): the participant's tasks from `GET /portal/progress`, which
 * carries done flags and codes only, never a value; the optional pages separately as "Freiwillig",
 * outside the count.
 */
function Checklist() {
  const { t } = useTranslation();
  const { api } = Route.useRouteContext();
  const id = useId();
  const progress = useQuery({
    queryKey: ["portal-progress"],
    queryFn: async () => {
      const { data } = await api.GET("/api/v1/portal/progress");
      if (!data) throw new Error("No portal data");
      return data as PortalProgress;
    },
  });
  if (progress.isPending) {
    return (
      <Card title={t("home.missing.title")}>
        <Loading />
      </Card>
    );
  }
  if (progress.isError) {
    return (
      <Card title={t("home.missing.title")}>
        <EmptyState
          variant="error"
          title={t("home.missing.failed")}
          onRetry={() => void progress.refetch()}
        />
      </Card>
    );
  }
  const { done, total } = progressCount(progress.data);
  const open = progress.data.tasks.filter((task) => !task.done);
  const finished = progress.data.tasks.filter((task) => task.done);
  const percent = total === 0 ? 100 : Math.round((done / total) * 100);
  return (
    <Card title={t("home.missing.title")}>
      <Stack gap={5}>
        <div className="tp-task-progress">
          <label htmlFor={`${id}-bar`}>{t("home.missing.progress")}</label>
          <progress
            id={`${id}-bar`}
            value={done}
            max={Math.max(total, 1)}
            aria-describedby={`${id}-count`}
          />
          <p id={`${id}-count`}>{t("home.missing.count", { done, total, percent })}</p>
        </div>
        {open.length === 0 ? (
          <p>{t("home.missing.nothing")}</p>
        ) : (
          <ul className="tp-task-list">
            {open.map((task) => (
              <TaskItem key={taskKey(task)} task={task} />
            ))}
          </ul>
        )}
        {finished.length > 0 && (
          <details className="tp-task-done">
            <summary>{t("home.missing.done", { count: finished.length })}</summary>
            <ul className="tp-task-list">
              {finished.map((task) => (
                <TaskItem key={taskKey(task)} task={task} />
              ))}
            </ul>
          </details>
        )}
        {progress.data.optional.length > 0 && <Optional pages={progress.data.optional} />}
      </Stack>
    </Card>
  );
}

const taskKey = (task: PortalTask) =>
  task.kind === "section"
    ? `section-${task.page}`
    : task.kind === "upload"
      ? `upload-${task.documentType}`
      : task.kind === "appointment"
        ? `appointment-${task.appointmentId}`
        : task.kind;

/** One task: its state as an icon and text (never colour alone) and the link to do it. */
function TaskItem({ task }: { task: PortalTask }) {
  const { t } = useTranslation();
  const Icon = task.done ? CheckmarkFilled : CircleDash;
  return (
    <li className={`tp-task tp-task--${task.done ? "done" : "open"}`}>
      <Icon size={20} aria-hidden="true" className="tp-task-icon" />
      <span className="tp-visually-hidden">
        {t(task.done ? "home.missing.stateDone" : "home.missing.stateOpen")}
      </span>
      <TaskLink task={task} />
    </li>
  );
}

function TaskLink({ task }: { task: PortalTask }) {
  const { t } = useTranslation();
  const { t: wizard } = useTranslation(SELF_SERVICE_NAMESPACE);
  const page = (key: SelfServicePage) => wizard(`pages.${key}`);
  switch (task.kind) {
    case "notice":
      return <Link to="/self-service">{t("home.missing.notice")}</Link>;
    case "section":
      return (
        <Link to="/self-service" search={{ step: task.page }}>
          {t("home.missing.section", { page: page(task.page) })}
        </Link>
      );
    case "upload":
      return (
        <Link to="/self-service" search={{ step: "documents" }}>
          {t("home.missing.upload", {
            type: wizard(`documents.types.${task.documentType}`),
          })}
        </Link>
      );
    case "appointment":
      return (
        <Link to="/appointments">
          {t("home.missing.appointment", {
            kind: t(`appointments.kinds.${task.appointmentKind}`),
          })}
        </Link>
      );
  }
}

/** "Freiwillig": pages without a required item, listed, never counted. */
function Optional({ pages }: { pages: readonly SelfServicePage[] }) {
  const { t } = useTranslation();
  const { t: wizard } = useTranslation(SELF_SERVICE_NAMESPACE);
  const id = useId();
  return (
    <section aria-labelledby={id} className="tp-task-optional">
      <h3 id={id}>{t("home.missing.optional")}</h3>
      <p className="tp-hint">{t("home.missing.optionalText")}</p>
      <ul className="tp-task-list">
        {pages.map((key) => (
          <li key={key} className="tp-task">
            <Link to="/self-service" search={{ step: key }}>
              {wizard(`pages.${key}`)}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The next booked appointment, or what to do without one. */
function NextAppointment() {
  const { t } = useTranslation();
  const { api } = Route.useRouteContext();
  const format = useFormat();
  const sections = useQuery({
    queryKey: ["portal-appointments"],
    queryFn: async () => {
      const { data } = await api.GET("/api/v1/portal/appointments");
      if (!data) throw new Error("No portal data");
      return data;
    },
  });
  const title = t("home.next.title");
  if (sections.isPending) {
    return (
      <Card title={title}>
        <Loading />
      </Card>
    );
  }
  if (sections.isError) {
    return (
      <Card title={title}>
        <EmptyState
          variant="error"
          title={t("appointments.failed")}
          onRetry={() => void sections.refetch()}
        />
      </Card>
    );
  }
  const next = sections.data.bookings.toSorted(
    (a, b) => Date.parse(a.details.startsAt) - Date.parse(b.details.startsAt),
  )[0];
  const invited = sections.data.invitations.length;
  return (
    <Card title={title}>
      <Stack gap={4}>
        {next ? (
          <div className="tp-next-appointment">
            <Calendar size={24} aria-hidden="true" />
            <Stack gap={2}>
              <p className="tp-next-appointment-heading">
                {t("appointments.heading", {
                  kind: t(`appointments.kinds.${next.kind}`),
                  date: format.date(next.details.startsAt),
                })}
              </p>
              <Facts details={next.details} />
            </Stack>
          </div>
        ) : (
          <p>{t(invited > 0 ? "home.next.invited" : "home.next.none", { count: invited })}</p>
        )}
        <Link to="/appointments">{t("home.next.all")}</Link>
      </Stack>
    </Card>
  );
}

/** A card with one link, its title; the text describes it, and the whole card is clickable. */
function AreaLink(props: {
  to: "/self-service" | "/appointments" | "/consents";
  title: string;
  text: string;
}) {
  const id = useId();
  return (
    <div className="tp-area-link">
      <Link to={props.to} className="tp-area-link-title" aria-describedby={id}>
        {props.title}
      </Link>
      <p id={id} className="tp-area-link-text">
        {props.text}
      </p>
      <ArrowRight size={20} aria-hidden="true" className="tp-area-link-icon" />
    </div>
  );
}
