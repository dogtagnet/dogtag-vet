import "server-only";
import {entityKindsFromMask, type EntityKindId} from "@dogtag/standard";
import type {ClinicSettingsDoc} from "@/lib/models/ClinicSettings";
import {readEntityKinds} from "@/lib/chainRead";
import {getServerEnv} from "@/lib/env";
import {DEFAULT_ENTITY_KINDS} from "@/lib/entityCard";

type Address = `0x${string}`;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The kinds `GET /v1/entity` reports for this clinic (WP4.21, plan 2.11): read from the registry for
 * the clinic's OWN entity account. Kinds are a record only, so this can never fail the card: no
 * registry configured, no (valid) entity account, an unregistered account, an unreadable chain, or a
 * mask with no kind this build knows all resolve to the default `["VET"]`. `read` is injectable so
 * the unit tests drive it without a chain.
 */
export async function resolveEntityCardKinds(
  settings: Pick<ClinicSettingsDoc, "entityAccount">,
  deps: {
    registryAddress?: string;
    read?: typeof readEntityKinds;
  } = {},
): Promise<EntityKindId[]> {
  const registry = deps.registryAddress ?? getServerEnv().ENTITY_REGISTRY_ADDRESS;
  const account = settings.entityAccount;
  if (!registry || !ADDRESS_RE.test(registry) || !account || !ADDRESS_RE.test(account)) return [...DEFAULT_ENTITY_KINDS];
  try {
    const result = await (deps.read ?? readEntityKinds)(registry as Address, account as Address);
    if (result.status !== "registered") return [...DEFAULT_ENTITY_KINDS];
    const kinds = entityKindsFromMask(result.mask);
    return kinds.length > 0 ? kinds : [...DEFAULT_ENTITY_KINDS];
  } catch {
    return [...DEFAULT_ENTITY_KINDS];
  }
}
