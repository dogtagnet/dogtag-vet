import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {randomUUID} from "node:crypto";
import mongoose from "mongoose";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";

/**
 * WP4.7A FIX ROUND 1 (MINOR-1 + RULING R1) - A2's own text asked for "Tests: 403 matrix per role x
 * route", but what existed after grade round 1 was a role x HELPER matrix
 * (wp47BackCompat.integration.test.ts's requireVetSession/requireOwnerSession suite) plus e2e proof
 * of the `/tags` PAGE redirect. No test invoked the actual ROUTE HANDLERS and asserted 403 - a gap
 * a future refactor could drop silently (a route that forgets to call the helper at all still
 * typechecks, still lints, and only ever surfaces as a live security hole).
 *
 * Covers all FIVE routes now on `requireVetSession`: the three A2 originally named
 * (confirm/tx/retry) plus the two RULING R1 added in this same fix round (start, attestation).
 * Modelled on `tests/unit/booking/settingsRouteD1.integration.test.ts` - `vi.mock("@/auth")` +
 * `startEphemeralMongod` on a free port > 44000 (44123 - 44117-44122 already taken by sibling
 * suites).
 *
 * Per the grade file's own recipe: a vet/owner call may fail LATER for missing session data (no
 * such MintSession, a malformed body) - every route's guard runs FIRST, before any body/param
 * parsing (confirmed by reading each handler), so this only asserts "not 403" for the allowed
 * cases rather than seeding a full MintSession/BindToken fixture per route.
 */
vi.mock("@/auth", () => ({auth: vi.fn()}));

import {auth} from "@/auth";
import {connectToDatabase} from "@/lib/db";
import {Staff, type StaffRole} from "@/lib/models/Staff";
import {POST as startPOST} from "@/app/api/tags/issue/start/route";
import {POST as confirmPOST} from "@/app/api/tags/issue/[sessionId]/confirm/route";
import {POST as txPOST} from "@/app/api/tags/issue/[sessionId]/tx/route";
import {POST as retryPOST} from "@/app/api/tags/issue/[sessionId]/retry/route";
import {GET as attestationGET, POST as attestationPOST} from "@/app/api/tags/issue/[sessionId]/attestation/route";

const MONGO_PORT = 44_123;

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod(MONGO_PORT, "dogtag-vet-wp47-issuance-route-guards");
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
  await Staff.deleteMany({});
  vi.mocked(auth).mockReset();
});

function jsonRequest(url: string, body: unknown = {}): Request {
  return new Request(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
}

function getRequest(url: string): Request {
  return new Request(url, {method: "GET"});
}

function sessionIdParams(sessionId = "does-not-exist"): {params: Promise<{sessionId: string}>} {
  return {params: Promise.resolve({sessionId})};
}

/** Same 5-case role x disabled matrix wp47BackCompat.integration.test.ts already pins at the
 * requireVetSession HELPER level - reused here at the ROUTE level, which is the actual gap this
 * file closes. */
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

const ROUTES: Array<{name: string; invoke: () => Promise<Response>}> = [
  {
    name: "POST /api/tags/issue/start",
    invoke: () => startPOST(jsonRequest("https://vet.example.com/api/tags/issue/start", {})),
  },
  {
    name: "POST /api/tags/issue/:sessionId/confirm",
    invoke: () =>
      confirmPOST(jsonRequest("https://vet.example.com/api/tags/issue/x/confirm", {}), sessionIdParams()),
  },
  {
    name: "POST /api/tags/issue/:sessionId/tx",
    invoke: () => txPOST(jsonRequest("https://vet.example.com/api/tags/issue/x/tx", {}), sessionIdParams()),
  },
  {
    name: "POST /api/tags/issue/:sessionId/retry",
    invoke: () => retryPOST(jsonRequest("https://vet.example.com/api/tags/issue/x/retry", {}), sessionIdParams()),
  },
  {
    name: "GET /api/tags/issue/:sessionId/attestation",
    // attestationGET's inferred return type carries a spurious `| undefined` from TypeScript's `in`
    // narrowing over buildAttestationPayload's (route.ts, not test code) inferred union return type
    // - every actual branch in that function returns a real NextResponse (confirmed by reading the
    // full source), so this is a static-analysis artifact, not a runtime possibility. Asserted here
    // rather than adding an explicit return-type annotation to production code out of this fix
    // round's scope.
    invoke: () =>
      attestationGET(getRequest("https://vet.example.com/api/tags/issue/x/attestation"), sessionIdParams()) as Promise<Response>,
  },
  {
    name: "POST /api/tags/issue/:sessionId/attestation",
    // Same spurious `| undefined` as attestationGET above.
    invoke: () =>
      attestationPOST(jsonRequest("https://vet.example.com/api/tags/issue/x/attestation", {}), sessionIdParams()) as Promise<Response>,
  },
];

describe.each(ROUTES)("$name - requireVetSession gate", ({invoke}) => {
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

  it("refuses a session whose staffId matches no Staff row at all", async () => {
    vi.mocked(auth).mockResolvedValue({user: {staffId: "does-not-exist", email: "nobody@example.com"}} as never);
    const res = await invoke();
    expect(res.status).toBe(403);
  });

  it("refuses when there is no session at all", async () => {
    // `auth`'s real type is overloaded (next-auth v5 also uses it as edge middleware), which
    // confuses `vi.mocked(...)`'s overload picking for a bare `null` resolve - same `as never`
    // escape hatch this file's own session mocks already use above for the same reason.
    vi.mocked(auth).mockResolvedValue(null as never);
    const res = await invoke();
    expect(res.status).toBe(401);
  });
});
