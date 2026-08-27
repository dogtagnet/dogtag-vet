import {dogTagIdField} from "@dogtag/standard";

/** The frozen cap on allocation attempts per mint (wp4-vet.md's issuance step 2: "cap 256"). Past
 * this, the deployment either has a badly stuck counter or is genuinely exhausting the id space -
 * either way, looping forever is the wrong failure mode. */
export const MAX_ALLOCATION_ATTEMPTS = 256;

export interface AllocateDogTagIdDeps {
  /** Atomically allocates and returns the next raw decimal handle (`Counter.nextSequence` in
   * production). Called at most `MAX_ALLOCATION_ATTEMPTS` times. */
  nextHandle: () => Promise<string>;
  /** Reads whether `DogTagSBTConsent.profileRoot(dogTagIdField(handle))` is unset on chain right
   * now. MUST reject (throw), never resolve `false`, on a read failure - see
   * `chainRead.ts`'s fail-closed contract, which every production implementation of this
   * parameter satisfies by construction (every `readContract` there throws on failure). */
  isRootUnset: (dogTagIdFieldDec: string) => Promise<boolean>;
}

export type AllocateDogTagIdResult =
  | {ok: true; dogTagIdDec: string; dogTagIdFieldDec: string; attempts: number}
  | {ok: false; reason: "exhausted"; attempts: number};

/**
 * The FAIL-CLOSED dogTagId allocation loop (wp4-vet.md's issuance step 2, normative): atomically
 * increment the counter, then read the chain itself for whether that handle's on-chain root is
 * still unset - never guess, never trust a local record of "handles we've issued", because the
 * canonical state is on chain. A handle whose root already reads as set (this deployment's counter
 * somehow re-issuing a value, or a handle collision from a different deployment sharing the same
 * SBT) is skipped and the next counter value is tried; a chain read that cannot be completed at all
 * refuses the WHOLE request rather than treating the unreadable answer as "unset" - that
 * distinction is exactly what {@link AllocateDogTagIdDeps.isRootUnset}'s throw-on-failure contract
 * exists to preserve, and this function does not swallow that throw into a `false`.
 *
 * Every call to `nextHandle` before this function returns `ok: true` has already burned that
 * counter value permanently (Mongo counters never roll back) - by design, per the doc comment on
 * `Counter.ts`: skipped handles are simply never reused, not reclaimed.
 */
export async function allocateDogTagId(deps: AllocateDogTagIdDeps): Promise<AllocateDogTagIdResult> {
  for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt++) {
    const dogTagIdDec = await deps.nextHandle();
    const dogTagIdFieldDec = dogTagIdField(dogTagIdDec).toString();
    // A thrown read (unreadable chain) is intentionally NOT caught here - it propagates out of
    // allocateDogTagId entirely, refusing the request, rather than being reinterpreted below.
    const unset = await deps.isRootUnset(dogTagIdFieldDec);
    if (unset) {
      return {ok: true, dogTagIdDec, dogTagIdFieldDec, attempts: attempt};
    }
  }
  return {ok: false, reason: "exhausted", attempts: MAX_ALLOCATION_ATTEMPTS};
}
