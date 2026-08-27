import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Bind all interfaces so the dev server is reachable from the LAN
    // (e.g. http://192.168.1.39:5173 from a PC), not just localhost.
    host: true,
    proxy: {
      '/api': {
        target: 'http://localhost:8099',
        changeOrigin: true,
      },
      '/ai': {
        target: 'http://localhost:8099',
        changeOrigin: true,
      },
    },
  },
});
