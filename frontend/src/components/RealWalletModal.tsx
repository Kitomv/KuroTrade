// Real Wallet = ACTIVATION ONLY: connect MetaMask, bind it, switch virtual↔real,
// and choose the approve policy (manual in MetaMask vs. auto-open MetaMask so the
// user signs each intent without pressing Approve first). Nothing is ever signed
// server-side — there is no executor and no private key.
// Trading lives on the Trade page (RealTradeForm) — this modal deliberately
// duplicates neither.
// Importers/callers: RealWalletControl (lazy). API: useEvmWallet() shared context.
// User instruction: "real wallet itu cuma tempat aktifasi pindah dari virtual ke
// real wallet" → keep it activation-only, but make the 3 steps explicit and show
// network + wallet state so nothing is ambiguous.
import { Modal } from './Modal';
import { useEvmWallet } from './EvmWalletContext';
import { useConfirm } from './ConfirmDialog';
import { shortAddr, chainNameFromId } from '../lib/evm';
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
    connected, isBound, realMode, autoApprove, binding, bindError, setRealMode, setAutoApprove, bindWallet,
    boundWallet, chainId, address, connect, available, chainMismatch, switchToChain,
  } = useEvmWallet();
  const confirmAction = useConfirm();

  const network = chainId ? (CHAIN_LABEL[chainId] ?? `Chain ${chainId}`) : 'Tidak terhubung';
  // Base is the default execution path; other chains work too, so this is a
  // hint rather than a hard block.
  const offBase = Boolean(chainId && chainId !== '0x2105');

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

  /**
   * Arming auto-approve is a standing grant, not a per-trade setting, so it
   * gets its own confirmation and states the cost plainly: an ERC-20
   * allowance survives after real mode is switched off and lives on until it is
   * explicitly revoked on-chain. Turning real mode off does NOT undo it.
   *
   * It does NOT mean the bot signs for you — the server holds no private key.
   * "Automatic" means the wallet prompt is opened for you on each new intent;
   * you still press Approve in MetaMask.
   */
  const toggleAutoApprove = async () => {
    if (!autoApprove) {
      const ok = await confirmAction({
        title: 'Auto-approve aktifkan?',
        message: 'Saat ada intent, KuroTrade otomatis membuka MetaMask agar kamu menandatangani. Kamu tetap yang menekan Setujui di MetaMask — KuroTrade tidak pernah memegang private key. Allowance token ERC-20 yang dibuat berlaku sampai dicabut on-chain; mematikan mode real tidak mencabutnya. Allowance dibuat untuk jumlah persis per trade, bukan tanpa batas.',
        confirmLabel: 'Ya, buka MetaMask otomatis',
        danger: true,
      });
      if (!ok) return;
    }
    await setAutoApprove(!autoApprove);
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

      {/* 4 · Approve policy. Only meaningful in real mode — the server refuses
          to arm it otherwise, so the control states that rather than silently
          doing nothing. */}
      <div className="rwc-row" style={{ marginTop: 14, flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
        <div className="rwc-row" style={{ marginBottom: 0 }}>
          <span className="rwc-k">4 · Persetujuan otomatis</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
              {!realMode ? 'Perlu mode real' : autoApprove ? 'Otomatis' : 'Manual'}
            </span>
            <button
              type="button"
              className={`btn${autoApprove ? ' primary' : ''}`}
              style={{ minHeight: 32, padding: '4px 14px', fontSize: 12 }}
              disabled={!realMode}
              onClick={toggleAutoApprove}
            >
              {autoApprove ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
          {autoApprove
            ? 'Saat ada intent, MetaMask otomatis dibuka agar kamu tanda tangani. Kamu tetap menekan Setujui — KuroTrade tidak memegang private key.'
            : 'Setiap approve dan swap kamu tanda tangani sendiri di MetaMask.'}
        </p>
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
          <span className="rwc-badge" style={{ background: 'var(--panel)', color: autoApprove ? 'var(--down)' : 'var(--muted)' }}>
            {autoApprove ? 'Buka MetaMask otomatis' : 'Approve manual di MetaMask'}
          </span>
        </div>
        {chainMismatch && (
          <div style={{ margin: '10px 0 0', padding: 10, borderRadius: 8, background: 'var(--down-bg)', border: '1px solid rgba(239,68,68,.35)' }}>
            <p style={{ margin: 0, fontSize: 11.5, color: 'var(--down)', lineHeight: 1.5 }}>
              <IconAlert size={12} /> Swap terakhir ditolak: wallet kamu di {network}, transaksinya untuk chain {chainNameFromId(chainMismatch.wanted) ?? chainMismatch.wanted}.
            </p>
            <button
              type="button"
              className="btn primary"
              style={{ marginTop: 8, fontSize: 12, minHeight: 32 }}
              onClick={() => { switchToChain(chainMismatch.wanted).catch(() => {}); }}
            >
              Ganti ke {chainNameFromId(chainMismatch.wanted) ?? `chain ${chainMismatch.wanted}`}
            </button>
          </div>
        )}
        {offBase && !chainMismatch && (
          <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--down)', lineHeight: 1.5 }}>
            Wallet kamu di {network}. Ganti ke Base di MetaMask agar swap memakai likuiditas paling dalam.
          </p>
        )}
        <p style={{ margin: '10px 0 0', fontSize: 11, color: 'var(--muted)', lineHeight: 1.5 }}>
          {autoApprove
            ? 'Swap dibangun server. Saat ada intent, MetaMask otomatis dibuka untuk kamu tanda tangani. Allowance ERC-20 aktif sampai dicabut on-chain.'
            : 'Backend tidak menyimpan private key. Swap dibangun server, kamu tanda tangani sendiri di MetaMask.'}
        </p>
      </div>

      <p className="rwc-hint" style={{ marginTop: 12 }}>
        {!connected
          ? 'Connect MetaMask untuk memakai mode real. Private key tetap di wallet kamu.'
          : !isBound
            ? 'Bind wallet sekali agar swap dana asli diizinkan.'
            : realMode
              ? autoApprove
                ? 'Dana asli aktif, approve otomatis. MetaMask terbuka sendiri tiap intent — kamu yang tanda tangani. Matikan switch 4 untuk kembali manual.'
                : 'Dana asli aktif. Autopilot mengusulkan trade, kamu approve tiap transaksi di MetaMask.'
              : 'Mode virtual aktif. Nyalakan "Mode real" untuk memakai dana asli.'}
      </p>
    </Modal>
  );
}