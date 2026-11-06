import { TableBatchAction } from "@carbon/react";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DataTable, nextSort, sortItems, type DataColumn, type TableSort } from "./data-table";
import { renderUi } from "./test-utils";

// Synthetic rows only.
type Row = { id: string; name: string; code: string; count: number | null };
const rows: Row[] = [
  { id: "1", name: "Özdemir", code: "B", count: 3 },
  { id: "2", name: "Adler", code: "C", count: null },
  { id: "3", name: "Zander", code: "A", count: 10 },
];
const columns: DataColumn<Row>[] = [
  {
    key: "name",
    header: "Name",
    render: (r) => r.name,
    sortValue: (r) => r.name,
    alwaysVisible: true,
  },
  { key: "code", header: "Code", render: (r) => r.code, sortValue: (r) => r.code },
  { key: "count", header: "Anzahl", render: (r) => r.count ?? "", sortValue: (r) => r.count },
  { key: "note", header: "Notiz", render: () => "–", hiddenByDefault: true },
];
const names = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell").at(0)?.textContent ?? "");

describe("sorting rules", () => {
  it("cycles ascending, descending, unsorted", () => {
    expect(nextSort(null, "name")).toEqual({ key: "name", direction: "ASC" });
    expect(nextSort({ key: "name", direction: "ASC" }, "name")).toEqual({
      key: "name",
      direction: "DESC",
    });
    expect(nextSort({ key: "name", direction: "DESC" }, "name")).toBeNull();
    expect(nextSort({ key: "name", direction: "DESC" }, "code")).toEqual({
      key: "code",
      direction: "ASC",
    });
  });

  it("sorts German text and numbers, empty values last both ways", () => {
    const by = (key: string, direction: "ASC" | "DESC") =>
      sortItems(rows, { key, direction }, columns).map((r) => r.id);
    expect(by("name", "ASC")).toEqual(["2", "1", "3"]);
    expect(by("count", "ASC")).toEqual(["1", "3", "2"]);
    expect(by("count", "DESC")).toEqual(["3", "1", "2"]);
    expect(sortItems(rows, null, columns)).toBe(rows);
  });
});

const batch = () => screen.queryByRole("button", { name: "Erinnern" });

describe("DataTable", () => {
  it("sorts by a header with the keyboard and reports the order (aria-sort)", async () => {
    const onSortChange = vi.fn<(sort: TableSort) => void>();
    renderUi(
      <DataTable
        title="Konten"
        items={rows}
        columns={columns}
        rowLabel={(r) => r.name}
        emptyState="leer"
        onSortChange={onSortChange}
      />,
    );
    expect(names()).toEqual(["Özdemir", "Adler", "Zander"]);
    const header = screen.getByRole("button", { name: /^Name/ });
    header.focus();
    await userEvent.keyboard("{Enter}");
    expect(names()).toEqual(["Adler", "Özdemir", "Zander"]);
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await userEvent.keyboard("{Enter}");
    expect(names()).toEqual(["Zander", "Özdemir", "Adler"]);
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "name", direction: "DESC" });
    expect(screen.queryByRole("button", { name: /^Notiz/ })).not.toBeInTheDocument();
  });

  it("follows a controlled sort", () => {
    renderUi(
      <DataTable
        title="Konten"
        items={rows}
        columns={columns}
        rowLabel={(r) => r.name}
        emptyState="leer"
        sort={{ key: "code", direction: "ASC" }}
      />,
    );
    expect(names()).toEqual(["Zander", "Özdemir", "Adler"]);
  });

  it("shows the empty state instead of an empty table", () => {
    renderUi(
      <DataTable
        title="Konten"
        items={[]}
        columns={columns}
        rowLabel={(r) => r.name}
        emptyState="Noch keine Konten"
      />,
    );
    expect(screen.getByText("Noch keine Konten")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("shows the batch bar only with a selection", async () => {
    const remind = vi.fn<(ids: string[]) => void>();
    function Selectable() {
      const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
      return (
        <DataTable
          title="Konten"
          items={rows}
          columns={columns}
          rowLabel={(r) => r.name}
          emptyState="leer"
          selection={{
            selected,
            onChange: setSelected,
            batchActions: (
              <TableBatchAction onClick={() => remind([...selected])}>
                {"Erinnern"}
              </TableBatchAction>
            ),
          }}
        />
      );
    }
    renderUi(<Selectable />);
    expect(batch()).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "Adler auswählen" }));
    expect(screen.getByText("1 ausgewählt")).toBeInTheDocument();
    await userEvent.click(batch()!);
    expect(remind).toHaveBeenCalledWith(["2"]);
    await userEvent.click(screen.getByRole("checkbox", { name: "Alle Zeilen auswählen" }));
    expect(screen.getByText("3 ausgewählt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Auswahl aufheben" }));
    expect(screen.getByRole("checkbox", { name: "Adler auswählen" })).not.toBeChecked();
  });

  it("opens a row's overflow menu with the keyboard", async () => {
    const edit = vi.fn<(id: string) => void>();
    renderUi(
      <DataTable
        title="Konten"
        items={rows}
        columns={columns}
        rowLabel={(r) => r.name}
        emptyState="leer"
        rowActions={(row) =>
          row.id === "3" ? [] : [{ label: "Bearbeiten", onClick: () => edit(row.id) }]
        }
      />,
    );
    expect(screen.queryByRole("button", { name: "Aktionen für Zander" })).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Aktionen für Adler" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    expect(button).toHaveAttribute("aria-expanded", "true");
    // Carbon keeps a floating menu invisible until it is placed, which jsdom never does, and may
    // mount it outside the body; the e2e of the staff page opens it for real.
    const menu = document.getElementById(button.getAttribute("aria-controls")!)!;
    expect(menu).toHaveAttribute("aria-label", "Aktionen für Adler");
    await userEvent.click(within(menu).getByText("Bearbeiten"));
    expect(edit).toHaveBeenCalledWith("2");
  });

  it("hides and shows columns in memory only", async () => {
    renderUi(
      <DataTable
        title="Konten"
        items={rows}
        columns={columns}
        rowLabel={(r) => r.name}
        emptyState="leer"
        columnChooser
      />,
    );
    const chooser = screen.getByRole("button", { name: "Spalten" });
    expect(chooser).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(chooser);
    const group = screen.getByRole("group", { name: "Angezeigte Spalten" });
    expect(within(group).getByRole("checkbox", { name: "Name" })).toBeDisabled();
    await userEvent.click(within(group).getByRole("checkbox", { name: "Notiz" }));
    await userEvent.click(within(group).getByRole("checkbox", { name: "Code" }));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      expect.stringContaining("Name"),
      expect.stringContaining("Anzahl"),
      "Notiz",
    ]);
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(window.location.search).toBe("");
  });

  it("shows more rows on 'Weitere anzeigen' and fetches the next page when asked", async () => {
    const more = vi.fn<() => void>();
    renderUi(
      <DataTable
        title="Konten"
        items={rows}
        columns={columns}
        rowLabel={(r) => r.name}
        emptyState="leer"
        pageSize={2}
        loadMore={{ onClick: more }}
      />,
    );
    expect(names()).toHaveLength(2);
    expect(screen.getByText("2 von 3 angezeigt")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Weitere anzeigen" }));
    expect(names()).toHaveLength(3);
    expect(more).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Weitere anzeigen" }));
    expect(more).toHaveBeenCalledOnce();
  });

  it("keeps the table in a focusable, labelled scroll container", () => {
    renderUi(
      <DataTable
        title="Konten"
        items={rows}
        columns={columns}
        rowLabel={(r) => r.name}
        emptyState="leer"
      />,
    );
    expect(screen.getByRole("region", { name: "Konten" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("table", { name: "Konten" })).toBeInTheDocument();
  });
});
