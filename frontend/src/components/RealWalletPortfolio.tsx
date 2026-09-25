// On-chain wallet detail for the Portfolio page, shown ONLY when real mode is
// on (the virtual ledger is hidden then — real funds are what matters).
// Balances come from RPC; the swap dialog reuses the existing RealTradeForm
// rather than reimplementing quote → sign → broadcast.
// Importers/callers: Portfolio.tsx (when realMode).
// API/data: useWallet/useConnection RPC reads; RealTradeForm for swaps.
// User instruction: "di menu porto juga, kalo real wallet aktif ya tampilin
// detail real wallet bukan yang virtual" + "gas tambahin swap dialog juga".
import { useCallback, useEffect, useState } from 'react';
import { useWallet, useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { Modal } from './Modal';
import { RealTradeForm } from './RealTradeForm';
import { useRealWallet } from './RealWalletContext';
import { IconAlert, IconLock } from './Icons';
import { LAMPORTS_PER_SOL, shortAddr } from '../lib/solana';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** Known mints → display symbol (unknown mints fall back to the mint prefix). */
const KNOWN_MINTS: Record<string, string> = {
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
};

interface HeldToken {
  mint: string;
  symbol: string;
  uiAmount: number;
  decimals: number;
}

export function RealWalletPortfolio() {
  const { connected, publicKey } = useWallet();
  const { connection } = useConnection();
  const { isBound } = useRealWallet();

  const [sol, setSol] = useState<number | null>(null);
  const [tokens, setTokens] = useState<HeldToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [swapOpen, setSwapOpen] = useState(false);

  const load = useCallback(async () => {
    if (!connected || !publicKey) { setSol(null); setTokens([]); setLoading(false); return; }
    const pk = publicKey!; // guarded by connected check above
    setLoading(true);
    try {
      const [lamports, accounts] = await Promise.all([
        connection.getBalance(pk),
        connection.getParsedTokenAccountsByOwner(pk, { programId: TOKEN_PROGRAM_ID }),
      ]);
      setSol(lamports / LAMPORTS_PER_SOL);
      const held: HeldToken[] = [];
      for (const acc of accounts.value) {
        const info = acc.account.data.parsed.info;
        const uiAmount = Number(info.tokenAmount.uiAmount);
        if (uiAmount > 0) {
          held.push({
            mint: info.mint,
            symbol: KNOWN_MINTS[info.mint] ?? `${info.mint.slice(0, 4).toUpperCase()}…`,
            uiAmount,
            decimals: Number(info.tokenAmount.decimals),
          });
        }
      }
      setTokens(held.sort((a, b) => b.uiAmount - a.uiAmount));
      setErr('');
    } catch (e: any) {
      setErr(e?.message ?? 'Gagal memuat saldo on-chain');
    } finally {
      setLoading(false);
    }
  }, [connected, publicKey, connection]);

  useEffect(() => { load(); }, [load]);

  if (!connected) {
    return (
      <div className="card" style={{ padding: 20, marginBottom: 24 }}>
        <div className="empty" style={{ padding: 16 }}>
          Connect Phantom untuk melihat detail wallet on-chain (dana asli).
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14 }}>Wallet On-Chain (Dana Asli)</strong>
          <span className="chip" style={{ background: 'var(--down-bg)', color: 'var(--down)', fontSize: 10, fontWeight: 700, border: '1px solid rgba(239,68,68,.4)' }}>
            REAL
          </span>
          {!isBound && (
            <span className="chip" style={{ background: 'rgba(245,158,11,.15)', color: 'var(--accent)', fontSize: 10 }}>
              Belum bind — swap dikunci
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" style={{ fontSize: 12, minHeight: 32 }} onClick={load} disabled={loading}>
            {loading ? 'Memuat…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="btn primary"
            style={{ fontSize: 12, minHeight: 32 }}
            onClick={() => setSwapOpen(true)}
            disabled={!isBound}
            title={isBound ? 'Buka form swap dana asli' : 'Bind wallet dulu di panel Real Wallet'}
          >
            Swap / Trade
          </button>
        </div>
      </div>

      <div style={{ padding: 20 }}>
        {err && <div className="error" style={{ marginBottom: 14 }}><IconAlert size={13} /> {err}</div>}
        {!isBound && (
          <div className="error" style={{ marginBottom: 14, background: 'rgba(245,158,11,.14)', color: 'var(--accent)' }}>
            <IconLock size={13} /> Bind wallet dulu (panel Real Wallet di sidebar) sebelum swap dana asli.
          </div>
        )}

        <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10, wordBreak: 'break-all' }}>
          {shortAddr(publicKey!.toBase58(), 6)}
        </div>

        <div className="kpi-grid">
          <div className="card kpi">
            <div className="kpi-label">SOL (gas + trade)</div>
            <div className="kpi-value">{sol === null ? '…' : sol.toFixed(4)}</div>
            <div className="kpi-sub">{sol !== null && sol < 0.02 ? '⚠ di bawah biaya gas' : 'siap untuk transaksi'}</div>
          </div>
          <div className="card kpi">
            <div className="kpi-label">SPL Token</div>
            <div className="kpi-value">{tokens.length}</div>
            <div className="kpi-sub">posisi on-chain</div>
          </div>
        </div>

        {tokens.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Mint</th>
                  <th className="num">Jumlah</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.mint}>
                    <td><strong>{t.symbol}</strong></td>
                    <td style={{ fontSize: 11, color: 'var(--muted)' }}>{shortAddr(t.mint, 4)}</td>
                    <td className="num">{t.uiAmount.toLocaleString(undefined, { maximumFractionDigits: 6 })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && tokens.length === 0 && (
          <div className="empty" style={{ marginTop: 12 }}>
            Belum ada SPL token di wallet ini. Kirim SOL ke alamat di atas untuk mulai trading.
          </div>
        )}
      </div>

      {swapOpen && (
        <Modal title="Swap Dana Asli" onClose={() => { setSwapOpen(false); load(); }} maxWidth={560}>
          <RealTradeForm />
        </Modal>
      )}
    </div>
  );
}
