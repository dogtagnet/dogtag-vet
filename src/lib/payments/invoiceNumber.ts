/** `${prefix}-${seq zero-padded to 6 digits}` - e.g. `INV-000042`. Pure formatting only; the
 * sequence itself always comes from `Counter.nextSequence("invoiceNumber")` (atomic
 * `findOneAndUpdate($inc)`), never generated or guessed here. */
export function formatInvoiceNumber(prefix: string, seq: number): string {
  return `${prefix}-${String(seq).padStart(6, "0")}`;
}

export interface AllocateInvoiceNumberDeps {
  /** `Counter.nextSequence("invoiceNumber")` in production - atomically allocates and returns the
   * next raw sequence value. Injected so allocation-under-concurrency is testable against an
   * in-memory fake with no live database (`tests/unit/invoiceNumber.test.ts`), mirroring
   * `lib/mint/allocate.ts`'s `AllocateDogTagIdDeps` shape. */
  nextHandle: () => Promise<number>;
}

/** Thin wrapper so every call site allocates the sequence and formats it the same way, rather than
 * each one doing `formatInvoiceNumber(prefix, await nextSequence(...))` independently. */
export async function allocateInvoiceNumber(deps: AllocateInvoiceNumberDeps, prefix: string): Promise<string> {
  const seq = await deps.nextHandle();
  return formatInvoiceNumber(prefix, seq);
}
