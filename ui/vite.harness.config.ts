import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Builds the touch-scroll test harness as one self-contained HTML for Playwright.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist-harness',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 8_000,
    rollupOptions: {
      input: fileURLToPath(new URL('./touch-scroll-harness.html', import.meta.url)),
    },
  },
})
