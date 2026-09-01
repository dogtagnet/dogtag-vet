"use client";

import {Button, Input, Select} from "@/components/ui/controls";
import type {WeightEntry} from "@/lib/models/Pet";

export interface WeightHistoryEditorProps {
  value: WeightEntry[];
  onChange: (next: WeightEntry[]) => void;
}

/** Repeatable weight-history rows (wp4-vet.md's `weightHistory: [{unit, value, measuredOn}]`).
 * `value` stays a decimal string end-to-end - never coerced to a JS number - matching the
 * protocol's canonical-decimal-string convention for every measured amount. */
export function WeightHistoryEditor({value, onChange}: WeightHistoryEditorProps) {
  function updateRow(index: number, patch: Partial<WeightEntry>) {
    onChange(value.map((row, i) => (i === index ? {...row, ...patch} : row)));
  }

  function removeRow(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function addRow() {
    onChange([...value, {unit: "kg", value: "", measuredOn: new Date().toISOString().slice(0, 10)}]);
  }

  return (
    <div className="space-y-2">
      {value.map((row, index) => (
        // WP4.7 A7 - was three wrapper divs (Input/Select's base class is w-full, which plain
        // string concatenation could never override); controls.tsx now merges className via
        // tailwind-merge (cn()), so a plain override on the control itself wins outright.
        <div key={index} className="flex items-end gap-2">
          <Input
            type="number"
            step="0.01"
            min="0"
            value={row.value}
            onChange={(e) => updateRow(index, {value: e.target.value})}
            placeholder="Weight"
            aria-label="Weight value"
            className="w-28"
          />
          <Select
            value={row.unit}
            onChange={(e) => updateRow(index, {unit: e.target.value as WeightEntry["unit"]})}
            aria-label="Weight unit"
            className="w-24"
          >
            <option value="kg">kg</option>
            <option value="lb">lb</option>
          </Select>
          <Input
            type="date"
            value={row.measuredOn}
            onChange={(e) => updateRow(index, {measuredOn: e.target.value})}
            aria-label="Measured on"
            className="min-w-0 flex-1"
          />
          <Button variant="ghost" onClick={() => removeRow(index)} aria-label="Remove weight entry">
            Remove
          </Button>
        </div>
      ))}
      <Button variant="secondary" onClick={addRow}>
        Add weight entry
      </Button>
    </div>
  );
}
