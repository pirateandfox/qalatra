import type { Plugin, UserConfig } from 'vite'

// Inline every JS and CSS chunk into the built HTML, so the mdpdf, terminal and harness builds are
// one self-contained file a WebView or Playwright can load with no further requests.
//
// A port of vite-plugin-singlefile 2.3.3 with its default options, which is all these builds ever
// used. The package was dropped because it depends on micromatch → braces, which carries a high
// advisory with no patched release (GHSA-vfj7-8cjw-p6xm); micromatch was only reached through the
// `inlinePattern` option. Output is byte-identical to the package's.

function replaceScript(html: string, scriptFilename: string, scriptCode: string): string {
  const f = scriptFilename.replaceAll('.', '\\.')
  const reScript = new RegExp(`<script([^>]*?) src="(?:[^"]*?/)?${f}"([^>]*)></script>`)
  const newCode = scriptCode.replace(/"?__VITE_PRELOAD__"?/g, 'void 0').replace(/<(\/script>|!--)/g, '\\x3C$1')
  return html.replace(reScript, (_, beforeSrc, afterSrc) => `<script${beforeSrc}${afterSrc}>${newCode.trim()}</script>`)
}

function replaceCss(html: string, cssFilename: string, cssCode: string): string {
  const f = cssFilename.replaceAll('.', '\\.')
  const reStyle = new RegExp(`<link([^>]*?) href="(?:[^"]*?/)?${f}"([^>]*)>`)
  const newCode = cssCode.replace('@charset "UTF-8";', '')
  return html.replace(reStyle, (_, beforeSrc, afterSrc) => `<style${beforeSrc}${afterSrc}>${newCode.trim()}</style>`)
}

function recommendedBuildConfig(config: UserConfig) {
  config.build ??= {}
  // Even very large assets are inlined into the JavaScript.
  config.build.assetsInlineLimit = () => true
  config.build.chunkSizeWarningLimit = 100_000_000
  // One CSS file, which is then inlined.
  config.build.cssCodeSplit = false
  // Relative paths so files copied from public/ still resolve, emitted at the outDir root.
  config.base = './'
  config.build.assetsDir = ''
  config.build.rollupOptions ??= {}
  config.build.rollupOptions.output ??= {}
  const outputs = Array.isArray(config.build.rollupOptions.output)
    ? config.build.rollupOptions.output
    : [config.build.rollupOptions.output]
  // Vite 8 (Rolldown): one chunk, so nothing is left to load separately.
  for (const out of outputs) (out as { codeSplitting?: boolean }).codeSplitting = false
}

export function singleFile(): Plugin {
  return {
    name: 'qalatra:single-file',
    config: recommendedBuildConfig,
    enforce: 'post',
    generateBundle(_options, bundle) {
      this.info('\n')
      const names = Object.keys(bundle)
      const html = names.filter(n => /\.html?$/.test(n))
      const css = names.filter(n => /\.css$/.test(n))
      const js = names.filter(n => /\.[mc]?js$/.test(n))
      const other = names.filter(n => !html.includes(n) && !css.includes(n) && !js.includes(n))
      const inlined: string[] = []
      for (const name of html) {
        const htmlChunk = bundle[name]
        if (htmlChunk.type !== 'asset') continue
        let source = String(htmlChunk.source)
        for (const filename of js) {
          const chunk = bundle[filename]
          if (chunk.type !== 'chunk' || chunk.code == null) continue
          this.info(`Inlining: ${filename}`)
          inlined.push(filename)
          source = replaceScript(source, chunk.fileName, chunk.code)
        }
        for (const filename of css) {
          const asset = bundle[filename]
          if (asset.type !== 'asset') continue
          this.info(`Inlining: ${filename}`)
          inlined.push(filename)
          source = replaceCss(source, asset.fileName, String(asset.source))
        }
        htmlChunk.source = source
      }
      for (const name of inlined) delete bundle[name]
      for (const name of other) this.info(`NOTE: asset not inlined: ${name}`)
    },
  }
}
