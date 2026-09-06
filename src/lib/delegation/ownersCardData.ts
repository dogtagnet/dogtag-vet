import "server-only";
import {DelegationSession, type DelegationSessionDoc} from "@/lib/models/DelegationSession";
import {Client, type ClientDoc} from "@/lib/models/Client";
import {readDelegationLeaves} from "@/lib/chainRead";
import {requireEnv} from "@/lib/env";
import {buildSecondaryOwnerRows, type SecondaryOwnerRow} from "@/lib/delegation/ownersCard";

export interface DisplaySecondaryOwnerRow extends SecondaryOwnerRow {
  clientName?: string;
}

export interface OwnersCardData {
  primaryOwnerClientId?: string;
  primaryOwnerName?: string;
  secondaries: DisplaySecondaryOwnerRow[];
  /** `false` when the live `delegationLeaves` chain read failed - every row's status is then
   * suffixed `_unverified` (`buildSecondaryOwnerRows`'s own doc comment) and the card shows an
   * honest "could not verify current status" banner rather than a guess. */
  chainVerified: boolean;
  /** Whether this deployment is even configured for multi-owner tags yet - `false` hides the
   * Add/Revoke actions entirely rather than showing them and having every click fail. */
  delegationConfigured: boolean;
}

/**
 * Server-side data loader for the pet page's Owners card (V1) - `connectToDatabase()` is assumed
 * already called by the page, same convention as every other model access in this repo.
 */
export async function loadOwnersCardData(petId: string, dogTagIdField: string | undefined, primaryOwnerClientId: string | undefined): Promise<OwnersCardData> {
  let delegationRegistryAddress: `0x${string}` | undefined;
  try {
    delegationRegistryAddress = requireEnv("DELEGATION_REGISTRY_ADDRESS") as `0x${string}`;
  } catch {
    delegationRegistryAddress = undefined;
  }

  if (!dogTagIdField) {
    return {primaryOwnerClientId, secondaries: [], chainVerified: true, delegationConfigured: Boolean(delegationRegistryAddress)};
  }

  const [confirmedAdds, confirmedRevokes] = await Promise.all([
    DelegationSession.find({dogTagIdField, kind: "add", status: "confirmed"})
      .select("commitment clientId clinicName consumedAt issuedAt")
      .lean<Pick<DelegationSessionDoc, "commitment" | "clientId" | "clinicName" | "consumedAt" | "issuedAt">[]>(),
    DelegationSession.find({dogTagIdField, kind: "revoke", status: "confirmed"})
      .select("commitment consumedAt issuedAt")
      .lean<Pick<DelegationSessionDoc, "commitment" | "consumedAt" | "issuedAt">[]>(),
  ]);

  let chainActive: Set<string> | null = null;
  if (delegationRegistryAddress) {
    try {
      const leaves = await readDelegationLeaves(delegationRegistryAddress, dogTagIdField);
      chainActive = new Set(leaves.filter((l) => l !== `0x${"0".repeat(64)}`).map((l) => l.toLowerCase()));
    } catch {
      chainActive = null;
    }
  }

  const rows = buildSecondaryOwnerRows(
    confirmedAdds
      .filter((s): s is typeof s & {commitment: string} => Boolean(s.commitment))
      .map((s) => ({commitment: s.commitment!.toLowerCase(), clientId: s.clientId, clinicName: s.clinicName, at: s.consumedAt ?? s.issuedAt})),
    confirmedRevokes
      .filter((s): s is typeof s & {commitment: string} => Boolean(s.commitment))
      .map((s) => ({commitment: s.commitment!.toLowerCase(), at: s.consumedAt ?? s.issuedAt})),
    chainActive,
  );

  const clientIds = [...new Set([primaryOwnerClientId, ...rows.map((r) => r.clientId)].filter((id): id is string => Boolean(id)))];
  const clients = clientIds.length > 0 ? await Client.find({clientId: {$in: clientIds}}).select("clientId name").lean<Pick<ClientDoc, "clientId" | "name">[]>() : [];
  const nameByClientId = new Map(clients.map((c) => [c.clientId, c.name]));

  return {
    primaryOwnerClientId,
    primaryOwnerName: primaryOwnerClientId ? nameByClientId.get(primaryOwnerClientId) : undefined,
    secondaries: rows.map((r) => ({...r, clientName: r.clientId ? nameByClientId.get(r.clientId) : undefined})),
    chainVerified: chainActive !== null,
    delegationConfigured: Boolean(delegationRegistryAddress),
  };
}
