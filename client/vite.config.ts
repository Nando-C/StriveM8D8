import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // The libraries change far less often than the app: in files of their own, a
        // returning visitor downloads only what a release actually changed.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          if (/node_modules\/(motion|framer-motion|motion-dom|motion-utils)\//.test(id)) return 'motion'
          if (/node_modules\/(socket\.io-client|socket\.io-parser|engine\.io-client|engine\.io-parser|@socket\.io)\//.test(id)) return 'socket'
          if (/node_modules\/(@radix-ui|radix-ui|@floating-ui)\//.test(id)) return 'ui'
          return undefined
        },
      },
    },
  },
  resolve: {
    alias: {
      // Must match the "@/*" path mapping in the tsconfig files.
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The Tailwind stylesheet is irrelevant to behaviour and slow to process.
    css: false,
  },
})
