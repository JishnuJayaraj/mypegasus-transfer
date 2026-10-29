import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createLink } from "@tanstack/react-router";
import { ApiProblemError, type components } from "@transfer/api-client";
import { kug200bBatchMax } from "@transfer/domain";
import {
  Button,
  DateField,
  formatDate,
  formatTimestamp,
  InlineNotification,
  Link,
  parseDisplayDate,
  SimpleTable,
  Stack,
  Tag,
} from "@transfer/ui";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { kug200bBatchesQuery, meQuery, projectConfigQuery, projectTeamQuery, useApi } from "../api";
import { documentNavigation } from "./documents-tab";

// The project tab "Agentur" (process-and-lifecycle.md, Kug 200b batches; D25, Q203): per placement
// Agentur its batch channel or "Einstellungen fehlen", the artifact (the Kug 200a, or the
// alternative the Agentur accepted with its date and confirmer) and the ready scans; "Sammelmeldung
// bilden" takes them all (up to 200); each batch with its work list (an export link, logged and
// re-authorized), "Übermittelt am", "Verwerfen" and, when stale, its refused rows. The PL only;
// every button by its capability, the API checks each again. German only.

type View = components["schemas"]["Kug200bBatches"];
type Agentur = View["agenturen"][number];
type Batch = View["batches"][number];
type StaleRow = components["schemas"]["Kug200bBatchStaleRow"];
const RouterLink = createLink(Link);

type Message = { kind: "success" | "error"; text: string; rows?: StaleRow[] };

const ok = <T,>(result: { data?: T; error?: unknown }) => {
  if (result.data === undefined && result.error) throw result.error;
  return result.data;
};

export function AgenturTab({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const query = kug200bBatchesQuery(api, projectId);
  const batches = useQuery(query);
  const config = useQuery(projectConfigQuery(api, projectId)).data;
  const team = useQuery({ ...projectTeamQuery(api, projectId), enabled: batches.isSuccess }).data;
  const me = useQuery(meQuery(api)).data;
  const [message, setMessage] = useState<Message>();
  const [busy, setBusy] = useState(false);

  if (batches.isPending) return <p aria-live="polite">{t("agentur.loading")}</p>;
  if (batches.isError) {
    const forbidden = batches.error instanceof ApiProblemError && batches.error.status === 403;
    return (
      <InlineNotification
        kind={forbidden ? "info" : "error"}
        title={t(forbidden ? "agentur.forbidden" : "agentur.failed")}
        hideCloseButton
        lowContrast
      />
    );
  }
  const view = batches.data;
  const labelOf = (key: string) =>
    config?.pins.find((pin) => pin.agenturKey === key)?.label.de ?? key;
  const nameOf = (staffUserId: string) =>
    staffUserId === me?.id
      ? me.displayName
      : (team?.members.find((m) => m.staffUserId === staffUserId)?.displayName ??
        t("agentur.otherStaff"));

  /** A write; the tab is read again afterwards, whatever happened. */
  async function act(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setMessage(undefined);
    try {
      await action();
      setMessage({ kind: "success", text: done });
    } catch (error) {
      const problem = error instanceof ApiProblemError ? error.problem : undefined;
      const code = problem?.errors?.[0]?.code;
      const known = code && t(`agentur.codes.${code}` as never, { defaultValue: "" });
      setMessage({
        kind: "error",
        text: known || t("agentur.failedWrite"),
        ...(problem?.staleRows && { rows: problem.staleRows }),
      });
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: query.queryKey });
    }
  }

  const names = new Map(
    [...view.agenturen.flatMap((a) => a.candidates), ...view.batches.flatMap((b) => b.members)].map(
      (p) => [p.participationId, [p.lastName, p.firstName].filter(Boolean).join(", ")],
    ),
  );
  const rowText = (row: StaleRow) =>
    row.participationId === null
      ? t("agentur.stale.settings_changed")
      : t("agentur.stale.row", {
          name: names.get(row.participationId) ?? "",
          reason: t(`agentur.stale.${row.reason}`),
        });

  return (
    <Stack gap={6}>
      {message && (
        <InlineNotification
          kind={message.kind}
          role={message.kind === "error" ? "alert" : "status"}
          title={message.text}
          onClose={() => setMessage(undefined)}
          lowContrast
        >
          {message.rows && (
            <ul className="tp-list">
              {message.rows.map((row) => (
                <li key={`${row.participationId}-${row.reason}`}>{rowText(row)}</li>
              ))}
            </ul>
          )}
        </InlineNotification>
      )}
      {view.withoutPlacementAgentur > 0 && (
        <p>{t("agentur.withoutPlacement", { count: view.withoutPlacementAgentur })}</p>
      )}
      {view.agenturen.length === 0 && <p>{t("agentur.empty")}</p>}
      {view.agenturen.map((agentur) => (
        <AgenturSection
          key={agentur.agenturKey}
          projectId={projectId}
          agentur={agentur}
          label={labelOf(agentur.agenturKey)}
          confirmer={
            agentur.artifact.kind === "accepted_alternative"
              ? nameOf(agentur.artifact.confirmedBy)
              : ""
          }
          busy={busy}
          onBuild={() =>
            act(async () => {
              ok(
                await api.POST("/api/v1/projects/{projectId}/kug200b-batches", {
                  params: { path: { projectId } },
                  body: {
                    agenturKey: agentur.agenturKey,
                    documentIds: agentur.candidates
                      .slice(0, kug200bBatchMax)
                      .map((c) => c.documentId),
                  },
                }),
              );
            }, t("agentur.built"))
          }
        />
      ))}
      {view.batches.length > 0 && <h3>{t("agentur.batches")}</h3>}
      {view.batches.map((batch) => (
        <BatchSection
          key={batch.id}
          batch={batch}
          label={labelOf(batch.agenturKey)}
          rowText={rowText}
          busy={busy}
          onIndex={() =>
            act(async () => {
              const data = ok(
                await api.POST("/api/v1/exports/{kind}", {
                  params: { path: { kind: "kug200b_batch_index" } },
                  body: { batchId: batch.id },
                }),
              );
              if (data) documentNavigation.assign(data.url);
            }, t("agentur.downloaded"))
          }
          onSubmit={(submittedOn) =>
            act(async () => {
              ok(
                await api.POST("/api/v1/kug200b-batches/{batchId}/submission", {
                  params: { path: { batchId: batch.id } },
                  body: { submittedOn },
                }),
              );
            }, t("agentur.submitted"))
          }
          onDiscard={() =>
            act(async () => {
              ok(
                await api.POST("/api/v1/kug200b-batches/{batchId}/discard", {
                  params: { path: { batchId: batch.id } },
                }),
              );
            }, t("agentur.discarded"))
          }
        />
      ))}
    </Stack>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className="tp-section" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <Stack gap={4}>{children}</Stack>
    </section>
  );
}

const personColumns = ["name", "formVersion", "route"] as const;

function People({ title, people }: { title: string; people: Agentur["candidates"] }) {
  const { t } = useTranslation();
  return (
    <SimpleTable
      title={title}
      columns={personColumns.map((key) => ({ key, header: t(`agentur.columns.${key}`) }))}
      rows={people.map((p) => ({
        id: p.participationId,
        name: [p.lastName, p.firstName].filter(Boolean).join(", "),
        formVersion: p.formVersion.replace("-", "/"),
        route: p.asuChannel ? t(`asu.channels.${p.asuChannel}`) : t("agentur.noRoute"),
      }))}
      emptyState={t("agentur.noCandidates")}
    />
  );
}

/** One placement Agentur: its channel or "Einstellungen fehlen", the artifact, the ready scans. */
function AgenturSection(props: {
  projectId: string;
  agentur: Agentur;
  label: string;
  confirmer: string;
  busy: boolean;
  onBuild: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { agentur } = props;
  const { artifact } = agentur;
  return (
    <Section title={props.label}>
      <p>
        {agentur.channel
          ? t("agentur.channel", { channel: t(`overrides.values.${agentur.channel}`) })
          : t("agentur.settingsMissing")}
      </p>
      <p data-testid="agentur-artifact">
        {artifact.kind === "kug200a"
          ? t("agentur.artifactKug200a")
          : t("agentur.artifactAlternative", {
              date: formatDate(artifact.confirmedOn),
              name: props.confirmer,
            })}
      </p>
      <People
        title={t("agentur.candidates", { count: agentur.candidates.length })}
        people={agentur.candidates}
      />
      {agentur.routeMissing.length > 0 && (
        <div data-testid="route-missing">
          <p>{t("agentur.routeMissing", { count: agentur.routeMissing.length })}</p>
          <p className="tp-hint">{t("agentur.routeMissingHint")}</p>
          <ul className="tp-list">
            {agentur.routeMissing.map((p) => (
              <li key={p.participationId}>
                <RouterLink
                  to="/projects/$projectId/participations/$participationId"
                  params={{ projectId: props.projectId, participationId: p.participationId }}
                  search={{ tab: "asu" }}
                >
                  {[p.lastName, p.firstName].filter(Boolean).join(", ")}
                </RouterLink>
              </li>
            ))}
          </ul>
        </div>
      )}
      {agentur.candidates.length > kug200bBatchMax && (
        <p className="tp-hint">{t("agentur.tooMany", { max: kug200bBatchMax })}</p>
      )}
      {agentur.capabilities.createBatch && (
        <div>
          <Button size="md" disabled={props.busy} onClick={() => void props.onBuild()}>
            {t("agentur.build")}
          </Button>
        </div>
      )}
    </Section>
  );
}

/** One batch: its state, members, stale rows and actions. */
function BatchSection(props: {
  batch: Batch;
  label: string;
  rowText: (row: StaleRow) => string;
  busy: boolean;
  onIndex: () => Promise<void>;
  onSubmit: (submittedOn: string) => Promise<void>;
  onDiscard: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const { batch } = props;
  const [date, setDate] = useState("");
  const [invalid, setInvalid] = useState(false);
  const submit = () => {
    const parsed = parseDisplayDate(date);
    if (!parsed.ok || parsed.value === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    void props.onSubmit(parsed.value);
  };
  return (
    <Section
      title={t("agentur.batchTitle", {
        agentur: props.label,
        at: formatTimestamp(batch.createdAt),
      })}
    >
      <p>
        <Tag
          type={batch.status === "open" ? "blue" : batch.status === "submitted" ? "green" : "gray"}
        >
          {t(`agentur.status.${batch.status}`)}
        </Tag>{" "}
        {t("agentur.batchFacts", {
          channel: t(`overrides.values.${batch.channel}`),
          artifact: t(`agentur.artifacts.${batch.artifact}`),
          count: batch.members.length,
        })}
      </p>
      {batch.submittedOn && (
        <p>{t("agentur.submittedOn", { date: formatDate(batch.submittedOn) })}</p>
      )}
      {batch.staleRows.length > 0 && (
        <InlineNotification
          kind="warning"
          title={t("agentur.staleTitle")}
          subtitle={t("agentur.staleHint")}
          hideCloseButton
          lowContrast
        >
          <ul className="tp-list" data-testid="stale-rows">
            {batch.staleRows.map((row) => (
              <li key={`${row.participationId}-${row.reason}`}>{props.rowText(row)}</li>
            ))}
          </ul>
        </InlineNotification>
      )}
      <People title={t("agentur.members")} people={batch.members} />
      <div className="tp-bulk-actions">
        {batch.capabilities.exportIndex && (
          <Button
            kind="tertiary"
            size="md"
            disabled={props.busy}
            onClick={() => void props.onIndex()}
          >
            {t("agentur.index")}
          </Button>
        )}
        {batch.capabilities.discard && (
          <Button
            kind="danger--tertiary"
            size="md"
            disabled={props.busy}
            onClick={() => void props.onDiscard()}
          >
            {t("agentur.discard")}
          </Button>
        )}
      </div>
      {batch.capabilities.submit && (
        <>
          <DateField
            id={`batch-submitted-on-${batch.id}`}
            labelText={t("agentur.submittedOnLabel")}
            defaultValue={date}
            onChange={setDate}
            invalidText={invalid ? t("agentur.invalidDate") : undefined}
          />
          <p className="tp-hint">{t("agentur.submitHint")}</p>
          <div>
            <Button size="md" disabled={props.busy} onClick={submit}>
              {t("agentur.submit")}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}
