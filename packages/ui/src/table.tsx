import {
  DataTable,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from "@carbon/react";
import type { ReactNode } from "react";

export interface TableColumn {
  key: string;
  header: string;
}

interface SimpleTableProps {
  title: string;
  /**
   * The title names the table without being shown, when the page's heading already says it
   * (ui-patterns.md, principle 6: the projects page says "Projekte" once).
   */
  hideTitle?: boolean;
  columns: TableColumn[];
  /** Cell values are display text, already formatted, or an element such as a link. */
  rows: ({ id: string } & Record<string, ReactNode>)[];
  emptyState: ReactNode;
  /** Below the table: "Mehr laden" of a cursor list, or the list's add action. */
  footer?: ReactNode;
}

/**
 * A small read-only Carbon DataTable (ui-patterns.md, which table); shows `emptyState` instead of
 * an empty table body. An interactive list is a `DataTable`.
 */
export function SimpleTable({ footer, ...props }: SimpleTableProps) {
  return (
    <>
      <Rows {...props} />
      {footer && <div className="tp-table-footer">{footer}</div>}
    </>
  );
}

function Rows({ title, hideTitle, columns, rows, emptyState }: Omit<SimpleTableProps, "footer">) {
  const shownTitle = hideTitle ? undefined : title;
  if (rows.length === 0) {
    return (
      <TableContainer title={shownTitle}>
        <div className="tp-table-empty">{emptyState}</div>
      </TableContainer>
    );
  }
  return (
    <DataTable rows={rows} headers={columns}>
      {({ rows: tableRows, headers, getTableProps, getHeaderProps, getRowProps }) => (
        <TableContainer title={shownTitle}>
          <Table {...getTableProps()} aria-label={hideTitle ? title : undefined}>
            <TableHead>
              <TableRow>
                {headers.map((header) => (
                  <TableHeader {...getHeaderProps({ header })} key={header.key}>
                    {header.header}
                  </TableHeader>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {tableRows.map((row) => (
                <TableRow {...getRowProps({ row })} key={row.id}>
                  {row.cells.map((cell) => (
                    <TableCell key={cell.id}>{cell.value}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </DataTable>
  );
}
