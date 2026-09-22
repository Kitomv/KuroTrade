// Connect/disconnect Phantom + show short address. Uses the wallet adapter
// context — the key never leaves the wallet.
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { WalletName } from '@solana/wallet-adapter-base';
import { shortAddr } from '../lib/solana';

export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { publicKey, disconnect, connected, connect, select, wallet, wallets } = useWallet();
  const { setVisible } = useWalletModal();

  const handleConnect = async () => {
    // If Phantom is injected via window.solana, connect directly (no modal).
    const anyWin = window as any;
    if (anyWin.solana?.isPhantom) {
      // Prefer the adapter's own connect; if no adapter selected, pick Phantom.
      if (!wallet) {
        const phantom = wallets.find((w) => w.adapter.name.toLowerCase().includes('phantom'));
        if (phantom) {
          try { select(phantom.adapter.name as WalletName); } catch {}
        }
      }
      try {
        await connect();
        return;
      } catch {
        // fall through to modal on failure
      }
    }
    setVisible(true);
  };

  if (!connected || !publicKey) {
    return (
      <button className="btn primary" style={{ fontSize: compact ? 12 : 13 }} onClick={handleConnect}>
        Connect Phantom
      </button>
    );
  }

  return (
    <button
      className="btn"
      style={{ fontSize: compact ? 12 : 13, fontFamily: 'var(--font-heading)' }}
      title={`${publicKey.toBase58()} — klik untuk disconnect`}
      onClick={() => disconnect().catch(() => {})}
    >
      {shortAddr(publicKey.toBase58())}
    </button>
  );
}
