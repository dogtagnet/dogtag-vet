import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.15V (grade feedback) - `Pet.primaryOwnerClientId` is V1's one real data-model invariant
 * ("set once by `POST /api/tags/issue/start`, never overwritten, never inferred" - `Pet.ts`'s own
 * doc comment) and, before this file, had zero coverage: `e2e/multi-owner.spec.ts` only ever
 * exercises a pet that never had the field set (asserting the "Primary not recorded" DISPLAY
 * path), never the `$exists: false` WRITE guard in `start/route.ts` itself. That guard is exactly
 * the kind of thing a future refactor of the issuance start route could silently drop - it is not
 * exercised by any existing test, and nothing would fail typecheck/lint if it regressed.
 *
 * Modelled on `tests/unit/api/issuanceRouteGuards.integration.test.ts` (same route, `vi.mock("@/
 * auth")` + a real `Staff` row for `requireVetSession`) but goes one step further: `preflightIssuance`
 * is ALSO mocked to succeed (that file deliberately leaves it unmocked and only asserts "not 403"),
 * so execution actually reaches the `primaryOwnerClientId` branch this file cares about.
 * `allocateDogTagId` is deliberately left UNmocked and allowed to fail (no `DOGTAG_SBT_ADDRESS`
 * configured in this test env - the same unconfigured-chain condition
 * `issuanceRouteGuards.integration.test.ts` already relies on) - the resulting 400 is expected and
 * asserted on for documentation, since it pins exactly where in the route this happens: AFTER the
 * `primaryOwnerClientId` write (which happens immediately after `connectToDatabase()`) and BEFORE
 * dogTagId allocation. The DB side effect under test has therefore already landed by the time the
 * response comes back, regardless of that later failure.
 *
 * ISOLATION: own ephemeral mongod, port 44138 (44137 is
 * tests/unit/api/delegationRouteGuards.integration.test.ts's own port - see that file's doc
 * comment for the full port ledger as of this wave).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));
vi.mock("@/lib/mint/preflight", () => ({
  preflightIssuance: vi.fn(async () => ({
    ok: true,
    cloneAddress: `0x${"2".repeat(40)}`,
    entityAccount: `0x${"3".repeat(40)}`,
  })),
}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {Staff} from "@/lib/models/Staff";
import {Pet, type PetDoc} from "@/lib/models/Pet";
import {POST as startPOST} from "@/app/api/tags/issue/start/route";

const MONGO_PORT = 44_138;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-primary-owner-start");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Pet.deleteMany({});
  await Staff.deleteMany({});
  vi.mocked(auth).mockReset();
});

function startRequest(body: Record<string, unknown>): Request {
  return new Request("https://vet.example.com/api/tags/issue/start", {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify(body),
  });
}

async function asVetSession(): Promise<void> {
  const staff = await Staff.create({email: `vet-${randomUUID()}@example.com`, role: "vet", disabled: false});
  vi.mocked(auth).mockResolvedValue({user: {staffId: staff.staffId, email: staff.email}} as never);
}

/** The minimum `startMintSessionSchema` needs to parse - `profile.weightHistory` defaults to
 * `[]`, every other `profile`/`ownerIdentity` field is optional. */
function minimalStartBody(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    clientId: "client-does-not-need-to-exist-for-this-check",
    petName: "Whatever",
    ownerIdentity: {},
    profile: {},
    operatorAddress: `0x${"1".repeat(40)}`,
    ...overrides,
  };
}

/** Confirms the route really did fail at chain-allocate (never 403, never a validation 400 from a
 * malformed body) so a passing assertion below actually proves the DB write happened before the
 * failure, not that the route bailed out before ever reaching it. */
async function expectChainAllocateFailure(res: Response): Promise<void> {
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.message).toMatch(/chain/i);
}

describe("Pet.primaryOwnerClientId - set-once invariant through POST /api/tags/issue/start", () => {
  it("an existing pet that already has primaryOwnerClientId keeps it unchanged, even when a different client starts a new issuance", async () => {
    await asVetSession();
    const petId = randomUUID();
    await Pet.create({petId, name: "Rex", ownerClientIds: ["owner-a"], primaryOwnerClientId: "owner-a", searchKey: "rex"});

    const res = await startPOST(startRequest(minimalStartBody({petId, clientId: "owner-b"})));
    await expectChainAllocateFailure(res);

    const found = await Pet.findOne({petId}).lean<PetDoc>();
    expect(found?.primaryOwnerClientId).toBe("owner-a");
  });

  it("an existing pet with no primaryOwnerClientId recorded gets it set to the issuing client", async () => {
    await asVetSession();
    const petId = randomUUID();
    await Pet.create({petId, name: "Fido", ownerClientIds: ["owner-a"], searchKey: "fido"});
    expect((await Pet.findOne({petId}).lean<PetDoc>())?.primaryOwnerClientId).toBeUndefined();

    const res = await startPOST(startRequest(minimalStartBody({petId, clientId: "owner-a"})));
    await expectChainAllocateFailure(res);

    const found = await Pet.findOne({petId}).lean<PetDoc>();
    expect(found?.primaryOwnerClientId).toBe("owner-a");
  });

  it("a brand-new pet (no petId supplied - the Pet.create branch) gets primaryOwnerClientId set unconditionally at creation", async () => {
    await asVetSession();
    const distinctiveName = `Brand New Pet ${randomUUID()}`;

    const res = await startPOST(startRequest(minimalStartBody({petName: distinctiveName, clientId: "owner-c"})));
    await expectChainAllocateFailure(res);

    const found = await Pet.findOne({name: distinctiveName}).lean<PetDoc>();
    expect(found).toBeDefined();
    expect(found?.primaryOwnerClientId).toBe("owner-c");
    expect(found?.ownerClientIds).toEqual(["owner-c"]);
  });
});
