/**
 * Converts a fiat amount + quoted rate into token base units, then reserves a unique dust suffix
 * in the smallest 3 decimal digits so every OPEN payment's expected on-chain amount for a given
 * (chain, token, receivingAddress) is unambiguous - wp4-vet.md's "unique sub-unit dust per open
 * payment per (chain, token, address)".
 */

export const DUST_MIN = 1;
export const DUST_MAX = 999;
const DUST_MODULUS = 1000n;

/**
 * The fiat->base-unit conversion rounds UP to the next multiple of 1000 base units before dust is
 * added (never down): a payer following the exact posted amount always sends at least as much as
 * the quoted fiat value converts to, dust included - the clinic is never shorted by the rounding
 * step itself. `fiatAmount` and `quotedRate` are canonical decimal strings (fiat per token, and
 * the invoice's fiat total respectively); both are parsed with a fixed-point scale wide enough
 * (30 digits) that intermediate precision loss versus a real bignum-decimal library is not
 * observable at the sub-cent dust scale this feeds into.
 */
export function idealAmountBase(fiatAmount: string, quotedRate: string, decimals: number): bigint {
  const SCALE = 10n ** 30n;
  const fiatScaled = toScaledBigInt(fiatAmount, SCALE);
  const rateScaled = toScaledBigInt(quotedRate, SCALE);
  if (rateScaled === 0n) throw new Error("quotedRate must be positive");

  // tokens = fiat / rate; base units = tokens * 10^decimals
  // = (fiatScaled / SCALE) / (rateScaled / SCALE) * 10^decimals
  // = fiatScaled * 10^decimals / rateScaled  (the SCALE cancels)
  const numerator = fiatScaled * 10n ** BigInt(decimals);
  const base = ceilDiv(numerator, rateScaled);

  return ceilToModulus(base, DUST_MODULUS);
}

function toScaledBigInt(decimalString: string, scale: bigint): bigint {
  const [whole = "0", frac = ""] = decimalString.split(".");
  const scaleDigits = scale.toString().length - 1;
  const fracPadded = (frac + "0".repeat(scaleDigits)).slice(0, scaleDigits);
  return BigInt(whole || "0") * scale + BigInt(fracPadded || "0");
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function ceilToModulus(value: bigint, modulus: bigint): bigint {
  const remainder = value % modulus;
  return remainder === 0n ? value : value + (modulus - remainder);
}

/** Appends a dust value (1-999) into the smallest 3 decimal digits of `base` (which is always a
 * multiple of 1000, per `idealAmountBase`). */
export function withDust(base: bigint, dust: number): string {
  if (dust < DUST_MIN || dust > DUST_MAX) throw new Error(`dust out of range: ${dust}`);
  return (base + BigInt(dust)).toString();
}

export class DustExhaustedError extends Error {
  constructor() {
    super("Every dust value (1-999) for this rail is already in use by another open payment.");
    this.name = "DustExhaustedError";
  }
}

/**
 * Tries dust values 1..999 in order, asking `tryReserve` (an atomic "claim this exact amountBase
 * or tell me someone already has it" operation - see `AmountReservation.ts`) to claim each
 * candidate until one succeeds. Sequential rather than random: for a single-clinic deployment with
 * at most a handful of concurrently open payments per rail, trying in order finds a free slot in
 * O(1) expected attempts and keeps the behavior deterministic for tests.
 */
export async function pickDust(base: bigint, tryReserve: (amountBase: string) => Promise<boolean>): Promise<string> {
  for (let dust = DUST_MIN; dust <= DUST_MAX; dust++) {
    const candidate = withDust(base, dust);
    if (await tryReserve(candidate)) return candidate;
  }
  throw new DustExhaustedError();
}
