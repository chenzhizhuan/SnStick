import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Standalone visual QA only. No proxy, no backend, no remote fonts.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, '../src') } },
  server: { host: '127.0.0.1', port: 3012, strictPort: true },
})
