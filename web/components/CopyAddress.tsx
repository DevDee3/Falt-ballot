"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function CopyAddress({ address, label }: { address: string; label: string }) {
  const [qr, setQr] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    QRCode.toDataURL(address, { margin: 1, width: 192, color: { dark: "#0f2233", light: "#f9fbfb" } })
      .then((u) => live && setQr(u))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [address]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked: the address stays selectable on screen */
    }
  }

  return (
    <div className="addr">
      {qr ? <img src={qr} alt={`QR code for the ${label} deposit address`} width={96} height={96} /> : <div style={{ width: 96, height: 96 }} />}
      <div>
        <div className="mono" style={{ userSelect: "all" }}>{address}</div>
        <div className="actions">
          <button className="btn small" onClick={copy} aria-live="polite">{copied ? "Copied" : "Copy address"}</button>
        </div>
      </div>
    </div>
  );
}
