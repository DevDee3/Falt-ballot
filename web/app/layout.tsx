import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";
import { WalletProvider } from "@/components/WalletProvider";
import { ConnectButton } from "@/components/ConnectButton";
import { CONFIG } from "@/lib/config";

export const metadata: Metadata = {
  title: "Flat Ballot",
  description: "Launch a $WIF election in one transaction. Vote by sending $WIF to an address. Every vote burns, and every result can be recomputed from the chain.",
};

function Mark() {
  return (
    <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden>
      <rect x="1.5" y="1.5" width="23" height="23" fill="none" stroke="#0f2233" strokeWidth="2" />
      <path d="M1.5 13h23M13 1.5v23" stroke="#0f2233" strokeWidth="1.4" />
      <path d="M5 21 L9 5" stroke="#d6303b" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M10 21 L14 5" stroke="#d6303b" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <header className="site-head">
            <div className="wrap">
              <Link href="/" className="brand">
                <Mark /> Flat Ballot
              </Link>
              <nav className="nav" aria-label="Main">
                <a href="/#elections" className="hide-sm">Elections</a>
                <a href="/create"><span className="hide-sm">Start an election</span><span className="show-sm">Start</span></a>
                <ConnectButton />
              </nav>
            </div>
          </header>
          <main>{children}</main>
          <footer className="foot">
            <div className="wrap">
              <span>Built for the World is Flat hackathon. Independent of Robinhood Markets, Inc.</span>
              <a href={`${CONFIG.explorer}/token/${CONFIG.wif}`} target="_blank" rel="noreferrer">$WIF contract</a>
            </div>
          </footer>
        </WalletProvider>
      </body>
    </html>
  );
}
