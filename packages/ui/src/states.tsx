import {
  Button,
  DataTableSkeleton,
  InlineLoading,
  SkeletonPlaceholder,
  SkeletonText,
} from "@carbon/react";
import { Locked, Renew, Search, WarningAltFilled, Folder } from "@carbon/icons-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UI_NAMESPACE } from "./i18n";

// Every state is designed (ui-patterns.md, principle 7): loading looks like the final layout,
// empty says what this is, why it is empty and the next step, an error says what failed and how
// to retry, forbidden says who may see it.

/** A small inline loading line, announced politely; `label` says what is loading. */
export function Loading({ label }: { label?: string }) {
  const { t } = useTranslation(UI_NAMESPACE);
  return (
    <InlineLoading className="tp-loading" description={label ?? t("loading")} aria-live="polite" />
  );
}

/** A visually hidden status for a skeleton, so a screen reader hears what is loading. */
function LoadingStatus({ label }: { label?: string }) {
  const { t } = useTranslation(UI_NAMESPACE);
  return <output className="tp-visually-hidden">{label ?? t("loading")}</output>;
}

/** A page still loading: the header's title and a few lines and blocks where the content goes. */
export function PageSkeleton({ label }: { label?: string }) {
  return (
    <div className="tp-page-skeleton" aria-busy="true">
      <LoadingStatus label={label} />
      <SkeletonText heading width="30%" />
      <SkeletonText paragraph lineCount={2} width="60%" />
      <SkeletonPlaceholder className="tp-page-skeleton-block" />
    </div>
  );
}

/** A table still loading, with its real column headers when they are known. */
export function TableSkeleton({
  headers,
  rowCount = 5,
  label,
}: {
  headers: string[];
  rowCount?: number;
  label?: string;
}) {
  return (
    <div className="tp-table-skeleton" aria-busy="true">
      <LoadingStatus label={label} />
      <DataTableSkeleton
        headers={headers.map((header, index) => ({ key: String(index), header }))}
        columnCount={headers.length}
        rowCount={rowCount}
        showHeader={false}
        showToolbar={false}
      />
    </div>
  );
}

type EmptyStateProps = {
  /** What this is, in one line ("Noch keine Teilnehmenden"). */
  title: string;
  /** Why it is empty, or who may see it, and what to do. */
  description?: ReactNode;
  /** The next step (a button or link) for `noData`. */
  action?: ReactNode;
} & (
  | { variant: "noData" }
  | { variant: "noMatches"; onResetFilters?: () => void }
  | { variant: "forbidden" }
  | { variant: "error"; onRetry?: () => void }
);

const icons = { noData: Folder, noMatches: Search, forbidden: Locked, error: WarningAltFilled };

/**
 * An empty, forbidden or failed list or page. `noMatches` offers "Filter zurücksetzen", `error`
 * "Erneut versuchen". Forbidden and error are alerts, since they replace what was asked for.
 */
export function EmptyState(props: EmptyStateProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  const Icon = icons[props.variant];
  const alert = props.variant === "forbidden" || props.variant === "error";
  return (
    <div
      className={`tp-empty-state tp-empty-state--${props.variant}`}
      role={alert ? "alert" : undefined}
    >
      <Icon size={32} aria-hidden="true" className="tp-empty-state-icon" />
      <div className="tp-empty-state-text">
        <p className="tp-empty-state-title">{props.title}</p>
        {props.description && <div className="tp-empty-state-description">{props.description}</div>}
        {props.variant === "noMatches" && props.onResetFilters && (
          <Button kind="tertiary" size="sm" onClick={props.onResetFilters}>
            {t("emptyState.resetFilters")}
          </Button>
        )}
        {props.variant === "error" && props.onRetry && (
          <Button kind="tertiary" size="sm" renderIcon={Renew} onClick={props.onRetry}>
            {t("emptyState.retry")}
          </Button>
        )}
        {props.action}
      </div>
    </div>
  );
}
