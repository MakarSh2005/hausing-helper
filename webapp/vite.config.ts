import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Мини-приложение раздаёт бэкенд по /app (один сервер, без CORS).
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // Локально: API — на бэкенде (npm run dev в backend).
    proxy: { '/api': 'http://localhost:3000', '/bot': 'http://localhost:3000' },
  },
  build: { outDir: 'dist', assetsDir: 'assets', sourcemap: false },
});
