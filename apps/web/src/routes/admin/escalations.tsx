import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ApiProblemError } from "@transfer/api-client";
import { EmptyState, PageHeader, SimpleTable, TableSkeleton } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { escalationsQuery, useApi } from "../../api";
import { RouteError } from "../../components/route-error";
import { usePageTitle } from "../../page-title";

export const Route = createFileRoute("/admin/escalations")({
  component: EscalationsPage,
  errorComponent: RouteError,
});

const types = ["tl407_not_submitted", "profiling_compliance"] as const;

/**
 * "Eskalationen" (data-protection.md, the regional view; Q57): for the regional admin the TG
 * projects of their regions, for the admin every one; per project its PLs and per type the count
 * and the days overdue of the oldest. Never a participant: details come from the PL.
 */
function EscalationsPage() {
  const { t } = useTranslation();
  usePageTitle(t("escalations.title"));
  const query = useQuery(escalationsQuery(useApi()));
  const header = <PageHeader title={t("escalations.title")} />;
  if (query.error instanceof ApiProblemError && query.error.status === 403) {
    return (
      <>
        {header}
        <EmptyState variant="forbidden" title={t("escalations.forbidden")} />
      </>
    );
  }
  if (query.isError) {
    return (
      <>
        {header}
        <EmptyState
          variant="error"
          title={t("escalations.failed")}
          onRetry={() => void query.refetch()}
        />
      </>
    );
  }
  if (!query.data) {
    return (
      <>
        {header}
        <TableSkeleton
          label={t("escalations.loading")}
          headers={[
            t("escalations.columns.project"),
            t("escalations.columns.leads"),
            ...types.map((type) => t(`escalations.types.${type}`)),
          ]}
        />
      </>
    );
  }
  const cell = (row: (typeof query.data.rows)[number], type: (typeof types)[number]) => {
    const found = row.counts.find((c) => c.type === type);
    if (!found) return "–";
    const days = found.oldestDaysOverdue;
    const oldest =
      days === 0 ? t("escalations.oldestToday") : t("escalations.oldest", { count: days });
    return t("escalations.count", { count: found.count, oldest });
  };
  return (
    <>
      {header}
      <p>{t("escalations.intro")}</p>
      <SimpleTable
        title={t("escalations.title")}
        columns={[
          { key: "project", header: t("escalations.columns.project") },
          { key: "leads", header: t("escalations.columns.leads") },
          ...types.map((type) => ({ key: type, header: t(`escalations.types.${type}`) })),
        ]}
        rows={query.data.rows.map((row) => ({
          id: row.projectId,
          project: row.projectName,
          leads: row.leads.join(", "),
          tl407_not_submitted: cell(row, "tl407_not_submitted"),
          profiling_compliance: cell(row, "profiling_compliance"),
        }))}
        emptyState={t("escalations.empty")}
      />
    </>
  );
}
