import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { ApiProblemError, type components } from "@transfer/api-client";
import { createLink } from "@tanstack/react-router";
import {
  Add,
  Button,
  Checkbox,
  InlineNotification,
  Link,
  Select,
  SelectItem,
  SimpleTable,
  useToast,
} from "@transfer/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  entryWavesQuery,
  participantsQuery,
  projectConfigQuery,
  type ParticipationFilters,
  useApi,
} from "../api";
import { ActivationPrintView, NoticePrintView } from "./activation-print-view";
import { ManualParticipationForm } from "./manual-participation-form";
import { useConsultants } from "./team";

const RouterLink = createLink(Link);

const columns = [
  "select",
  "personnelNumber",
  "lastName",
  "firstName",
  "status",
  "profilingStatus",
  "dsvStatus",
  "consultants",
  "activationStatus",
  "privacyNoticeState",
] as const;

type ListItem = components["schemas"]["ParticipationListItem"];
type ActivationPrintItem = components["schemas"]["BatchActivationCodeResult"]["items"][number];
type PrivacyNoticePrintItem = components["schemas"]["PrivacyNoticeBatchResult"]["items"][number];
type PrintState =
  | { kind: "letter" | "sheet"; items: ActivationPrintItem[] }
  | { kind: "notice"; items: PrivacyNoticePrintItem[] };

/**
 * The project's participations (Slice 2 plan 5.13, AC-33): the person fields the API lists for
 * this viewer and the three statuses, page by page. The API decides who sees them; a 403 reads as
 * "not allowed", never as an empty list. Each row opens the participant's page. The PL selects
 * rows and assigns them to a consultant of the project (Q62).
 */
export function Participants({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [filters, setFilters] = useState<ParticipationFilters>({});
  const query = useInfiniteQuery(participantsQuery(api, projectId, filters));
  // Manual creation is one import row (R32): offered with the import's capability.
  const { data: config } = useSuspenseQuery(projectConfigQuery(api, projectId));
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const { consultants, mayAssign } = useConsultants(projectId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [print, setPrint] = useState<PrintState | null>(null);
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const forbidden = query.error instanceof ApiProblemError && query.error.status === 403;
  const rows = (query.data?.pages ?? []).flatMap((page) =>
    page.items.map((item) => ({
      id: item.id,
      select: (
        <Checkbox
          id={`select-${item.id}`}
          labelText={t("participants.select", {
            name: item.personnelNumber ?? t("participants.open"),
          })}
          hideLabel
          checked={selected.has(item.id)}
          onChange={(_, { checked }) => toggle(item.id, checked)}
        />
      ),
      // The URL carries only the id, never a person's value (R19).
      personnelNumber: (
        <RouterLink
          to="/projects/$projectId/participations/$participationId"
          params={{ projectId, participationId: item.id }}
        >
          {item.personnelNumber ?? t("participants.open")}
        </RouterLink>
      ),
      lastName: item.lastName ?? "",
      firstName: item.firstName ?? "",
      status: t(`participants.statuses.${item.status}`),
      profilingStatus: t(`participants.profilingStatuses.${item.profilingStatus}`),
      dsvStatus: t(`participants.dsvStatuses.${item.dsvStatus}`),
      consultants: item.consultants.map((c) => c.displayName).join(", "),
      activationStatus: t(
        item.activationStatus.account === "activated"
          ? "activation.status.activated"
          : `activation.code.${item.activationStatus.code}`,
      ),
      privacyNoticeState: t(`activation.notice.${item.privacyNoticeState.state}`, {
        dueOn: item.privacyNoticeState.dueOn,
      }),
    })),
  );
  const items = (query.data?.pages ?? []).flatMap((page) => page.items);
  const selectedItems = items.filter((item) => selected.has(item.id));
  const mayActivate = items.some(
    (item) =>
      item.activationCapabilities.issueActivationCode ||
      item.activationCapabilities.providePrivacyNotice,
  );
  const shown = mayAssign || mayActivate ? columns : columns.filter((key) => key !== "select");
  if (print) {
    return print.kind === "notice" ? (
      <NoticePrintView items={print.items} onClose={() => setPrint(null)} />
    ) : (
      <ActivationPrintView
        kind={print.kind}
        items={print.items}
        onClose={() => setPrint(null)}
        itemActions={
          print.kind === "sheet"
            ? print.items.map((item) => (
                <SheetHandover
                  key={item.activationCodeId}
                  item={item}
                  projectId={projectId}
                  onChanged={() =>
                    queryClient.invalidateQueries({
                      queryKey: participantsQuery(api, projectId).queryKey,
                    })
                  }
                />
              ))
            : undefined
        }
        footerActions={
          print.kind === "sheet" ? (
            <RevokeUnhandedSheets
              items={print.items}
              onDone={() => {
                setPrint(null);
                void queryClient.invalidateQueries({
                  queryKey: participantsQuery(api, projectId).queryKey,
                });
              }}
            />
          ) : undefined
        }
      />
    );
  }
  return (
    <section aria-labelledby="project-participants" className="tp-section">
      <h2 id="project-participants">{t("participants.title")}</h2>
      {created && (
        <>
          <InlineNotification
            kind="success"
            title={t("manual.created")}
            onClose={() => setCreated(null)}
          />
          <p>
            <RouterLink
              to="/projects/$projectId/participations/$participationId"
              params={{ projectId, participationId: created }}
            >
              {t("manual.openCreated")}
            </RouterLink>
          </p>
        </>
      )}
      {adding ? (
        <ManualParticipationForm
          projectId={projectId}
          onCancel={() => setAdding(false)}
          onCreated={async (detail) => {
            setAdding(false);
            setCreated(detail.id);
            showToast({ title: t("manual.created") });
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: participantsQuery(api, projectId).queryKey,
              }),
              queryClient.invalidateQueries({ queryKey: entryWavesQuery(api, projectId).queryKey }),
            ]);
          }}
        />
      ) : (
        config.capabilities.importParticipations && (
          <Button
            className="tp-load-more"
            renderIcon={Add}
            onClick={() => {
              setCreated(null);
              setAdding(true);
            }}
          >
            {t("manual.add")}
          </Button>
        )
      )}
      {forbidden ? (
        <p role="alert">{t("participants.forbidden")}</p>
      ) : query.isError ? (
        <p role="alert">{t("participants.failed")}</p>
      ) : (
        <>
          {mayAssign && (
            <BulkAssign
              projectId={projectId}
              consultants={consultants}
              selected={[...selected]}
              onAssigned={() => setSelected(new Set())}
            />
          )}
          <ParticipationFiltersView
            filters={filters}
            onChange={(next) => {
              setSelected(new Set());
              setFilters(next);
            }}
          />
          {mayActivate && (
            <BulkActivation
              projectId={projectId}
              selected={selectedItems}
              onPrinted={(result) => {
                setSelected(new Set());
                setPrint(result);
              }}
            />
          )}
          <SimpleTable
            title={t("participants.title")}
            columns={shown.map((key) => ({ key, header: t(`participants.columns.${key}`) }))}
            rows={rows}
            emptyState={query.isPending ? "" : t("participants.empty")}
          />
          {query.hasNextPage && (
            <Button
              className="tp-load-more"
              kind="tertiary"
              disabled={query.isFetchingNextPage}
              onClick={() => query.fetchNextPage()}
            >
              {t("participants.more")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

/** "Zuweisen": the selected participations to one consultant of the project (Q62). */
function BulkAssign({
  projectId,
  consultants,
  selected,
  onAssigned,
}: {
  projectId: string;
  consultants: { staffUserId: string; displayName: string }[];
  selected: string[];
  onAssigned: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useToast();
  const [staffUserId, setStaffUserId] = useState("");
  const [refused, setRefused] = useState(false);
  const assign = useMutation({
    mutationFn: async () => {
      const { data } = await api.POST("/api/v1/projects/{projectId}/assignments", {
        params: { path: { projectId } },
        body: { staffUserId, participationIds: selected },
      });
      return data!;
    },
    onSuccess: async ({ assigned }) => {
      setRefused(false);
      onAssigned();
      showToast({ title: t("participants.assigned", { count: assigned }) });
      await queryClient.invalidateQueries({ queryKey: participantsQuery(api, projectId).queryKey });
    },
    onError: () => setRefused(true),
  });
  return (
    <div className="tp-bulk-actions">
      {refused && (
        <InlineNotification
          kind="error"
          title={t("participants.assignFailed")}
          onClose={() => setRefused(false)}
        />
      )}
      <Select
        id="assign-consultant"
        labelText={t("participants.assignTo")}
        value={staffUserId}
        onChange={(event) => setStaffUserId(event.target.value)}
      >
        <SelectItem value="" text={t("participants.chooseConsultant")} />
        {consultants.map((c) => (
          <SelectItem key={c.staffUserId} value={c.staffUserId} text={c.displayName} />
        ))}
      </Select>
      <Button
        kind="secondary"
        disabled={!staffUserId || selected.length === 0 || assign.isPending}
        onClick={() => assign.mutate()}
      >
        {t("participants.assign", { count: selected.length })}
      </Button>
    </div>
  );
}

function ParticipationFiltersView({
  filters,
  onChange,
}: {
  filters: ParticipationFilters;
  onChange: (filters: ParticipationFilters) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="tp-bulk-actions">
      <Select
        id="activation-filter"
        labelText={t("activation.filters.activation")}
        value={filters.activation ?? ""}
        onChange={(event) =>
          onChange({
            ...filters,
            activation: (event.target.value || undefined) as ParticipationFilters["activation"],
          })
        }
      >
        <SelectItem value="" text={t("activation.filters.all")} />
        {(
          [
            "none",
            "printed",
            "open",
            "delivery_unknown",
            "expired",
            "locked",
            "revoked",
            "used",
          ] as const
        ).map((state) => (
          <SelectItem key={state} value={state} text={t(`activation.code.${state}`)} />
        ))}
      </Select>
      <Select
        id="notice-filter"
        labelText={t("activation.filters.notice")}
        value={filters.privacyNotice ?? ""}
        onChange={(event) =>
          onChange({
            ...filters,
            privacyNotice: (event.target.value ||
              undefined) as ParticipationFilters["privacyNotice"],
          })
        }
      >
        <SelectItem value="" text={t("activation.filters.all")} />
        {(["provided", "due", "overdue"] as const).map((state) => (
          <SelectItem key={state} value={state} text={t(`activation.notice.${state}`)} />
        ))}
      </Select>
    </div>
  );
}

function BulkActivation({
  projectId,
  selected,
  onPrinted,
}: {
  projectId: string;
  selected: ListItem[];
  onPrinted: (state: PrintState) => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const queryClient = useQueryClient();
  const [language, setLanguage] = useState<"de" | "en">("de");
  const [replace, setReplace] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const requiresReplacement = selected.some((item) =>
    ["printed", "open", "delivery_unknown"].includes(item.activationStatus.code),
  );
  const mayIssue =
    selected.length > 0 &&
    selected.every((item) => item.activationCapabilities.issueActivationCode);
  const mayNotice =
    selected.length > 0 &&
    selected.every((item) => item.activationCapabilities.providePrivacyNotice);
  const ids = selected.map(({ id }) => id);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: participantsQuery(api, projectId).queryKey });
  const issue = async (kind: "letter" | "sheet") => {
    setPending(true);
    setFailed(false);
    try {
      const { data } = await api.POST("/api/v1/projects/{projectId}/activation-codes", {
        params: { path: { projectId } },
        body: {
          participationIds: ids,
          channel: kind,
          language,
          replaceOpenCode: replace,
        },
      });
      if (!data) throw new Error("No print data");
      await refresh();
      onPrinted({ kind, items: data.items });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const notice = async () => {
    setPending(true);
    setFailed(false);
    try {
      const { data } = await api.POST("/api/v1/projects/{projectId}/privacy-notices", {
        params: { path: { projectId } },
        body: { participationIds: ids, language },
      });
      if (!data) throw new Error("No print data");
      await refresh();
      onPrinted({ kind: "notice", items: data.items });
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return (
    <section className="tp-section" aria-label={t("activation.bulk.title")}>
      <h3>{t("activation.bulk.title")}</h3>
      {failed && (
        <InlineNotification
          kind="error"
          title={t("activation.bulk.failed")}
          onClose={() => setFailed(false)}
        />
      )}
      <div className="tp-bulk-actions">
        <Select
          id="activation-language"
          labelText={t("activation.bulk.language")}
          value={language}
          onChange={(event) => setLanguage(event.target.value as "de" | "en")}
        >
          <SelectItem value="de" text="Deutsch" />
          <SelectItem value="en" text="English" />
        </Select>
        {requiresReplacement && (
          <Checkbox
            id="confirm-activation-reissue"
            labelText={t("activation.bulk.confirmReissue")}
            checked={replace}
            onChange={(_, { checked }) => setReplace(checked)}
          />
        )}
        <Button
          kind="secondary"
          disabled={!mayIssue || pending || (requiresReplacement && !replace)}
          onClick={() => void issue("letter")}
        >
          {t("activation.bulk.letters")}
        </Button>
        <Button
          kind="secondary"
          disabled={!mayIssue || pending || (requiresReplacement && !replace)}
          onClick={() => void issue("sheet")}
        >
          {t("activation.bulk.sheets")}
        </Button>
        <Button kind="secondary" disabled={!mayNotice || pending} onClick={() => void notice()}>
          {t("activation.bulk.notices")}
        </Button>
      </div>
    </section>
  );
}

function SheetHandover({
  item,
  projectId,
  onChanged,
}: {
  item: ActivationPrintItem;
  projectId: string;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [state, setState] = useState<"printed" | "handed" | "revoked" | "failed">("printed");
  const [pending, setPending] = useState(false);
  const perform = async (action: "handover" | "revocation") => {
    setPending(true);
    const response =
      action === "handover"
        ? await api.POST("/api/v1/participations/{participationId}/activation-codes/handover", {
            params: { path: { participationId: item.participationId } },
            body: { activationCodeId: item.activationCodeId },
          })
        : await api.POST("/api/v1/participations/{participationId}/activation-codes/revocation", {
            params: { path: { participationId: item.participationId } },
            body: { activationCodeId: item.activationCodeId, reason: "not_handed_over" },
          });
    setPending(false);
    if (!response.data) return setState("failed");
    setState(action === "handover" ? "handed" : "revoked");
    onChanged();
  };
  return (
    <div className="tp-print-controls" data-project-id={projectId}>
      {state === "printed" ? (
        <>
          <Button disabled={pending} onClick={() => void perform("handover")}>
            {t("activation.handover.confirm")}
          </Button>
          <Button
            kind="danger--tertiary"
            disabled={pending}
            onClick={() => void perform("revocation")}
          >
            {t("activation.handover.revoke")}
          </Button>
        </>
      ) : (
        <strong>{t(`activation.handover.${state}`)}</strong>
      )}
    </div>
  );
}

function RevokeUnhandedSheets({
  items,
  onDone,
}: {
  items: ActivationPrintItem[];
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const api = useApi();
  const [pending, setPending] = useState(false);
  const revoke = async () => {
    setPending(true);
    await Promise.all(
      items.map((item) =>
        api.POST("/api/v1/participations/{participationId}/activation-codes/revocation", {
          params: { path: { participationId: item.participationId } },
          body: { activationCodeId: item.activationCodeId, reason: "not_handed_over" },
        }),
      ),
    );
    setPending(false);
    onDone();
  };
  return (
    <div className="tp-print-controls">
      <Button kind="danger" disabled={pending} onClick={() => void revoke()}>
        {t("activation.handover.revokeRemaining")}
      </Button>
    </div>
  );
}
