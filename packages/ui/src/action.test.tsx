import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActionButton } from "./action";
import { renderUi } from "./test-utils";

// C1 (ui-patterns.md, blocked actions): the unauthorised action is the caller's not to render;
// an authorised but blocked one is disabled with its prerequisite as text.
describe("ActionButton", () => {
  it("is enabled without a reason", () => {
    renderUi(<ActionButton>{"Rolle hinzufügen"}</ActionButton>);
    expect(screen.getByRole("button", { name: "Rolle hinzufügen" })).toBeEnabled();
  });

  it("shows the prerequisite as visible text next to the disabled button", () => {
    renderUi(
      <ActionButton unavailableReason="Erst eine Region wählen.">
        {"Rolle hinzufügen"}
      </ActionButton>,
    );
    const button = screen.getByRole("button", { name: "Rolle hinzufügen" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription("Erst eine Region wählen.");
    expect(screen.getByText("Erst eine Region wählen.")).toBeVisible();
  });
});
