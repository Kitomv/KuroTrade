// Real Wallet = ACTIVATION ONLY: connect MetaMask, bind it, switch virtual↔real.
// Trading lives on the Trade page (RealTradeForm) and the autopilot + hot wallet
// live in Pengaturan — this modal deliberately duplicates neither.
// Importers/callers: RealWalletControl (lazy). API: useEvmWallet() shared
// context + useHotWallet() (auto-execute / emergency-pause status).
// User instruction: "real wallet itu cuma tempat aktifasi pindah dari virtual ke
// real wallet" → keep it activation-only, but make the 3 steps explicit and show
// network + hot-wallet state so nothing is ambiguous.
import { Modal } from './Modal';
import { useEvmWallet } from './EvmWalletContext';
import { useConfirm } from './ConfirmDialog';
import { shortAddr } from '../lib/evm';
import { IconAlert, IconCheck, IconGear, IconLock, IconShield } from './Icons';

/** MetaMask reports the chain as a 0x-prefixed id. */
const CHAIN_LABEL: Record<string, string> = {
  '0x2105': 'Base · dana asli',
  '0x1': 'Ethereum · dana asli',
  '0xa4b1': 'Arbitrum · dana asli',
  '0x38': 'BNB Chain · dana asli',
  '0xa': 'Optimism · dana asli',
  '0x89': 'Polygon · dana asli',
  '0xa86a': 'Avalanche · dana asli',
};

export default function RealWalletModal({ onClose }: { onClose: () => void }) {
  const {
    connected, isBound, realMode, binding, bindError, setRealMode, bindWallet,
    boundWallet, chainId, address, connect, available,
  } = useEvmWallet();
  const confirmAction = useConfirm();

  const network = chainId ? (CHAIN_LABEL[chainId] ?? `Chain ${chainId}`) : 'Tidak terhubung';
  // Base is the default execution path; other chains work too, so this is a
  // hint rather than a hard block.
  const chainMismatch = Boolean(chainId && chainId !== '0x2105');

  const StepBadge = ({ done }: { done: boolean }) =>
    done ? (
      <span className="rwc-badge ok"><IconCheck size={11} /> Siap</span>
    ) : (
      <span className="rwc-badge" style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}><IconLock size={11} /> Belum</span>
    );

  const toggleReal = async () => {
    if (!realMode) {
      const ok = await confirmAction({
        title: 'Aktifkan Real Wallet?',
        message: 'Semua halaman (Portfolio, Trade, Agents, Leaderboard) akan memakai dana asli on-chain, bukan saldo virtual. Setiap transaksi akan meminta konfirmasi di MetaMask.',
        confirmLabel: 'Ya, pakai dana asli',
        danger: true,
      });
      if (!ok) return;
    }
    await setRealMode(!realMode);
  };

  return (
    <Modal title="Real Wallet" onClose={onClose} maxWidth={460}>
      <div className="rwc-row" style={{ marginBottom: 16 }}>
        <strong style={{ fontSize: 13, color: realMode ? 'var(--down)' : 'var(--text)' }}>
          {realMode ? 'REAL · DANA ASLI' : 'VIRTUAL'}
        </strong>
        {connected
          ? <span className="rwc-badge ok"><IconCheck size={11} /> {address ? shortAddr(address, 4) : 'Terhubung'}</span>
          : (
            <button
              type="button"
              className="btn primary"
              style={{ minHeight: 32, padding: '4px 14px', fontSize: 12 }}
              disabled={!available}
              onClick={() => connect().catch(() => {})}
            >
              {available ? 'Connect MetaMask' : 'MetaMask tidak terpasang'}
            </button>
          )}
      </div>

      {/* 1 · Connect */}
      <div className="rwc-row" style={{ marginBottom: 8 }}>
        <span className="rwc-k">1 · Connect MetaMask</span>
        <StepBadge done={connected} />
      </div>

      {/* 2 · Bind */}
      <div className="rwc-row" style={{ marginBottom: 4 }}>
        <span className="rwc-k">2 · Bind wallet</span>
        {isBound ? (
          <span className="rwc-badge ok">
            <IconCheck size={11} /> {boundWallet ? shortAddr(boundWallet, 5) : 'Ter-bind'}
          </span>
        ) : connected ? (
          <button
            type="button"
            className="btn"
            style={{ minHeight: 32, padding: '4px 14px', fontSize: 12 }}
            disabled={binding}
            onClick={() => bindWallet()}
          >
            {binding ? 'Menunggu…' : 'Bind Wallet'}
          </button>
        ) : (
          <StepBadge done={false} />
        )}
      </div>

      {bindError && <div className="rwc-error" style={{ marginBottom: 4 }}><IconAlert size={13} /> {bindError}</div>}

      {/* 3 · Real mode */}
      <div className="rwc-row">
        <span className="rwc-k">3 · Mode real</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>{realMode ? 'Aktif' : 'Nonaktif'}</span>
          <button
            type="button"
            className={`btn${realMode ? ' primary' : ''}`}
            style={{ minHeight: 32, padding: '4px 14px', fontSize: 12 }}
            disabled={!connected || !isBound}
            onClick={toggleReal}
          >
            {realMode ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {/* Status: which chain, and who executes */}
      <div
        style={{
          marginTop: 18,
          padding: '12px 14px',
          borderRadius: 10,
          background: 'var(--panel-2)',
          border: `1px solid ${realMode ? 'rgba(239,68,68,.35)' : 'var(--border)'}`,
        }}
      >
        <div className="rwc-row">
          <span className="rwc-k" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <IconShield size={12} /> Jaringan
          </span>
          <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>
            {network}
          </span>
        </div>
        <div className="rwc-row" style={{ marginTop: 8 }}>
          <span className="rwc-k" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <IconGear size={12} /> Eksekusi
          </span>
          <span className="rwc-badge" style={{ background: 'var(--panel)', color: 'var(--muted)' }}>
            Approve manual di MetaMask
          </span>
        </div>
        {chainMismatch && (
          <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--down)', lineHeight: 1.5 }}>
            Wallet kamu di {network}. Ganti ke Base di MetaMask agar swap memakai likuiditas paling dalam.
          </p>
        )}
        <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
          Backend tidak menyimpan private key. Swap dibangun server, kamu tanda tangani sendiri di MetaMask.
        </p>
      </div>

      <p className="rwc-hint" style={{ marginTop: 12 }}>
        {!connected
          ? 'Connect MetaMask untuk memakai mode real. Private key tetap di wallet kamu.'
          : !isBound
            ? 'Bind wallet sekali agar swap dana asli diizinkan.'
            : realMode
              ? 'Dana asli aktif. Autopilot mengusulkan trade, kamu approve tiap transaksi di MetaMask.'
              : 'Mode virtual aktif. Nyalakan "Mode real" untuk memakai dana asli.'}
      </p>
    </Modal>
  );
}