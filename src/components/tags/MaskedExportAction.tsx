"use client";

import {useState} from "react";
import {Button} from "@/components/ui/controls";
import {MaskedExportPanel} from "@/components/tags/MaskedExportPanel";

/** The pet page's "Export with masking" trigger (WP4.10V item 4) - a plain trigger + inline
 * reveal, mirroring `ShareTagDataAction.tsx`'s own shape exactly (this app's established
 * trigger/panel idiom - no dialog/modal primitive anywhere, design-system.md). */
export function MaskedExportAction({petId}: {petId: string}) {
  const [open, setOpen] = useState(false);

  if (open) {
    return <MaskedExportPanel petId={petId} onClose={() => setOpen(false)} />;
  }

  return (
    <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
      Export with masking
    </Button>
  );
}
