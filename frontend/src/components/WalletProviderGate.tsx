// Persistent wallet-adapter provider stack. Mounted once around the authenticated
// app, not inside Portfolio, so changing pages does not disconnect Phantom.
// Importers/callers: App.tsx. API/data: none; ConnectionProvider owns RPC,
// WalletProvider owns the adapter connection. User request: keep wallet connected
// when leaving Portfolio.
import React, { useMemo } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { RealWalletProvider } from './RealWalletContext';
import { SOLANA_RPC } from '../lib/solana';
import '@solana/wallet-adapter-react-ui/styles.css';

export default function WalletProviderGate({ children }: { children: React.ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter()], []);
  // createElement avoids TS2786 with wallet-adapter's older React types.
  return React.createElement(
    ConnectionProvider as any,
    { endpoint: SOLANA_RPC },
    React.createElement(
      WalletProvider as any,
      { wallets, autoConnect: false },
      React.createElement(
        WalletModalProvider as any,
        null,
        React.createElement(RealWalletProvider, null, children),
      ),
    ),
  );
}