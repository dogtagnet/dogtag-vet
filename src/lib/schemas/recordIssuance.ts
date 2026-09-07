import {z} from "zod";
import {decimalString, hexAddress, isoDate} from "@/lib/schemas/common";
import {isKnownRecordStandard, KNOWN_RECORD_STANDARDS} from "@/lib/records/standards";

/**
 * `POST /api/pets/:id/records` request body - plan section 11.2 item V3's issuance form.
 *
 * Deliberately carries NO `saltHex`/`leaves`/`root` field of any kind: every leaf a record ever
 * carries is either derived from CONTEXT this route reads itself (the pet's own `dogTagIdField`,
 * the clinic's clone/chain settings, the practitioner's composed name) or from one of the plain
 * clinical fields below - `lib/records/build.ts`'s `buildVaccinationRecord` is the ONLY place a
 * salt or a root is ever computed, always server-side. A client that tried to smuggle a chosen
 * salt or a pre-computed root through this schema has no field to put it in.
 */
export const vaccinationRecordFormSchema = z.object({
  targetDisease: z.string().trim().min(1).max(200),
  targetDiseaseCode: z.string().trim().max(120).optional(),
  vaccineProductName: z.string().trim().min(1).max(200),
  vaccineProductCode: z.string().trim().max(120).optional(),
  vaccineManufacturer: z.string().trim().min(1).max(200),
  batchLotNumber: z.string().trim().min(1).max(120),
  vaccinationDate: isoDate,
  validFrom: isoDate,
  validUntil: isoDate,
  nextDueDate: isoDate.optional(),
  series: z.enum(["primary", "booster"]).optional(),
  route: z.string().trim().max(120).optional(),
  site: z.string().trim().max(120).optional(),
  doseQuantity: decimalString.optional(),
  vaccineExpirationDate: isoDate.optional(),
});

/** One entry of the issuing vet's OWN claim that this record's data was filled out to satisfy a
 * known external standard (`lib/records/standards.ts`) - UNCOMMITTED, descriptive-only, and never
 * itself verified against the record's leaves (see that module's own doc comment for why not: the
 * registry is explicitly "nothing ... parses, validates, or enforces any of it"). Only the
 * (standard, version) PAIR is checked, against the whitelist - a client cannot claim conformance to
 * a standard this protocol version does not even recognize. */
const conformsToEntrySchema = z
  .object({
    standard: z.string().trim().min(1).max(120),
    version: z.string().trim().min(1).max(60),
  })
  .refine((entry) => isKnownRecordStandard(entry.standard, entry.version), {
    message: "Unrecognized standard/version pair - see lib/records/standards.ts for the known list.",
  });

export const createRecordArtifactSchema = z.object({
  /** The staff member's currently-connected wallet - the server preflights whitelist status
   * against THIS address (never `ClinicSettings.operatorWallet`), exactly like
   * `startMintSessionSchema.operatorAddress`'s own doc comment states for tags. */
  operatorAddress: hexAddress,
  form: vaccinationRecordFormSchema,
  conformsTo: z.array(conformsToEntrySchema).max(KNOWN_RECORD_STANDARDS.length).optional(),
});

export type VaccinationRecordFormInput = z.infer<typeof vaccinationRecordFormSchema>;
