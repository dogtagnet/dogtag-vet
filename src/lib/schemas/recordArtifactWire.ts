import {z} from "zod";
import {hex32} from "@/lib/schemas/common";

/**
 * `RecordArtifact`'s wire shape (plan section 11.2 V6's "registry-first shape validation" step for
 * a presented record) - the record sibling of `lib/schemas/redactedArtifact.ts`'s
 * `redactedTagArtifactSchema`, mirroring `specs/schemas/dogtag.record-artifact.v1.schema.json`.
 * SHAPE only, exactly like that schema's own tag sibling: this says nothing about whether `root`
 * actually recomputes - that is `verifyRecordArtifact`'s job (`lib/records/verifier.ts`).
 */
const openedLeafWireSchema = z.object({
  keyPath: z.string().min(1),
  saltHex: z.string().regex(/^(0x)?[0-9a-fA-F]{32}$/, "Must be 16 raw bytes, hex-encoded (0x prefix optional)"),
  tag: z.number().int().min(0).max(5),
  value: z.string(),
});

export const recordArtifactWireSchema = z.object({
  protocolVersion: z.string().min(1),
  artifactType: z.literal("record"),
  schemaId: z.string().min(1).optional(),
  root: hex32,
  disclosed: z.array(openedLeafWireSchema),
  obfuscatedLeafHashes: z.array(hex32),
  // ALWAYS EMPTY for a record (specs/leaf-commitment.md section 16) - unlike a tag's exactly-3.
  reservedLeafHashes: z.array(hex32).length(0),
});
export type RecordArtifactWireInput = z.infer<typeof recordArtifactWireSchema>;
