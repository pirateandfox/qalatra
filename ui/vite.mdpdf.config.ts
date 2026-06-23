import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

// Builds the markdown editor (mdpdf MdView) as a single self-contained HTML file
// — all JS/CSS inlined — so it can be served by the Qalatra server and loaded in
// a mobile WebView with no external asset requests. See src/mdpdf-webview/main.tsx.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  resolve: {
    alias: {
      '@qalatra/shared': fileURLToPath(new URL('../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist-mdpdf',
    emptyOutDir: true,
    // Inline everything; assetsInlineLimit huge so nothing is emitted separately.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 8_000,
    rollupOptions: {
      input: fileURLToPath(new URL('./mdpdf.html', import.meta.url)),
    },
  },
})
