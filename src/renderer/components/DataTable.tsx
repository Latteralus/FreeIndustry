import type { ReactNode } from 'react';

/**
 * A compact, sortable report grid (spec §3.2 "sortable grids", §8.2
 * "table-first"). Sorting only reorders what the worker sent; it never
 * computes a business value. Click a column heading (or focus it and press
 * Enter) to sort by it; again to reverse.
 */

type SortValue = string | number | bigint;

export interface Column<Row> {
  readonly id: string;
  readonly header: string;
  readonly numeric?: boolean;
  /** Present when the column can be sorted. */
  readonly sortValue?: (row: Row) => SortValue;
  readonly render: (row: Row) => ReactNode;
}

export interface SortState {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
}

export interface DataTableProps<Row> {
  readonly label: string;
  readonly columns: readonly Column<Row>[];
  readonly rows: readonly Row[];
  readonly rowKey: (row: Row) => string;
  readonly sort?: SortState | null;
  readonly onSortChange?: (sort: SortState) => void;
  readonly emptyText?: string;
  readonly rowTestId?: (row: Row) => string;
  readonly rowProps?: (row: Row) => Record<string, string>;
  readonly footer?: ReactNode;
  readonly testId?: string;
}

function compare(a: SortValue, b: SortValue): number {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
  }
  if (typeof a === 'bigint' || typeof b === 'bigint') {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rows in the requested order; ties keep their original (worker) order. */
export function sortRows<Row>(
  rows: readonly Row[],
  columns: readonly Column<Row>[],
  sort: SortState | null | undefined,
): readonly Row[] {
  const column = columns.find((candidate) => candidate.id === sort?.column);
  const value = column?.sortValue;
  if (!sort || !value) {
    return rows;
  }
  const sign = sort.direction === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, key: value(row) }))
    .sort((a, b) => compare(a.key, b.key) * sign || a.index - b.index)
    .map((entry) => entry.row);
}

export function DataTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  sort = null,
  onSortChange,
  emptyText = 'None.',
  rowTestId,
  rowProps,
  footer,
  testId,
}: DataTableProps<Row>) {
  const ordered = sortRows(rows, columns, sort);
  return (
    <table className="data-table" aria-label={label} data-testid={testId}>
      <thead>
        <tr>
          {columns.map((column) => {
            const sorted = sort?.column === column.id ? sort.direction : null;
            const className = column.numeric ? 'data-table-number' : undefined;
            return (
              <th
                key={column.id}
                scope="col"
                className={className}
                aria-sort={
                  sorted === null ? undefined : sorted === 'asc' ? 'ascending' : 'descending'
                }
              >
                {column.sortValue && onSortChange ? (
                  <button
                    type="button"
                    className="data-table-sort"
                    onClick={() => {
                      onSortChange({
                        column: column.id,
                        direction: sorted === 'asc' ? 'desc' : 'asc',
                      });
                    }}
                  >
                    {column.header}
                    <span aria-hidden="true">
                      {sorted === 'asc' ? ' ▲' : sorted === 'desc' ? ' ▼' : ''}
                    </span>
                  </button>
                ) : (
                  column.header
                )}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {ordered.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className="data-table-empty">
              {emptyText}
            </td>
          </tr>
        ) : (
          ordered.map((row) => (
            <tr key={rowKey(row)} data-testid={rowTestId?.(row)} {...rowProps?.(row)}>
              {columns.map((column) => (
                <td key={column.id} className={column.numeric ? 'data-table-number' : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
      {footer}
    </table>
  );
}
