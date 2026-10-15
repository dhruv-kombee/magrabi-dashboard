import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Local dev only -- in production the built frontend is served same-origin by Flask,
      // so this proxy target never matters there.
      '/api': {
        target: 'http://127.0.0.1:5151',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../backend/static',
    emptyOutDir: true,
  },
})
