import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // NEXT_PUBLIC_ is kept so the existing NEXT_PUBLIC_CHAINGRAPH_URL setting (e.g. on Netlify) keeps working
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  build: {
    // @bitauth/libauth instantiates its WASM crypto with top-level await
    target: 'es2022',
    // Single-page app shipped as one chunk; libauth inlines its WASM binaries as base64 (~340 kB)
    chunkSizeWarningLimit: 1000,
  },
})
