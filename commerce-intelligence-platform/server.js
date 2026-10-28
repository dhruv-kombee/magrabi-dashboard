import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApiRequest } from './server/router.js'
import { config } from './server/config.js'
import { initDatabase, isDatabaseConfigured, closePool } from './server/db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, 'dist')

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'")

  // 1. Try API routes
  if (req.url && req.url.startsWith('/api/commerce/')) {
    const handled = await handleApiRequest(req, res)
    if (handled) return
  }

  // 2. Serve static SPA assets from dist/
  let pathname
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname) } catch { res.writeHead(400); res.end('Bad request.'); return }
  const relativePath = pathname.replace(/^[/\\]+/, '')
  let filePath = path.resolve(distDir, relativePath)
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${path.sep}`)) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=UTF-8' })
    res.end('Bad request.')
    return
  }

  // Check if file exists; if not, fallback to index.html (SPA routing)
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html')
  }

  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')
    res.writeHead(200, { 'Content-Type': contentType })
    const stream = fs.createReadStream(filePath)
    stream.pipe(res)
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Static build assets not found. Run "npm run build" first.')
  }
})

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[Magrabi Commerce Intelligence] Server running on port ${config.port} (Production Mode)`)
  if (isDatabaseConfigured()) {
    initDatabase()
      .then(() => console.log('[Magrabi Commerce Intelligence] Connected to external PostgreSQL RBAC database.'))
      .catch((err) => console.error('[Magrabi Commerce Intelligence] Database initialization error:', err?.message || err))
  }
})

process.on('SIGTERM', () => {
  closePool().finally(() => {
    server.close(() => process.exit(0))
  })
})
process.on('SIGINT', () => {
  closePool().finally(() => {
    server.close(() => process.exit(0))
  })
})
