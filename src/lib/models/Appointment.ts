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
  petId?: string;
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
    petId: {type: String, index: true},
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
