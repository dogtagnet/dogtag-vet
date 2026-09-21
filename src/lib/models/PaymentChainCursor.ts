import {Schema} from "mongoose";
import {getOrCreateModel} from "@/lib/models/registerModel";

/** The payment watcher's per-chain scan cursor (`src/worker/index.ts`'s payment loop) - the next
 * block to scan from on that chain. Kept as its own tiny collection (one document per payment
 * chain - today, exactly one, `roax`) rather than folded into `ClinicSettings`, since the registry
 * design (plans/wp4.18-roax-payments.md section 7: "a future chain is a config and registry
 * addition, never a rewrite") anticipates more than one document here again eventually, and
 * because - unlike the chain-activity follower, which only ever watches this clinic's single ROAX
 * clone - the payment watcher's cursor is keyed per payment chain, independently. */
export interface PaymentChainCursorDoc {
  _id: string; // PaymentChainKey
  blockNumber: number;
}

const paymentChainCursorSchema = new Schema<PaymentChainCursorDoc>({
  _id: {type: String, required: true},
  blockNumber: {type: Number, required: true, default: 0},
});

export const PaymentChainCursor = getOrCreateModel<PaymentChainCursorDoc>(
  "PaymentChainCursor",
  paymentChainCursorSchema,
);
