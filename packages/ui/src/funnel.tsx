import type { ReactNode } from "react";

export interface FunnelStage {
  key: string;
  count: number;
  label: string;
  /** A stage that ends the track ("Ausgeschieden") is set apart from the ones on the way. */
  ended?: boolean;
  /**
   * The link to exactly the counted rows (the app's router link), given the stage's class and
   * content; without it the stage is text.
   */
  renderLink?: (props: { className: string; children: ReactNode }) => ReactNode;
}

/**
 * The stages of one track as one row of counts (ui-patterns.md, which pattern; C3: one track per
 * funnel). Each number can open the list with exactly those rows. The row wraps on narrow
 * screens; the number and its label are text, so nothing depends on colour or width.
 */
export function Funnel({ label, stages }: { label: string; stages: FunnelStage[] }) {
  return (
    <ol className="tp-funnel" aria-label={label}>
      {stages.map((stage) => {
        const className = `tp-funnel-stage${stage.ended ? " tp-funnel-stage--ended" : ""}`;
        const children = (
          <>
            <span className="tp-funnel-count">{stage.count}</span>{" "}
            <span className="tp-funnel-label">{stage.label}</span>
          </>
        );
        return (
          <li key={stage.key}>
            {stage.renderLink ? (
              stage.renderLink({ className, children })
            ) : (
              <span className={className}>{children}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
