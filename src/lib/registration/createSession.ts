import {randomUUID} from "node:crypto";
import type {Hex} from "viem";
import {generateHexToken} from "@/lib/models/BindToken";
import {computeClientHash, type ClientHashFields} from "@/lib/registration/clientHash";

/** Token TTL - plans/wp4.2-client-wallet-registration.md, dogtag-vet section 2: "TTL 600s", same
 * as the mint session's `TOKEN_TTL_SECS` (`app/api/tags/issue/start/route.ts`). */
export const REGISTRATION_TOKEN_TTL_SECS = 600;

export interface CreateRegistrationSessionInput {
  clientFields: ClientHashFields;
}

export type CreateRegistrationSessionResult =
  | {
      ok: true;
      token: string;
      registrationId: string;
      clientHash: Hex;
      issuedAt: number;
      blockNumber: number;
      deadline: number;
    }
  | {ok: false; code: "chain_unreachable"};

/**
 * `POST /api/clients/:id/wallet-registrations`'s core logic, factored out as a pure function (no
 * Mongo, no HTTP) exactly like `lib/mint/preflight.ts`/`lib/mint/allocate.ts` factor mint's own
 * session-start preconditions out of `app/api/tags/issue/start/route.ts` - the ROUTE still does
 * the actual `WalletRegistrationSession.create(...)` write, mirroring how mint's start route calls
 * `preflightIssuance`/`allocateDogTagId` and only then persists.
 *
 * `getBlockNumber` is injected (never called internally via `roaxPublicClient()` directly) so this
 * is directly unit-testable without a chain, and so the fail-closed contract - "session creation
 * FAILS CLOSED if the RPC is unreachable" - is a property of THIS function, provable with a
 * throwing fake, rather than something only an integration/e2e test could ever exercise.
 */
export async function createRegistrationSession(
  input: CreateRegistrationSessionInput,
  now: number,
  getBlockNumber: () => Promise<bigint>,
): Promise<CreateRegistrationSessionResult> {
  let blockNumber: bigint;
  try {
    blockNumber = await getBlockNumber();
  } catch {
    return {ok: false, code: "chain_unreachable"};
  }

  const registrationId = randomUUID();
  return {
    ok: true,
    token: generateHexToken(),
    registrationId,
    clientHash: computeClientHash(input.clientFields, registrationId),
    issuedAt: now,
    blockNumber: Number(blockNumber),
    deadline: now + REGISTRATION_TOKEN_TTL_SECS,
  };
}
