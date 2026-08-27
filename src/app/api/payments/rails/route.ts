import {NextResponse} from "next/server";
import {connectToDatabase} from "@/lib/db";
import {getClinicSettings} from "@/lib/models/ClinicSettings";
import {requireStaffSession} from "@/lib/staffApi";
import {ALL_CHAIN_KEYS, ALL_TOKENS, tokenInfo} from "@/lib/payments/tokenRegistry";

export interface RailAvailability {
  chainKey: (typeof ALL_CHAIN_KEYS)[number];
  token: (typeof ALL_TOKENS)[number];
  receivingAddressConfigured: boolean;
  placeholder: boolean;
}

/** `GET /api/payments/rails` - staff-only. Everything returned is public-on-chain information (a
 * token contract address, whether a receiving address is set) - safe to expose directly rather
 * than duplicating the token registry client-side, so the payment-creation form can grey out and
 * annotate rails this deployment cannot actually accept yet. */
export async function GET() {
  const {response} = await requireStaffSession();
  if (response) return response;

  await connectToDatabase();
  const settings = await getClinicSettings();
  const configuredChains = new Set(settings.receivingAddresses.map((r) => r.chainKey));

  const rails: RailAvailability[] = [];
  for (const chainKey of ALL_CHAIN_KEYS) {
    for (const token of ALL_TOKENS) {
      const info = tokenInfo(chainKey, token);
      rails.push({
        chainKey,
        token,
        receivingAddressConfigured: configuredChains.has(chainKey),
        placeholder: Boolean(info.placeholder),
      });
    }
  }

  return NextResponse.json(rails);
}
