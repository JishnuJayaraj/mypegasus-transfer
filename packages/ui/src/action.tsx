import { Button, type ButtonProps } from "@carbon/react";
import { useId, type ElementType } from "react";

type ActionButtonProps = ButtonProps<ElementType> & {
  /**
   * Why an authorised action can't run yet, as its prerequisite ("Erst eine Region wählen"):
   * the button is disabled and the text stands next to it (ui-patterns.md, C1). An action the
   * viewer may not take at all is not rendered; that is the caller's capability check.
   */
  unavailableReason?: string | null;
};

/**
 * A button that is either available or disabled with its prerequisite as visible text, never a
 * bare disabled button and never a tooltip-only explanation (not reachable by touch or zoom).
 */
export function ActionButton({ unavailableReason, disabled, ...props }: ActionButtonProps) {
  const id = useId();
  const reason = unavailableReason || null;
  return (
    <span className="tp-action">
      <Button
        {...props}
        disabled={disabled || reason !== null}
        aria-describedby={reason ? id : undefined}
      />
      {reason && (
        <span id={id} className="tp-action-reason">
          {reason}
        </span>
      )}
    </span>
  );
}
