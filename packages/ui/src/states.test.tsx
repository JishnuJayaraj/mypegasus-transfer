import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { EmptyState, Loading, PageSkeleton, TableSkeleton } from "./states";
import { renderUi } from "./test-utils";

describe("states", () => {
  it("announces loading with a label", () => {
    renderUi(<Loading label="Termine werden geladen …" />);
    expect(screen.getByText("Termine werden geladen …")).toBeInTheDocument();
  });

  it("gives page and table skeletons a status for screen readers", () => {
    renderUi(
      <>
        <PageSkeleton />
        <TableSkeleton headers={["Name", "Status"]} label="Liste wird geladen …" />
      </>,
    );
    expect(screen.getAllByRole("status").map((node) => node.textContent)).toEqual([
      "Wird geladen …",
      "Liste wird geladen …",
    ]);
    expect(screen.getByText("Status")).toBeInTheDocument();
  });

  it("distinguishes no data from no matches, which offers to reset the filters", async () => {
    const reset = vi.fn<() => void>();
    renderUi(
      <>
        <EmptyState variant="noData" title="Noch keine Teilnehmenden" description="Importieren …" />
        <EmptyState variant="noMatches" title="Keine Treffer" onResetFilters={reset} />
      </>,
    );
    expect(screen.getByText("Noch keine Teilnehmenden")).toBeInTheDocument();
    expect(screen.queryAllByRole("alert")).toEqual([]);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("makes forbidden and error alerts; an error offers a retry by keyboard", async () => {
    const retry = vi.fn<() => void>();
    renderUi(
      <>
        <EmptyState variant="forbidden" title="Nicht erlaubt" description="Nur die PL." />
        <EmptyState variant="error" title="Nicht geladen" onRetry={retry} />
      </>,
    );
    expect(screen.getAllByRole("alert").map((node) => node.textContent)).toEqual([
      "Nicht erlaubtNur die PL.",
      "Nicht geladenErneut versuchen",
    ]);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Erneut versuchen" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(retry).toHaveBeenCalledOnce();
  });
});
