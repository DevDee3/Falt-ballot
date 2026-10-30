"use client";

import { useAppKit, useAppKitAccount } from "@reown/appkit/react";
import { shortAddr } from "@/lib/format";

/** Opens Reown's modal: pick a wallet (WalletConnect QR, browser wallets), switch network, disconnect. */
export function ConnectButton() {
  const { open } = useAppKit();
  const { address, isConnected, status } = useAppKitAccount();

  if (isConnected && address) {
    return (
      <button className="btn small" onClick={() => open({ view: "Account" })} aria-label={`Wallet ${address}. Open account details`}>
        <span className="dot" style={{ color: "var(--sea)" }} aria-hidden />
        <span className="mono">{shortAddr(address)}</span>
      </button>
    );
  }
  return (
    <button className="btn small primary" onClick={() => open({ view: "Connect" })} disabled={status === "connecting"}>
      {status === "connecting" ? "Connecting…" : "Connect wallet"}
    </button>
  );
}
