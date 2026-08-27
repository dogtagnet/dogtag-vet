import Link from "next/link";
import {ThemeToggle} from "@/components/ui/ThemeToggle";

export default function LandingPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <span className="text-emphasized font-semibold text-ink">
          dogtag<span className="text-brand">-vet</span>
        </span>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 text-center">
        <h1 className="text-hero text-ink">Self-deployable DogTag vet platform</h1>
        <p className="max-w-xl text-body text-ink-muted">
          Clients, pets, appointments, DogTag issuance, verification, and payments - deployed and
          operated by your own clinic.
        </p>
        <Link
          href="/sign-in"
          className="rounded-control bg-brand px-5 py-2.5 text-body font-medium text-white hover:opacity-90"
        >
          Staff sign in
        </Link>
      </main>
    </div>
  );
}
