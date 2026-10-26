import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { handleApiRequest } from './server/router.js'

const redactDevError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/bearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 500)

function commerceApiPlugin(): Plugin {
  return {
    name: 'commerce-api-middleware',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/commerce/')) {
          return next()
        }
        try {
          const handled = await handleApiRequest(req, res)
          if (!handled) next()
        } catch (err) {
          console.error('[Commerce API Dev Server Error]:', redactDevError(err))
          if (!res.headersSent) {
            res.statusCode = 500
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ status: 'FAIL', error: err instanceof Error ? err.message : String(err) }))
          }
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Client builds never load the server credential file. All external access stays server-side.
  envDir: 'src/client-env',
  plugins: [react(), commerceApiPlugin()],
  server: {
    port: 5174,
    open: false,
  },
})
