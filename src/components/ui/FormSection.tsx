import type {ReactNode} from "react";

export interface FormSectionProps {
  title: string;
  helperText?: string;
  children: ReactNode;
}

/** Titled group with helper text - design-system.md's FormSection. Compose several of these
 * inside a form; pair with FormField below for inline validation under each input. */
export function FormSection({title, helperText, children}: FormSectionProps) {
  return (
    <section className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className="mb-4">
        <h3 className="text-section-title text-ink">{title}</h3>
        {helperText && <p className="mt-1 text-body text-ink-muted">{helperText}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export interface FormFieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  helperText?: string;
  children: ReactNode;
}

/** One labeled control with inline validation, per design-system.md ("validation inline under
 * fields"). */
export function FormField({label, htmlFor, error, helperText, children}: FormFieldProps) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block text-body font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-caption text-danger">{error}</p>
      ) : helperText ? (
        <p className="mt-1 text-caption text-ink-muted">{helperText}</p>
      ) : null}
    </div>
  );
}

/** Fixed bottom-right primary action bar for a long form, per design-system.md. Wrap the form's
 * submit button with this at the page level (not inside FormSection, which can repeat). */
export function FormActionBar({children}: {children: ReactNode}) {
  return (
    <div className="sticky bottom-0 -mx-6 mt-6 flex justify-end border-t border-border bg-surface/95 px-6 py-4 backdrop-blur">
      {children}
    </div>
  );
}
