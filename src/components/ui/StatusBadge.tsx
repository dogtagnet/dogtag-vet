export type StatusTone = "ok" | "warn" | "danger" | "info" | "neutral";

const toneClasses: Record<StatusTone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-danger-soft text-danger",
  info: "bg-info-soft text-info",
  neutral: "bg-neutral-status-soft text-neutral-status",
};

const dotClasses: Record<StatusTone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
  info: "bg-info",
  neutral: "bg-neutral-status",
};

export interface StatusBadgeProps {
  tone: StatusTone;
  label: string;
}

/** Soft background + strong text from the shared status palette, dot prefix, always a word (never
 * color-only) - design-system.md's StatusBadge. Every lifecycle entity (entity, tag, payment,
 * appointment) renders its state through this component. */
export function StatusBadge({tone, label}: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-badge px-2.5 py-1 text-caption font-medium ${toneClasses[tone]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClasses[tone]}`} aria-hidden />
      {label}
    </span>
  );
}
