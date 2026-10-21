import type { FormEvent } from "react";

/** A form's submit handler that runs `action` instead of the browser's submission. */
export const submitWith = (action: () => unknown) => (event: FormEvent) => {
  event.preventDefault();
  void action();
};
