import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ApiProblemError } from "@transfer/api-client";
import { PageHeader, SimpleTable } from "@transfer/ui";
import { useTranslation } from "react-i18next";
import { escalationsQuery, useApi } from "../../api";
import { RouteError } from "../../components/route-error";

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
  const query = useQuery(escalationsQuery(useApi()));
  if (query.error instanceof ApiProblemError && query.error.status === 403) {
    return <p role="alert">{t("escalations.forbidden")}</p>;
  }
  if (query.isError) return <p role="alert">{t("escalations.failed")}</p>;
  if (!query.data) return <p aria-live="polite">{t("escalations.loading")}</p>;
  const cell = (row: (typeof query.data.rows)[number], type: (typeof types)[number]) => {
    const found = row.counts.find((c) => c.type === type);
    return found
      ? t("escalations.count", { count: found.count, days: found.oldestDaysOverdue })
      : "–";
  };
  return (
    <>
      <PageHeader title={t("escalations.title")} />
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
