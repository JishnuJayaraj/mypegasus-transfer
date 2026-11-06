import {
  Button,
  Checkbox,
  OverflowMenu,
  OverflowMenuItem,
  Table,
  TableBatchActions,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableSelectAll,
  TableSelectRow,
  TableToolbar,
  TableToolbarContent,
} from "@carbon/react";
import { Column } from "@carbon/icons-react";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { UI_NAMESPACE } from "./i18n";

export interface DataColumn<T> {
  key: string;
  header: string;
  render: (item: T) => ReactNode;
  /** Makes the column sortable: the value compared (text in German order, empty last). */
  sortValue?: (item: T) => string | number | null | undefined;
  /** Not shown until chosen in the column chooser. */
  hiddenByDefault?: boolean;
  /** Never hidden (the column that names the row). */
  alwaysVisible?: boolean;
}

export type SortDirection = "ASC" | "DESC";
export type TableSort = { key: string; direction: SortDirection } | null;

/** One entry of a row's overflow menu. */
export interface RowAction {
  label: string;
  /** Gets the row's menu button, so a side panel can return the focus to it. */
  onClick: (trigger: HTMLElement | null) => void;
  danger?: boolean;
}

interface DataTableProps<T extends { id: string }> {
  /** The table's accessible name; the visible heading is the page's or the section's. */
  title: string;
  items: readonly T[];
  columns: DataColumn<T>[];
  /** Names a row in the checkbox and the row menu: only what the row already shows. */
  rowLabel: (item: T) => string;
  /** Shown instead of the table when `items` is empty (an EmptyState). */
  emptyState: ReactNode;
  /** A controlled sort (e.g. kept in the URL); without it the table keeps its own. */
  sort?: TableSort;
  onSortChange?: (sort: TableSort) => void;
  /** Selection with a batch bar that appears only while rows are selected (principle 2). */
  selection?: {
    selected: ReadonlySet<string>;
    onChange: (ids: Set<string>) => void;
    /** The batch actions (TableBatchAction buttons). */
    batchActions: ReactNode;
  };
  /** The row's actions, in its overflow menu; an empty list renders no menu for that row. */
  rowActions?: (item: T) => RowAction[];
  /** Lets the viewer hide and show columns; the choice is component state only (Q223). */
  columnChooser?: boolean;
  /** Rows shown at first; "Weitere anzeigen" adds as many. Without it every row is shown. */
  pageSize?: number;
  /** More rows on the server (a cursor): "Weitere anzeigen" fetches them. */
  loadMore?: { onClick: () => void; pending?: boolean };
  /** Further toolbar content (e.g. the search, 6b-3). */
  toolbar?: ReactNode;
}

const collator = new Intl.Collator("de", { numeric: true, sensitivity: "base" });

function compare(a: string | number | null | undefined, b: string | number | null | undefined) {
  const emptyA = a === null || a === undefined || a === "";
  const emptyB = b === null || b === undefined || b === "";
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return collator.compare(String(a), String(b));
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "";

/** The next sort for a click on a column header: ascending, descending, then unsorted. */
export function nextSort(current: TableSort, key: string): TableSort {
  if (current?.key !== key) return { key, direction: "ASC" };
  return current.direction === "ASC" ? { key, direction: "DESC" } : null;
}

/** The items sorted by a column (stable; empty values last in both directions). */
export function sortItems<T>(
  items: readonly T[],
  sort: TableSort,
  columns: Pick<DataColumn<T>, "key" | "sortValue">[],
): readonly T[] {
  const value = sort && columns.find((column) => column.key === sort.key)?.sortValue;
  if (!sort || !value) return items;
  const sign = sort.direction === "ASC" ? 1 : -1;
  return items.toSorted((a, b) => {
    const [x, y] = [value(a), value(b)];
    // Empty stays last either way.
    if (isEmpty(x) || isEmpty(y)) return compare(x, y);
    return sign * compare(x, y);
  });
}

/**
 * The interactive list (ui-patterns.md, data table): sortable headers, a sticky header inside its
 * own scroll container (the only thing that may scroll horizontally, D10), selection with a batch
 * bar, a row overflow menu, a column chooser kept in memory only and "Weitere anzeigen". Small
 * read-only tables stay `SimpleTable`.
 */
export function DataTable<T extends { id: string }>(props: DataTableProps<T>) {
  const { t } = useTranslation(UI_NAMESPACE);
  const id = useId();
  const [ownSort, setOwnSort] = useState<TableSort>(null);
  const sort = props.sort !== undefined ? props.sort : ownSort;
  const setSort = (next: TableSort) => {
    if (props.sort === undefined) setOwnSort(next);
    props.onSortChange?.(next);
  };
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(props.columns.filter((c) => c.hiddenByDefault).map((c) => c.key)),
  );
  const [choosing, setChoosing] = useState(false);
  const [limit, setLimit] = useState(props.pageSize ?? Infinity);
  const triggers = useRef(new Map<string, HTMLElement | null>());

  const columns = props.columns.filter((column) => !hidden.has(column.key));
  const sorted = useMemo(
    () => sortItems(props.items, sort, props.columns),
    [props.items, sort, props.columns],
  );
  const shown = sorted.slice(0, limit);
  const { selection, rowActions } = props;
  const selected = selection?.selected;
  const allSelected =
    selected !== undefined &&
    props.items.length > 0 &&
    props.items.every((i) => selected.has(i.id));
  const someSelected = selected !== undefined && selected.size > 0 && !allSelected;
  const hasToolbar = Boolean(selection || props.columnChooser || props.toolbar);

  if (props.items.length === 0) return <>{props.emptyState}</>;

  const batchLabels = (messageId: string, args?: { totalSelected?: number }) =>
    messageId === "carbon.table.batch.cancel"
      ? t("dataTable.cancelSelection")
      : messageId === "carbon.table.batch.selectAll"
        ? t("dataTable.selectAll")
        : t("dataTable.selected", { count: args?.totalSelected ?? 0 });

  return (
    <div className="tp-data-table">
      {hasToolbar && (
        <TableToolbar aria-label={props.title}>
          {/* Rendered only with a selection: no bulk control without one (principle 2). */}
          {selection && selection.selected.size > 0 && (
            <TableBatchActions
              shouldShowBatchActions
              totalSelected={selection.selected.size}
              totalCount={props.items.length}
              onCancel={() => selection.onChange(new Set())}
              translateWithId={batchLabels as never}
            >
              {selection.batchActions}
            </TableBatchActions>
          )}
          <TableToolbarContent
            aria-hidden={selection && selection.selected.size > 0 ? true : undefined}
          >
            {props.toolbar}
            {props.columnChooser && (
              <Button
                kind="ghost"
                renderIcon={Column}
                aria-expanded={choosing}
                aria-controls={`${id}-columns`}
                onClick={() => setChoosing(!choosing)}
              >
                {t("dataTable.columns")}
              </Button>
            )}
          </TableToolbarContent>
        </TableToolbar>
      )}
      {props.columnChooser && choosing && (
        <fieldset id={`${id}-columns`} className="tp-column-chooser">
          <legend>{t("dataTable.columnsLegend")}</legend>
          {props.columns.map((column) => (
            <Checkbox
              key={column.key}
              id={`${id}-column-${column.key}`}
              labelText={column.header}
              checked={!hidden.has(column.key)}
              disabled={column.alwaysVisible}
              onChange={(_, { checked }) => {
                const next = new Set(hidden);
                if (checked) next.delete(column.key);
                else next.add(column.key);
                setHidden(next);
              }}
            />
          ))}
        </fieldset>
      )}
      {/* A scroll container must be reachable by keyboard (WCAG 2.1.1, axe scrollable-region-focusable). */}
      {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
      <section className="tp-data-table-scroll" aria-label={props.title} tabIndex={0}>
        <Table aria-label={props.title} isSortable size="md">
          <TableHead>
            <TableRow>
              {selection && (
                <TableSelectAll
                  id={`${id}-all`}
                  name={`${id}-select`}
                  aria-label={t("dataTable.selectAll")}
                  checked={allSelected}
                  indeterminate={someSelected}
                  onSelect={() =>
                    selection.onChange(
                      allSelected ? new Set() : new Set(props.items.map((item) => item.id)),
                    )
                  }
                />
              )}
              {columns.map((column) => (
                <TableHeader
                  key={column.key}
                  isSortable={Boolean(column.sortValue)}
                  isSortHeader={sort?.key === column.key}
                  sortDirection={sort?.key === column.key ? sort.direction : "NONE"}
                  translateWithId={() =>
                    sort?.key === column.key
                      ? t(
                          sort.direction === "ASC"
                            ? "dataTable.sortedAscending"
                            : "dataTable.sortedDescending",
                        )
                      : t("dataTable.sortBy", { column: column.header })
                  }
                  onClick={column.sortValue ? () => setSort(nextSort(sort, column.key)) : undefined}
                >
                  {column.header}
                </TableHeader>
              ))}
              {rowActions && (
                <TableHeader>
                  <span className="tp-visually-hidden">{t("dataTable.actionsColumn")}</span>
                </TableHeader>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {shown.map((item) => {
              const actions = rowActions?.(item) ?? [];
              return (
                <TableRow key={item.id} isSelected={selected?.has(item.id)}>
                  {selection && (
                    <TableSelectRow
                      id={`${id}-row-${item.id}`}
                      name={`${id}-select`}
                      aria-label={t("dataTable.selectRow", { name: props.rowLabel(item) })}
                      checked={selection.selected.has(item.id)}
                      onSelect={() => {
                        const next = new Set(selection.selected);
                        if (next.has(item.id)) next.delete(item.id);
                        else next.add(item.id);
                        selection.onChange(next);
                      }}
                    />
                  )}
                  {columns.map((column) => (
                    <TableCell key={column.key}>{column.render(item)}</TableCell>
                  ))}
                  {rowActions && (
                    <TableCell className="cds--table-column-menu">
                      {actions.length > 0 && (
                        <OverflowMenu
                          ref={(node: HTMLElement | null) => {
                            triggers.current.set(item.id, node);
                          }}
                          size="sm"
                          flipped
                          aria-label={t("dataTable.rowActions", { name: props.rowLabel(item) })}
                          iconDescription={t("dataTable.rowActions", {
                            name: props.rowLabel(item),
                          })}
                        >
                          {actions.map((action) => (
                            <OverflowMenuItem
                              key={action.label}
                              itemText={action.label}
                              isDelete={action.danger}
                              onClick={() => action.onClick(triggers.current.get(item.id) ?? null)}
                            />
                          ))}
                        </OverflowMenu>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </section>
      {(sorted.length > limit || props.loadMore) && (
        <div className="tp-data-table-more">
          {sorted.length > limit && (
            <p>{t("dataTable.shownOf", { shown: shown.length, count: sorted.length })}</p>
          )}
          <Button
            kind="tertiary"
            size="sm"
            disabled={props.loadMore?.pending}
            onClick={() =>
              sorted.length > limit
                ? setLimit(limit + (props.pageSize ?? 0))
                : props.loadMore?.onClick()
            }
          >
            {t("dataTable.showMore")}
          </Button>
        </div>
      )}
    </div>
  );
}
