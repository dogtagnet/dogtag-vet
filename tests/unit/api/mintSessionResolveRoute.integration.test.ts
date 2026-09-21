import {afterAll, afterEach, beforeAll, describe, expect, it} from "vitest";
import mongoose from "mongoose";
import {randomUUID} from "node:crypto";
import {startEphemeralMongod, stopEphemeralMongod, type EphemeralMongod} from "../helpers/ephemeralMongod";
import {connectToDatabase} from "@/lib/db";
import {GET} from "@/app/p/[token]/route";
import {MintSession} from "@/lib/models/MintSession";
import {BindToken, generateHexToken} from "@/lib/models/BindToken";

/**
 * WP4.12V item 4 - `GET /p/:token` (`src/app/p/[token]/route.ts`) is a HAND-WRITTEN object
 * literal: `color`/`registrationId`/`registrationAuthority` only reach the wire because the route
 * explicitly assigns `session.profile.color` etc. A missing passthrough line fails SILENTLY (the
 * key is just absent from the JSON, no error, no type failure - `MintProfile`'s fields are all
 * optional) - so this suite drives the REAL route handler against a REAL ephemeral mongod, not a
 * hand-rolled fixture of what the route is assumed to return, exactly the discipline
 * `exportTagDataFields.integration.test.ts` already established for a sibling hand-written route.
 *
 * Two directions, both load-bearing: PRESENT when the session's profile actually has a value (a
 * fresh session created the normal way), and ABSENT - not merely `undefined` - when it does not,
 * proven two ways: an ordinary session that simply never set these fields, and a genuinely LEGACY
 * MintSession document (a raw `collection.insertOne` bypassing every mongoose default, the exact
 * shape `mintSessionFieldDefaults.test.ts` already established real pre-this-wave documents have -
 * `profile: {weightHistory: []}`, no color/registrationId/registrationAuthority keys at all).
 * `toHaveProperty` (not `toBeUndefined`) is the assertion for absence throughout: a wrongly-written
 * passthrough line (e.g. `color: session.profile.color ?? null`) would still make
 * `body.pet.profile.color === undefined` false today, but `"color" in body.pet.profile` true - only
 * `not.toHaveProperty` catches that.
 *
 * `GET /p/:token` is public (no `@/auth` involved), so unlike the sibling `api/` integration
 * suites this file needs no `vi.mock("@/auth", ...)`.
 *
 * ISOLATION: own ephemeral mongod on a freshly OS-reserved free port (see
 * tests/unit/helpers/ephemeralMongod.ts - each spawn reserves a currently-free port by binding
 * and releasing a throwaway socket, unique across concurrent processes including two whole
 * copies of this suite running at once, and retries on a genuine bind collision, so no fixed
 * port or manual coordination between sibling suites is needed).
 */

let ephemeral: EphemeralMongod;

beforeAll(async () => {
  ephemeral = await startEphemeralMongod("dogtag-vet-resolve-route");
  process.env.MONGODB_URI = ephemeral.uri;
  await connectToDatabase();
  expect(mongoose.connection.host).toBe("127.0.0.1");
  expect(mongoose.connection.port).toBe(ephemeral.port);
  expect(mongoose.connection.name).toBe("dogtag-vet-resolve-route");
}, 90_000);

afterAll(async () => {
  await mongoose.connection.close();
  await stopEphemeralMongod(ephemeral);
});

afterEach(async () => {
  await Promise.all([MintSession.deleteMany({}), BindToken.deleteMany({})]);
});

function resolve(token: string) {
  return GET(new Request(`https://vet.example.com/p/${token}`), {params: Promise.resolve({token})});
}

/** A valid, unconsumed 32-lowercase-hex token bound to `sessionId`, mirroring exactly what
 * `POST /api/tags/issue/start` creates alongside its `MintSession` (`BindToken.create` in that
 * route) - `resolveMintSession`'s stage 1 needs this row to exist before it ever reads the session
 * itself. */
async function seedToken(sessionId: string, now: number): Promise<string> {
  const token = generateHexToken();
  await BindToken.create({token, sessionId, exp: now + 600, consumed: false});
  return token;
}

const NOW = Math.floor(Date.now() / 1000);

describe("GET /p/:token - color/registrationId/registrationAuthority passthrough", () => {
  it("PRESENT: a freshly created session with all three set carries them verbatim in the resolve payload", async () => {
    const session = await MintSession.create({
      sessionId: randomUUID(),
      dogTagIdDec: "1001",
      dogTagIdField: "1001",
      ownerIdentity: {name: "Jane Doe"},
      petName: "Blaze",
      profile: {weightHistory: [], color: "brown", registrationId: "SGP-DOG-0042", registrationAuthority: "AVS Singapore"},
      status: "pending",
      protocolVersion: "dogtag-v2/1",
      tokenExp: NOW + 600,
    });
    const token = await seedToken(session.sessionId, NOW);

    const res = await resolve(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pet.profile.color).toBe("brown");
    expect(body.pet.profile.registrationId).toBe("SGP-DOG-0042");
    expect(body.pet.profile.registrationAuthority).toBe("AVS Singapore");
  });

  it("ABSENT (ordinary case): a fresh session that never set the three fields omits all three keys entirely - not null, not undefined-but-present", async () => {
    const session = await MintSession.create({
      sessionId: randomUUID(),
      dogTagIdDec: "1002",
      dogTagIdField: "1002",
      ownerIdentity: {name: "Jane Doe"},
      petName: "Rex",
      profile: {weightHistory: [], species: "dog"},
      status: "pending",
      protocolVersion: "dogtag-v2/1",
      tokenExp: NOW + 600,
    });
    const token = await seedToken(session.sessionId, NOW);

    const res = await resolve(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Other profile fields still come through fine - this is not a wholesale profile failure.
    expect(body.pet.profile.species).toBe("dog");
    expect(body.pet.profile).not.toHaveProperty("color");
    expect(body.pet.profile).not.toHaveProperty("registrationId");
    expect(body.pet.profile).not.toHaveProperty("registrationAuthority");
  });

  it("ABSENT (legacy document): a raw-inserted pre-WP4.12V MintSession (no color/registrationId/registrationAuthority keys in storage at all) resolves cleanly with all three keys omitted", async () => {
    const sessionId = randomUUID();
    // Bypasses every mongoose default/cast, exactly like mintSessionFieldDefaults.test.ts's own
    // "what minimize actually persists" fixtures and wp47BackCompat.integration.test.ts's raw
    // insert convention - this is what a document written before this wave actually looks like on
    // disk, not what `.create()` would produce today.
    await MintSession.collection.insertOne({
      sessionId,
      dogTagIdDec: "1003",
      dogTagIdField: "1003",
      ownerIdentity: {name: "Jane Doe"},
      identityLeaves: [],
      petName: "Fido",
      microchip: {},
      profile: {weightHistory: []},
      status: "pending",
      protocolVersion: "dogtag-v2/1",
      tokenExp: NOW + 600,
      createdAt: new Date(),
    } as never);
    const token = await seedToken(sessionId, NOW);

    const res = await resolve(token);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pet.name).toBe("Fido");
    expect(body.pet.profile).not.toHaveProperty("color");
    expect(body.pet.profile).not.toHaveProperty("registrationId");
    expect(body.pet.profile).not.toHaveProperty("registrationAuthority");
  });
});
