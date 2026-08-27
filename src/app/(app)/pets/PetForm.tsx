"use client";

import {useState} from "react";
import {useRouter} from "next/navigation";
import {Button, Input, Select, Textarea} from "@/components/ui/controls";
import {FormActionBar, FormField, FormSection} from "@/components/ui/FormSection";
import {OwnerPicker} from "@/components/pets/OwnerPicker";
import {PhotoCropUpload} from "@/components/pets/PhotoCropUpload";
import {WeightHistoryEditor} from "@/components/pets/WeightHistoryEditor";
import {useSnackbar} from "@/components/ui/Snackbar";
import type {PetDoc, PetSex, WeightEntry} from "@/lib/models/Pet";
import type {ClientDoc} from "@/lib/models/Client";

interface PetFormValues {
  name: string;
  species: string;
  breed: string;
  sex: PetSex | "";
  dateOfBirth: string;
  notes: string;
  microchipCode: string;
  microchipStandard: string;
  microchipImplantDate: string;
  microchipBodyLocation: string;
  weightHistory: WeightEntry[];
  owners: {clientId: string; name: string}[];
}

function toValues(pet?: PetDoc, owners?: ClientDoc[]): PetFormValues {
  return {
    name: pet?.name ?? "",
    species: pet?.species ?? "",
    breed: pet?.breed ?? "",
    sex: pet?.sex ?? "",
    dateOfBirth: pet?.dateOfBirth ?? "",
    notes: pet?.notes ?? "",
    microchipCode: pet?.microchip?.code ?? "",
    microchipStandard: pet?.microchip?.standard ?? "",
    microchipImplantDate: pet?.microchip?.implantDate ?? "",
    microchipBodyLocation: pet?.microchip?.bodyLocation ?? "",
    weightHistory: pet?.weightHistory ?? [],
    owners: owners?.map((o) => ({clientId: o.clientId, name: o.name})) ?? [],
  };
}

export function PetForm({pet, initialOwners, defaultOwnerClientId}: {
  pet?: PetDoc;
  initialOwners?: ClientDoc[];
  defaultOwnerClientId?: {clientId: string; name: string};
}) {
  const router = useRouter();
  const snackbar = useSnackbar();
  const [values, setValues] = useState<PetFormValues>(() => {
    const base = toValues(pet, initialOwners);
    if (!pet && defaultOwnerClientId && base.owners.length === 0) {
      base.owners = [defaultOwnerClientId];
    }
    return base;
  });
  const [saving, setSaving] = useState(false);

  function set<K extends keyof PetFormValues>(key: K, value: PetFormValues[K]) {
    setValues((prev) => ({...prev, [key]: value}));
  }

  async function handleSave() {
    if (!values.name.trim()) {
      snackbar.show("Name is required", "danger");
      return;
    }
    if (values.owners.length === 0) {
      snackbar.show("At least one owner is required", "danger");
      return;
    }
    setSaving(true);
    const payload = {
      name: values.name.trim(),
      species: values.species.trim() || undefined,
      breed: values.breed.trim() || undefined,
      sex: values.sex || undefined,
      dateOfBirth: values.dateOfBirth || undefined,
      notes: values.notes.trim() || undefined,
      microchip: {
        code: values.microchipCode.trim() || undefined,
        standard: (values.microchipStandard || undefined) as PetDoc["microchip"]["standard"],
        implantDate: values.microchipImplantDate || undefined,
        bodyLocation: values.microchipBodyLocation.trim() || undefined,
      },
      weightHistory: values.weightHistory.filter((w) => w.value.trim() !== ""),
      ownerClientIds: values.owners.map((o) => o.clientId),
    };
    try {
      const res = await fetch(pet ? `/api/pets/${pet.petId}` : "/api/pets", {
        method: pet ? "PATCH" : "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error("Save failed");
      const saved = await res.json();
      snackbar.show(pet ? "Pet updated" : "Pet created", "ok");
      if (!pet) router.push(`/pets/${saved.petId}`);
      else router.refresh();
    } catch {
      snackbar.show("Could not save pet - try again", "danger");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      {pet && (
        <FormSection title="Photo" helperText="Cropped to a square before upload.">
          <PhotoCropUpload petId={pet.petId} currentFileId={pet.photoFileId} />
        </FormSection>
      )}

      <FormSection title="Basics">
        <FormField label="Name" htmlFor="pet-name">
          <Input id="pet-name" value={values.name} onChange={(e) => set("name", e.target.value)} required />
        </FormField>
        <FormField label="Species" htmlFor="pet-species">
          <Input id="pet-species" value={values.species} onChange={(e) => set("species", e.target.value)} placeholder="Dog, cat, ..." />
        </FormField>
        <FormField label="Breed" htmlFor="pet-breed">
          <Input id="pet-breed" value={values.breed} onChange={(e) => set("breed", e.target.value)} />
        </FormField>
        <FormField label="Sex" htmlFor="pet-sex">
          <Select id="pet-sex" value={values.sex} onChange={(e) => set("sex", e.target.value as PetSex)}>
            <option value="">Unspecified</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
            <option value="unknown">Unknown</option>
          </Select>
        </FormField>
        <FormField label="Date of birth" htmlFor="pet-dob">
          <Input id="pet-dob" type="date" value={values.dateOfBirth} onChange={(e) => set("dateOfBirth", e.target.value)} />
        </FormField>
        <FormField label="Notes" htmlFor="pet-notes">
          <Textarea id="pet-notes" rows={3} value={values.notes} onChange={(e) => set("notes", e.target.value)} />
        </FormField>
      </FormSection>

      <FormSection title="Owners" helperText="A pet can have more than one owner.">
        <OwnerPicker value={values.owners} onChange={(owners) => set("owners", owners)} />
      </FormSection>

      <FormSection title="Microchip">
        <FormField label="Code" htmlFor="chip-code">
          <Input id="chip-code" value={values.microchipCode} onChange={(e) => set("microchipCode", e.target.value)} />
        </FormField>
        <FormField label="Standard" htmlFor="chip-standard">
          <Select id="chip-standard" value={values.microchipStandard} onChange={(e) => set("microchipStandard", e.target.value)}>
            <option value="">Unspecified</option>
            <option value="ISO11784">ISO 11784</option>
            <option value="ISO11785">ISO 11785</option>
            <option value="FDX-B">FDX-B</option>
            <option value="other">Other</option>
          </Select>
        </FormField>
        <FormField label="Implant date" htmlFor="chip-implant-date">
          <Input
            id="chip-implant-date"
            type="date"
            value={values.microchipImplantDate}
            onChange={(e) => set("microchipImplantDate", e.target.value)}
          />
        </FormField>
        <FormField label="Body location" htmlFor="chip-location">
          <Input
            id="chip-location"
            value={values.microchipBodyLocation}
            onChange={(e) => set("microchipBodyLocation", e.target.value)}
          />
        </FormField>
      </FormSection>

      <FormSection title="Weight history">
        <WeightHistoryEditor value={values.weightHistory} onChange={(w) => set("weightHistory", w)} />
      </FormSection>

      <FormActionBar>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : pet ? "Save changes" : "Create pet"}
        </Button>
      </FormActionBar>
    </div>
  );
}
