import "server-only";
import {DelegationSession, type DelegationSessionDoc} from "@/lib/models/DelegationSession";
import type {DelegationFlowStore, DelegationSessionRow} from "@/lib/delegation/flow";

export function toDelegationSessionRow(doc: DelegationSessionDoc): DelegationSessionRow {
  return {
    token: doc.token,
    registrationId: doc.registrationId,
    kind: doc.kind,
    petId: doc.petId,
    dogTagIdField: doc.dogTagIdField,
    dogTagIdDec: doc.dogTagIdDec,
    clientId: doc.clientId,
    clinic: doc.clinic,
    chainId: doc.chainId,
    clinicName: doc.clinicName,
    maskedTargetName: doc.maskedTargetName,
    commitment: doc.commitment,
    wallet: doc.wallet,
    issuedAt: doc.issuedAt,
    blockNumber: doc.blockNumber,
    deadline: doc.deadline,
    status: doc.status,
    errorReason: doc.errorReason,
    txHash: doc.txHash,
    consumed: doc.consumed,
    consumedAt: doc.consumedAt,
  };
}

/** Mongoose-backed `DelegationFlowStore` - the production adapter for `lib/delegation/flow.ts`'s
 * pure logic, mirroring `lib/registration/mongoStore.ts`. `connectToDatabase()` is assumed already
 * called by the route handler, same convention as every other model access in this repo. */
export const mongoDelegationStore: DelegationFlowStore = {
  async getByToken(token) {
    const doc = await DelegationSession.findOne({token}).lean<DelegationSessionDoc>();
    return doc ? toDelegationSessionRow(doc) : null;
  },

  async getByRegistrationId(registrationId) {
    const doc = await DelegationSession.findOne({registrationId}).lean<DelegationSessionDoc>();
    return doc ? toDelegationSessionRow(doc) : null;
  },

  async tryConsume(token, now) {
    const updated = await DelegationSession.findOneAndUpdate(
      {token, consumed: false},
      {$set: {consumed: true, consumedAt: now}},
      {new: true},
    ).lean<DelegationSessionDoc>();
    return Boolean(updated);
  },

  async recordClaim(token, fields) {
    await DelegationSession.updateOne({token}, {$set: {status: "claimed", commitment: fields.commitment, wallet: fields.wallet}});
  },

  async recordError(token, reason) {
    await DelegationSession.updateOne({token}, {$set: {status: "error", errorReason: reason}});
  },

  async hasActiveSecondaryForClient(dogTagIdField, clientId) {
    const [addedSessions, revokedSessions] = await Promise.all([
      DelegationSession.find({dogTagIdField, clientId, kind: "add", status: "confirmed"})
        .select("commitment")
        .lean<Pick<DelegationSessionDoc, "commitment">[]>(),
      DelegationSession.find({dogTagIdField, kind: "revoke", status: "confirmed"})
        .select("commitment")
        .lean<Pick<DelegationSessionDoc, "commitment">[]>(),
    ]);
    const revoked = new Set(revokedSessions.map((s) => s.commitment).filter(Boolean));
    return addedSessions.some((s) => s.commitment && !revoked.has(s.commitment));
  },
};
