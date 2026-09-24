import { createRoot } from 'react-dom/client';
// Browser has no global Buffer. @solana/web3.js reads window.Buffer when it
// deserializes transactions, and the real-wallet components call
// Buffer.from(..., 'base64') directly — without this the whole real-swap flow
// throws ReferenceError. Must run before App (and any Solana module) loads.
import { Buffer } from 'buffer';
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
import { App } from './App';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);