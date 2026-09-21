/**
 * EIP-681 payment URI builder, per `protocol/specs/qr-formats.md`'s "Payment QR" section (the
 * exact grammar there is normative). Pure and dependency-free so it can be unit-tested against
 * fixed fixtures for both ROAX tokens (PLASMA native, RUSD ERC-20) without touching env, the token
 * registry, or any network call - see `tests/unit/eip681.test.ts`.
 */
export interface Eip681NativeInput {
  kind: "native";
  chainId: number;
  to: `0x${string}`;
  /** Exact expected amount in wei, decimal digits only (no separators) - `amountBase` as stored on
   * the payment's crypto rail. */
  amountBaseWei: string;
}

export interface Eip681TokenInput {
  kind: "erc20";
  chainId: number;
  /** The ERC-20 contract address - appears right after the `ethereum:` scheme, per the spec's
   * `ethereum:<token>@<chainId>/transfer?...` grammar. Not the recipient. */
  tokenAddress: `0x${string}`;
  /** The vet's receiving address - goes in the `address=` query parameter, not the URI authority. */
  to: `0x${string}`;
  /** Exact expected amount in the token's smallest unit, decimal digits only. */
  amountBase: string;
}

export type Eip681Input = Eip681NativeInput | Eip681TokenInput;

/** Builds the exact URI string a general-purpose QR scanner falls through to a wallet app for.
 * See qr-formats.md's two grammars: native asset transfer vs. ERC-20 `/transfer`. */
export function buildEip681Uri(input: Eip681Input): string {
  if (input.kind === "native") {
    return `ethereum:${input.to}@${input.chainId}?value=${input.amountBaseWei}`;
  }
  return `ethereum:${input.tokenAddress}@${input.chainId}/transfer?address=${input.to}&uint256=${input.amountBase}`;
}
