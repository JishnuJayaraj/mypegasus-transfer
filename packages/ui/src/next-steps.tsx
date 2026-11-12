import { useId, type ReactNode } from "react";
import { toneIcon, type StatusTone } from "./status";

export interface NextStep {
  id: string;
  /** How urgent the item is; shown as an icon with `toneLabel`, never by colour alone. */
  tone: StatusTone;
  /** What the icon means, for assistive technology ("Überfällig"). */
  toneLabel: string;
  title: string;
  /** One line under the title (a relative and an absolute date, who was reminded when). */
  detail?: ReactNode;
  /** The item's own action (an outlined or text button, a link), beside it. */
  action?: ReactNode;
}

/**
 * Open items, each with its own action beside it (ui-patterns.md, which pattern): the caller
 * gives them in the order of the domain's next step (C2) and decides how many. Without items the
 * card says so.
 */
export function NextSteps({
  title,
  level = 2,
  summary,
  items,
  emptyText,
  more,
}: {
  title: string;
  level?: 2 | 3;
  /** Beside the title ("3 von 6 offenen Punkten"). */
  summary?: ReactNode;
  items: NextStep[];
  emptyText: string;
  /** The way to the rest ("Alle 6 anzeigen"), at the end of the header. */
  more?: ReactNode;
}) {
  const id = useId();
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <section className="tp-card tp-next-steps" aria-labelledby={id}>
      <div className="tp-section-card-header">
        <Heading id={id}>{title}</Heading>
        {summary && <p className="tp-section-card-summary">{summary}</p>}
        {more && <div className="tp-card-actions">{more}</div>}
      </div>
      {items.length === 0 ? (
        <p>{emptyText}</p>
      ) : (
        <ul className="tp-next-steps-list">
          {items.map((item) => {
            const Icon = toneIcon[item.tone];
            return (
              <li key={item.id} className={`tp-next-steps-item tp-next-steps-item--${item.tone}`}>
                <Icon size={16} aria-hidden="true" className="tp-next-steps-icon" />
                <div className="tp-next-steps-text">
                  <span className="tp-visually-hidden">
                    {item.toneLabel}
                    {": "}
                  </span>
                  <span className="tp-next-steps-title">{item.title}</span>
                  {item.detail && <span className="tp-next-steps-detail">{item.detail}</span>}
                </div>
                {item.action && <div className="tp-next-steps-action">{item.action}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
