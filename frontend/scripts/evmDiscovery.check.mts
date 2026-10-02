// Verifies the EIP-6963 discovery logic in lib/evm.ts against a fake window.
// Run: node src/evmDiscovery.check.ts
//
// The bug being guarded: reading `window.ethereum` raw returns whichever
// extension injected last, and MetaMask's own selection fallback then throws
// an opaque "Unexpected error" from inside its bundle — before any user click.
//
// The module keeps module-level state, so this harness loads it ONCE and drives
// announcements in order, exactly as a browser does on page load.

type Announcement = {
  info: { uuid: string; name: string; rdns?: string; isMetaMask?: boolean };
  provider: unknown;
};

const listeners = new Map<string, Set<(e: unknown) => void>>();
let pending: Announcement | undefined;

(globalThis as { window?: unknown }).window = {
  addEventListener(type: string, fn: (e: unknown) => void) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(fn);
  },
  dispatchEvent(event: { type: string }) {
    for (const fn of listeners.get(event.type) ?? []) {
      fn({ type: event.type, detail: pending });
    }
    return true;
  },
};

const evm = await import('../src/lib/evm.ts');

const log: string[] = [];
const check = (label: string, actual: unknown, expected: unknown) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `  — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const announce = (a: Announcement) => {
  pending = a;
  (globalThis as { window: { dispatchEvent: (e: { type: string }) => void } }).window
    .dispatchEvent({ type: 'eip6963:announceProvider' });
};
const wallet = (name: string, uuid: string, isMetaMask?: boolean, rdns?: string): Announcement =>
  ({ info: { uuid, name, isMetaMask, rdns }, provider: { name, isMetaMask, request: async () => name } });

// --- 1. Nothing installed yet ---
check('no provider before anything announces', evm.getInjectedProvider(), null);
check('hasInjectedWallet is false', evm.hasInjectedWallet(), false);
check('message tells the user to install MetaMask',
  evm.missingWalletMessage().includes('install'), true);

// --- 2. A rival wallet announces first (the reported scenario) ---
announce(wallet('Coinbase Wallet', 'uuid-cb'));
check('a non-MetaMask provider is refused, not returned', evm.getInjectedProvider(), null);
check('the message names the wallet that is in the way',
  evm.missingWalletMessage().includes('Coinbase Wallet'), true);

// --- 3. MetaMask announces second ---
const metaMask = wallet('MetaMask', 'uuid-mm', true, 'io.metamask');
announce(metaMask);
check('MetaMask is found once it announces', evm.getInjectedProvider() !== null, true);
check('the provider handed back is MetaMask, not the rival',
  await (evm.getInjectedProvider()!.request({ method: 'eth_requestAccounts' }) as Promise<string>),
  'MetaMask');

// --- 4. Late-arriving wallet notifies subscribers ---
let fired = 0;
const off = evm.subscribeProviders(() => { fired++; });
check('subscriber does not fire for an already-known provider', fired, 0);
announce(wallet('Rabby', 'uuid-rabby'));
check('adding a non-MetaMask wallet does not notify', fired, 0);
off();

// --- 5. rdns-only identification (some builds omit isMetaMask) ---
check('rdns io.metamask still resolves to the MetaMask provider',
  await (evm.getInjectedProvider()!.request({ method: 'x' }) as Promise<string>), 'MetaMask');

// --- 6. A forged MetaMask announcement cannot displace the real provider ---
// EIP-6963 does not authenticate announcers, so a page script can dispatch an
// announcement claiming to be MetaMask with its own provider object. It cannot,
// however, make window.ethereum point at that object — so when the real
// MetaMask owns the slot, the announcement matching the slot must win.
(globalThis as { ethereum?: unknown }).ethereum = metaMask.provider;
const forgedProvider = { name: 'forged', isMetaMask: true, request: async () => 'FORGED' };
announce({ info: { uuid: 'uuid-forged', name: 'MetaMask', isMetaMask: true, rdns: 'io.metamask' }, provider: forgedProvider });
check('forged announcement loses to the wallet that owns window.ethereum',
  await (evm.getInjectedProvider()!.request({ method: 'eth_requestAccounts' }) as Promise<string>),
  'MetaMask');
(globalThis as { ethereum?: unknown }).ethereum = undefined;

for (const l of log) console.log(l);
const failed = log.filter((l) => l.startsWith('FAIL')).length;
console.log(`\n${log.length - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
