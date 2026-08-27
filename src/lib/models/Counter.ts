import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/** `{_id, seq}` - atomic sequence source for dogTagIdDec allocation and invoice numbering.
 * Always mutated via `findOneAndUpdate` with `$inc`, never read-then-write, so concurrent callers
 * never observe or hand out the same value (tested in tests/unit/counter.test.ts). */
export interface CounterDoc {
  _id: string;
  seq: number;
}

const counterSchema = new Schema<CounterDoc>({
  _id: {type: String, required: true},
  seq: {type: Number, required: true, default: 0},
});

export const Counter = getOrCreateModel<CounterDoc>("Counter", counterSchema);

/** Atomically increment and return the next value for `name`. Creates the counter at 0 -> 1 on
 * first use. */
export async function nextSequence(name: string): Promise<number> {
  const doc = await Counter.findOneAndUpdate(
    {_id: name},
    {$inc: {seq: 1}},
    {upsert: true, new: true},
  ).lean<CounterDoc>();
  if (!doc) throw new Error(`Failed to allocate sequence for counter "${name}"`);
  return doc.seq;
}
