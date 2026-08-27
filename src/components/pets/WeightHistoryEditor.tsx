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
        <div key={index} className="flex items-end gap-2">
          <div className="w-28">
            <Input
              type="number"
              step="0.01"
              min="0"
              value={row.value}
              onChange={(e) => updateRow(index, {value: e.target.value})}
              placeholder="Weight"
              aria-label="Weight value"
            />
          </div>
          <div className="w-24">
            <Select
              value={row.unit}
              onChange={(e) => updateRow(index, {unit: e.target.value as WeightEntry["unit"]})}
              aria-label="Weight unit"
            >
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </Select>
          </div>
          <div className="flex-1">
            <Input
              type="date"
              value={row.measuredOn}
              onChange={(e) => updateRow(index, {measuredOn: e.target.value})}
              aria-label="Measured on"
            />
          </div>
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
