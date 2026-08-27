import "server-only";
import {MintSession, type MintSessionDoc} from "@/lib/models/MintSession";
import {BindToken, type BindTokenDoc} from "@/lib/models/BindToken";
import type {MintFlowStore, MintSessionRow, MintTokenRow} from "@/lib/mint/flow";
import type {OpenedLeaf} from "@dogtag/standard";

function toSessionRow(doc: MintSessionDoc): MintSessionRow {
  return {
    sessionId: doc.sessionId,
    dogTagIdDec: doc.dogTagIdDec,
    dogTagIdFieldDec: doc.dogTagIdField,
    ownerIdentity: doc.ownerIdentity,
    identityLeaves: doc.identityLeaves,
    petName: doc.petName,
    microchip: doc.microchip,
    profile: doc.profile,
    status: doc.status,
    root: doc.root,
    errorStage: doc.errorStage,
  };
}

function toTokenRow(doc: BindTokenDoc): MintTokenRow {
  return {token: doc.token, sessionId: doc.sessionId, exp: doc.exp, consumed: doc.consumed, consumedAt: doc.consumedAt};
}

/** Mongoose-backed `MintFlowStore` - the production adapter for `lib/mint/flow.ts`'s pure logic.
 * `connectToDatabase()` is assumed already called by the route handler, same convention as every
 * other model access in this repo. */
export const mongoMintStore: MintFlowStore = {
  async getToken(token) {
    const doc = await BindToken.findOne({token}).lean<BindTokenDoc>();
    return doc ? toTokenRow(doc) : null;
  },

  async getSession(sessionId) {
    const doc = await MintSession.findOne({sessionId}).lean<MintSessionDoc>();
    return doc ? toSessionRow(doc) : null;
  },

  async extendTtlOnFirstResolve(token, now, minExp) {
    // Atomic: only a request that finds `firstResolvedAt` still unset performs the extension, so
    // two concurrent first resolves can't each independently push `exp` forward past `minExp`.
    const updated = await MintSession.findOneAndUpdate(
      {sessionId: token.sessionId, firstResolvedAt: {$exists: false}},
      {$set: {firstResolvedAt: new Date(now * 1000)}},
      {new: true},
    ).lean<MintSessionDoc>();
    if (updated) {
      const newExp = Math.max(token.exp, minExp);
      await Promise.all([
        BindToken.updateOne({token: token.token}, {$set: {exp: newExp}}),
        MintSession.updateOne({sessionId: token.sessionId}, {$set: {tokenExp: newExp}}),
      ]);
      return newExp;
    }
    return token.exp;
  },

  async tryConsumeToken(token, now) {
    const updated = await BindToken.findOneAndUpdate(
      {token, consumed: false},
      {$set: {consumed: true, consumedAt: now}},
      {new: true},
    ).lean<BindTokenDoc>();
    return Boolean(updated);
  },

  async commitReady(session, result) {
    await MintSession.updateOne(
      {sessionId: session.sessionId},
      {
        $set: {
          status: "ready",
          root: result.root,
          boundLeaves: result.boundLeaves as OpenedLeaf[],
          reservedLeafHashes: result.reservedLeafHashes,
        },
      },
    );
  },

  async markError(sessionId, stage) {
    await MintSession.updateOne({sessionId}, {$set: {status: "error", errorStage: stage}});
  },
};
