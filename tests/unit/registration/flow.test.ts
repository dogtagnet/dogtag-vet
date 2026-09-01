import {describe, expect, it} from "vitest";
import {privateKeyToAccount, generatePrivateKey} from "viem/accounts";
import type {Address, Hex} from "viem";
import {
  CLIENT_REGISTRATION_PRIMARY_TYPE,
  CLIENT_REGISTRATION_TYPES,
  buildClientRegistrationDomain,
} from "@/lib/registration/eip712";
import {registrationIdToHex32} from "@/lib/registration/uuid";
import {
  STATUS_GRACE_PERIOD_SECS,
  completeRegistration,
  getRegistrationSessionStatus,
  resolveRegistrationChallenge,
  type AppendWalletInput,
  type RegistrationFlowStore,
  type RegistrationSessionRow,
} from "@/lib/registration/flow";

/**
 * In-memory `RegistrationFlowStore` - no live database, matching
 * `tests/unit/mintFlow.integration.test.ts`'s convention of exercising the pure flow logic
 * against a hand-rolled fake. `findClientWalletByRegistrationId` reads back from the SAME
 * `walletsByClient` map `appendWalletToClient` writes to - `getRegistrationSessionStatus`'s
 * "registered" status is derived from the wallet actually being on the client, never from a
 * redundant flag on the session row that could drift out of sync with a real append.
 */
function makeStore(session: RegistrationSessionRow, existingClientIds: string[] = [session.clientId]) {
  const sessions = new Map<string, RegistrationSessionRow>([[session.token, {...session}]]);
  const byRegistrationId = new Map<string, string>([[session.registrationId, session.token]]);
  const clientsExist = new Set<string>(existingClientIds);
  const walletsByClient = new Map<string, {address: string; registrationId: string}[]>();

  const store: RegistrationFlowStore = {
    async getByToken(token) {
      const row = sessions.get(token);
      return row ? {...row} : null;
    },
    async getByRegistrationId(registrationId) {
      const token = byRegistrationId.get(registrationId);
      if (!token) return null;
      const row = sessions.get(token);
      return row ? {...row} : null;
    },
    async tryConsume(token, now) {
      const row = sessions.get(token);
      if (!row || row.consumed) return false;
      row.consumed = true;
      row.consumedAt = now;
      return true;
    },
    async appendWalletToClient(clientId, entry) {
      if (!clientsExist.has(clientId)) return "not_found";
      const existing = walletsByClient.get(clientId) ?? [];
      if (existing.some((w) => w.address === entry.address)) return "already_registered";
      walletsByClient.set(clientId, [...existing, {address: entry.address, registrationId: entry.registrationId}]);
      return "ok";
    },
    async findClientWalletByRegistrationId(clientId, registrationId) {
      const found = (walletsByClient.get(clientId) ?? []).find((w) => w.registrationId === registrationId);
      return found ? {address: found.address} : null;
    },
    async recordOutcome(token, outcome) {
      const row = sessions.get(token);
      if (row) row.outcome = outcome;
    },
  };
  return {store, sessions, walletsByClient};
}

const NOW = 1_735_689_600;

function newSessionFixture(overrides?: Partial<RegistrationSessionRow>): RegistrationSessionRow {
  return {
    token: "a".repeat(32),
    registrationId: "8fd81415-a95c-9b04-c6f9-08ec7d0bcf3a",
    clientId: "client-1",
    clinic: "0x7b9bf16f0e39adf8c38d8491f4c7e9c17e85d703",
    chainId: 135,
    clinicName: "Example Vet Clinic",
    maskedClientName: "J****** A******",
    clientHash: `0x${"ab".repeat(32)}` as Hex,
    issuedAt: NOW,
    blockNumber: 42,
    deadline: NOW + 600,
    consumed: false,
    ...overrides,
  };
}

/** Signs the EXACT struct `completeRegistration` will independently rebuild from `session` - a
 * real key, real `signTypedData`, no fakes anywhere in the crypto path. */
async function signFor(session: RegistrationSessionRow, account: ReturnType<typeof privateKeyToAccount>, walletOverride?: Address) {
  const domain = buildClientRegistrationDomain(session.chainId, session.clinic as Address);
  const message = {
    clinic: session.clinic as Address,
    clientHash: session.clientHash as Hex,
    registrationId: registrationIdToHex32(session.registrationId),
    wallet: walletOverride ?? account.address,
    issuedAt: BigInt(session.issuedAt),
    blockNumber: BigInt(session.blockNumber),
    deadline: BigInt(session.deadline),
  };
  const signature = await account.signTypedData({domain, types: CLIENT_REGISTRATION_TYPES, primaryType: CLIENT_REGISTRATION_PRIMARY_TYPE, message});
  return {wallet: walletOverride ?? account.address, signature};
}

describe("resolveRegistrationChallenge (GET /w/:token)", () => {
  it("resolves an open session with the remaining ttlSecs", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const result = await resolveRegistrationChallenge(store, session.token, NOW + 100);
    expect(result).toEqual({ok: true, session, ttlSecs: 500});
  });

  it("404s for an unknown token", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const result = await resolveRegistrationChallenge(store, "unknown-token", NOW);
    expect(result).toEqual({ok: false, status: 404});
  });

  it("410s once naturally expired", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const result = await resolveRegistrationChallenge(store, session.token, session.deadline + 1);
    expect(result).toEqual({ok: false, status: 410});
  });

  it("410s IMMEDIATELY once consumed - no grace window for the challenge itself, unlike the staff status poll", async () => {
    const session = newSessionFixture({consumed: true, consumedAt: NOW});
    const {store} = makeStore(session);
    const result = await resolveRegistrationChallenge(store, session.token, NOW + 1); // 1 second after consuming, well within any grace window
    expect(result).toEqual({ok: false, status: 410});
  });
});

describe("completeRegistration (POST /w/:token/complete)", () => {
  it("happy path: real signature, recovered wallet appended to the client, receiptHash returned", async () => {
    const session = newSessionFixture();
    const {store, walletsByClient} = makeStore(session);
    const account = privateKeyToAccount(generatePrivateKey());
    const {wallet, signature} = await signFor(session, account);

    const result = await completeRegistration(store, {token: session.token, wallet, signature}, NOW + 5);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.wallet).toBe(wallet.toLowerCase());
    expect(result.clientId).toBe(session.clientId);
    expect(result.receiptHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(walletsByClient.get(session.clientId)).toEqual([{address: wallet.toLowerCase(), registrationId: session.registrationId}]);
  });

  it("not_found for an unknown token", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const account = privateKeyToAccount(generatePrivateKey());
    const {wallet, signature} = await signFor(session, account);
    const result = await completeRegistration(store, {token: "unknown", wallet, signature}, NOW + 5);
    expect(result).toEqual({ok: false, code: "not_found"});
  });

  it("expired_or_reused for a token that was never consumed and simply expired", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const account = privateKeyToAccount(generatePrivateKey());
    const {wallet, signature} = await signFor(session, account);
    const result = await completeRegistration(store, {token: session.token, wallet, signature}, session.deadline + 1);
    expect(result).toEqual({ok: false, code: "expired_or_reused"});
  });

  it("expired_or_reused on a SECOND completion attempt against an already-consumed token, even with a fresh valid signature", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const first = privateKeyToAccount(generatePrivateKey());
    const firstSig = await signFor(session, first);
    const ok = await completeRegistration(store, {token: session.token, ...firstSig}, NOW + 5);
    expect(ok.ok).toBe(true);

    const second = privateKeyToAccount(generatePrivateKey());
    const secondSig = await signFor(session, second);
    const result = await completeRegistration(store, {token: session.token, ...secondSig}, NOW + 6);
    expect(result).toEqual({ok: false, code: "expired_or_reused"});
  });

  it("signature_invalid when the signature was produced by a different key than the claimed wallet", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const signer = privateKeyToAccount(generatePrivateKey());
    const claimedWallet = privateKeyToAccount(generatePrivateKey()).address; // not the signer
    const {signature} = await signFor(session, signer, claimedWallet);

    const result = await completeRegistration(store, {token: session.token, wallet: claimedWallet, signature}, NOW + 5);
    expect(result).toEqual({ok: false, code: "signature_invalid"});
  });

  it("signature_invalid for a structurally malformed signature (recoverTypedDataAddress throws)", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    const result = await completeRegistration(store, {token: session.token, wallet, signature: `0x${"00".repeat(65)}`}, NOW + 5);
    expect(result).toEqual({ok: false, code: "signature_invalid"});
  });

  it("signature_invalid burns the token - a retry against the same token after a bad signature is expired_or_reused, not a second chance", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    const bad = await completeRegistration(store, {token: session.token, wallet, signature: `0x${"00".repeat(65)}`}, NOW + 5);
    expect(bad).toEqual({ok: false, code: "signature_invalid"});

    const account = privateKeyToAccount(generatePrivateKey());
    const goodSig = await signFor(session, account);
    const retry = await completeRegistration(store, {token: session.token, ...goodSig}, NOW + 6);
    expect(retry).toEqual({ok: false, code: "expired_or_reused"});
  });

  it("already_registered (409) when this wallet is already on the client - no new receipt is appended", async () => {
    const session = newSessionFixture();
    const {store, walletsByClient} = makeStore(session);
    const account = privateKeyToAccount(generatePrivateKey());
    walletsByClient.set(session.clientId, [{address: account.address.toLowerCase(), registrationId: "some-other-registration"}]);

    const {wallet, signature} = await signFor(session, account);
    const result = await completeRegistration(store, {token: session.token, wallet, signature}, NOW + 5);
    expect(result).toEqual({ok: false, code: "already_registered"});
    expect(walletsByClient.get(session.clientId)).toHaveLength(1); // unchanged
  });

  it("not_found if the client itself no longer exists at completion time", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session, []); // client does not exist
    const account = privateKeyToAccount(generatePrivateKey());
    const {wallet, signature} = await signFor(session, account);
    const result = await completeRegistration(store, {token: session.token, wallet, signature}, NOW + 5);
    expect(result).toEqual({ok: false, code: "not_found"});
  });

  it("WP4.5 track3-sig: persists outcome 'registered' on the session row after a successful completion", async () => {
    const session = newSessionFixture();
    const {store, sessions} = makeStore(session);
    const account = privateKeyToAccount(generatePrivateKey());
    const {wallet, signature} = await signFor(session, account);
    const result = await completeRegistration(store, {token: session.token, wallet, signature}, NOW + 5);
    expect(result.ok).toBe(true);
    expect(sessions.get(session.token)?.outcome).toBe("registered");
  });

  it("WP4.5 track3-sig: persists outcome 'signature_invalid' when the signature does not recover to the claimed wallet", async () => {
    const session = newSessionFixture();
    const {store, sessions} = makeStore(session);
    const signer = privateKeyToAccount(generatePrivateKey());
    const claimedWallet = privateKeyToAccount(generatePrivateKey()).address;
    const {signature} = await signFor(session, signer, claimedWallet);
    await completeRegistration(store, {token: session.token, wallet: claimedWallet, signature}, NOW + 5);
    expect(sessions.get(session.token)?.outcome).toBe("signature_invalid");
  });

  it("WP4.5 track3-sig: persists outcome 'signature_invalid' for a structurally malformed signature too", async () => {
    const session = newSessionFixture();
    const {store, sessions} = makeStore(session);
    const wallet = privateKeyToAccount(generatePrivateKey()).address;
    await completeRegistration(store, {token: session.token, wallet, signature: `0x${"00".repeat(65)}`}, NOW + 5);
    expect(sessions.get(session.token)?.outcome).toBe("signature_invalid");
  });

  it("WP4.5 track3-sig: does NOT persist an outcome for already_registered - that is not a signature problem, and no new outcome should overwrite whatever this session's own outcome already was", async () => {
    const session = newSessionFixture();
    const {store, walletsByClient, sessions} = makeStore(session);
    const account = privateKeyToAccount(generatePrivateKey());
    walletsByClient.set(session.clientId, [{address: account.address.toLowerCase(), registrationId: "some-other-registration"}]);
    const {wallet, signature} = await signFor(session, account);
    const result = await completeRegistration(store, {token: session.token, wallet, signature}, NOW + 5);
    expect(result).toEqual({ok: false, code: "already_registered"});
    expect(sessions.get(session.token)?.outcome).toBeUndefined();
  });

  it("WP4.5 track3-sig: a recordOutcome failure never changes completeRegistration's own return value (best-effort only)", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    store.recordOutcome = async () => {
      throw new Error("simulated write failure");
    };
    const account = privateKeyToAccount(generatePrivateKey());
    const {wallet, signature} = await signFor(session, account);
    const result = await completeRegistration(store, {token: session.token, wallet, signature}, NOW + 5);
    expect(result.ok).toBe(true);
  });

  it("a lost tryConsume race (concurrent completion already won) is expired_or_reused, never double-appends", async () => {
    const session = newSessionFixture();
    const {store, walletsByClient} = makeStore(session);
    const originalTryConsume = store.tryConsume.bind(store);
    let calls = 0;
    store.tryConsume = async (token, now) => {
      calls++;
      if (calls === 1) {
        await originalTryConsume(token, now); // a "concurrent" request wins the race first
        return false; // but THIS call loses it
      }
      return originalTryConsume(token, now);
    };
    const account = privateKeyToAccount(generatePrivateKey());
    const {wallet, signature} = await signFor(session, account);
    const result = await completeRegistration(store, {token: session.token, wallet, signature}, NOW + 5);
    expect(result).toEqual({ok: false, code: "expired_or_reused"});
    expect(walletsByClient.get(session.clientId) ?? []).toHaveLength(0);
  });
});

describe("getRegistrationSessionStatus (staff poll)", () => {
  it("404s for an unknown registrationId", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const result = await getRegistrationSessionStatus(store, session.clientId, "unknown-registration-id", NOW);
    expect(result).toEqual({ok: false, status: 404});
  });

  it("404s when the registrationId resolves to a DIFFERENT client - never leaks status across clients", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const result = await getRegistrationSessionStatus(store, "some-other-client-id", session.registrationId, NOW);
    expect(result).toEqual({ok: false, status: 404});
  });

  it("waiting: not yet consumed, not yet expired", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const result = await getRegistrationSessionStatus(store, session.clientId, session.registrationId, NOW + 100);
    expect(result).toEqual({ok: true, status: "waiting"});
  });

  it("expired: never consumed, past the deadline", async () => {
    const session = newSessionFixture();
    const {store} = makeStore(session);
    const result = await getRegistrationSessionStatus(store, session.clientId, session.registrationId, session.deadline + 1);
    expect(result).toEqual({ok: true, status: "expired"});
  });

  it("registered: consumed AND the wallet is actually on the client (derived from the client record, not a redundant flag)", async () => {
    const session = newSessionFixture({consumed: true, consumedAt: NOW});
    const {store, walletsByClient} = makeStore(session);
    walletsByClient.set(session.clientId, [{address: "0x1111111111111111111111111111111111111111", registrationId: session.registrationId}]);
    const result = await getRegistrationSessionStatus(store, session.clientId, session.registrationId, NOW + 10);
    expect(result).toEqual({ok: true, status: "registered", wallet: "0x1111111111111111111111111111111111111111"});
  });

  it("failed: consumed, no matching wallet on the client (a bad-signature attempt burned it), still within the grace window", async () => {
    const session = newSessionFixture({consumed: true, consumedAt: NOW});
    const {store} = makeStore(session);
    const result = await getRegistrationSessionStatus(store, session.clientId, session.registrationId, NOW + 10);
    expect(result).toEqual({ok: true, status: "failed"});
  });

  it("WP4.5 track3-sig: failed WITH outcome signature_invalid when that was recorded - the one case that earns the accusation", async () => {
    const session = newSessionFixture({consumed: true, consumedAt: NOW, outcome: "signature_invalid"});
    const {store} = makeStore(session);
    const result = await getRegistrationSessionStatus(store, session.clientId, session.registrationId, NOW + 10);
    expect(result).toEqual({ok: true, status: "failed", outcome: "signature_invalid"});
  });

  it("WP4.5 track3-sig: failed with NO outcome field at all when none was ever recorded (backward-safe - a session from before this field existed, or a recording failure) - never silently implies signature_invalid", async () => {
    const session = newSessionFixture({consumed: true, consumedAt: NOW});
    const {store} = makeStore(session);
    const result = await getRegistrationSessionStatus(store, session.clientId, session.registrationId, NOW + 10);
    expect(result).toEqual({ok: true, status: "failed"});
    expect("outcome" in result && result.outcome).toBeFalsy();
  });

  it("expired: consumed, no matching wallet, and past the post-consume grace window - the session is now simply gone", async () => {
    const session = newSessionFixture({consumed: true, consumedAt: NOW});
    const {store} = makeStore(session);
    const result = await getRegistrationSessionStatus(store, session.clientId, session.registrationId, NOW + STATUS_GRACE_PERIOD_SECS + 1);
    expect(result).toEqual({ok: true, status: "expired"});
  });

  it("still reports registered within the grace window even after it would otherwise read as past-grace - a successful registration is never demoted to expired", async () => {
    const session = newSessionFixture({consumed: true, consumedAt: NOW});
    const {store, walletsByClient} = makeStore(session);
    walletsByClient.set(session.clientId, [{address: "0x2222222222222222222222222222222222222222", registrationId: session.registrationId}]);
    const result = await getRegistrationSessionStatus(store, session.clientId, session.registrationId, NOW + STATUS_GRACE_PERIOD_SECS + 1000);
    expect(result).toEqual({ok: true, status: "registered", wallet: "0x2222222222222222222222222222222222222222"});
  });
});

describe("AppendWalletInput shape sanity", () => {
  it("is structurally what a mongo adapter would push into Client.wallets[] (compile-time check only)", () => {
    const input: AppendWalletInput = {
      address: "0x1111111111111111111111111111111111111111",
      registrationId: "reg-1",
      receipt: {payloadJson: "{}", signature: "0x00", recoveredAt: 0},
      receiptHash: `0x${"00".repeat(32)}`,
      issuedAt: 0,
      blockNumber: 0,
      registeredAt: 0,
    };
    expect(input.address).toBeTruthy();
  });
});
