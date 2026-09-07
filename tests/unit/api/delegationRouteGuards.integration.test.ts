import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.15 multi-owner (PLANNED) item V6 - the delegation ceremony's "integration (routes fail-
 * closed)" checklist line, exercised against the REAL route handlers, not just
 * `lib/delegation/flow.ts`'s pure functions (`tests/unit/delegation/flow.test.ts` already covers
 * those). Modelled directly on `issuanceRouteGuards.integration.test.ts` - same
 * `vi.mock("@/auth")` + `startEphemeralMongod` + role x disabled matrix convention, since these
 * routes reuse the identical `requireVetSession` gate `/api/tags/issue/*` already does.
 *
 * The PUBLIC `/d/:token*` routes are deliberately covered separately (no `vi.mock("@/auth")`
 * dependency at all for them) - they must NEVER require a staff session, only a valid token, per
 * `docs/DELEGATION.md` section 4.3 (a secondary owner's own phone calls these directly).
 *
 * ISOLATION: own ephemeral mongod, port 44137 (44117-44136 already taken by sibling suites - see
 * each file's own ISOLATION note, most recently `mintSessionResolveRoute.integration.test.ts`'s
 * 44136).
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {Staff, type StaffRole} from "@/lib/models/Staff";
import {Pet} from "@/lib/models/Pet";
import {DelegationSession} from "@/lib/models/DelegationSession";
import {POST as startPOST} from "@/app/api/pets/[id]/delegations/route";
import {GET as staffStatusGET} from "@/app/api/pets/[id]/delegations/[registrationId]/route";
import {POST as txPOST} from "@/app/api/pets/[id]/delegations/[registrationId]/tx/route";
import {POST as confirmPOST} from "@/app/api/pets/[id]/delegations/[registrationId]/confirm/route";
import {GET as publicResolveGET} from "@/app/d/[token]/route";
import {POST as publicCompletePOST} from "@/app/d/[token]/complete/route";
import {GET as publicStatusGET} from "@/app/d/[token]/status/route";

const MONGO_PORT = 44_137;
let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-wp415-delegation-route-guards");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(MONGO_PORT);
}, 30_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([Staff.deleteMany({}), Pet.deleteMany({}), DelegationSession.deleteMany({})]);
  vi.mocked(auth).mockReset();
});

function jsonRequest(url: string, body: unknown = {}): Request {
  return new Request(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
}
function getRequest(url: string): Request {
  return new Request(url, {method: "GET"});
}
function petParams(id = "does-not-exist"): {params: Promise<{id: string}>} {
  return {params: Promise.resolve({id})};
}
function petRegParams(id = "does-not-exist", registrationId = "does-not-exist"): {params: Promise<{id: string; registrationId: string}>} {
  return {params: Promise.resolve({id, registrationId})};
}
function tokenParams(token: string): {params: Promise<{token: string}>} {
  return {params: Promise.resolve({token})};
}

const ROLE_MATRIX = [
  {role: "vet", disabled: false, expectForbidden: false},
  {role: "owner", disabled: false, expectForbidden: false},
  {role: "staff", disabled: false, expectForbidden: true},
  {role: "vet", disabled: true, expectForbidden: true},
  {role: "owner", disabled: true, expectForbidden: true},
] as const;

async function withStaffSession(role: StaffRole, disabled: boolean): Promise<void> {
  const staff = await Staff.create({email: `${role}-${disabled}-${randomUUID()}@example.com`, role, disabled});
  vi.mocked(auth).mockResolvedValue({user: {staffId: staff.staffId, email: staff.email}} as never);
}

const STAFF_ONLY_ROUTES: Array<{name: string; invoke: () => Promise<Response>}> = [
  {name: "POST /api/pets/:id/delegations", invoke: () => startPOST(jsonRequest("https://vet.example.com/api/pets/x/delegations", {}), petParams())},
  {
    name: "GET /api/pets/:id/delegations/:registrationId",
    invoke: () => staffStatusGET(getRequest("https://vet.example.com/api/pets/x/delegations/y"), petRegParams()),
  },
  {
    name: "POST /api/pets/:id/delegations/:registrationId/tx",
    invoke: () => txPOST(jsonRequest("https://vet.example.com/api/pets/x/delegations/y/tx", {}), petRegParams()),
  },
  {
    name: "POST /api/pets/:id/delegations/:registrationId/confirm",
    invoke: () => confirmPOST(jsonRequest("https://vet.example.com/api/pets/x/delegations/y/confirm", {}), petRegParams()),
  },
];

describe.each(STAFF_ONLY_ROUTES)("$name - requireVetSession gate", ({invoke}) => {
  it.each(ROLE_MATRIX)("role=$role disabled=$disabled -> forbidden=$expectForbidden", async ({role, disabled, expectForbidden}) => {
    await withStaffSession(role, disabled);
    const res = await invoke();
    if (expectForbidden) {
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("forbidden");
    } else {
      expect(res.status).not.toBe(403);
    }
  });

  it("401s with no session at all", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await invoke();
    expect(res.status).toBe(401);
  });
});

describe("POST /api/pets/:id/delegations - fail-closed preconditions", () => {
  it("404s for a pet that does not exist", async () => {
    await withStaffSession("vet", false);
    const res = await startPOST(jsonRequest("https://vet.example.com/api/pets/nope/delegations", {mode: "add", clientId: "c1", operatorAddress: "0x1111111111111111111111111111111111111111"}), petParams("nope"));
    expect(res.status).toBe(404);
  });

  it("400s for a pet with no issued tag - never lets a ceremony start against a tag that does not exist", async () => {
    await withStaffSession("vet", false);
    const pet = await Pet.create({name: "Blaze", ownerClientIds: [], dogTag: {}, searchKey: "blaze"});
    const res = await startPOST(
      jsonRequest(`https://vet.example.com/api/pets/${pet.petId}/delegations`, {mode: "add", clientId: "c1", operatorAddress: "0x1111111111111111111111111111111111111111"}),
      petParams(pet.petId),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toMatch(/no DogTag issued/i);
  });

  it("400s a malformed body before touching the database at all", async () => {
    await withStaffSession("vet", false);
    const res = await startPOST(jsonRequest("https://vet.example.com/api/pets/x/delegations", {mode: "bogus"}), petParams());
    expect(res.status).toBe(400);
  });
});

describe("Public /d/:token* routes - never gated on a staff session", () => {
  const UNKNOWN_TOKEN = "a".repeat(32);

  it("GET /d/:token 404s an unknown token with NO auth check at all (no @/auth call, no session)", async () => {
    vi.mocked(auth).mockResolvedValue(null as never); // deliberately absent - proves this route never even asks
    const res = await publicResolveGET(getRequest(`https://vet.example.com/d/${UNKNOWN_TOKEN}`), tokenParams(UNKNOWN_TOKEN));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("GET /d/:token/status 404s an unknown token, not 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await publicStatusGET(getRequest(`https://vet.example.com/d/${UNKNOWN_TOKEN}/status`), tokenParams(UNKNOWN_TOKEN));
    expect(res.status).toBe(404);
  });

  it("POST /d/:token/complete 404s an unknown token, not 401", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await publicCompletePOST(
      jsonRequest(`https://vet.example.com/d/${UNKNOWN_TOKEN}/complete`, {commitment: `0x${"1".repeat(64)}`, wallet: "0x1111111111111111111111111111111111111111", signature: `0x${"2".repeat(130)}`}),
      tokenParams(UNKNOWN_TOKEN),
    );
    expect(res.status).toBe(404);
  });

  it("GET /d/:token 404s a kind:revoke session's token - structurally never publicly resolvable", async () => {
    const pet = await Pet.create({name: "Blaze", ownerClientIds: [], dogTag: {dogTagIdField: "42"}, searchKey: "blaze"});
    const token = "b".repeat(32);
    await DelegationSession.create({
      token,
      registrationId: randomUUID(),
      kind: "revoke",
      petId: pet.petId,
      dogTagIdField: "42",
      clientId: "c1",
      clinic: "0x1111111111111111111111111111111111111111",
      chainId: 135,
      clinicName: "Test Clinic",
      maskedTargetName: "J**",
      commitment: `0x${"1".repeat(64)}`,
      issuedAt: Math.floor(Date.now() / 1000),
      deadline: Math.floor(Date.now() / 1000) + 600,
      status: "claimed",
      consumed: true,
      consumedAt: Math.floor(Date.now() / 1000),
    });
    const res = await publicResolveGET(getRequest(`https://vet.example.com/d/${token}`), tokenParams(token));
    expect(res.status).toBe(404);
  });
});
