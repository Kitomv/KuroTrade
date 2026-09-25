// Multi-Chain Wallet Panel — wraps Solana (HotWalletPanel) and EVM (EvmWalletPanel)
// with a chain selector tab switcher. Mounted at Settings.tsx.
import { useState } from 'react';
import { HotWalletPanel } from './HotWalletPanel';
import { EvmWalletPanel } from './EvmWalletPanel';
import { IconKey, IconLock } from './Icons';

export function MultiChainWalletPanel() {
  const [chain, setChain] = useState<'solana' | 'base'>('solana');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Chain Selector */}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className={`btn${chain === 'solana' ? ' primary' : ''}`}
          style={{ minHeight: 36, fontSize: 12 }}
          aria-pressed={chain === 'solana'}
          onClick={() => setChain('solana')}
        >
          <IconKey size={13} /> Solana
        </button>
        <button
          type="button"
          className={`btn${chain === 'base' ? ' primary' : ''}`}
          style={{ minHeight: 36, fontSize: 12 }}
          aria-pressed={chain === 'base'}
          onClick={() => setChain('base')}
        >
          <IconLock size={13} /> Base
        </button>
      </div>

      {/* Panel */}
      {chain === 'solana' ? <HotWalletPanel /> : <EvmWalletPanel />}
    </div>
  );
}