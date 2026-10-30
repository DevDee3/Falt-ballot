"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { WagmiProvider, useAccount } from "wagmi";
import { getAccount, watchAccount } from "wagmi/actions";
import { useAppKit } from "@reown/appkit/react";
import { appKit, wagmiConfig } from "@/lib/wagmi";

interface WalletCtx {
  account: Address | null;
  connecting: boolean;
  /** Opens the wallet modal if needed. Resolves with the account, or null if the person closed the modal. */
  connectWallet: () => Promise<Address | null>;
}

const Ctx = createContext<WalletCtx>({ account: null, connecting: false, connectWallet: async () => null });
export const useWallet = () => useContext(Ctx);

function Inner({ children }: { children: ReactNode }) {
  const { address, isConnecting, isReconnecting } = useAccount();
  const { open } = useAppKit();

  const connectWallet = useCallback(
    () =>
      new Promise<Address | null>((resolve) => {
        const existing = getAccount(wagmiConfig).address;
        if (existing) return resolve(existing);

        let seenOpen = false;
        let done = false;
        const finish = (a: Address | null) => {
          if (done) return;
          done = true;
          stopAccount();
          stopModal();
          resolve(a);
        };
        const stopAccount = watchAccount(wagmiConfig, { onChange: (a) => a.address && finish(a.address) });
        const stopModal = appKit.subscribeState((s: { open: boolean }) => {
          if (s.open) seenOpen = true;
          else if (seenOpen) setTimeout(() => finish(getAccount(wagmiConfig).address ?? null), 400);
        });
        open({ view: "Connect" });
      }),
    [open],
  );

  const value = useMemo<WalletCtx>(
    () => ({ account: (address as Address | undefined) ?? null, connecting: isConnecting || isReconnecting, connectWallet }),
    [address, isConnecting, isReconnecting, connectWallet],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
      <QueryClientProvider client={queryClient}>
        <Inner>{children}</Inner>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
