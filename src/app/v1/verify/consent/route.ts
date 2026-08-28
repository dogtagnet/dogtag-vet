import {verifyProfileDisclosure} from "@dogtag/standard";
import {connectToDatabase} from "@/lib/db";
import {VerifySession, type VerifySessionDoc} from "@/lib/models/VerifySession";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {submitVerifyConsentSchema} from "@/lib/schemas/verifySession";
import {requireEnv} from "@/lib/env";
import {readIsValidRoot, readNullifierConsumed, readProfileRoot} from "@/lib/chainRead";
import {enforceRateLimit, errorBody, jsonWithHeaders, readJsonBody} from "@/lib/publicApi";

/** pubSignals is pinned `[dogTagId, purpose, relayer, nullifier, R, recordType, deadline]`
 * (`vet-public-api.yaml`'s `GrothProof` doc comment, `docs/crypto-improvements-v2.md`). Named
 * indices so no call site below has to remember the order by number. */
const PUB = {dogTagId: 0, purpose: 1, relayer: 2, nullifier: 3, R: 4, recordType: 5, deadline: 6} as const;

/** Every `pubSignals` entry is a decimal field-element string; every stored comparator field this
 * route checks it against (`relayerAddress`, a disclosure's `R`/`dogTagId`) is `0x`-prefixed hex.
 * Comparing as strings would silently pass or fail depending on casing/leading zeros - every
 * comparison in this route goes through `BigInt(...) === BigInt(...)` instead. */
function sameFieldValue(a: string, b: string): boolean {
  try {
    return BigInt(a) === BigInt(b);
  } catch {
    return false;
  }
}

const DEADLINE_MIN_LEAD_SECS = 120;

/**
 * `POST /v1/verify/consent` - `postVerifyConsent` in `vet-public-api.yaml`. This route only ever
 * forwards/records a proof the device already produced; it never accepts owner secret material
 * and never proves anything server-side. The actual on-chain `recordVerificationZK` call is made
 * later by the relayer's own staff wallet (`wagmi`, browser-side) - this route's job is to
 * validate the shape, verify the (optional) disclosure envelope locally, and preflight the checks
 * that would otherwise let a doomed submission reach the wallet only to revert.
 */
export async function POST(request: Request) {
  const rateLimit = enforceRateLimit(request, "verify-consent", 20, 60_000);
  if (rateLimit.limited) return rateLimit.response;

  const parsedBody = await readJsonBody(request, "verify-consent");
  if (!parsedBody.ok) {
    return jsonWithHeaders(
      errorBody("invalid_input", parsedBody.tooLarge ? "Request body is too large." : "Malformed consent request."),
      {status: 400, headers: rateLimit.headers},
    );
  }
  const parsed = submitVerifyConsentSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return jsonWithHeaders(errorBody("invalid_input", "Malformed consent request.", parsed.error.flatten()), {
      status: 400,
      headers: rateLimit.headers,
    });
  }
  const {exportToken, proof, profileDisclosure} = parsed.data;

  await connectToDatabase();
  const session = await VerifySession.findOne({token: exportToken}).lean<VerifySessionDoc>();
  if (!session) {
    return jsonWithHeaders(errorBody("token_not_found", "exportToken/sessionId unknown."), {
      status: 404,
      headers: rateLimit.headers,
    });
  }

  const now = Math.floor(Date.now() / 1000);
  if (now > session.challenge.deadline) {
    return jsonWithHeaders(errorBody("token_expired", "This verification request has expired."), {
      status: 410,
      headers: rateLimit.headers,
    });
  }
  if (session.status !== "pending") {
    return jsonWithHeaders(errorBody("already_submitted", "A proof was already submitted for this session."), {
      status: 409,
      headers: rateLimit.headers,
    });
  }

  if (!sameFieldValue(proof.pubSignals[PUB.relayer]!, session.relayerAddress)) {
    return jsonWithHeaders(errorBody("invalid_input", "pubSignals[relayer] does not match this session."), {
      status: 400,
      headers: rateLimit.headers,
    });
  }
  const deadlineField = BigInt(proof.pubSignals[PUB.deadline]!);
  if (deadlineField < BigInt(now + DEADLINE_MIN_LEAD_SECS)) {
    return jsonWithHeaders(errorBody("token_expired", "This proof's deadline is too close to expiry to accept."), {
      status: 410,
      headers: rateLimit.headers,
    });
  }

  if (profileDisclosure) {
    // A disclosure presented without a validly-bound consent proof for the same R is a replayable
    // bearer credential (vet-public-api.yaml's postVerifyConsent doc comment) - both bindings are
    // checked before the disclosure's own pure verification is trusted for anything.
    if (
      !sameFieldValue(profileDisclosure.R, proof.pubSignals[PUB.R]!) ||
      !sameFieldValue(profileDisclosure.dogTagId, proof.pubSignals[PUB.dogTagId]!)
    ) {
      return jsonWithHeaders(errorBody("invalid_input", "profileDisclosure does not bind to this proof."), {
        status: 400,
        headers: rateLimit.headers,
      });
    }
    let disclosureValid: boolean;
    try {
      disclosureValid = verifyProfileDisclosure(profileDisclosure);
    } catch {
      disclosureValid = false; // malformed envelope - reject, never propagate as a 500
    }
    if (!disclosureValid) {
      return jsonWithHeaders(errorBody("invalid_input", "profileDisclosure failed verification."), {
        status: 400,
        headers: rateLimit.headers,
      });
    }
  }

  let verificationRegistryAddress: `0x${string}`;
  let sbtAddress: `0x${string}`;
  try {
    verificationRegistryAddress = requireEnv("VERIFICATION_REGISTRY_ADDRESS") as `0x${string}`;
    sbtAddress = requireEnv("DOGTAG_SBT_ADDRESS") as `0x${string}`;
  } catch {
    return jsonWithHeaders(errorBody("not_configured", "Protocol addresses are not configured."), {
      status: 500,
      headers: rateLimit.headers,
    });
  }

  const settings = await getClinicSettings();
  if (!settings.cloneAddress) {
    return jsonWithHeaders(errorBody("not_configured", "This deployment has not completed setup."), {
      status: 500,
      headers: rateLimit.headers,
    });
  }

  let alreadyConsumed: boolean;
  let root: string;
  let tagActive: boolean;
  try {
    const nullifierHex = `0x${BigInt(proof.pubSignals[PUB.nullifier]!).toString(16).padStart(64, "0")}`;
    alreadyConsumed = await readNullifierConsumed(verificationRegistryAddress, nullifierHex);
    root = await readProfileRoot(sbtAddress, proof.pubSignals[PUB.dogTagId]!);
    tagActive = await readIsValidRoot(settings.cloneAddress as `0x${string}`, root);
  } catch {
    return jsonWithHeaders(errorBody("chain_unreadable", "Could not reach the chain to verify this proof."), {
      status: 503,
      headers: rateLimit.headers,
    });
  }
  if (alreadyConsumed) {
    return jsonWithHeaders(errorBody("nullifier_replayed", "This proof has already been submitted."), {
      status: 409,
      headers: rateLimit.headers,
    });
  }
  if (!tagActive) {
    return jsonWithHeaders(errorBody("tag_not_active", "This tag is not currently active."), {
      status: 409,
      headers: rateLimit.headers,
    });
  }

  await VerifySession.updateOne(
    {sessionId: session.sessionId},
    {
      $set: {
        status: "proof_received",
        proof,
        ...(profileDisclosure ? {profileDisclosure, disclosedKeyPaths: profileDisclosure.disclosures.map((d) => d.keyPath)} : {}),
      },
    },
  );

  return jsonWithHeaders({verified: true, status: "pending_confirmation"}, {headers: rateLimit.headers});
}
