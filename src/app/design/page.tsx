import {notFound} from "next/navigation";
import {GalleryContent} from "@/app/design/GalleryContent";
import {ThemeToggle} from "@/components/ui/ThemeToggle";

export const metadata = {
  title: "Design gallery - dogtag-vet (dev)",
};

/** Dev-only component gallery: every shared UI primitive, rendered once in light and once in dark
 * (a `.dark` wrapper div, not `html.dark` - see globals.css) so both themes are checkable side by
 * side without toggling. Not reachable in a production build. */
export default function DesignGalleryPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }

  return (
    <div className="min-h-dvh bg-bg p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-page-title text-ink">Design gallery</h1>
          <p className="text-body text-ink-muted">Dev-only. Every shared component, both themes.</p>
        </div>
        <ThemeToggle />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="overflow-hidden rounded-card border border-border">
          <p className="border-b border-border bg-surface-2 px-4 py-2 text-caption font-medium uppercase tracking-wide text-ink-muted">
            Light
          </p>
          <GalleryContent />
        </div>
        <div className="dark overflow-hidden rounded-card border border-border">
          <p className="border-b border-border bg-surface-2 px-4 py-2 text-caption font-medium uppercase tracking-wide text-ink-muted">
            Dark
          </p>
          <GalleryContent />
        </div>
      </div>
    </div>
  );
}
