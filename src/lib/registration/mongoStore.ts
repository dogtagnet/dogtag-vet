import "server-only";
import {WalletRegistrationSession, type WalletRegistrationSessionDoc} from "@/lib/models/WalletRegistrationSession";
import {Client, type ClientDoc, type ClientWallet} from "@/lib/models/Client";
import type {
  AppendWalletInput,
  AppendWalletResult,
  RegistrationFlowStore,
  RegistrationSessionRow,
} from "@/lib/registration/flow";

export function toRegistrationSessionRow(doc: WalletRegistrationSessionDoc): RegistrationSessionRow {
  return {
    token: doc.token,
    registrationId: doc.registrationId,
    clientId: doc.clientId,
    clinic: doc.clinic,
    chainId: doc.chainId,
    clinicName: doc.clinicName,
    maskedClientName: doc.maskedClientName,
    clientHash: doc.clientHash,
    issuedAt: doc.issuedAt,
    blockNumber: doc.blockNumber,
    deadline: doc.deadline,
    consumed: doc.consumed,
    consumedAt: doc.consumedAt,
  };
}

/** Mongoose-backed `RegistrationFlowStore` - the production adapter for `lib/registration/flow.ts`'s
 * pure logic, mirroring `lib/mint/mongoStore.ts`. `connectToDatabase()` is assumed already called
 * by the route handler, same convention as every other model access in this repo. */
export const mongoRegistrationStore: RegistrationFlowStore = {
  async getByToken(token) {
    const doc = await WalletRegistrationSession.findOne({token}).lean<WalletRegistrationSessionDoc>();
    return doc ? toRegistrationSessionRow(doc) : null;
  },

  async getByRegistrationId(registrationId) {
    const doc = await WalletRegistrationSession.findOne({registrationId}).lean<WalletRegistrationSessionDoc>();
    return doc ? toRegistrationSessionRow(doc) : null;
  },

  async tryConsume(token, now) {
    const updated = await WalletRegistrationSession.findOneAndUpdate(
      {token, consumed: false},
      {$set: {consumed: true, consumedAt: now}},
      {new: true},
    ).lean<WalletRegistrationSessionDoc>();
    return Boolean(updated);
  },

  async appendWalletToClient(clientId, entry: AppendWalletInput): Promise<AppendWalletResult> {
    // One atomic round trip: matches only if this client exists AND does not already carry this
    // address, so there is no separate check-then-push window a concurrent completion could race.
    // `runValidators: true` (review finding 8): update operations skip schema validation by
    // mongoose default, which would let a malformed entry bypass the wallet subdocument's
    // conditional registrationId/blockNumber requirement that a document-level save enforces.
    const updated = await Client.findOneAndUpdate(
      {clientId, "wallets.address": {$ne: entry.address}},
      {$push: {wallets: entry satisfies ClientWallet}},
      {new: true, runValidators: true},
    ).lean<ClientDoc>();
    if (updated) return "ok";

    const stillExists = await Client.exists({clientId});
    return stillExists ? "already_registered" : "not_found";
  },

  async findClientWalletByRegistrationId(clientId, registrationId) {
    const client = await Client.findOne(
      {clientId, "wallets.registrationId": registrationId},
      {"wallets.$": 1},
    ).lean<Pick<ClientDoc, "wallets">>();
    const wallet = client?.wallets?.[0];
    return wallet ? {address: wallet.address} : null;
  },
};
