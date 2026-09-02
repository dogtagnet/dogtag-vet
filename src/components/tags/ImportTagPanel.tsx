"use client";

import {useEffect, useState} from "react";
import {Button, Input} from "@/components/ui/controls";
import {FormField, FormSection} from "@/components/ui/FormSection";
import {ImportQrPanel} from "@/components/tags/ImportQrPanel";
import type {PetDoc} from "@/lib/models/Pet";

type TargetMode = "existing" | "new";

/**
 * The Tags page's "Import tag" panel (plans/wp4.9-tag-data-custody.md section 2.3) - staff picks a
 * target (an existing pet, searched by name across the whole roster, or "create new from verified
 * data") before generating the QR. This is the ONE surface that needs the picker at all - the pet
 * page's own `ImportTagAction.tsx` variant already knows its target (the pet whose page it is on)
 * and skips straight to the QR.
 *
 * Reachability note (WP4.9V item 1's own logged finding, re-verified for item 6): `/tags` itself
 * redirects a plain `staff` session to `/dashboard` (WP4.7 A2, `src/app/(app)/tags/page.tsx`) - so
 * THIS panel is only ever reachable by a `vet`/`owner` session, even though the underlying
 * `POST /api/tags/import-sessions` route itself only requires `requireStaffSession`. A plain staff
 * member can still import tag data, just via the pet-page variant, never from here. This is an
 * inherited asymmetry from where each entry point lives, not a new gate this panel adds.
 */
export function ImportTagPanel({onClose}: {onClose: () => void}) {
  const [mode, setMode] = useState<TargetMode>("existing");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PetDoc[]>([]);
  const [selectedPetId, setSelectedPetId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    if (mode !== "existing" || query.trim().length === 0) {
      setResults([]);
      return;
    }
    const handle = setTimeout(() => {
      fetch(`/api/pets?q=${encodeURIComponent(query.trim())}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((pets: PetDoc[]) => setResults(pets.slice(0, 8)));
    }, 250);
    return () => clearTimeout(handle);
  }, [mode, query]);

  if (generating) {
    return <ImportQrPanel targetPetId={mode === "existing" ? (selectedPetId ?? undefined) : undefined} onClose={onClose} />;
  }

  const canGenerate = mode === "new" || Boolean(selectedPetId);

  return (
    <FormSection
      title="Import tag"
      helperText="Bring another clinic's (or your own reclaimed) DogTag data onto a pet here - the owner's app proves it on chain before anything is saved."
    >
      <div className="flex gap-2">
        <Button
          variant={mode === "existing" ? "primary" : "secondary"}
          size="sm"
          onClick={() => {
            setMode("existing");
            setSelectedPetId(null);
          }}
        >
          Existing pet
        </Button>
        <Button
          variant={mode === "new" ? "primary" : "secondary"}
          size="sm"
          onClick={() => {
            setMode("new");
            setSelectedPetId(null);
          }}
        >
          Create new pet from verified data
        </Button>
      </div>

      {mode === "existing" && (
        <FormField label="Search for the target pet" htmlFor="import-target-search">
          <Input
            id="import-target-search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedPetId(null);
            }}
            placeholder="Pet name..."
          />
          {results.length > 0 && (
            <ul className="mt-2 divide-y divide-border rounded-control border border-border">
              {results.map((pet) => (
                <li key={pet.petId}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPetId(pet.petId);
                      setQuery(pet.name);
                      setResults([]);
                    }}
                    className={`block w-full px-3 py-2 text-left text-body hover:bg-surface-2 ${
                      selectedPetId === pet.petId ? "bg-surface-2 font-medium" : ""
                    }`}
                  >
                    {pet.name}
                    {pet.species ? ` - ${pet.species}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selectedPetId && <p className="mt-2 text-caption text-ink-faint">Target selected.</p>}
        </FormField>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => setGenerating(true)} disabled={!canGenerate}>
          Generate code
        </Button>
      </div>
    </FormSection>
  );
}
