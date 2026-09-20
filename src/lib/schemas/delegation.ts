import {z} from "zod";
import {hex32, hexAddress, hexSignature65} from "@/lib/schemas/common";

/** `POST /api/pets/:id/delegations` body - the vet-issued add/revoke ceremony start
 * (`docs/DELEGATION.md` sections 4.3/4.5). `operatorAddress` is the browser's currently-connected
 * wallet (mirrors `startMintSessionSchema`'s own field of the same name) - checked against the
 * clinic's on-chain operator whitelist via `preflightIssuance` before anything else happens. */
export const startDelegationSchema = z.discriminatedUnion("mode", [
  z.object({mode: z.literal("add"), clientId: z.string().min(1), operatorAddress: hexAddress}),
  z.object({mode: z.literal("revoke"), commitment: hex32, operatorAddress: hexAddress}),
]);
export type StartDelegationInput = z.infer<typeof startDelegationSchema>;

/** `POST /d/:token/complete` body - `specs/vet-public-api.yaml`'s `DelegationSessionCompleteRequest`. */
export const completeDelegationSchema = z.object({
  commitment: hex32,
  wallet: hexAddress,
  signature: hexSignature65,
});
export type CompleteDelegationInput = z.infer<typeof completeDelegationSchema>;

/** `POST /api/pets/:id/delegations/:registrationId/tx` body - records the `addSecondaryOwner`/
 * `revokeSecondaryOwner` transaction hash the operator wallet just submitted, mirroring
 * `POST /api/tags/issue/:sessionId/tx`'s identical `{txHash}` shape. */
export const delegationTxSchema = z.object({
  txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "txHash must be a 0x-prefixed 32-byte transaction hash."),
});
export type DelegationTxInput = z.infer<typeof delegationTxSchema>;
