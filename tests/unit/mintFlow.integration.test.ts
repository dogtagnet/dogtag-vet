import {randomBytes} from "node:crypto";
import {describe, expect, it} from "vitest";
import {
  TypeTag,
  buildMerkle,
  dogTagIdField,
  fromHex32,
  hashLeaf,
  toHex32,
  type OpenedLeaf,
} from "@dogtag/standard";
import {
  custodialBind,
  resolveMintSession,
  type MintFlowStore,
  type MintSessionRow,
  type MintTokenRow,
} from "@/lib/mint/flow";
import {buildIdentityLeaves} from "@/lib/mint/identityLeaves";
import {allocateDogTagId} from "@/lib/mint/allocate";

/**
 * In-memory `MintFlowStore` - no live database, matching `tests/unit/book.concurrency.test.ts`'s
 * convention of exercising the pure flow logic against a hand-rolled fake rather than a real
 * mongoose connection.
 */
function makeStore(session: MintSessionRow, token: MintTokenRow) {
  const sessions = new Map<string, MintSessionRow>([[session.sessionId, session]]);
  const tokens = new Map<string, MintTokenRow>([[token.token, {...token}]]);
  const firstResolvedFor = new Set<string>();

  const store: MintFlowStore = {
    async getToken(t) {
      const row = tokens.get(t);
      return row ? {...row} : null;
    },
    async getSession(sessionId) {
      const row = sessions.get(sessionId);
      return row ? {...row} : null;
    },
    async extendTtlOnFirstResolve(t, _now, minExp) {
      const row = tokens.get(t.token)!;
      if (!firstResolvedFor.has(t.sessionId)) {
        firstResolvedFor.add(t.sessionId);
        row.exp = Math.max(row.exp, minExp);
      }
      return row.exp;
    },
    async tryConsumeToken(t, now) {
      const row = tokens.get(t);
      if (!row || row.consumed) return false;
      row.consumed = true;
      row.consumedAt = now;
      return true;
    },
    async commitReady(session, result) {
      const row = sessions.get(session.sessionId)!;
      row.status = "ready";
      row.root = result.root;
    },
    async markError(sessionId, stage) {
      const row = sessions.get(sessionId)!;
      row.status = "error";
      row.errorStage = stage;
    },
  };
  return {store, sessions, tokens};
}

/** Builds the reserved owner-control leaf hashes exactly the way the phone does: opaque hashes
 * the vet can never recompute (they commit to owner secrets that never leave the device). Content
 * doesn't matter for this test - only that they are valid `0x..` 32-byte hex. */
function fakeReservedLeafHashes(): string[] {
  return [0, 1, 2].map((i) =>
    toHex32(hashLeaf(`owner.reserved.${i}`, randomBytes(16), {tag: TypeTag.Bytes, value: randomBytes(8)})),
  );
}

/** Simulates the owner's device: folds the vet-attested identity leaves it received from
 * `GET /p/:token` plus one ordinary attribute leaf into a tree using `@dogtag/standard` exactly as
 * the mobile app would, and returns the posted `custodial-bind` body. */
function deviceBuildBindRequest(token: string, identityLeaves: OpenedLeaf[], petNameValue: string) {
  const reservedLeafHashes = fakeReservedLeafHashes();
  const attributeLeaf: OpenedLeaf = {
    keyPath: "credentialSubject.name",
    saltHex: `0x${randomBytes(16).toString("hex")}`,
    tag: TypeTag.String,
    value: petNameValue,
  };
  const leaves = [...identityLeaves, attributeLeaf];
  // Every leaf in this test fixture is TypeTag.String, so the recompute below can hardcode that
  // arm of `TypedScalar` rather than threading a generic (and type-unsafe) `{tag, value}` through.
  const leafHashes = leaves.map((l) => hashLeaf(l.keyPath, Buffer.from(l.saltHex.slice(2), "hex"), {tag: TypeTag.String, value: l.value}));
  const reservedFields = reservedLeafHashes.map(fromHex32);
  const {root} = buildMerkle([...reservedFields, ...leafHashes]);
  return {token, root: toHex32(root), leaves, reservedLeafHashes};
}

function newSessionFixture(): {session: MintSessionRow; token: MintTokenRow; identityLeaves: OpenedLeaf[]} {
  const dogTagIdDec = "42";
  const identityLeaves = buildIdentityLeaves({
    name: "Jordan Alvarez",
    countryOfIdentification: "US",
    identification: "P1234567",
  });
  const session: MintSessionRow = {
    sessionId: "session-1",
    dogTagIdDec,
    dogTagIdFieldDec: dogTagIdField(dogTagIdDec).toString(),
    ownerIdentity: {name: "Jordan Alvarez", countryOfIdentification: "US", identification: "P1234567"},
    identityLeaves,
    petName: "Biscuit",
    microchip: {},
    profile: {weightHistory: []},
    status: "pending",
  };
  const token: MintTokenRow = {
    token: randomBytes(16).toString("hex"),
    sessionId: session.sessionId,
    exp: Math.floor(Date.now() / 1000) + 600,
    consumed: false,
  };
  return {session, token, identityLeaves};
}

describe("mint flow integration (mocked chain reads, no live database)", () => {
  it("full bind round trip: start -> resolve -> device build -> custodial-bind -> ready", async () => {
    const {session, token, identityLeaves} = newSessionFixture();
    const {store} = makeStore(session, token);
    const now = Math.floor(Date.now() / 1000);

    const resolved = await resolveMintSession(store, token.token, now);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error("unreachable");
    expect(resolved.session.identityLeaves).toEqual(identityLeaves);

    const bindRequest = deviceBuildBindRequest(token.token, resolved.session.identityLeaves, session.petName);

    let chainReadCount = 0;
    const isRootStillUnset = async () => {
      chainReadCount++;
      return true; // mocked chain read: never issued before
    };

    const result = await custodialBind(store, bindRequest, now, isRootStillUnset);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.session.status).toBe("ready");
    expect(result.session.root).toBe(bindRequest.root);
    expect(chainReadCount).toBe(1);
  });

  it("rejects a tampered identity leaf with errorStage attestation", async () => {
    const {session, token, identityLeaves} = newSessionFixture();
    const {store, sessions} = makeStore(session, token);
    const now = Math.floor(Date.now() / 1000);

    const tampered = identityLeaves.map((l, i) => (i === 0 ? {...l, value: "Someone Else"} : l));
    const bindRequest = deviceBuildBindRequest(token.token, tampered, session.petName);

    const result = await custodialBind(store, bindRequest, now, async () => true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("leaf_commitment_invalid");
    expect(sessions.get(session.sessionId)?.status).toBe("error");
    expect(sessions.get(session.sessionId)?.errorStage).toBe("attestation");
  });

  it("second bind against the same token is rejected 409 already_bound with the dogTagId (per vet-public-api.yaml)", async () => {
    const {session, token, identityLeaves} = newSessionFixture();
    const {store} = makeStore(session, token);
    const now = Math.floor(Date.now() / 1000);

    const bindRequest = deviceBuildBindRequest(token.token, identityLeaves, session.petName);
    const first = await custodialBind(store, bindRequest, now, async () => true);
    expect(first.ok).toBe(true);

    const second = await custodialBind(store, bindRequest, now, async () => true);
    expect(second.ok).toBe(false);
    if (second.ok || second.code !== "already_bound") throw new Error("unreachable");
    expect(second.dogTagIdDec).toBe(session.dogTagIdDec);
  });

  it("a token that was never consumed and simply expired is rejected 410", async () => {
    const {session, token, identityLeaves} = newSessionFixture();
    const {store} = makeStore(session, {...token, exp: Math.floor(Date.now() / 1000) - 1});
    const now = Math.floor(Date.now() / 1000);

    const bindRequest = deviceBuildBindRequest(token.token, identityLeaves, session.petName);
    const result = await custodialBind(store, bindRequest, now, async () => true);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("expired_or_reused");
  });

  it("rejects the bind (seal conflict) when the chain now reports the root as already set", async () => {
    const {session, token, identityLeaves} = newSessionFixture();
    const {store, sessions} = makeStore(session, token);
    const now = Math.floor(Date.now() / 1000);
    const bindRequest = deviceBuildBindRequest(token.token, identityLeaves, session.petName);

    const result = await custodialBind(store, bindRequest, now, async () => false);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("seal_conflict");
    expect(sessions.get(session.sessionId)?.errorStage).toBe("seal");
  });

  it("a transient chain-read failure during the seal re-check never escapes uncaught, and leaves the session error/retryable rather than wedged pending", async () => {
    // Regression test for the round-4 finding: `isRootStillUnset` (`chainRead.ts`) is deliberately
    // fail-closed and THROWS on an RPC failure rather than resolving to a guess. The token is
    // already consumed by the time this call runs, so a bare rethrow used to escape `custodialBind`
    // entirely, past both `markError` calls, leaving the session at `pending` forever with its one
    // bind token burned - un-retryable (`/retry` only accepts `status: "error"`) and unrecoverable.
    const {session, token, identityLeaves} = newSessionFixture();
    const {store, sessions, tokens} = makeStore(session, token);
    const now = Math.floor(Date.now() / 1000);
    const bindRequest = deviceBuildBindRequest(token.token, identityLeaves, session.petName);

    const isRootStillUnset = async () => {
      throw new Error("ECONNREFUSED: RPC endpoint unreachable");
    };

    const result = await custodialBind(store, bindRequest, now, isRootStillUnset);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("transient_error");

    // The token was already (correctly) consumed before the failing read - that part of the
    // fail-closed contract ("a second bind against this token is always rejected") is unaffected.
    expect(tokens.get(token.token)?.consumed).toBe(true);
    // But the SESSION - unlike before this fix - is left in a state the owner and the operator can
    // both actually recover from: `error`/`seal` is immediately eligible for
    // `/api/tags/issue/:sessionId/retry`, which mints a fresh token against the same dogTagId.
    expect(sessions.get(session.sessionId)?.status).toBe("error");
    expect(sessions.get(session.sessionId)?.errorStage).toBe("seal");
  });
});

describe("dogTagId allocation (fail-closed)", () => {
  it("accepts the first handle whose on-chain root reads as unset", async () => {
    let calls = 0;
    const result = await allocateDogTagId({
      nextHandle: async () => String(++calls),
      isRootUnset: async () => true,
    });
    expect(result).toEqual({ok: true, dogTagIdDec: "1", dogTagIdFieldDec: dogTagIdField("1").toString(), attempts: 1});
  });

  it("skips a burnt handle whose root already reads as set, and never reuses it", async () => {
    let calls = 0;
    const seenUnset: string[] = [];
    const result = await allocateDogTagId({
      nextHandle: async () => String(++calls),
      isRootUnset: async (fieldDec) => {
        seenUnset.push(fieldDec);
        return calls >= 3; // handles 1 and 2 are already burnt, 3 is free
      },
    });
    expect(result).toEqual({ok: true, dogTagIdDec: "3", dogTagIdFieldDec: dogTagIdField("3").toString(), attempts: 3});
    expect(seenUnset).toEqual([dogTagIdField("1").toString(), dogTagIdField("2").toString(), dogTagIdField("3").toString()]);
  });

  it("refuses the whole request when the chain is unreadable, never guessing 'unset'", async () => {
    let calls = 0;
    await expect(
      allocateDogTagId({
        nextHandle: async () => String(++calls),
        isRootUnset: async () => {
          throw new Error("RPC timeout");
        },
      }),
    ).rejects.toThrow("RPC timeout");
    expect(calls).toBe(1); // never falls through to a second attempt on an unreadable chain
  });

  it("gives up after the 256-attempt cap rather than looping forever", async () => {
    let calls = 0;
    const result = await allocateDogTagId({
      nextHandle: async () => String(++calls),
      isRootUnset: async () => false, // every handle already burnt
    });
    expect(result).toEqual({ok: false, reason: "exhausted", attempts: 256});
    expect(calls).toBe(256);
  });
});
