import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";

export type AppointmentStatus =
  | "scheduled"
  | "confirmed"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "no_show";

export type AppointmentSource = "staff" | "public_booking" | "mobile";

export interface AppointmentDoc {
  appointmentId: string;
  clientId?: string;
  /** WP4.3 A1: replaces the never-set `petId?` - one client, N pets. Always an array on any
   * document created after this change (mongoose `default: []`); a document from before it exists
   * only in history no environment actually carries (verified at design time - see
   * plans/wp4.3-appointment-tagging-client-id.md's Facts section), but `default` only fires at
   * CREATION time regardless, so every read site still defensively coalesces with `?? []` rather
   * than trusting the type alone (the same class of gap `ClientDoc.wallets` has - see
   * `api/clients/[id]/route.ts`'s doc comment on it). */
  petIds: string[];
  serviceId?: string;
  staffName?: string;
  startAt: number; // unix seconds
  endAt: number; // unix seconds
  status: AppointmentStatus;
  notes?: string;
  source: AppointmentSource;
  clientName: string;
  petName: string;
  cancelToken?: string;
  createdAt: Date;
  updatedAt: Date;
}

const appointmentSchema = new Schema<AppointmentDoc>(
  {
    appointmentId: {type: String, required: true, unique: true, default: () => randomUUID()},
    clientId: {type: String, index: true},
    petIds: {type: [String], default: [], index: true},
    serviceId: {type: String, index: true},
    staffName: String,
    startAt: {type: Number, required: true, index: true},
    endAt: {type: Number, required: true},
    status: {
      type: String,
      enum: ["scheduled", "confirmed", "in_progress", "completed", "cancelled", "no_show"],
      required: true,
      default: "scheduled",
      index: true,
    },
    notes: String,
    source: {type: String, enum: ["staff", "public_booking", "mobile"], required: true},
    clientName: {type: String, required: true},
    petName: {type: String, required: true},
    cancelToken: {type: String, index: true, sparse: true, unique: true},
  },
  {timestamps: true},
);

export const Appointment =
  getOrCreateModel<AppointmentDoc>("Appointment", appointmentSchema);
