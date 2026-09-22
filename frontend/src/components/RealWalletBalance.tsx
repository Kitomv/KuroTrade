// Compact on-chain balance summary for the global Real Wallet panel.
// Importers/callers: RealWalletControl. Requires the hoisted wallet provider.
// API/data: uses useWallet/useConnection + RPC; no backend API.
// Data schema: in-memory <sol:number, tokens:number>.
// User instruction: "yang di porto hilangin real walletnya" — move real UI to global panel.
import { useEffect, useState } from 'react';
import { PublicKey } from '@solana/web3.js';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

export function RealWalletBalance() {
  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const [sol, setSol] = useState<number | null>(null);
  const [tokens, setTokens] = useState(0);

  useEffect(() => {
    if (!connected || !publicKey) { setSol(null); setTokens(0); return; }
    let cancelled = false;
    (async () => {
      try {
        const [lamports, accounts] = await Promise.all([
          connection.getBalance(publicKey),
          connection.getParsedTokenAccountsByOwner(publicKey, { programId: TOKEN_PROGRAM_ID }),
        ]);
        if (cancelled) return;
        setSol(lamports / 1_000_000_000);
        setTokens(accounts.value.filter((a) => Number(a.account.data.parsed.info.tokenAmount.uiAmount) > 0).length);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [connected, publicKey, connection]);

  if (!connected) return null;
  return (
    <div className="rwc-balance">
      <span><b>{sol === null ? '…' : sol.toFixed(4)}</b> SOL</span>
      <span><b>{tokens}</b> SPL token</span>
    </div>
  );
}