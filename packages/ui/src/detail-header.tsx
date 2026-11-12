import type { Fact } from "./facts";
import { Crumbs, HeaderActions, type PageHeaderProps } from "./page-header";

/** A detail header shows at most this many key facts; more belong on the page. */
export const detailHeaderFacts = 5;

interface DetailHeaderProps extends PageHeaderProps {
  /** Up to five key facts under the title ("TG-Beginn 01.03.2027"); further ones are dropped. */
  facts?: Fact[];
}

/**
 * The header of one object (ui-patterns.md, which pattern): the breadcrumbs, then a card with
 * the page's one `h1`, one metadata line, the track tags, the primary action with "Aktionen",
 * and up to five key facts. The actions wrap below the title on narrow screens.
 */
export function DetailHeader({
  title,
  breadcrumbs,
  metadata,
  tags,
  facts = [],
  primaryAction,
  menuActions,
}: DetailHeaderProps) {
  const shown = facts.slice(0, detailHeaderFacts);
  return (
    <div className="tp-detail-header">
      <Crumbs items={breadcrumbs} />
      <div className="tp-detail-header-card">
        <div className="tp-detail-header-main">
          <div className="tp-detail-header-title">
            <h1>{title}</h1>
            {metadata && <p className="tp-page-header-metadata">{metadata}</p>}
            {tags && <div className="tp-detail-header-tags">{tags}</div>}
          </div>
          <HeaderActions primaryAction={primaryAction} menuActions={menuActions} />
        </div>
        {shown.length > 0 && (
          <dl className="tp-detail-header-facts">
            {shown.map(({ label, value }) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}
