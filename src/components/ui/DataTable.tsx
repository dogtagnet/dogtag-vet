import type {ReactNode} from "react";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  align?: "left" | "right";
  mono?: boolean;
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  emptyMessage?: string;
}

/** Sticky header, mono columns for chain data, row hover, one-line empty state, right-aligned
 * numeric columns - design-system.md's DataTable. Pagination/infinite-scroll is left to callers
 * (a table this small never needs to own that concern generically). */
export function DataTable<T>({columns, rows, getRowKey, emptyMessage}: DataTableProps<T>) {
  return (
    <div className="overflow-x-auto rounded-card border border-border bg-surface shadow-card">
      <table className="w-full border-collapse text-table-body">
        <thead className="sticky top-0 z-10 bg-surface-2">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={`whitespace-nowrap px-4 py-2.5 text-caption font-medium uppercase tracking-wide text-ink-muted ${
                  col.align === "right" ? "text-right" : "text-left"
                }`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-8 text-center text-body text-ink-faint">
                {emptyMessage ?? "Nothing here yet."}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={getRowKey(row)} className="border-t border-border hover:bg-surface-2">
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className={`px-4 py-2.5 align-middle text-ink ${col.mono ? "font-mono tabular-nums" : ""} ${
                      col.align === "right" ? "text-right" : "text-left"
                    }`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
