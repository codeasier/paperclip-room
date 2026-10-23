import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': process.env.ROOM_API_PROXY || 'http://127.0.0.1:3200' },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client'],
          markdown: ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
});
