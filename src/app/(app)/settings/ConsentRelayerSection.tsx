"use client";

import {useState} from "react";
import {FormSection} from "@/components/ui/FormSection";
import {useSnackbar} from "@/components/ui/Snackbar";

/**
 * WP4.15 multi-owner (PLANNED) item V5 - the clinic-wide DEFAULT for `/verify`'s "use this
 * clinic's clone as the relayer" toggle (`VerifySessionPanel.tsx`'s own doc comment has the full
 * mechanism). Owner-only (a clinic-wide policy default, mirroring `schedulingMode`'s own
 * owner-only ruling - WP4.7A orchestrator R2): staying OFF changes nothing about today's behavior;
 * turning it ON only takes effect once the DogTag admin has separately whitelisted this clinic's
 * clone for `canVerify` - `POST /api/verify/start`'s existing preflight refuses cleanly until then.
 */
export function ConsentRelayerSection({initial, isOwner}: {initial: boolean; isOwner: boolean}) {
  const snackbar = useSnackbar();
  const [enabled, setEnabled] = useState(initial);
  const [saving, setSaving] = useState(false);

  async function save(next: boolean) {
    setEnabled(next);
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({consentRelayerViaCloneEnabled: next}),
      });
      if (!res.ok) throw new Error("Save failed");
      snackbar.show("Saved", "ok");
    } catch {
      setEnabled(!next);
      snackbar.show("Could not save this setting", "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormSection
      title="Consent relayer (experimental)"
      helperText="Default for the /verify page's 'use this clinic's clone as the relayer' option - pending the DogTag admin whitelisting this clinic's clone for canVerify."
    >
      <label className="flex items-center gap-2 text-body text-ink">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!isOwner || saving}
          onChange={(e) => save(e.target.checked)}
        />
        Default to the clone as relayer on /verify
      </label>
      {!isOwner && <p className="mt-1 text-caption text-ink-faint">Only an owner can change this default.</p>}
    </FormSection>
  );
}
