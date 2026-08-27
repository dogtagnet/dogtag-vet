import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";
import {randomUUID} from "node:crypto";

/** Pet photos and generated PDFs (invoices, receipts). Content is stored as a Buffer directly on
 * the document - fine at this scale (single-clinic deployments, small photo/PDF counts) and keeps
 * the deployment story to "just Mongo", per the one-pager quickstart in docs/DEPLOY.md. */
export interface StoredFileDoc {
  fileId: string;
  filename: string;
  contentType: string;
  byteLength: number;
  data: Buffer;
  createdAt: Date;
}

const storedFileSchema = new Schema<StoredFileDoc>(
  {
    fileId: {type: String, required: true, unique: true, default: () => randomUUID()},
    filename: {type: String, required: true},
    contentType: {type: String, required: true},
    byteLength: {type: Number, required: true},
    data: {type: Buffer, required: true},
  },
  {timestamps: {createdAt: true, updatedAt: false}},
);

export const StoredFile =
  getOrCreateModel<StoredFileDoc>("StoredFile", storedFileSchema);
