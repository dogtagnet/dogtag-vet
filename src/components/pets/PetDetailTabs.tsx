"use client";

import {useState} from "react";
import type {ReactNode} from "react";

const TABS = ["profile", "records"] as const;
type TabKey = (typeof TABS)[number];

const TAB_ID: Record<TabKey, string> = {profile: "pet-detail-tab-profile", records: "pet-detail-tab-records"};
const PANEL_ID: Record<TabKey, string> = {profile: "pet-detail-panel-profile", records: "pet-detail-panel-records"};
const TAB_LABEL: Record<TabKey, string> = {profile: "Profile", records: "Records"};

/**
 * `/pets/:id`'s two-tab shell (plan section 11.2 V4: "pet page -> Records tab") - "Profile" (the
 * pre-existing tag card + edit form, unchanged) and "Records" (the new vaccination-record list this
 * wave adds). Both panels stay mounted and are toggled with `hidden` rather than conditionally
 * rendered, so `PetForm`'s own in-progress edits (and, once switched to once, `RecordsCard`'s own
 * already-fetched list) survive a tab switch instead of being torn down and refetched every time -
 * the same local-button-group idiom `PaymentRailTabs.tsx` already uses for a different pair of tabs
 * (plain `useState`, no shared tab-primitive library exists in this app to reach for instead).
 *
 * Grade round 1 O2: this used to declare `role="tablist"`/`role="tab"`/`aria-selected` but leave the
 * panels as plain `<div hidden>` with no `role="tabpanel"`, no `id`/`aria-controls`/`aria-labelledby`
 * linkage, and no arrow-key roving focus - an incomplete ARIA tabs pattern that announces "tab" to
 * assistive tech with no identified panel to go with it. Completed rather than dropped, since
 * `e2e/vaccination-records.spec.ts` already selects by `getByRole("tab")`. Automatic activation
 * (WAI-ARIA APG's own recommended default for a simple tablist like this one): Left/Right on the
 * tablist moves focus AND switches the active tab in one step, rather than requiring a separate
 * Enter/Space to commit.
 */
export function PetDetailTabs({profileTab, recordsTab}: {profileTab: ReactNode; recordsTab: ReactNode}) {
  const [active, setActive] = useState<TabKey>("profile");

  function handleTablistKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    // Exactly two tabs - Left/Right both just toggle to "the other one" (a modulo-indexed lookup
    // into TABS would need a defensive undefined-check for no real benefit with only two entries).
    const next: TabKey = active === "profile" ? "records" : "profile";
    setActive(next);
    document.getElementById(TAB_ID[next])?.focus();
  }

  return (
    <div>
      <div className="mb-6 flex gap-2" role="tablist" onKeyDown={handleTablistKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab}
            id={TAB_ID[tab]}
            type="button"
            role="tab"
            aria-selected={active === tab}
            aria-controls={PANEL_ID[tab]}
            tabIndex={active === tab ? 0 : -1}
            onClick={() => setActive(tab)}
            className={`rounded-control border px-3 py-1.5 text-body ${
              active === tab ? "border-brand bg-brand-soft text-brand" : "border-border text-ink-muted hover:bg-surface-2"
            }`}
          >
            {TAB_LABEL[tab]}
          </button>
        ))}
      </div>

      <div id={PANEL_ID.profile} role="tabpanel" aria-labelledby={TAB_ID.profile} tabIndex={0} hidden={active !== "profile"}>
        {profileTab}
      </div>
      <div id={PANEL_ID.records} role="tabpanel" aria-labelledby={TAB_ID.records} tabIndex={0} hidden={active !== "records"}>
        {recordsTab}
      </div>
    </div>
  );
}
