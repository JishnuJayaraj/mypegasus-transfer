import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { ApiProblemError } from "@transfer/api-client";
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
import { entryWavesQuery, participantsQuery, projectConfigQuery, useApi } from "../api";
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
] as const;

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
  const query = useInfiniteQuery(participantsQuery(api, projectId));
  // Manual creation is one import row (R32): offered with the import's capability.
  const { data: config } = useSuspenseQuery(projectConfigQuery(api, projectId));
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const { consultants, mayAssign } = useConsultants(projectId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
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
    })),
  );
  const shown = mayAssign ? columns : columns.filter((key) => key !== "select");
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
