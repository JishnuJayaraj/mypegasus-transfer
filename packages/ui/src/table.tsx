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
  /** Cell values are display text, already formatted. */
  rows: ({ id: string } & Record<string, string>)[];
  emptyState: ReactNode;
}

/** A read-only Carbon DataTable; shows `emptyState` instead of an empty table body. */
export function SimpleTable({ title, columns, rows, emptyState }: SimpleTableProps) {
  if (rows.length === 0) {
    return (
      <TableContainer title={title}>
        <div className="tp-empty-state">{emptyState}</div>
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
