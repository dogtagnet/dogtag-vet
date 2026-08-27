import type {ReactNode} from "react";

export interface KeyValueRow {
  key: string;
  label: string;
  value: ReactNode;
}

export interface KeyValuePanelProps {
  title?: string;
  rows: KeyValueRow[];
}

/** Two-column definition list for entity profiles, tag details, payment details -
 * design-system.md's KeyValuePanel. */
export function KeyValuePanel({title, rows}: KeyValuePanelProps) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      {title && <h3 className="mb-3 text-section-title text-ink">{title}</h3>}
      <dl className="divide-y divide-border">
        {rows.map((row) => (
          <div key={row.key} className="grid grid-cols-[minmax(120px,1fr)_2fr] gap-4 py-2.5">
            <dt className="text-body text-ink-muted">{row.label}</dt>
            <dd className="text-body text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
