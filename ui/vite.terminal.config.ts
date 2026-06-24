import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Builds the xterm.js terminal as one self-contained HTML (all JS/CSS inlined),
// served by the Qalatra server and loaded in the mobile WebView. No React needed
// — see src/terminal-webview/main.ts.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist-terminal',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 8_000,
    rollupOptions: {
      input: fileURLToPath(new URL('./terminal.html', import.meta.url)),
    },
  },
})
