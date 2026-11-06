import { Breadcrumb, BreadcrumbItem, MenuButton, MenuItem } from "@carbon/react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UI_NAMESPACE } from "./i18n";
import { useMediaQuery } from "./shell";

/** A secondary page action in the "Aktionen" menu. */
export interface MenuAction {
  label: string;
  onClick: () => void;
  /** A destructive action (cancel, delete): shown in red, last. */
  danger?: boolean;
}

interface PageHeaderProps {
  title: string;
  /**
   * The ancestors of this page, each a link (the app's router link); the page itself is the
   * title, not a breadcrumb.
   */
  breadcrumbs?: ReactNode[];
  /** One line of metadata below the title ("Mi, 12.11.2026, 10:00 · Raum 1"), plain text. */
  metadata?: ReactNode;
  /** Status tags beside the title (StatusTag). */
  tags?: ReactNode;
  /** The page's one primary action (ui-patterns.md, principle 3). */
  primaryAction?: ReactNode;
  /** Secondary actions, in an "Aktionen" menu; none, no menu. */
  menuActions?: MenuAction[];
}

/**
 * The top of every staff page (ui-patterns.md, page header): breadcrumbs, the page's one `h1`,
 * tags and a metadata line, the primary action and the "Aktionen" menu at the end. It wraps on
 * narrow screens; the actions then go below the title.
 */
export function PageHeader({
  title,
  breadcrumbs,
  metadata,
  tags,
  primaryAction,
  menuActions = [],
}: PageHeaderProps) {
  const { t } = useTranslation(UI_NAMESPACE);
  // On narrow screens the actions wrap to the start of the line, so the menu opens from there.
  const wide = useMediaQuery("(min-width: 42rem)");
  const ordered = [...menuActions.filter((a) => !a.danger), ...menuActions.filter((a) => a.danger)];
  return (
    <div className="tp-page-header">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumb noTrailingSlash aria-label={t("pageHeader.breadcrumb")}>
          {breadcrumbs.map((crumb, index) => (
            <BreadcrumbItem key={index}>{crumb}</BreadcrumbItem>
          ))}
        </Breadcrumb>
      )}
      <div className="tp-page-header-main">
        <div className="tp-page-header-title">
          <h1>{title}</h1>
          {tags && <div className="tp-page-header-tags">{tags}</div>}
        </div>
        {(primaryAction || ordered.length > 0) && (
          <div className="tp-page-header-actions">
            {ordered.length > 0 && (
              <MenuButton
                label={t("pageHeader.actions")}
                kind="tertiary"
                menuAlignment={wide ? "bottom-end" : "bottom-start"}
              >
                {ordered.map((action) => (
                  <MenuItem
                    key={action.label}
                    label={action.label}
                    kind={action.danger ? "danger" : "default"}
                    onClick={action.onClick}
                  />
                ))}
              </MenuButton>
            )}
            {primaryAction}
          </div>
        )}
      </div>
      {metadata && <p className="tp-page-header-metadata">{metadata}</p>}
    </div>
  );
}
