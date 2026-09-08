import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src/web', import.meta.url)) } },
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/.muon/**'] }, proxy: { '/api': 'http://127.0.0.1:4310' } },
  build: { outDir: 'dist' },
});
