import {randomUUID} from "node:crypto";
import {generateHexToken} from "@/lib/models/BindToken";

/** Fixed TTL for both ceremony kinds (non-negotiable, plan section 14.1 item V2: "TTL 600s
 * fixed") - same value as the wallet-registration and mint sessions this ceremony mirrors. */
export const DELEGATION_SESSION_TTL_SECS = 600;

export type CreateAddDelegationSessionOutcome =
  | {ok: true; token: string; registrationId: string; issuedAt: number; blockNumber: number; deadline: number}
  | {ok: false; code: "chain_unreachable"};

/**
 * `POST /api/pets/:id/delegations {mode: "add"}`'s core logic, factored out as a pure function -
 * mirrors `lib/registration/createSession.ts`'s `createRegistrationSession` exactly, including its
 * fail-closed contract ("session creation FAILS CLOSED if the RPC is unreachable" - the
 * `DelegationClaim`'s `blockNumber` field needs a REAL chain read the same way `ClientRegistration`'s
 * does). `getBlockNumber` is injected so this is directly unit-testable without a chain.
 */
export async function createAddDelegationSession(
  now: number,
  getBlockNumber: () => Promise<bigint>,
): Promise<CreateAddDelegationSessionOutcome> {
  let blockNumber: bigint;
  try {
    blockNumber = await getBlockNumber();
  } catch {
    return {ok: false, code: "chain_unreachable"};
  }
  return {
    ok: true,
    token: generateHexToken(),
    registrationId: randomUUID(),
    issuedAt: now,
    blockNumber: Number(blockNumber),
    deadline: now + DELEGATION_SESSION_TTL_SECS,
  };
}

/**
 * `POST /api/pets/:id/delegations {mode: "revoke"}`'s core logic. Needs no chain read at all - a
 * revoke ceremony signs nothing (`docs/DELEGATION.md` section 4.5), so there is no `blockNumber`
 * for any struct to carry; `token`/`registrationId` exist purely for schema uniformity with the
 * add-kind row (this token is never exposed through any public route - see
 * `DelegationSession.ts`'s own doc comment).
 */
export function createRevokeDelegationSession(now: number): {token: string; registrationId: string; issuedAt: number; deadline: number} {
  return {
    token: generateHexToken(),
    registrationId: randomUUID(),
    issuedAt: now,
    deadline: now + DELEGATION_SESSION_TTL_SECS,
  };
}
