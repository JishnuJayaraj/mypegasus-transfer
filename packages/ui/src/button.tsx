import { Button as CarbonButton } from "@carbon/react";
import type { ComponentProps } from "react";

/**
 * The kinds of a button (ui-patterns.md, principle 3): `primary` once per page, in its header;
 * every other action `tertiary` (outlined) or `ghost` (a text button) beside what it acts on.
 * Carbon's dark `secondary` kind is not offered: it reads as disabled.
 */
export type ButtonKind =
  | "primary"
  | "tertiary"
  | "ghost"
  | "danger"
  | "danger--tertiary"
  | "danger--ghost";

type ButtonProps = Omit<ComponentProps<typeof CarbonButton>, "kind"> & { kind?: ButtonKind };

/** Carbon's button with the kit's kinds. */
export function Button(props: ButtonProps) {
  return <CarbonButton {...props} />;
}
