import {describe, expect, it} from "vitest";
import {buildEip681Uri} from "@/lib/payments/eip681";
import {resolveTokenInfo, defaultAddressesFor, ALL_CHAIN_KEYS} from "@/lib/payments/tokenTable";
import type {PaymentChainKey} from "@/lib/chains";

const RECEIVING = "0x1111111111111111111111111111111111111a";

const EXPECTED_CHAIN_IDS: Record<PaymentChainKey, number> = {
  ethereum: 1,
  base: 8453,
  sepolia: 11155111,
  baseSepolia: 84532,
};

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

  it("generates a valid URI for all four chains and all three tokens via the real token registry", () => {
    for (const chainKey of ALL_CHAIN_KEYS) {
      const addresses = defaultAddressesFor(chainKey);
      for (const token of ["ETH", "USDC", "USDT"] as const) {
        const info = resolveTokenInfo(chainKey, token, addresses);
        expect(info.chainId).toBe(EXPECTED_CHAIN_IDS[chainKey]);

        const uri = info.address
          ? buildEip681Uri({kind: "erc20", chainId: info.chainId, tokenAddress: info.address, to: RECEIVING, amountBase: "1000"})
          : buildEip681Uri({kind: "native", chainId: info.chainId, to: RECEIVING, amountBaseWei: "1000"});

        expect(uri.startsWith("ethereum:")).toBe(true);
        expect(uri).toContain(`@${EXPECTED_CHAIN_IDS[chainKey]}`);
        if (token === "ETH") {
          expect(uri).toBe(`ethereum:${RECEIVING}@${EXPECTED_CHAIN_IDS[chainKey]}?value=1000`);
        } else {
          expect(uri).toContain("/transfer?address=");
          expect(uri).toContain(`address=${RECEIVING}`);
          expect(uri).toContain("uint256=1000");
          expect(info.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        }
      }
    }
  });

  it("marks exactly the three testnet-USDT-with-no-canonical-deployment slots as placeholder", () => {
    const placeholderPairs: string[] = [];
    for (const chainKey of ALL_CHAIN_KEYS) {
      const info = resolveTokenInfo(chainKey, "USDT", defaultAddressesFor(chainKey));
      if (info.placeholder) placeholderPairs.push(chainKey);
    }
    expect(placeholderPairs.sort()).toEqual(["base", "baseSepolia", "sepolia"]);

    // Ethereum USDT and every USDC slot are real, non-placeholder deployments.
    expect(resolveTokenInfo("ethereum", "USDT", defaultAddressesFor("ethereum")).placeholder).toBeUndefined();
    for (const chainKey of ALL_CHAIN_KEYS) {
      expect(resolveTokenInfo(chainKey, "USDC", defaultAddressesFor(chainKey)).placeholder).toBeUndefined();
    }
  });
});
