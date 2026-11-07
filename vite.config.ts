import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(process.env.PORT ?? env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT invalide.');
  return {
    plugins: [react()],
    server: { port: 5173, strictPort: true, proxy: { '/api': `http://127.0.0.1:${port}` } },
    build: { outDir: 'dist' },
  };
});
