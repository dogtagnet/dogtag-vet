import type {ReactNode} from "react";

export function PageHeader({title, description, action}: {title: string; description?: string; action?: ReactNode}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="text-page-title text-ink">{title}</h1>
        {description && <p className="mt-1 text-body text-ink-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
