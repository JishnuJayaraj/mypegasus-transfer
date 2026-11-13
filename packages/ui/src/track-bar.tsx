import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UI_NAMESPACE } from "./i18n";

/**
 * Where ONE track stands on its own fixed path (ui-patterns.md, C3: each track its own bar, never
 * one sequence across tracks): the track's name, its steps as a segmented bar (done, current,
 * ahead; each step named for assistive technology) and its status tag, which carries the meaning
 * as text. `current` is the step's index; a status off the path (-1) has no bar, and `children`
 * says so. `children` is one line or a few facts under the bar.
 */
export function TrackBar({
  title,
  steps,
  current,
  tag,
  children,
}: {
  title: string;
  /** The labels of the path's steps, in order. */
  steps: readonly string[];
  current: number;
  /** The track's status tag (StatusTag). */
  tag: ReactNode;
  children?: ReactNode;
}) {
  const { t } = useTranslation(UI_NAMESPACE);
  return (
    <section className="tp-track-bar" aria-label={title}>
      <h3>{title}</h3>
      {current >= 0 ? (
        <ol aria-label={t("trackBar.steps", { track: title })}>
          {steps.map((step, index) => (
            <li
              key={step}
              className={
                index < current
                  ? "tp-track-bar-done"
                  : index === current
                    ? "tp-track-bar-current"
                    : undefined
              }
              aria-current={index === current ? "step" : undefined}
            >
              <span className="tp-visually-hidden">
                {step}
                {index < current && ` (${t("trackBar.done")})`}
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <span />
      )}
      <div className="tp-track-bar-tag">{tag}</div>
      {children && <div className="tp-track-bar-detail">{children}</div>}
    </section>
  );
}
