"use client";

import {useState} from "react";
import {Button} from "@/components/ui/controls";
import {ImportTagPanel} from "@/components/tags/ImportTagPanel";

/** Trigger + inline reveal for `ImportTagPanel` - kept separate from the panel itself so the panel
 * stays reusable without owning its own "is this even open" state (same split `ExportQrPanel`'s
 * two mount points already use). */
export function ImportTagSection() {
  const [open, setOpen] = useState(false);

  if (open) {
    return (
      <div className="mb-6 max-w-xl">
        <ImportTagPanel onClose={() => setOpen(false)} />
      </div>
    );
  }

  return (
    <div className="mb-6">
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Import tag
      </Button>
    </div>
  );
}
