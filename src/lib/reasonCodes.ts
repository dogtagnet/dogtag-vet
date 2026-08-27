import {keccak256, toBytes} from "viem";

/**
 * `revokeTag`/`reactivateTag`/`revokeEntity` all take a `bytes32 reasonCode` (see
 * `protocol/contracts/exports/abi/VetIssuer.json`, `EntityRegistry.json`), but this protocol
 * snapshot vendors no fixed reason-code table anywhere (`protocol/specs/events.md` and the
 * flattened contracts only ever name a `reasonCode` PARAMETER, never a list of values - unlike
 * `RECORD_TYPE_*`, which the clone itself exposes as view functions). This repo therefore defines
 * its own list, deriving each value the same documented way `specs/issuer-attestation.md` says
 * `recordType` is derived ("the keccak256-derived constant ... never a free string"):
 * `keccak256(utf8Bytes(name))`. `wp4-vet.md` names `REASON_REPLACED` explicitly for the
 * replace-tag wizard; the rest of this list covers the reasons a vet realistically revokes or
 * reactivates a tag.
 */
export const REASON_CODES = [
  {name: "REASON_OWNER_REQUEST", label: "Owner requested"},
  {name: "REASON_LOST", label: "Tag lost"},
  {name: "REASON_STOLEN", label: "Tag stolen"},
  {name: "REASON_DECEASED", label: "Pet deceased"},
  {name: "REASON_ERROR_CORRECTION", label: "Correcting an error"},
  {name: "REASON_FRAUD", label: "Suspected fraud"},
  {name: "REASON_REPLACED", label: "Replaced by a new tag"},
  {name: "REASON_OTHER", label: "Other"},
] as const;

export type ReasonCodeName = (typeof REASON_CODES)[number]["name"];

const HASH_BY_NAME = new Map<string, `0x${string}`>(REASON_CODES.map((r) => [r.name, keccak256(toBytes(r.name))]));
const NAME_BY_HASH = new Map<string, ReasonCodeName>([...HASH_BY_NAME].map(([name, hash]) => [hash, name as ReasonCodeName]));

export function reasonCodeHash(name: ReasonCodeName): `0x${string}` {
  const hash = HASH_BY_NAME.get(name);
  if (!hash) throw new Error(`Unknown reason code: ${name}`);
  return hash;
}

/** Best-effort reverse lookup for rendering a reason code read back off a chain event -
 * `undefined` for a hash this deployment doesn't recognize (e.g. from a differently-configured
 * vet, or a future addition), rendered as the raw hash rather than a guess. */
export function reasonCodeLabel(hash: string): string | undefined {
  const name = NAME_BY_HASH.get(hash.toLowerCase());
  return name ? REASON_CODES.find((r) => r.name === name)?.label : undefined;
}
