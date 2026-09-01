import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import {cn} from "@/lib/cn";

const baseControlClasses =
  "w-full rounded-control border border-border bg-surface px-3 py-2 text-body text-ink placeholder:text-ink-faint focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:opacity-50";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  const {className, ...rest} = props;
  return <input className={cn(baseControlClasses, className)} {...rest} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const {className, ...rest} = props;
  return <select className={cn(baseControlClasses, className)} {...rest} />;
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const {className, ...rest} = props;
  return <textarea className={cn(baseControlClasses, className)} {...rest} />;
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";
type ButtonSize = "sm" | "md";

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-brand text-white hover:opacity-90",
  secondary: "border border-border-strong bg-surface text-ink hover:bg-surface-2",
  danger: "bg-danger text-white hover:opacity-90",
  ghost: "text-ink hover:bg-surface-2",
};

// "sm" is for controls that live inside an already-dense DESKTOP row (a DataTable's own actions
// column, matching design-system.md's "density with breathing room: compact rows" principle)
// rather than standing alone as a page-level action - see WalletsPanel.tsx's per-wallet
// Receipt/Revoke controls. It is NOT a substitute for design-system.md's separate "44px touch
// targets on mobile" rule - that rule governs the native mobile apps' own components, never this
// web control, and nothing in this app renders "sm" as a mobile tap target. "md" (the default) is
// byte-identical to this component's classes before `size` existed - every existing call site
// omits `size` and renders exactly as before.
const sizeClasses: Record<ButtonSize, string> = {
  sm: "px-2.5 py-1.5 text-caption",
  md: "px-4 py-2 text-body",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({variant = "primary", size = "md", className, ...rest}: ButtonProps) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-control font-medium transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-50",
        sizeClasses[size],
        variantClasses[variant],
        className,
      )}
      {...rest}
    />
  );
}
