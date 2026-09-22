import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // @solana/web3.js and friends expect Node's `buffer` — polyfill for the
  // browser (Vite externalizes `buffer` by default, which breaks tx deserialization).
  define: {
    global: {},
  },
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
  build: {
    // No modulepreload: lazy chunks (Solana wallet) must only load on demand,
    // not be preloaded from index.html on every page.
    modulePreload: false,
    rollupOptions: {
      output: {
        // Split heavy Solana vendor code out of the main bundle — keeps each
        // chunk under the 500kB warning threshold and lets the browser cache
        // vendor code independently of app code.
        manualChunks: {
          'vendor-solana': ['@solana/web3.js'],
          'vendor-wallet': [
            '@solana/wallet-adapter-react',
            '@solana/wallet-adapter-react-ui',
            '@solana/wallet-adapter-phantom',
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    host: true, // listen on all interfaces (ngrok / LAN)
    // Allow ngrok & other tunnel hosts — Vite blocks unknown Host headers by default.
    allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.ngrok.io', '.trycloudflare.com', 'localhost'],
    proxy: { '/api': 'http://localhost:3001' },
  },
});