import "server-only";
import {requireEnv} from "@/lib/env";
import {isProfileRootUnset} from "@/lib/chainRead";

/** The clinic's `DogTagSBTConsent` address, from server env. Every fail-closed root check in the
 * mint flow (allocation, custodial-bind's re-check) reads through this single accessor. */
export function sbtAddress(): `0x${string}` {
  return requireEnv("DOGTAG_SBT_ADDRESS") as `0x${string}`;
}

export async function isDogTagIdUnset(dogTagIdFieldDec: string): Promise<boolean> {
  return isProfileRootUnset(sbtAddress(), dogTagIdFieldDec);
}
