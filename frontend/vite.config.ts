import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // No modulepreload: the lazy-loaded wallet modal must only load on demand,
    // not be preloaded from index.html on every page.
    modulePreload: false,
  },
  server: {
    port: 5173,
    host: true, // listen on all interfaces (ngrok / LAN)
    // Allow ngrok & other tunnel hosts — Vite blocks unknown Host headers by default.
    allowedHosts: ['.ngrok-free.app', '.ngrok.app', '.ngrok.io', '.trycloudflare.com', 'localhost'],
    proxy: { '/api': 'http://localhost:3001' },
  },
});