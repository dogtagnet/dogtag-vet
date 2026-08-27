"use client";

import {useState, type ReactNode} from "react";
import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {WagmiProvider} from "wagmi";
import {wagmiConfig} from "@/lib/wagmi";
import {SnackbarProvider} from "@/components/ui/Snackbar";

/** Client-side provider tree: wagmi (wallet/chain state) + TanStack Query (wagmi's own
 * requirement, also used for our own data fetching) + the Snackbar host. Mounted once in the root
 * layout so any client component anywhere can use wagmi hooks or useSnackbar(). */
export function Providers({children}: {children: ReactNode}) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SnackbarProvider>{children}</SnackbarProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
