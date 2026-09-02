"use client";

import {useState} from "react";
import {Button} from "@/components/ui/controls";
import {ImportQrPanel} from "@/components/tags/ImportQrPanel";

/** The pet page's "Import tag" trigger (plans/wp4.9-tag-data-custody.md section 2.3) - the target
 * is always THIS pet, so unlike the Tags page's `ImportTagPanel.tsx` there is no picker: a plain
 * trigger + inline reveal, the same shape `ShareTagDataAction.tsx` uses for export. */
export function ImportTagAction({petId}: {petId: string}) {
  const [open, setOpen] = useState(false);

  if (open) {
    return <ImportQrPanel targetPetId={petId} onClose={() => setOpen(false)} />;
  }

  return (
    <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
      Import tag
    </Button>
  );
}
