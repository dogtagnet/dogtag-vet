import {z} from "zod";
import {hex32} from "@/lib/schemas/common";

/**
 * `RedactedTagArtifact`'s wire shape (WP4.10V item 5's "registry-first shape validation" step),
 * mirroring `dogtag.redacted-tag-artifact.v1.schema.json` field-for-field (protocol/specs/schemas/
 * dogtag.redacted-tag-artifact.v1.schema.json) - SHAPE only, exactly like that registry schema's
 * own description states ("this schema says nothing about whether root actually recomputes...
 * that is verifyRedactedArtifact's job"). This app avoids a full JSON-Schema-registry/ajv
 * dependency for wire validation elsewhere (`lib/schemas/tagImport.ts`'s own precedent) - this is
 * that same "a testable gate mirroring the registry, not a fetched-and-checked schema" convention,
 * applied to the one NEW record shape this wave introduces.
 */
const decimalStringNoLeadingZero = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, "Must be a canonical non-negative decimal integer string (no leading zeros)");

/** Mirrors the registry schema's own `$defs.openedLeaf` exactly - notably `saltHex`'s `0x` prefix
 * is OPTIONAL there (unlike this app's own `hex16Salt`, which is stricter/always-prefixed for ITS
 * own wire conventions elsewhere) - this schema is deliberately no stricter than the registry it
 * mirrors, since a pasted artifact may have come from anywhere, not just this app's own writes. */
const openedLeafWireSchema = z.object({
  keyPath: z.string().min(1),
  saltHex: z.string().regex(/^(0x)?[0-9a-fA-F]{32}$/, "Must be 16 raw bytes, hex-encoded (0x prefix optional)"),
  tag: z.number().int().min(0).max(5),
  value: z.string(),
});

export const redactedTagArtifactSchema = z.object({
  protocolVersion: z.string().min(1),
  schemaId: z.string().min(1).optional(),
  dogTagIdDec: decimalStringNoLeadingZero.optional(),
  dogTagIdField: decimalStringNoLeadingZero,
  root: hex32,
  disclosed: z.array(openedLeafWireSchema),
  obfuscatedLeafHashes: z.array(hex32),
  reservedLeafHashes: z.array(hex32).length(3),
  issuerClone: z.string().min(1),
});
export type RedactedTagArtifactWire = z.infer<typeof redactedTagArtifactSchema>;
