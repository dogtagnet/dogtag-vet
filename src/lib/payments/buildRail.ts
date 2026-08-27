import "server-only";
import type {PaymentChainKey} from "@/lib/chains";
import type {CryptoRail, PaymentToken} from "@/lib/models/Payment";
import {tokenInfo} from "@/lib/payments/tokenRegistry";
import {idealAmountBase, pickDust} from "@/lib/payments/amountBase";
import {buildEip681Uri} from "@/lib/payments/eip681";
import {makeTryReserve} from "@/lib/payments/reservations";

export interface BuildCryptoRailInput {
  paymentId: string;
  chainKey: PaymentChainKey;
  token: PaymentToken;
  fiatTotal: string;
  quotedRate: string; // fiat per token, already resolved (live, cached, or manual)
  receivingAddress: string;
}

/** Assembles one `Payment.crypto[]` entry end to end: converts the invoice's fiat total at the
 * given rate into token base units, reserves a unique dust suffix against every other currently
 * open payment on this exact (chain, token, address), and builds the EIP-681 URI the QR encodes.
 * Throws `DustExhaustedError` (see `amountBase.ts`) in the - practically unreachable for a
 * single-clinic deployment - case all 999 dust values on this rail are already spoken for. */
export async function buildCryptoRail(input: BuildCryptoRailInput): Promise<CryptoRail> {
  const info = tokenInfo(input.chainKey, input.token);
  const base = idealAmountBase(input.fiatTotal, input.quotedRate, info.decimals);
  const tryReserve = makeTryReserve(input.paymentId, input.chainKey, input.token, input.receivingAddress);
  const amountBase = await pickDust(base, tryReserve);

  const eip681 = info.address
    ? buildEip681Uri({
        kind: "erc20",
        chainId: info.chainId,
        tokenAddress: info.address,
        to: input.receivingAddress as `0x${string}`,
        amountBase,
      })
    : buildEip681Uri({
        kind: "native",
        chainId: info.chainId,
        to: input.receivingAddress as `0x${string}`,
        amountBaseWei: amountBase,
      });

  return {
    chainKey: input.chainKey,
    token: input.token,
    tokenAddress: info.address,
    decimals: info.decimals,
    quotedRate: input.quotedRate,
    amountBase,
    receivingAddress: input.receivingAddress,
    eip681,
  };
}
