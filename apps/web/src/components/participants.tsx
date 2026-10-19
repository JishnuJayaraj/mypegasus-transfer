import { useInfiniteQuery } from "@tanstack/react-query";
import { ApiProblemError } from "@transfer/api-client";
import { createLink } from "@tanstack/react-router";
import { Button, Link, SimpleTable } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { participantsQuery, useApi } from "../api";

const RouterLink = createLink(Link);

const columns = [
  "personnelNumber",
  "lastName",
  "firstName",
  "status",
  "profilingStatus",
  "dsvStatus",
] as const;

/**
 * The project's participations (Slice 2 plan 5.13, AC-33): the person fields the API lists for
 * this viewer and the three statuses, page by page. The API decides who sees them; a 403 reads as
 * "not allowed", never as an empty list. Each row opens the participant's page.
 */
export function Participants({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const query = useInfiniteQuery(participantsQuery(useApi(), projectId));
  const forbidden = query.error instanceof ApiProblemError && query.error.status === 403;
  const rows = (query.data?.pages ?? []).flatMap((page) =>
    page.items.map((item) => ({
      id: item.id,
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
    })),
  );
  return (
    <section aria-labelledby="project-participants" className="tp-section">
      <h2 id="project-participants">{t("participants.title")}</h2>
      {forbidden ? (
        <p role="alert">{t("participants.forbidden")}</p>
      ) : query.isError ? (
        <p role="alert">{t("participants.failed")}</p>
      ) : (
        <>
          <SimpleTable
            title={t("participants.title")}
            columns={columns.map((key) => ({ key, header: t(`participants.columns.${key}`) }))}
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
