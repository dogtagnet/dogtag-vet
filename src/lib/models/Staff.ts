import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";

export type StaffRole = "owner" | "staff";

/**
 * A staff account's role, keyed by email and independent of whichever Auth.js adapter/provider
 * authenticated the sign-in (Google, email magic link, or the dev-only credentials provider) -
 * the `jwt` callback in src/lib/auth.ts looks this up by email and stamps `role` onto the token.
 * The FIRST staff record ever created becomes `owner`; every one after that defaults to `staff`.
 */
export interface StaffDoc {
  staffId: string;
  email: string;
  name?: string;
  role: StaffRole;
  createdAt: Date;
  updatedAt: Date;
}

const staffSchema = new Schema<StaffDoc>(
  {
    staffId: {type: String, required: true, unique: true, default: () => randomUUID()},
    email: {type: String, required: true, unique: true, lowercase: true, trim: true},
    name: String,
    role: {type: String, enum: ["owner", "staff"], required: true, default: "staff"},
  },
  {timestamps: true},
);

export const Staff = getOrCreateModel<StaffDoc>("Staff", staffSchema);

/** Look up (or provision) the Staff record for a freshly authenticated email: the first ever
 * staff record becomes `owner`, every subsequent one is `staff`. Called from the Auth.js `jwt`
 * callback on every sign-in, so it is idempotent for an already-provisioned email. */
export async function ensureStaffForEmail(email: string, name?: string): Promise<StaffDoc> {
  const normalized = email.toLowerCase().trim();
  const existing = await Staff.findOne({email: normalized}).lean<StaffDoc>();
  if (existing) return existing;

  const staffCount = await Staff.countDocuments();
  const role: StaffRole = staffCount === 0 ? "owner" : "staff";
  const created = await Staff.create({email: normalized, name, role});
  return created.toObject();
}
