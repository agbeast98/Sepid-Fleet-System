import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: { rollupOptions: { input: { main: 'index.html', legacy: 'legacy-online.html' } } },
  server: {
    port: 55321,
    strictPort: true,
    proxy: { '/api': process.env.SEPID_API_URL ?? 'http://127.0.0.1:55320' },
  },
});
