import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { hashPassword } from '../server/auth.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(scriptDir, '..')
const secretDir = path.resolve(projectDir, '..', '.secrets')
const deploymentMode = process.argv.includes('--deployment-env')
const targetPath = path.join(secretDir, deploymentMode ? 'dashboard-auth-deployment.env' : 'dashboard-auth.env')

async function visiblePrompt(message) {
  const interfaceHandle = createInterface({ input: process.stdin, output: process.stdout })
  try { return (await interfaceHandle.question(message)).trim() } finally { interfaceHandle.close() }
}

function hiddenPrompt(message) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Interactive terminal required.')
  }
  return new Promise((resolve, reject) => {
    let value = ''
    process.stdout.write(message)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    const restore = () => {
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdin.removeListener('data', onData)
    }
    const onData = (buffer) => {
      const input = buffer.toString('utf8')
      for (const character of input) {
        if (character === '\u0003') {
          restore()
          process.stdout.write('\n')
          reject(new Error('Cancelled.'))
          return
        }
        if (character === '\r' || character === '\n') {
          restore()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1)
        else value += character
      }
    }
    process.stdin.on('data', onData)
  })
}

try {
  console.log(`Configure the Commerce Intelligence admin and viewer ${deploymentMode ? 'deployment environment' : 'local login'}. Password input is hidden.`)
  const adminUsername = await visiblePrompt('Admin username: ')
  if (adminUsername.length < 3 || adminUsername.length > 100 || /[\r\n=]/.test(adminUsername)) throw new Error('Username must contain 3-100 valid characters.')
  const adminPassword = await hiddenPrompt('Admin password (minimum 12 characters): ')
  const adminConfirmation = await hiddenPrompt('Confirm admin password: ')
  if (adminPassword !== adminConfirmation) throw new Error('Passwords do not match.')

  const viewerUsername = await visiblePrompt('Viewer username: ')
  if (viewerUsername.length < 3 || viewerUsername.length > 100 || /[\r\n=]/.test(viewerUsername)) throw new Error('Username must contain 3-100 valid characters.')
  if (viewerUsername === adminUsername) throw new Error('Admin and viewer usernames must be different.')
  const viewerPassword = await hiddenPrompt('Viewer password (minimum 12 characters): ')
  const viewerConfirmation = await hiddenPrompt('Confirm viewer password: ')
  if (viewerPassword !== viewerConfirmation) throw new Error('Passwords do not match.')

  const adminPasswordHash = await hashPassword(adminPassword)
  const viewerPasswordHash = await hashPassword(viewerPassword)
  const sessionSecret = randomBytes(48).toString('base64url')
  const content = [
    '# Generated dashboard authentication configuration. Never commit this file.',
    `AUTH_ADMIN_USERNAME=${adminUsername}`,
    `AUTH_ADMIN_PASSWORD_HASH=${adminPasswordHash}`,
    `AUTH_VIEWER_USERNAME=${viewerUsername}`,
    `AUTH_VIEWER_PASSWORD_HASH=${viewerPasswordHash}`,
    `AUTH_SESSION_SECRET=${sessionSecret}`,
    'AUTH_SESSION_TIMEOUT_MINUTES=10',
    '',
  ].join('\n')
  await fs.mkdir(secretDir, { recursive: true })
  await fs.writeFile(targetPath, content, { encoding: 'utf8', mode: 0o600 })
  console.log(`OK: Authentication variables saved securely to ${targetPath}`)
  console.log(deploymentMode
    ? 'Import this file through the deployment platform secret/environment-variable interface. Do not commit or print its contents.'
    : 'Restart the application to load the new login configuration.')
} catch (error) {
  const safeMessages = new Set(['Interactive terminal required.', 'Cancelled.', 'Username must contain 3-100 valid characters.', 'Admin and viewer usernames must be different.', 'Passwords do not match.', 'Password must contain at least 12 characters.'])
  const message = error instanceof Error && safeMessages.has(error.message) ? error.message : 'Authentication configuration could not be saved.'
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}
