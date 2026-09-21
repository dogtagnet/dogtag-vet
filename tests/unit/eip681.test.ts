import {describe, expect, it} from "vitest";
import {buildEip681Uri} from "@/lib/payments/eip681";
import {resolveTokenInfo, defaultAddressesFor, ALL_CHAIN_KEYS} from "@/lib/payments/tokenTable";

const RECEIVING = "0x1111111111111111111111111111111111111a";
const ROAX_CHAIN_ID = 135;

describe("buildEip681Uri", () => {
  it("builds the native asset form: ethereum:<addr>@<chainId>?value=<wei>", () => {
    const uri = buildEip681Uri({kind: "native", chainId: 1, to: RECEIVING, amountBaseWei: "1500000000000000000"});
    expect(uri).toBe(`ethereum:${RECEIVING}@1?value=1500000000000000000`);
  });

  it("builds the ERC-20 form with the TOKEN address after the scheme and the recipient in address=", () => {
    const token = "0x2222222222222222222222222222222222222b";
    const uri = buildEip681Uri({kind: "erc20", chainId: 8453, tokenAddress: token, to: RECEIVING, amountBase: "50000000"});
    expect(uri).toBe(`ethereum:${token}@8453/transfer?address=${RECEIVING}&uint256=50000000`);
    // Regression: the token contract address must be the URI authority, and the vet's own
    // receiving address must be the `address=` query param - never swapped.
    expect(uri.startsWith(`ethereum:${token}@`)).toBe(true);
    expect(uri).toContain(`address=${RECEIVING}`);
  });

  it("generates a valid URI for ROAX's two tokens (PLASMA native, RUSD ERC-20) via the real token registry", () => {
    expect(ALL_CHAIN_KEYS).toEqual(["roax"]);
    for (const chainKey of ALL_CHAIN_KEYS) {
      const addresses = defaultAddressesFor(chainKey);
      for (const token of ["PLASMA", "RUSD"] as const) {
        const info = resolveTokenInfo(chainKey, token, addresses, ROAX_CHAIN_ID);
        expect(info.chainId).toBe(ROAX_CHAIN_ID);

        const uri = info.address
          ? buildEip681Uri({kind: "erc20", chainId: info.chainId, tokenAddress: info.address, to: RECEIVING, amountBase: "1000"})
          : buildEip681Uri({kind: "native", chainId: info.chainId, to: RECEIVING, amountBaseWei: "1000"});

        expect(uri.startsWith("ethereum:")).toBe(true);
        expect(uri).toContain(`@${ROAX_CHAIN_ID}`);
        if (token === "PLASMA") {
          expect(uri).toBe(`ethereum:${RECEIVING}@${ROAX_CHAIN_ID}?value=1000`);
          expect(info.decimals).toBe(18);
        } else {
          expect(uri).toContain("/transfer?address=");
          expect(uri).toContain(`address=${RECEIVING}`);
          expect(uri).toContain("uint256=1000");
          expect(info.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
          expect(info.decimals).toBe(6);
        }
      }
    }
  });

  it("marks RUSD's default address as a placeholder until an operator overrides TOKEN_RUSD_ROAX_ADDRESS", () => {
    // RUSD is a fresh, per-deployment dev stablecoin with no canonical address this repo could
    // ever bake in (docs/DEV-TOKENS.md) - the exact same "no real deployment to point to"
    // situation the old testnet USDT slots were in before WP4.18 removed them.
    const info = resolveTokenInfo("roax", "RUSD", defaultAddressesFor("roax"), ROAX_CHAIN_ID);
    expect(info.placeholder).toBe(true);

    // Once an operator sets a real address, the placeholder flag correctly stops warning.
    const overridden = resolveTokenInfo("roax", "RUSD", {rusd: "0x9999999999999999999999999999999999999a"}, ROAX_CHAIN_ID);
    expect(overridden.placeholder).toBeUndefined();

    // PLASMA is native - never a placeholder, since there is no address to source at all.
    const plasma = resolveTokenInfo("roax", "PLASMA", defaultAddressesFor("roax"), ROAX_CHAIN_ID);
    expect(plasma.placeholder).toBeUndefined();
    expect(plasma.address).toBeUndefined();
  });
});
