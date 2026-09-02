"use client";

import {useState} from "react";
import {Button} from "@/components/ui/controls";
import {ExportQrPanel} from "@/components/tags/ExportQrPanel";

/** The pet page's "Share tag data to owner's phone" trigger (plans/wp4.9-tag-data-custody.md
 * section 2.2) - a plain trigger + inline reveal, the simplest of `ExportQrPanel`'s two mount
 * points (`TagsTable.tsx`'s row-expansion variant is the other, since a table row has no room of
 * its own to reveal a QR into). */
export function ShareTagDataAction({petId}: {petId: string}) {
  const [open, setOpen] = useState(false);

  if (open) {
    return <ExportQrPanel petId={petId} onClose={() => setOpen(false)} />;
  }

  return (
    <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
      Share tag data to owner&apos;s phone
    </Button>
  );
}
