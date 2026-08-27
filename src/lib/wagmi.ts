import {http, createConfig} from "wagmi";
import {metaMask} from "wagmi/connectors";
import {roax} from "@/lib/chains";

/**
 * Wallet config for chain-identity operations (setup wizard, tag issuance, verification relaying,
 * revoke/reactivate). Scoped to ROAX only here - the payment side of the app reads chain state
 * with plain viem public clients (no wallet needed to watch for incoming transfers) and is wired
 * separately when the payment worker lands.
 */
export const wagmiConfig = createConfig({
  chains: [roax],
  connectors: [metaMask()],
  transports: {
    [roax.id]: http(),
  },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
