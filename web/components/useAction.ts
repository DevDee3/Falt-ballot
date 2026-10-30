"use client";

import { useCallback, useState } from "react";
import type { Address, Hex } from "viem";
import { readableError, writeAndWait } from "@/lib/chain";
import { useWallet } from "./WalletProvider";

export interface WriteReq {
  address: Address;
  abi: any;
  functionName: string;
  args: any[];
}

/** Runs wallet writes with one busy flag, one error slot and the last tx hash. */
export function useAction(onDone?: () => void) {
  const { account, connectWallet } = useWallet();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<Hex | null>(null);

  const run = useCallback(
    async (label: string, steps: (from: Address) => Promise<Hex | void>) => {
      setError(null);
      setBusy(label);
      try {
        const from = account ?? (await connectWallet());
        if (!from) {
          setError("Connect a wallet to continue.");
          return;
        }
        const hash = await steps(from);
        if (hash) setTx(hash);
        onDone?.();
      } catch (e) {
        setError(readableError(e));
      } finally {
        setBusy(null);
      }
    },
    [account, connectWallet, onDone],
  );

  const write = useCallback((from: Address, req: WriteReq) => writeAndWait(from, req), []);
  return { run, write, busy, error, tx, clearError: () => setError(null) };
}
