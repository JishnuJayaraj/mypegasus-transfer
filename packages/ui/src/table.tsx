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

function Rows({ title, columns, rows, emptyState }: Omit<SimpleTableProps, "footer">) {
  if (rows.length === 0) {
    return (
      <TableContainer title={title}>
        <div className="tp-table-empty">{emptyState}</div>
      </TableContainer>
    );
  }
  return (
    <DataTable rows={rows} headers={columns}>
      {({ rows: tableRows, headers, getTableProps, getHeaderProps, getRowProps }) => (
        <TableContainer title={title}>
          <Table {...getTableProps()}>
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
