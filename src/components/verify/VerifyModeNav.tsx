import Link from "next/link";

const MODES = [
  {href: "/verify", label: "Consent (ZK)"},
  {href: "/verify/redacted", label: "Redacted document"},
  {href: "/verify/records", label: "Records"},
] as const;

/**
 * Small sub-nav linking `/verify`'s three independent modes - previously undiscoverable except by
 * typing a URL directly (`/verify/redacted` had no link pointing to it anywhere in the app before
 * this). Added alongside plan section 11.2 V6's new `/verify/records` mode so all three are
 * reachable from any one of them, not just the new one.
 */
export function VerifyModeNav({active}: {active: (typeof MODES)[number]["href"]}) {
  return (
    <div className="mb-6 flex flex-wrap gap-2">
      {MODES.map((mode) => (
        <Link
          key={mode.href}
          href={mode.href}
          className={`rounded-control border px-3 py-1.5 text-body ${
            mode.href === active ? "border-brand bg-brand-soft text-brand" : "border-border text-ink-muted hover:bg-surface-2"
          }`}
        >
          {mode.label}
        </Link>
      ))}
    </div>
  );
}
