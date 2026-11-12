import { CheckmarkFilled, CircleDash, InProgress, WarningAltFilled } from "@carbon/icons-react";
import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UI_NAMESPACE } from "./i18n";

export type StepState = "done" | "current" | "open" | "blocked";

export interface Step {
  id: string;
  title: string;
  state: StepState;
  /** One line of status under the title in the list ("4 Angaben fehlen"). */
  status?: string;
  /** The step's content with its action, shown while the step is selected. */
  children?: ReactNode;
}

const stateIcon = {
  done: CheckmarkFilled,
  current: InProgress,
  open: CircleDash,
  blocked: WarningAltFilled,
} satisfies Record<StepState, unknown>;

/**
 * The steps of ONE track (ui-patterns.md, which pattern; C3: never a sequence across tracks):
 * the list of steps, each with its state and one line of status, and the selected step's content
 * beside it (below it under 66rem). It starts on the current step. The selection is component
 * state only.
 */
export function StepList({
  label,
  steps,
  level = 3,
}: {
  /** The list's accessible name: the track ("Profiling"). */
  label: string;
  steps: Step[];
  /** The selected step's heading level. */
  level?: 2 | 3;
}) {
  const { t } = useTranslation(UI_NAMESPACE);
  const id = useId();
  const [chosen, setChosen] = useState<string | null>(null);
  const selected =
    steps.find((step) => step.id === chosen) ??
    steps.find((step) => step.state === "current") ??
    steps[0];
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className="tp-step-list">
      <nav aria-label={label}>
        <ol>
          {steps.map((step) => {
            const Icon = stateIcon[step.state];
            const current = step.id === selected?.id;
            return (
              <li key={step.id}>
                <button
                  type="button"
                  className={`tp-step tp-step--${step.state}`}
                  aria-current={current ? "step" : undefined}
                  aria-controls={`${id}-panel`}
                  onClick={() => setChosen(step.id)}
                >
                  <Icon size={16} aria-hidden="true" className="tp-step-icon" />
                  <span className="tp-step-text">
                    <span className="tp-step-title">{step.title}</span>
                    <span className="tp-step-status">
                      <span className="tp-visually-hidden">
                        {t(`stepList.states.${step.state}`)}
                        {step.status ? ": " : ""}
                      </span>
                      {step.status}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {selected && (
        <section id={`${id}-panel`} className="tp-card" aria-labelledby={`${id}-title`}>
          <Heading id={`${id}-title`}>{selected.title}</Heading>
          <div className="tp-card-body">{selected.children}</div>
        </section>
      )}
    </div>
  );
}
