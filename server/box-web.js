import crypto from 'crypto'
import http from 'http'

const TARGET_HOST = '127.0.0.1'
const TARGET_PORT = parseInt(process.env.QALATRA_BOX_WEB_PORT || '8080', 10)
const SESSION_TTL_MS = parseInt(process.env.QALATRA_BOX_WEB_SESSION_TTL_MS || String(8 * 60 * 60 * 1000), 10)
const MAX_HTML_REWRITE_BYTES = parseInt(process.env.QALATRA_BOX_WEB_MAX_HTML_BYTES || String(5 * 1024 * 1024), 10)

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function newTicket() {
  return crypto.randomBytes(24).toString('base64url')
}

function proxyBase(ticket) {
  return `/api/box-web/proxy/${encodeURIComponent(ticket)}`
}

function targetLabel() {
  return `http://${TARGET_HOST}:${TARGET_PORT}`
}

function respondHtml(res, status, title, message) {
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #0f1117;
      color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(520px, calc(100vw - 48px));
      border: 1px solid #2e3250;
      border-radius: 8px;
      background: #1a1d27;
      padding: 24px;
    }
    h1 { margin: 0 0 10px; font-size: 18px; }
    p { margin: 0; color: #94a3b8; line-height: 1.5; }
    code { color: #cbd5e1; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
</body>
</html>`
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  })
  res.end(html)
}

function copyRequestHeaders(req) {
  const headers = { ...req.headers }
  for (const header of HOP_BY_HOP_HEADERS) delete headers[header]
  delete headers.host
  delete headers.authorization
  headers.host = `${TARGET_HOST}:${TARGET_PORT}`
  headers['accept-encoding'] = 'identity'
  headers['x-forwarded-host'] = req.headers.host || ''
  headers['x-forwarded-proto'] = 'http'
  return headers
}

function rewriteLocation(value, base) {
  if (!value) return value
  if (value.startsWith('/')) return `${base}${value}`
  const target = targetLabel()
  if (value.startsWith(target)) return `${base}${value.slice(target.length) || '/'}`
  return value
}

function rewriteSetCookie(value, base) {
  const rewriteOne = cookie => {
    if (/;\s*Path=/i.test(cookie)) return cookie.replace(/;\s*Path=[^;]*/i, `; Path=${base}/`)
    return `${cookie}; Path=${base}/`
  }
  return Array.isArray(value) ? value.map(rewriteOne) : rewriteOne(value)
}

function copyResponseHeaders(proxyHeaders, base, rewritingBody) {
  const headers = {}
  for (const [name, value] of Object.entries(proxyHeaders)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    if (lower === 'x-frame-options') continue
    if (lower === 'content-security-policy') continue
    if (lower === 'content-security-policy-report-only') continue
    if (lower === 'content-length' && rewritingBody) continue
    if (lower === 'content-encoding' && rewritingBody) continue
    if (lower === 'location') {
      headers[name] = rewriteLocation(Array.isArray(value) ? value[0] : value, base)
      continue
    }
    if (lower === 'set-cookie') {
      headers[name] = rewriteSetCookie(value, base)
      continue
    }
    headers[name] = value
  }
  headers['Cache-Control'] = 'no-store'
  headers.Pragma = 'no-cache'
  headers.Expires = '0'
  return headers
}

function rewriteRootRelativeAttributes(html, base) {
  const baseWithoutSlash = base.slice(1)
  return html
    .replace(/\b(href|src|action|poster)=("|')\/(?!\/)([^"']*)\2/gi, (match, attr, quote, value) => {
      if (value === baseWithoutSlash || value.startsWith(`${baseWithoutSlash}/`)) return match
      return `${attr}=${quote}${base}/${value}${quote}`
    })
    .replace(/\bsrcset=("|')([^"']*)\1/gi, (_match, quote, value) => {
      const rewritten = value.replace(/(^|,\s*)\/(?!\/)([^,\s]+)/g, (_item, prefix, asset) => {
        if (asset === baseWithoutSlash || asset.startsWith(`${baseWithoutSlash}/`)) return `${prefix}/${asset}`
        return `${prefix}${base}/${asset}`
      })
      return `srcset=${quote}${rewritten}${quote}`
    })
    .replace(/url\((["']?)\/(?!\/)([^)"']*)/gi, (match, quote, asset) => {
      if (asset === baseWithoutSlash || asset.startsWith(`${baseWithoutSlash}/`)) return match
      return `url(${quote}${base}/${asset}`
    })
}

function boxWebRuntimeScript(base) {
  return `<script>
(() => {
  const boxWebBase = ${JSON.stringify(base)};
  const refreshParam = '__qalatra_refresh';

  try {
    const current = new URL(window.location.href);
    if (current.searchParams.has(refreshParam)) {
      current.searchParams.delete(refreshParam);
      window.history.replaceState(window.history.state, '', current.pathname + current.search + current.hash);
    }
  } catch {}

  function rewriteBoxWebUrl(value) {
    if (typeof value !== 'string') return value;
    try {
      const url = new URL(value, document.baseURI || window.location.href);
      if (url.origin !== window.location.origin) return value;
      if (!url.pathname.startsWith('/api/')) return value;
      if (url.pathname === boxWebBase || url.pathname.startsWith(boxWebBase + '/')) return value;
      return boxWebBase + url.pathname + url.search + url.hash;
    } catch {
      return value;
    }
  }

  function rewriteFetchInput(input) {
    if (typeof Request !== 'undefined' && input instanceof Request) {
      const rewritten = rewriteBoxWebUrl(input.url);
      return rewritten === input.url ? input : new Request(rewritten, input);
    }
    return rewriteBoxWebUrl(input);
  }

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => originalFetch(rewriteFetchInput(input), init);
  }

  if (typeof XMLHttpRequest !== 'undefined') {
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      return originalOpen.call(this, method, rewriteBoxWebUrl(url), ...rest);
    };
  }

  if (typeof EventSource !== 'undefined') {
    const OriginalEventSource = EventSource;
    window.EventSource = function(url, config) {
      return new OriginalEventSource(rewriteBoxWebUrl(url), config);
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
  }

  if (navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => originalSendBeacon(rewriteBoxWebUrl(url), data);
  }

  window.addEventListener('message', event => {
    if (event.source !== window.parent) return;
    if (!event.data || event.data.type !== 'qalatra-box-web:refresh') return;
    try {
      const next = new URL(window.location.href);
      next.searchParams.set(refreshParam, String(Date.now()));
      window.location.replace(next.toString());
    } catch {
      window.location.reload();
    }
  });
})();
</script>`
}

function rewriteHtml(html, ticket) {
  const base = proxyBase(ticket)
  const baseTag = `<base href="${base}/">`
  const headExtras = `${baseTag}${boxWebRuntimeScript(base)}`
  const withBase = /<head(\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(\s[^>]*)?>/i, match => `${match}${headExtras}`)
    : `${headExtras}${html}`
  return rewriteRootRelativeAttributes(withBase, base)
}

function rewriteCss(css, ticket) {
  return rewriteRootRelativeAttributes(css, proxyBase(ticket))
}

function cleanupSessions(sessions) {
  const now = Date.now()
  for (const [ticket, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(ticket)
  }
}

function getProxyPath(url, matchedPath) {
  const path = matchedPath && matchedPath.startsWith('/') ? matchedPath : '/'
  return `${path}${url.search || ''}`
}

function proxyRequest(req, res, url, ticket, matchedPath) {
  const upstreamPath = getProxyPath(url, matchedPath)
  const request = http.request({
    host: TARGET_HOST,
    port: TARGET_PORT,
    method: req.method,
    path: upstreamPath,
    headers: copyRequestHeaders(req),
  }, proxyRes => {
    const contentType = String(proxyRes.headers['content-type'] || '')
    const isHtml = /\btext\/html\b/i.test(contentType)
    const isCss = /\btext\/css\b/i.test(contentType)
    const shouldRewrite = isHtml || isCss
    const base = proxyBase(ticket)
    const headers = copyResponseHeaders(proxyRes.headers, base, shouldRewrite)

    if (!shouldRewrite || req.method === 'HEAD') {
      res.writeHead(proxyRes.statusCode || 502, headers)
      proxyRes.pipe(res)
      return
    }

    const chunks = []
    let total = 0
    proxyRes.on('data', chunk => {
      total += chunk.length
      if (total > MAX_HTML_REWRITE_BYTES) {
        request.destroy(new Error(`Box web app HTML exceeded ${MAX_HTML_REWRITE_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    proxyRes.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const rewritten = isHtml ? rewriteHtml(body, ticket) : rewriteCss(body, ticket)
      const buffer = Buffer.from(rewritten)
      res.writeHead(proxyRes.statusCode || 200, {
        ...headers,
        'Content-Length': buffer.length,
      })
      res.end(buffer)
    })
  })

  request.setTimeout(30_000, () => request.destroy(new Error('Box web app request timed out')))
  request.on('error', err => {
    if (res.headersSent) {
      res.destroy(err)
      return
    }
    respondHtml(
      res,
      502,
      'Box web app unavailable',
      `Qalatra could not reach <code>${targetLabel()}</code> on this box. Start the box web app service and reload this view.`,
    )
  })

  req.pipe(request)
}

function checkStatus() {
  return new Promise(resolve => {
    const req = http.request({
      host: TARGET_HOST,
      port: TARGET_PORT,
      method: 'HEAD',
      path: '/',
      timeout: 1500,
    }, res => {
      res.resume()
      resolve({ ok: true, statusCode: res.statusCode || null, target: targetLabel() })
    })
    req.on('timeout', () => req.destroy(new Error('Timed out')))
    req.on('error', error => resolve({ ok: false, error: error.message, target: targetLabel() }))
    req.end()
  })
}

export function createBoxWebProxy() {
  const sessions = new Map()

  return {
    createSession() {
      cleanupSessions(sessions)
      const ticket = newTicket()
      const expiresAt = Date.now() + SESSION_TTL_MS
      sessions.set(ticket, { expiresAt })
      return {
        path: `${proxyBase(ticket)}/`,
        expiresAt: new Date(expiresAt).toISOString(),
        target: targetLabel(),
      }
    },

    checkStatus,

    handleProxy(req, res, url) {
      const match = url.pathname.match(/^\/api\/box-web\/proxy\/([^/]+)(\/.*)?$/)
      if (!match) return false

      cleanupSessions(sessions)
      const ticket = decodeURIComponent(match[1])
      const session = sessions.get(ticket)
      if (!session) {
        respondHtml(res, 401, 'Box web app session expired', 'Open the Box Web App from Qalatra again to create a fresh session.')
        return true
      }

      proxyRequest(req, res, url, ticket, match[2] || '/')
      return true
    },
  }
}
