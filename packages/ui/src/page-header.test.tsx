import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PageHeader } from "./page-header";
import { renderUi } from "./test-utils";

describe("PageHeader", () => {
  it("shows breadcrumbs, one h1, tags, metadata and the primary action", () => {
    renderUi(
      <PageHeader
        title="Infoveranstaltung"
        breadcrumbs={[
          <a key="1" href="/projects">
            {"Projekte"}
          </a>,
          <a key="2" href="/projects/1">
            {"Werk Süd"}
          </a>,
        ]}
        tags={<span>{"Geplant"}</span>}
        metadata="Mi, 12.11.2026 · Raum 1"
        primaryAction={<button type="button">{"Ändern"}</button>}
      />,
    );
    const crumbs = screen.getByRole("navigation", { name: "Navigationspfad" });
    expect(
      within(crumbs)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Projekte", "Werk Süd"]);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText("Mi, 12.11.2026 · Raum 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ändern" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Aktionen" })).not.toBeInTheDocument();
  });

  it("puts secondary actions in an 'Aktionen' menu, destructive ones last, by keyboard", async () => {
    const cancel = vi.fn<() => void>();
    renderUi(
      <PageHeader
        title="Termin"
        menuActions={[
          { label: "Absagen", onClick: cancel, danger: true },
          { label: "Exportieren", onClick: () => {} },
        ]}
      />,
    );
    const menu = screen.getByRole("button", { name: "Aktionen" });
    await userEvent.tab();
    expect(menu).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["Exportieren", "Absagen"]);
    await userEvent.click(items[1]!);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
