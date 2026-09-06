// Unit coverage for the `verify()` orchestration (verify.ts) - the fail-closed TS mirror of the
// Rust `dogtag-standard-rs::verify` tests (impl §11.3, C7). `MockChain` is address-keyed (never
// ignores which contract it is asked of) so a forged-issuer test can actually distinguish "the real
// clone says X" from "the hostile contract says Y" - see the TERM 1-6 sweep below, one test per
// term of the anchor/whitelist/store-agreement design.
import {describe, it, expect} from "vitest";
import {TypeTag, wrapDocument, type IssuerMeta} from "../src/index.js";
import {
  checkIntegrity,
  grantInForceAt,
  recordTypeKey,
  verify,
  type DnsAdapter,
  type RegistryAdapter,
  type RpcAdapter,
  type VerifyOpts,
} from "../src/verify.js";
import type {GrantAtIssuance, GrantEvent, IssuerAnchor, LogPoint, WrappedDoc} from "../src/types.js";

/** A fresh `IssuerMeta` per call - `wrapDocument` stores this object by reference, and several
 * tests below mutate `doc.issuer.*` in place to model a forged claim, so sharing one instance
 * across tests would let an earlier mutation leak into every later test's "genuine" document. */
function freshIssuer(): IssuerMeta {
  return {
    name: "Seaport Animal Hospital",
    domain: "vet.seaport.example",
    documentStore: "0x0000000000000000000000000000000000000001", // == CLONE below
    recordType: "VACCINATION",
  };
}

const OWNER = "0xabc0000000000000000000000000000000000abc";
/** The clone the FACTORY names for the root - and, in `issuer`, also the document's own
 * `documentStore`, so an honest document has the two agreeing. */
const CLONE = "0x0000000000000000000000000000000000000001";
/** A contract the factory never deployed, run by whoever built a forged document. */
const HOSTILE = "0x00000000000000000000000000000000000ba0b";
/** The signer that actually issued R on-chain (== `clone.issuedBy[R]`). */
const SIGNER = "0x00000000000000000000000000000000000515e6";
/** The registry that gates `CLONE` - read from the clone, never from verifier config. */
const REGISTRY = "0x00000000000000000000000000000000005e6157";
const GRANTED_AT: LogPoint = {blockNumber: 100, logIndex: 0};
const ANCHORED_AT: LogPoint = {blockNumber: 200, logIndex: 3};

/** A wrapped doc with dogTagId == "42"; deterministic salts so the root is stable across runs. */
function validDoc(): WrappedDoc {
  let seq = 0;
  const fixedSalt = () => new Uint8Array(16).fill(++seq);
  return wrapDocument(
    {
      credentialSubject: {
        dogTagId: {tag: TypeTag.Integer, value: "42"},
        name: {tag: TypeTag.String, value: "Rex"},
      },
    },
    freshIssuer(),
    fixedSalt,
  );
}

/** Tamper a packed value while preserving salt/tag so integrity recomputes to INVALID. */
function tamperIntegrity(doc: WrappedDoc): WrappedDoc {
  const data = JSON.parse(JSON.stringify(doc.data));
  const packed: string = data.credentialSubject.name;
  const [salt, tag] = packed.split(":");
  data.credentialSubject.name = `${salt}:${tag}:Fido`;
  return {...doc, data};
}

function withProtocol(doc: WrappedDoc, issuerSigner: string): WrappedDoc {
  return {
    ...doc,
    protocol: {
      chainId: 135,
      version: "dogtag-levelb/1",
      verificationRegistry: "0x2B4d6f8a0c1e3a5b7d9f0e2C4a6b8d0F1E3A5c70",
      issuerClone: doc.issuer.documentStore,
      issuerSigner,
    },
  };
}

/**
 * An address-keyed fake chain. Every read below takes the contract it is asked of seriously, so a
 * mock that answered the same regardless of address could not model "the hostile contract lies
 * while the real clone tells the truth" - the exact shape of the forged-issuer attack.
 */
class MockChain implements RpcAdapter {
  hasFactory = true;
  rootIssuers = new Map<string, string>();
  isValidMap = new Map<string, boolean>();
  issuedByMap = new Map<string, string>();
  /** WP4.14S: the v2 `recordTypeOf(root)` PRIMARY answer, keyed by clone addr (this mock ignores
   * root for simplicity - no test here needs two different roots on the same clone to disagree). */
  recordTypes = new Map<string, string>();
  /** WP4.14S: the v1 `recordType()` FALLBACK answer, keyed by clone addr - a SEPARATE map from
   * `recordTypes` so a fallback test can prove the resolved value genuinely came from THIS call,
   * not merely from a coincidentally-shared source. `MockChain.genuine()` sets both to the same
   * value so every pre-existing test keeps passing regardless of which path actually executes. */
  legacyRecordTypes = new Map<string, string>();
  /** Addresses whose `issuerRecordTypeOfRoot` call itself throws - simulates a pre-v2 clone whose
   * bytecode has no `recordTypeOf` mapping at all, forcing the fallback to `issuerRecordType`. */
  recordTypeOfRootFails = new Set<string>();
  governingRegistry = new Map<string, string>();
  grants = new Map<string, GrantEvent[]>();
  rootIssuedAt = new Map<string, LogPoint>();
  owner: string | undefined = undefined;
  failing = new Set<string>();

  /** A chain on which `doc` is exactly what it claims: the factory names CLONE for the root, CLONE
   * issued it from SIGNER, declares VACCINATION, and SIGNER is whitelisted for that type. */
  static genuine(doc: WrappedDoc): MockChain {
    const c = new MockChain();
    const root = doc.signature.merkleRoot.toLowerCase();
    const rt = recordTypeKey("VACCINATION");
    c.owner = OWNER;
    c.rootIssuers.set(root, CLONE.toLowerCase());
    c.isValidMap.set(`${CLONE.toLowerCase()}|${root}`, true);
    c.issuedByMap.set(`${CLONE.toLowerCase()}|${root}`, SIGNER.toLowerCase());
    c.recordTypes.set(CLONE.toLowerCase(), rt);
    c.legacyRecordTypes.set(CLONE.toLowerCase(), rt);
    c.governingRegistry.set(CLONE.toLowerCase(), REGISTRY.toLowerCase());
    c.rootIssuedAt.set(`${CLONE.toLowerCase()}|${root}`, ANCHORED_AT);
    c.grants.set(`${REGISTRY.toLowerCase()}|${CLONE.toLowerCase()}|${SIGNER.toLowerCase()}`, [
      {at: GRANTED_AT, granted: true},
    ]);
    return c;
  }

  withGrants(history: GrantEvent[]): this {
    this.grants.set(`${REGISTRY.toLowerCase()}|${CLONE.toLowerCase()}|${SIGNER.toLowerCase()}`, history);
    return this;
  }

  withHostile(addr: string, root: string, isValid: boolean, issuedBy: string): this {
    const key = `${addr.toLowerCase()}|${root.toLowerCase()}`;
    this.isValidMap.set(key, isValid);
    this.issuedByMap.set(key, issuedBy.toLowerCase());
    this.recordTypes.set(addr.toLowerCase(), recordTypeKey("VACCINATION"));
    this.legacyRecordTypes.set(addr.toLowerCase(), recordTypeKey("VACCINATION"));
    return this;
  }

  /** WP4.14S: mark `addr` as a pre-v2 clone - its `issuerRecordTypeOfRoot` call itself throws
   * (no such function on that clone's bytecode), forcing the whitelist pillar to fall back to
   * `issuerRecordType`. */
  withPreV2Clone(addr: string): this {
    this.recordTypeOfRootFails.add(addr.toLowerCase());
    return this;
  }

  noFactory(): this {
    this.hasFactory = false;
    this.rootIssuers.clear();
    return this;
  }

  noRecord(): this {
    this.rootIssuers.clear();
    return this;
  }

  failingOn(what: string): this {
    this.failing.add(what);
    return this;
  }

  withoutWhitelist(): this {
    this.grants.clear();
    return this;
  }

  withoutGoverningRegistry(): this {
    this.governingRegistry.clear();
    return this;
  }

  withoutAnchoringEvent(): this {
    this.rootIssuedAt.clear();
    return this;
  }

  withValidAt(addr: string, root: string, v: boolean): this {
    this.isValidMap.set(`${addr.toLowerCase()}|${root.toLowerCase()}`, v);
    return this;
  }

  withOwner(o: string | undefined): this {
    this.owner = o;
    return this;
  }

  private check(what: string): void {
    if (this.failing.has(what)) throw new Error(`${what} read failed`);
  }

  async isValid(issuerAddr: string, root: string): Promise<boolean> {
    this.check("isValid");
    return this.isValidMap.get(`${issuerAddr.toLowerCase()}|${root.toLowerCase()}`) ?? false;
  }

  async ownerOf(): Promise<string> {
    this.check("ownerOf");
    if (this.owner === undefined) throw new Error("ownerOf");
    return this.owner;
  }

  async rootIssuer(root: string): Promise<IssuerAnchor> {
    this.check("rootIssuer");
    if (!this.hasFactory) return {kind: "noFactoryConfigured"};
    const clone = this.rootIssuers.get(root.toLowerCase());
    return clone ? {kind: "resolved", clone} : {kind: "noRecord"};
  }

  async issuedBy(addr: string, root: string): Promise<string | null> {
    this.check("issuedBy");
    return this.issuedByMap.get(`${addr.toLowerCase()}|${root.toLowerCase()}`) ?? null;
  }

  /** WP4.14S PRIMARY: v2's per-root `recordTypeOf(root)`. Throws for an address marked
   * `withPreV2Clone` - the exact failure mode that should trigger the `issuerRecordType` fallback. */
  async issuerRecordTypeOfRoot(addr: string, _root: string): Promise<string | null> {
    this.check("issuerRecordTypeOfRoot");
    if (this.recordTypeOfRootFails.has(addr.toLowerCase())) {
      throw new Error("recordTypeOf: no such function (pre-v2 clone)");
    }
    return this.recordTypes.get(addr.toLowerCase()) ?? null;
  }

  /** WP4.14S FALLBACK ONLY: v1's per-clone `recordType()`. Reads `legacyRecordTypes`, a map
   * deliberately separate from `recordTypes` above - see that field's own doc comment. */
  async issuerRecordType(addr: string): Promise<string | null> {
    this.check("issuerRecordType");
    return this.legacyRecordTypes.get(addr.toLowerCase()) ?? null;
  }

  /** Composed from the pieces a real adapter reads - the governing registry off the clone, the
   * anchoring event off the clone's log, then that registry's grant history through the shared
   * `grantInForceAt` fold - so this fake cannot paper over the before/after distinction under test. */
  async whitelistedAtIssuance(issuerAddr: string, signer: string, merkleRoot: string): Promise<GrantAtIssuance> {
    this.check("whitelistedAtIssuance");
    const clone = issuerAddr.toLowerCase();
    const root = merkleRoot.toLowerCase();
    const registry = this.governingRegistry.get(clone);
    if (!registry) return "UNDETERMINED";
    const anchoredAt = this.rootIssuedAt.get(`${clone}|${root}`);
    if (!anchoredAt) return "UNDETERMINED";
    const history = this.grants.get(`${registry}|${clone}|${signer.toLowerCase()}`) ?? [];
    return grantInForceAt(history, anchoredAt);
  }
}

function opts(
  chain: MockChain,
  dns: DnsAdapter,
  registry: RegistryAdapter,
  mode: "self-import" | "third-party",
  userWalletAddress?: string,
): VerifyOpts {
  return {rpc: chain, dns, registry, mode, userWalletAddress};
}

const dnsOk: DnsAdapter = {async txtMatches() { return true; }};
const dnsFail: DnsAdapter = {async txtMatches() { throw new Error("dns down"); }};
const registryOk: RegistryAdapter = {async knows() { return true; }};
const registryNo: RegistryAdapter = {async knows() { return false; }};

function thirdParty(doc: WrappedDoc, chain: MockChain) {
  return verify(doc, opts(chain, dnsOk, registryOk, "third-party"));
}

describe("verify() - the baseline: a genuine credential passes every pillar", () => {
  it("self-import, all pillars valid + owner matches -> valid", async () => {
    const doc = validDoc();
    const v = await verify(doc, opts(MockChain.genuine(doc), dnsOk, registryOk, "self-import", OWNER));
    expect(v.fragments.integrity).toBe("VALID");
    expect(v.fragments.issuance).toBe("VALID");
    expect(v.fragments.identity).toBe("VALID");
    expect(v.fragments.ownership).toBe("VALID");
    expect(v.issuerWhitelist).toBe("PASSED");
    expect(v.issuerResolution).toBe("RESOLVED");
    expect(v.valid).toBe(true);
  });

  it("self-import, owner mismatch gates validity", async () => {
    const doc = validDoc();
    const v = await verify(doc, opts(MockChain.genuine(doc), dnsOk, registryOk, "self-import", "0xdead"));
    expect(v.fragments.ownership).toBe("INVALID");
    expect(v.valid).toBe(false);
  });

  it("self-import, ownerOf throws -> ERROR, not valid", async () => {
    const doc = validDoc();
    const chain = MockChain.genuine(doc).withOwner(undefined);
    const v = await verify(doc, opts(chain, dnsOk, registryOk, "self-import", OWNER));
    expect(v.fragments.ownership).toBe("ERROR");
    expect(v.valid).toBe(false);
  });

  it("third-party, no wallet -> ownership NOT_APPLICABLE, does not gate", async () => {
    const doc = validDoc();
    const v = await thirdParty(doc, MockChain.genuine(doc));
    expect(v.fragments.ownership).toBe("NOT_APPLICABLE");
    expect(v.valid).toBe(true);
  });

  it("third-party, owner mismatch is reported but does NOT gate validity", async () => {
    const doc = validDoc();
    const v = await verify(doc, opts(MockChain.genuine(doc), dnsOk, registryOk, "third-party", "0xother"));
    expect(v.fragments.ownership).toBe("INVALID");
    expect(v.valid).toBe(true);
  });

  it("issuance false -> INVALID, not valid", async () => {
    const doc = validDoc();
    const chain = MockChain.genuine(doc).withValidAt(CLONE, doc.signature.merkleRoot, false);
    const v = await thirdParty(doc, chain);
    expect(v.fragments.issuance).toBe("INVALID");
    expect(v.valid).toBe(false);
  });

  it("issuance adapter throw -> ERROR, not valid", async () => {
    const doc = validDoc();
    const v = await thirdParty(doc, MockChain.genuine(doc).failingOn("isValid"));
    expect(v.fragments.issuance).toBe("ERROR");
    expect(v.valid).toBe(false);
  });

  it("identity requires BOTH txt and registry; a DNS throw is ERROR", async () => {
    const doc = validDoc();
    const chain = MockChain.genuine(doc);
    const noRegistry = await verify(doc, opts(chain, dnsOk, registryNo, "third-party"));
    expect(noRegistry.fragments.identity).toBe("INVALID");
    expect(noRegistry.valid).toBe(false);

    const dnsThrows = await verify(doc, opts(chain, dnsFail, registryOk, "third-party"));
    expect(dnsThrows.fragments.identity).toBe("ERROR");
    expect(dnsThrows.valid).toBe(false);
  });

  it("tampered integrity gates validity in both modes", async () => {
    const tampered = tamperIntegrity(validDoc());
    const chain = MockChain.genuine(validDoc());
    const self = await verify(tampered, opts(chain, dnsOk, registryOk, "self-import", OWNER));
    expect(self.fragments.integrity).toBe("INVALID");
    expect(self.valid).toBe(false);
    const third = await thirdParty(tampered, chain);
    expect(third.fragments.integrity).toBe("INVALID");
    expect(third.valid).toBe(false);
  });
});

// === the forged-issuer sweep ==================================================================
//
// `issuer.documentStore` sits OUTSIDE the Merkle root, so it is chosen by whoever built the
// document. Every read that decides a verdict is made against the clone THIS VERIFIER'S OWN
// factory names for the root, and the issuer-whitelist pillar is mandatory. Each test breaks
// exactly one term of that.
describe("verify() - the forged-issuer sweep", () => {
  it("TERM 1: is_valid is read against the FACTORY-RESOLVED clone, never issuer.documentStore", async () => {
    const doc = validDoc();
    const root = doc.signature.merkleRoot;
    doc.issuer.documentStore = HOSTILE;
    const chain = MockChain.genuine(doc).withHostile(HOSTILE, root, true, SIGNER).withValidAt(CLONE, root, false);
    expect(await chain.isValid(HOSTILE, root, 1)).toBe(true); // the hostile contract really would lie

    const v = await thirdParty(doc, chain);
    expect(v.issuerAddr.toLowerCase()).toBe(CLONE.toLowerCase());
    expect(v.fragments.issuance).toBe("INVALID");
    expect(v.valid).toBe(false);
  });

  it("TERM 2: the issuer-whitelist pillar is MANDATORY", async () => {
    const doc = validDoc();
    const chain = MockChain.genuine(doc).withoutWhitelist();
    const v = await thirdParty(doc, chain);
    expect(v.fragments.integrity).toBe("VALID");
    expect(v.fragments.issuance).toBe("VALID");
    expect(v.fragments.identity).toBe("VALID");
    expect(v.issuerWhitelist).toBe("FAILED");
    expect(v.valid).toBe(false);
  });

  it("TERM 3: NO_FACTORY_CONFIGURED (our gap) differs from NO_RECORD (evidence)", async () => {
    const doc = validDoc();
    const asked = await thirdParty(doc, MockChain.genuine(doc).noRecord());
    expect(asked.issuerResolution).toBe("NO_RECORD");
    expect(asked.issuerWhitelist).toBe("UNRESOLVED");
    expect(asked.valid).toBe(false);

    const never = await thirdParty(doc, MockChain.genuine(doc).noFactory());
    expect(never.issuerResolution).toBe("NO_FACTORY_CONFIGURED");
    expect(never.issuerWhitelist).toBe("UNAVAILABLE_NO_FACTORY_CONFIGURED");
    expect(never.valid).toBe(true); // our own misconfiguration is not evidence about the credential
  });

  it("TERM 4: a record-type relabel is refused", async () => {
    const doc = validDoc();
    expect(doc.issuer.recordType).toBe("VACCINATION");
    const chain = MockChain.genuine(doc);
    expect((await thirdParty(doc, chain)).valid).toBe(true);

    doc.issuer.recordType = "TRAVEL_CLEARANCE"; // free: recordType is outside R
    const v = await thirdParty(doc, chain);
    expect(v.issuerWhitelist).toBe("FAILED");
    expect(v.valid).toBe(false);
  });

  it("TERM 4b (WP4.14S): a pre-v2 clone (recordTypeOf(root) itself throws) falls back to recordType() and still resolves PASSED", async () => {
    const doc = validDoc();
    const chain = MockChain.genuine(doc).withPreV2Clone(CLONE);
    const v = await thirdParty(doc, chain);
    expect(v.issuerWhitelist).toBe("PASSED");
    expect(v.valid).toBe(true);
  });

  it("TERM 4c (WP4.14S): the fallback genuinely reads from recordType(), not merely a coincidentally-shared value", async () => {
    const doc = validDoc();
    const chain = MockChain.genuine(doc).withPreV2Clone(CLONE);
    // Wipe the v2 map entirely - if the code under test somehow still consulted it (or a shared
    // source) instead of genuinely falling back to issuerRecordType(), this would now resolve
    // UNRESOLVED (recordTypes.get(...) ?? null -> null) instead of PASSED.
    chain.recordTypes.clear();
    const v = await thirdParty(doc, chain);
    expect(v.issuerWhitelist).toBe("PASSED");
    expect(v.valid).toBe(true);
  });

  it("TERM 4d (WP4.14S): when BOTH recordTypeOf(root) and recordType() fail, UNRESOLVED - never a pass", async () => {
    const doc = validDoc();
    const chain = MockChain.genuine(doc).withPreV2Clone(CLONE);
    chain.legacyRecordTypes.clear(); // the v1 fallback now also has nothing to answer with
    const v = await thirdParty(doc, chain);
    expect(v.issuerWhitelist).toBe("UNRESOLVED");
    expect(v.valid).toBe(false);
  });

  it("TERM 4e (WP4.14S): recordTypeOf(root) SUCCEEDING with the zero word is UNRESOLVED and never falls back to recordType() - a successful call's null result is not a trigger", async () => {
    const doc = validDoc();
    const chain = MockChain.genuine(doc);
    chain.recordTypes.clear(); // v2 call succeeds, returns null (uninitialized on this clone)
    // The v1 fallback map is still genuinely populated (from MockChain.genuine) - if the code
    // under test incorrectly fell back on a successful-but-null v2 read, this would resolve PASSED
    // instead of UNRESOLVED.
    expect(chain.legacyRecordTypes.get(CLONE.toLowerCase())).toBeDefined();
    const v = await thirdParty(doc, chain);
    expect(v.issuerWhitelist).toBe("UNRESOLVED");
    expect(v.valid).toBe(false);
  });

  it("TERM 5: a factoryless deployment still refuses a forged issuerSigner claim, and a match never promotes", async () => {
    const forged = withProtocol(validDoc(), "0x00000000000000000000000000000000deadbeef");
    const vForged = await thirdParty(forged, MockChain.genuine(forged).noFactory());
    expect(vForged.issuerWhitelist).toBe("UNAVAILABLE_NO_FACTORY_CONFIGURED");
    expect(vForged.fragments.issuance).toBe("INVALID"); // the claim is still checked and fails
    expect(vForged.valid).toBe(false);

    const doc = validDoc();
    const root = doc.signature.merkleRoot;
    const matching = withProtocol(doc, SIGNER);
    const chain = MockChain.genuine(matching).withHostile(HOSTILE, root, true, SIGNER);
    const matched = await thirdParty(matching, chain);
    expect(matched.issuerStore).toBe("MATCHED");
    expect(matched.valid).toBe(true);

    const unanchored = await thirdParty(matching, chain.noRecord());
    expect(unanchored.issuerWhitelist).toBe("UNRESOLVED");
    expect(unanchored.issuerStore).toBe("NOT_EVALUATED");
    expect(unanchored.valid).toBe(false); // an agreeable claim never manufactures a pass
  });

  it("TERM 6: a documentStore the factory did not name is refused as a STORE MISMATCH, not a whitelist failure", async () => {
    const genuine = validDoc();
    const chain = MockChain.genuine(genuine);
    expect((await thirdParty(genuine, chain)).valid).toBe(true);

    const doc = {...genuine, issuer: {...genuine.issuer, documentStore: HOSTILE}};
    const v = await thirdParty(doc, chain);
    expect(v.issuerStore).toBe("DIFFERS");
    expect(v.issuerWhitelist).toBe("PASSED"); // the signer really is authorised - a different accusation
    expect(v.fragments.issuance).toBe("VALID");
    expect(v.valid).toBe(false);
  });
});

describe("verify() - read failures are indeterminate, never a pass and never an accusation", () => {
  it("a root_issuer read failure is READ_FAILED / UNRESOLVED, not a pass", async () => {
    const doc = validDoc();
    const v = await thirdParty(doc, MockChain.genuine(doc).failingOn("rootIssuer"));
    expect(v.issuerResolution).toBe("READ_FAILED");
    expect(v.issuerWhitelist).toBe("UNRESOLVED");
    expect(v.valid).toBe(false);
  });

  it("a whitelistedAtIssuance read failure is UNRESOLVED, not PASSED", async () => {
    const doc = validDoc();
    const v = await thirdParty(doc, MockChain.genuine(doc).failingOn("whitelistedAtIssuance"));
    expect(v.issuerWhitelist).toBe("UNRESOLVED");
    expect(v.valid).toBe(false);
  });

  it("an unanswerable grant history is UNRESOLVED, never FAILED", async () => {
    const doc = validDoc();
    for (const chain of [MockChain.genuine(doc).withoutGoverningRegistry(), MockChain.genuine(doc).withoutAnchoringEvent()]) {
      const v = await thirdParty(doc, chain);
      expect(v.issuerWhitelist).toBe("UNRESOLVED");
      expect(v.valid).toBe(false);
    }
  });

  it("PASSED, UNAVAILABLE_NO_FACTORY_CONFIGURED, and UNRESOLVED are pairwise distinguishable", async () => {
    const doc = validDoc();
    const passed = (await thirdParty(doc, MockChain.genuine(doc))).issuerWhitelist;
    const unavailable = (await thirdParty(doc, MockChain.genuine(doc).noFactory())).issuerWhitelist;
    const unresolved = (await thirdParty(doc, MockChain.genuine(doc).noRecord())).issuerWhitelist;
    expect(passed).toBe("PASSED");
    expect(unavailable).not.toBe(passed);
    expect(unresolved).not.toBe(passed);
    expect(unavailable).not.toBe(unresolved);
  });
});

describe("verify() - delisting is forward-only", () => {
  it("delisted AFTER anchoring still verifies; delisted BEFORE anchoring does not", async () => {
    const doc = validDoc();
    const granted: GrantEvent = {at: GRANTED_AT, granted: true};

    const after = await thirdParty(
      doc,
      MockChain.genuine(doc).withGrants([
        granted,
        {at: {blockNumber: ANCHORED_AT.blockNumber + 500, logIndex: 0}, granted: false},
      ]),
    );
    expect(after.issuerWhitelist).toBe("PASSED");
    expect(after.valid).toBe(true);

    const before = await thirdParty(
      doc,
      MockChain.genuine(doc).withGrants([
        granted,
        {at: {blockNumber: ANCHORED_AT.blockNumber - 1, logIndex: 0}, granted: false},
      ]),
    );
    expect(before.issuerWhitelist).toBe("FAILED");
    expect(before.valid).toBe(false);
  });

  it("a grant issued AFTER the anchoring does not authorise it retroactively", async () => {
    const doc = validDoc();
    const v = await thirdParty(
      doc,
      MockChain.genuine(doc).withGrants([{at: {blockNumber: ANCHORED_AT.blockNumber + 1, logIndex: 0}, granted: true}]),
    );
    expect(v.issuerWhitelist).toBe("FAILED");
    expect(v.valid).toBe(false);
  });

  it("grantInForceAt sequences same-block events by logIndex, inclusive at the anchoring point", () => {
    const at = (logIndex: number): LogPoint => ({blockNumber: ANCHORED_AT.blockNumber, logIndex});
    const g = (logIndex: number, granted: boolean): GrantEvent => ({at: at(logIndex), granted});
    expect(grantInForceAt([g(ANCHORED_AT.logIndex, true)], ANCHORED_AT)).toBe("AUTHORIZED");
    expect(grantInForceAt([g(0, true), g(ANCHORED_AT.logIndex + 1, false)], ANCHORED_AT)).toBe("AUTHORIZED");
    expect(grantInForceAt([g(0, true), g(ANCHORED_AT.logIndex - 1, false)], ANCHORED_AT)).toBe("NOT_AUTHORIZED");
    expect(grantInForceAt([], ANCHORED_AT)).toBe("NOT_AUTHORIZED"); // an answered-empty history, not an absent one
  });
});

// --- M7 provenance: the `protocol` block is a routing hint, NEVER authority (§4.2/§4.3) ---------
describe("verify() - M7 provenance issuer-signer check", () => {
  it("matching issuerSigner claim verifies", async () => {
    const doc = withProtocol(validDoc(), SIGNER);
    const v = await thirdParty(doc, MockChain.genuine(doc));
    expect(v.fragments.issuance).toBe("VALID");
    expect(v.valid).toBe(true);
  });

  it("wrong/forged issuerSigner does NOT verify", async () => {
    const doc = withProtocol(validDoc(), "0x00000000000000000000000000000000deadbeef");
    const v = await thirdParty(doc, MockChain.genuine(doc));
    expect(v.fragments.issuance).toBe("INVALID");
    expect(v.valid).toBe(false);
  });

  it("a matching block cannot rescue an on-chain-invalid record", async () => {
    const doc = withProtocol(validDoc(), SIGNER);
    const chain = MockChain.genuine(doc).withValidAt(CLONE, doc.signature.merkleRoot, false);
    const v = await thirdParty(doc, chain);
    expect(v.fragments.issuance).toBe("INVALID");
    expect(v.valid).toBe(false);
  });

  it("absent block verifies unchanged (back-compat)", async () => {
    const doc = validDoc();
    expect(doc.protocol).toBeUndefined();
    const v = await thirdParty(doc, MockChain.genuine(doc));
    expect(v.fragments.issuance).toBe("VALID");
    expect(v.valid).toBe(true);
  });

  it("a provenance read failure is ERROR, never a silent pass (replaces the old optional-adapter skip)", async () => {
    const doc = withProtocol(validDoc(), SIGNER);
    const v = await thirdParty(doc, MockChain.genuine(doc).failingOn("issuedBy"));
    expect(v.fragments.issuance).toBe("ERROR");
    expect(v.valid).toBe(false);
  });

  it("a stamped block cannot weaken integrity", async () => {
    const doc = withProtocol(tamperIntegrity(validDoc()), SIGNER);
    const v = await thirdParty(doc, MockChain.genuine(doc));
    expect(v.fragments.integrity).toBe("INVALID");
    expect(v.valid).toBe(false);
  });
});

// --- round 2 grader findings: fail-closed on hostile/malformed wire input, never a throw ---------
describe("verify() - malformed/hostile input resolves to a verdict, never a throw", () => {
  it("finding #1: an absent issuer.documentStore lands on DIFFERS, not a TypeError", async () => {
    const doc = validDoc();
    const stripped = {...doc, issuer: {...doc.issuer}};
    delete (stripped.issuer as Partial<IssuerMeta>).documentStore;
    const chain = MockChain.genuine(doc); // factory still resolves CLONE for this root
    const v = await thirdParty(stripped, chain);
    expect(v.issuerStore).toBe("DIFFERS");
    expect(v.valid).toBe(false);
  });

  it("finding #1: an empty-string issuer.documentStore also lands on DIFFERS, not MATCHED", async () => {
    const doc = validDoc();
    const emptied = {...doc, issuer: {...doc.issuer, documentStore: "   "}};
    const chain = MockChain.genuine(doc);
    const v = await thirdParty(emptied, chain);
    expect(v.issuerStore).toBe("DIFFERS");
    expect(v.valid).toBe(false);
  });

  it("finding #2: a malformed signature.targetHash resolves to INVALID, never throws", async () => {
    const doc = validDoc();
    const bad = {...doc, signature: {...doc.signature, targetHash: "0xzz"}};
    const chain = MockChain.genuine(doc);
    await expect(thirdParty(bad, chain)).resolves.toMatchObject({
      fragments: {integrity: "INVALID"},
      valid: false,
    });
  });

  it("finding #2: a targetHash that exceeds the field resolves to INVALID, never throws", async () => {
    const doc = validDoc();
    const bad = {...doc, signature: {...doc.signature, targetHash: "0x" + "f".repeat(64)}};
    const chain = MockChain.genuine(doc);
    await expect(thirdParty(bad, chain)).resolves.toMatchObject({
      fragments: {integrity: "INVALID"},
      valid: false,
    });
  });

  it("finding #2: a malformed signature.merkleRoot resolves to INVALID, never throws", async () => {
    const doc = validDoc();
    const bad = {...doc, signature: {...doc.signature, merkleRoot: "not-hex"}};
    const chain = MockChain.genuine(doc);
    await expect(thirdParty(bad, chain)).resolves.toMatchObject({
      fragments: {integrity: "INVALID"},
      valid: false,
    });
  });

  it("finding #2: a garbage packed leaf value resolves to INVALID, never throws", async () => {
    const doc = validDoc();
    const data = JSON.parse(JSON.stringify(doc.data));
    data.credentialSubject.name = "garbage";
    const bad = {...doc, data};
    const chain = MockChain.genuine(doc);
    await expect(thirdParty(bad, chain)).resolves.toMatchObject({
      fragments: {integrity: "INVALID"},
      valid: false,
    });
  });

  it("finding #2: an obfuscated hash that is HEX32-shaped but exceeds the field resolves to INVALID, never throws", async () => {
    const doc = validDoc();
    const bad = {
      ...doc,
      privacy: {...doc.privacy, obfuscated: [...doc.privacy.obfuscated, "0x" + "f".repeat(64)]},
    };
    const chain = MockChain.genuine(doc);
    await expect(thirdParty(bad, chain)).resolves.toMatchObject({
      fragments: {integrity: "INVALID"},
      valid: false,
    });
  });

  it("finding #2: an unknown packed tag resolves to INVALID, never throws", async () => {
    const doc = validDoc();
    const data = JSON.parse(JSON.stringify(doc.data));
    const packed: string = data.credentialSubject.name;
    const [salt] = packed.split(":");
    data.credentialSubject.name = `${salt}:99:Rex`;
    const bad = {...doc, data};
    const chain = MockChain.genuine(doc);
    await expect(thirdParty(bad, chain)).resolves.toMatchObject({
      fragments: {integrity: "INVALID"},
      valid: false,
    });
  });

  // finding B: `privacy`/`signature`/`issuer` are typed as always-present, but a `WrappedDoc` off
  // the wire is only as complete as whatever sent it. Each block's outright absence used to crash
  // past `verify()` with a bare TypeError instead of resolving to a verdict; the fail-closed shape
  // below is identical for all three, since none of them is a question the rest of verify() could
  // even begin to ask.
  const FAIL_CLOSED_VERDICT = {
    valid: false,
    fragments: {integrity: "INVALID", issuance: "ERROR", identity: "ERROR", ownership: "ERROR"},
    issuerWhitelist: "UNRESOLVED",
    issuerStore: "NOT_EVALUATED",
    issuerResolution: "READ_FAILED",
    issuerAddr: "",
  };

  it("finding B: an absent doc.privacy block resolves to a fail-closed verdict, never a TypeError", async () => {
    const doc = validDoc();
    const stripped: Partial<WrappedDoc> = {...doc};
    delete stripped.privacy;
    const v = await thirdParty(stripped as WrappedDoc, MockChain.genuine(doc));
    expect(v).toEqual(FAIL_CLOSED_VERDICT);
    // `checkIntegrity` is independently exported and reads `privacy` directly - guard it too.
    expect(checkIntegrity(stripped as WrappedDoc)).toEqual({state: "INVALID", root: 0n});
  });

  it("finding B: an absent doc.signature block resolves to a fail-closed verdict, never a TypeError", async () => {
    const doc = validDoc();
    const stripped: Partial<WrappedDoc> = {...doc};
    delete stripped.signature;
    const v = await thirdParty(stripped as WrappedDoc, MockChain.genuine(doc));
    expect(v).toEqual(FAIL_CLOSED_VERDICT);
    // `checkIntegrity` is independently exported and reads `signature` directly - guard it too.
    expect(checkIntegrity(stripped as WrappedDoc)).toEqual({state: "INVALID", root: 0n});
  });

  it("finding B: an absent doc.issuer block resolves to a fail-closed verdict, never a TypeError", async () => {
    const doc = validDoc();
    const stripped: Partial<WrappedDoc> = {...doc};
    delete stripped.issuer;
    const v = await thirdParty(stripped as WrappedDoc, MockChain.genuine(doc));
    expect(v).toEqual(FAIL_CLOSED_VERDICT);
  });
});

describe("verify() - argument contract", () => {
  it("self-import without userWalletAddress throws", async () => {
    const doc = validDoc();
    await expect(verify(doc, opts(MockChain.genuine(doc), dnsOk, registryOk, "self-import"))).rejects.toThrow(
      /userWalletAddress/,
    );
  });
});
