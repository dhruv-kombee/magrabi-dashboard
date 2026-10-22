import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApiRequest } from './server/router.js'
import { config } from './server/config.js'

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
  // 1. Try API routes
  if (req.url && req.url.startsWith('/api/commerce/')) {
    const handled = await handleApiRequest(req, res)
    if (handled) return
  }

  // 2. Serve static SPA assets from dist/
  let filePath = path.join(distDir, req.url.split('?')[0])

  // Check if file exists; if not, fallback to index.html (SPA routing)
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, 'index.html')
  }

  if (fs.existsSync(filePath)) {
    const ext = path.extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

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
})

process.on('SIGTERM', () => {
  server.close(() => process.exit(0))
})
process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
