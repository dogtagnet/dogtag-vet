"use client";

import {useState} from "react";
import {Button} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {useSnackbar} from "@/components/ui/Snackbar";

/** Read-only calendar feed URL (wp4-vet.md's "`/api/calendar/feed/:token`, rotatable bearer
 * token"). Rotating invalidates the old URL immediately - anyone with an old feed link loses
 * access on their next sync. */
export function IcsFeedSection({initialToken, publicBaseUrl}: {initialToken: string; publicBaseUrl?: string}) {
  const snackbar = useSnackbar();
  const [token, setToken] = useState(initialToken);
  const [rotating, setRotating] = useState(false);

  const feedPath = `/api/calendar/feed/${token}`;
  const feedUrl = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}${feedPath}` : feedPath;

  async function rotate() {
    setRotating(true);
    try {
      const res = await fetch("/api/ics-feed-token", {method: "POST"});
      if (!res.ok) throw new Error("Rotate failed");
      const {icsFeedToken} = await res.json();
      setToken(icsFeedToken);
      snackbar.show("Feed URL rotated - the old link no longer works", "ok");
    } catch {
      snackbar.show("Could not rotate the feed token - try again", "danger");
    } finally {
      setRotating(false);
    }
  }

  return (
    <FormSection title="Calendar feed" helperText="Subscribe to this URL from an external calendar app.">
      <FormField label="Feed URL" htmlFor="ics-feed-url">
        <div className="flex items-center gap-2">
          <input
            id="ics-feed-url"
            readOnly
            value={feedUrl}
            className="w-full rounded-control border border-border bg-surface-2 px-3 py-2 font-mono text-body text-ink"
          />
          <Button variant="secondary" onClick={rotate} disabled={rotating}>
            {rotating ? "Rotating..." : "Rotate"}
          </Button>
        </div>
      </FormField>
    </FormSection>
  );
}
