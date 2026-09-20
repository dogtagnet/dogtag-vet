import {describe, expect, it} from "vitest";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import type {Address, Hex} from "viem";
import {DELEGATION_CLAIM_PRIMARY_TYPE, DELEGATION_CLAIM_TYPES, buildDelegationClaimDomain} from "@/lib/delegation/eip712";
import {registrationIdToHex32} from "@/lib/registration/uuid";
import {
  checkDelegationCapNotReached,
  completeDelegationClaim,
  getDelegationSessionStatusForDevice,
  getStaffDelegationStatus,
  resolveDelegationChallenge,
  DELEGATION_STATUS_GRACE_PERIOD_SECS,
  type DelegationFlowStore,
  type DelegationSessionRow,
} from "@/lib/delegation/flow";

function baseSession(overrides: Partial<DelegationSessionRow> = {}): DelegationSessionRow {
  return {
    token: "a".repeat(32),
    registrationId: "11111111-1111-4111-8111-111111111111",
    kind: "add",
    petId: "pet-1",
    dogTagIdField: "42",
    clientId: "client-1",
    clinic: "0x1111111111111111111111111111111111111111",
    chainId: 135,
    clinicName: "Test Clinic",
    maskedTargetName: "J**",
    issuedAt: 1000,
    blockNumber: 500,
    deadline: 1600,
    status: "pending",
    consumed: false,
    ...overrides,
  };
}

/** In-memory `DelegationFlowStore` - mirrors `tests/unit/registration/flow.test.ts`'s own fake. */
function makeStore(session: DelegationSessionRow, opts: {activeSecondaryClients?: Set<string>} = {}) {
  const sessions = new Map<string, DelegationSessionRow>([[session.token, {...session}]]);
  const byRegistrationId = new Map<string, string>([[session.registrationId, session.token]]);
  const recordedErrors: {token: string; reason: string}[] = [];

  const store: DelegationFlowStore = {
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
    async recordClaim(token, fields) {
      const row = sessions.get(token);
      if (row) {
        row.status = "claimed";
        row.commitment = fields.commitment;
        row.wallet = fields.wallet;
      }
    },
    async recordError(token, reason) {
      const row = sessions.get(token);
      if (row) {
        row.status = "error";
        row.errorReason = reason;
      }
      recordedErrors.push({token, reason});
    },
    async hasActiveSecondaryForClient(_dogTagIdField, clientId) {
      return opts.activeSecondaryClients?.has(clientId) ?? false;
    },
  };
  return {store, sessions, recordedErrors};
}

describe("resolveDelegationChallenge", () => {
  it("404s for an unknown token", async () => {
    const {store} = makeStore(baseSession());
    const result = await resolveDelegationChallenge(store, "b".repeat(32), 1100);
    expect(result).toEqual({ok: false, status: 404});
  });

  it("404s for a kind:revoke session - no public route may ever resolve one", async () => {
    const {store} = makeStore(baseSession({kind: "revoke", status: "claimed", consumed: true, commitment: `0x${"1".repeat(64)}`}));
    const result = await resolveDelegationChallenge(store, "a".repeat(32), 1100);
    expect(result).toEqual({ok: false, status: 404});
  });

  it("410s once consumed", async () => {
    const {store} = makeStore(baseSession({consumed: true, consumedAt: 1100}));
    const result = await resolveDelegationChallenge(store, "a".repeat(32), 1200);
    expect(result).toEqual({ok: false, status: 410});
  });

  it("410s once past deadline, even if never consumed", async () => {
    const {store} = makeStore(baseSession());
    const result = await resolveDelegationChallenge(store, "a".repeat(32), 1700);
    expect(result).toEqual({ok: false, status: 410});
  });

  it("resolves with the remaining ttl", async () => {
    const {store} = makeStore(baseSession());
    const result = await resolveDelegationChallenge(store, "a".repeat(32), 1100);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ttlSecs).toBe(500);
  });
});

describe("completeDelegationClaim", () => {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const commitment = `0x${"22".repeat(32)}` as Hex;

  async function signClaim(session: DelegationSessionRow, wallet: Address = account.address): Promise<string> {
    const domain = buildDelegationClaimDomain(session.chainId, session.clinic as Address);
    const message = {
      clinic: session.clinic as Address,
      dogTagIdField: BigInt(session.dogTagIdField),
      commitment,
      registrationId: registrationIdToHex32(session.registrationId),
      wallet,
      issuedAt: BigInt(session.issuedAt),
      blockNumber: BigInt(session.blockNumber ?? 0),
      deadline: BigInt(session.deadline),
    };
    return account.signTypedData({domain, types: DELEGATION_CLAIM_TYPES, primaryType: DELEGATION_CLAIM_PRIMARY_TYPE, message});
  }

  const alwaysRegistered = async () => true;
  const neverActive = async () => false;

  it("succeeds for a correctly signed claim from a registered wallet, and burns the token", async () => {
    const session = baseSession();
    const {store, sessions} = makeStore(session);
    const signature = await signClaim(session);
    const result = await completeDelegationClaim(
      store,
      {token: session.token, commitment, wallet: account.address, signature},
      1100,
      {isCommitmentActiveOnChain: neverActive, isRegisteredWallet: alwaysRegistered},
    );
    expect(result).toEqual({ok: true, clientId: session.clientId, commitment: commitment.toLowerCase()});
    expect(sessions.get(session.token)?.status).toBe("claimed");
    expect(sessions.get(session.token)?.consumed).toBe(true);
  });

  it("kind:revoke sessions can never be completed through this route", async () => {
    const session = baseSession({kind: "revoke"});
    const {store} = makeStore(session);
    const signature = await signClaim(session);
    const result = await completeDelegationClaim(
      store,
      {token: session.token, commitment, wallet: account.address, signature},
      1100,
      {isCommitmentActiveOnChain: neverActive, isRegisteredWallet: alwaysRegistered},
    );
    expect(result).toEqual({ok: false, code: "not_found"});
  });

  it("signature_invalid when the recovered signer does not match the claimed wallet, and still burns the token", async () => {
    const session = baseSession();
    const {store, sessions} = makeStore(session);
    const signature = await signClaim(session); // signed for account.address
    const otherWallet = "0x9999999999999999999999999999999999999999" as Address;
    const result = await completeDelegationClaim(
      store,
      {token: session.token, commitment, wallet: otherWallet, signature},
      1100,
      {isCommitmentActiveOnChain: neverActive, isRegisteredWallet: alwaysRegistered},
    );
    expect(result).toEqual({ok: false, code: "signature_invalid"});
    expect(sessions.get(session.token)?.consumed).toBe(true); // burned even on failure
  });

  it("signature_invalid when the wallet is not registered to the target client (authorization, not just integrity)", async () => {
    const session = baseSession();
    const {store} = makeStore(session);
    const signature = await signClaim(session);
    const result = await completeDelegationClaim(
      store,
      {token: session.token, commitment, wallet: account.address, signature},
      1100,
      {isCommitmentActiveOnChain: neverActive, isRegisteredWallet: async () => false},
    );
    expect(result).toEqual({ok: false, code: "signature_invalid"});
  });

  it("already_secondary when this exact commitment is already active on chain", async () => {
    const session = baseSession();
    const {store} = makeStore(session);
    const signature = await signClaim(session);
    const result = await completeDelegationClaim(
      store,
      {token: session.token, commitment, wallet: account.address, signature},
      1100,
      {isCommitmentActiveOnChain: async () => true, isRegisteredWallet: alwaysRegistered},
    );
    expect(result).toEqual({ok: false, code: "already_secondary"});
  });

  it("already_secondary when this CLIENT already has a different active commitment on this tag", async () => {
    const session = baseSession();
    const {store} = makeStore(session, {activeSecondaryClients: new Set([session.clientId])});
    const signature = await signClaim(session);
    const result = await completeDelegationClaim(
      store,
      {token: session.token, commitment, wallet: account.address, signature},
      1100,
      {isCommitmentActiveOnChain: neverActive, isRegisteredWallet: alwaysRegistered},
    );
    expect(result).toEqual({ok: false, code: "already_secondary"});
  });

  it("expired_or_reused for an already-consumed token - no retry", async () => {
    const session = baseSession({consumed: true, consumedAt: 1050});
    const {store} = makeStore(session);
    const signature = await signClaim(session);
    const result = await completeDelegationClaim(
      store,
      {token: session.token, commitment, wallet: account.address, signature},
      1100,
      {isCommitmentActiveOnChain: neverActive, isRegisteredWallet: alwaysRegistered},
    );
    expect(result).toEqual({ok: false, code: "expired_or_reused"});
  });
});

describe("getDelegationSessionStatusForDevice (public wire vocabulary)", () => {
  it("maps internal submitting/confirmed to the wire's adding/added", async () => {
    const submitting = makeStore(baseSession({status: "submitting", consumed: true, consumedAt: 1050})).store;
    const confirmed = makeStore(baseSession({status: "confirmed", consumed: true, consumedAt: 1050})).store;
    const r1 = await getDelegationSessionStatusForDevice(submitting, "a".repeat(32), 1100);
    const r2 = await getDelegationSessionStatusForDevice(confirmed, "a".repeat(32), 1100);
    expect(r1).toMatchObject({ok: true, status: "adding"});
    expect(r2).toMatchObject({ok: true, status: "added", readyForBundle: true});
  });

  it("never persists the wire word 'added' internally - the stored status stays 'confirmed'", async () => {
    const {store, sessions} = makeStore(baseSession({status: "confirmed", consumed: true, consumedAt: 1050}));
    await getDelegationSessionStatusForDevice(store, "a".repeat(32), 1100);
    expect(sessions.get("a".repeat(32))?.status).toBe("confirmed");
  });

  it("keeps answering within the grace period after consumption, then 410s", async () => {
    const {store} = makeStore(baseSession({status: "confirmed", consumed: true, consumedAt: 1050}));
    const withinGrace = await getDelegationSessionStatusForDevice(store, "a".repeat(32), 1050 + DELEGATION_STATUS_GRACE_PERIOD_SECS - 1);
    const pastGrace = await getDelegationSessionStatusForDevice(store, "a".repeat(32), 1050 + DELEGATION_STATUS_GRACE_PERIOD_SECS + 1);
    expect(withinGrace.ok).toBe(true);
    expect(pastGrace).toEqual({ok: false, status: 410});
  });

  it("410s a never-claimed session past its deadline with no grace at all", async () => {
    const {store} = makeStore(baseSession({deadline: 1600}));
    const result = await getDelegationSessionStatusForDevice(store, "a".repeat(32), 1601);
    expect(result).toEqual({ok: false, status: 410});
  });

  it("surfaces the error reason only on status error", async () => {
    const {store} = makeStore(baseSession({status: "error", errorReason: "bad signature", consumed: true, consumedAt: 1050}));
    const result = await getDelegationSessionStatusForDevice(store, "a".repeat(32), 1100);
    expect(result).toMatchObject({ok: true, status: "error", reason: "bad signature"});
  });
});

describe("getStaffDelegationStatus", () => {
  it("serves both kinds and the full internal status, scoped to the pet", async () => {
    const session = baseSession({kind: "revoke", status: "submitting", txHash: `0x${"a".repeat(64)}`});
    const {store} = makeStore(session);
    const result = await getStaffDelegationStatus(store, "pet-1", session.registrationId);
    expect(result).toEqual({ok: true, status: {kind: "revoke", status: "submitting", errorReason: undefined, txHash: session.txHash, commitment: undefined}});
  });

  it("404s when the registrationId belongs to a different pet", async () => {
    const session = baseSession();
    const {store} = makeStore(session);
    const result = await getStaffDelegationStatus(store, "some-other-pet", session.registrationId);
    expect(result).toEqual({ok: false, status: 404});
  });
});

describe("checkDelegationCapNotReached", () => {
  it("ok when under the cap", async () => {
    const result = await checkDelegationCapNotReached("42", async () => 3);
    expect(result).toEqual({ok: true});
  });

  it("refuses at the cap (11)", async () => {
    const result = await checkDelegationCapNotReached("42", async () => 11);
    expect(result.ok).toBe(false);
  });

  it("fails closed when the chain is unreadable", async () => {
    const result = await checkDelegationCapNotReached("42", async () => {
      throw new Error("rpc down");
    });
    expect(result.ok).toBe(false);
  });
});
