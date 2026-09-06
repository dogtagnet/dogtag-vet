import "server-only";
import {Client, type ClientDoc} from "@/lib/models/Client";

/** Does this client have at least one currently-active (non-revoked) registered wallet? The
 * session-start precondition (`docs/DELEGATION.md` section 4.3: "the secondary human is already a
 * client with a wallet registered through the existing /w wallet-registration flow ... checked
 * when staff open the session, not by the public API below"). */
export async function clientHasActiveWallet(clientId: string): Promise<boolean> {
  const client = await Client.findOne({clientId}).select("wallets").lean<Pick<ClientDoc, "wallets">>();
  return Boolean(client?.wallets?.some((w) => w.revokedAt === undefined));
}

/** Is `wallet` one of `clientId`'s currently-active registered wallets? The authorization half of
 * `POST /d/:token/complete`'s two-part check (`docs/DELEGATION.md` section 4.3 step 5) - signature
 * integrity (recovered signer == claimed wallet) is `completeDelegationClaim`'s own job; this is
 * the OTHER thing it has no store method for, injected as `deps.isRegisteredWallet`. */
export async function isRegisteredWalletForClient(clientId: string, wallet: string): Promise<boolean> {
  const lower = wallet.toLowerCase();
  const match = await Client.findOne({clientId, wallets: {$elemMatch: {address: lower, revokedAt: {$exists: false}}}})
    .select("_id")
    .lean();
  return Boolean(match);
}
