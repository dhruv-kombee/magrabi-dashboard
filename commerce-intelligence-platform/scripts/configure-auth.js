import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import { hashPassword } from '../server/auth.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(scriptDir, '..')
const secretDir = path.resolve(projectDir, '..', '.secrets')
const targetPath = path.join(secretDir, 'dashboard-auth.env')

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
  console.log('Configure the Commerce Intelligence dashboard login. Password input is hidden.')
  const username = await visiblePrompt('Username: ')
  if (username.length < 3 || username.length > 100 || /[\r\n=]/.test(username)) throw new Error('Username must contain 3-100 valid characters.')
  const password = await hiddenPrompt('Password (minimum 12 characters): ')
  const confirmation = await hiddenPrompt('Confirm password: ')
  if (password !== confirmation) throw new Error('Passwords do not match.')
  const passwordHash = await hashPassword(password)
  const sessionSecret = randomBytes(48).toString('base64url')
  const content = [
    '# Generated dashboard authentication configuration. Never commit this file.',
    `AUTH_USERNAME=${username}`,
    `AUTH_PASSWORD_HASH=${passwordHash}`,
    `AUTH_SESSION_SECRET=${sessionSecret}`,
    'AUTH_SESSION_TIMEOUT_MINUTES=10',
    '',
  ].join('\n')
  await fs.mkdir(secretDir, { recursive: true })
  await fs.writeFile(targetPath, content, { encoding: 'utf8', mode: 0o600 })
  console.log(`OK: Dashboard authentication saved to ${targetPath}`)
  console.log('Restart the application to load the new login configuration.')
} catch (error) {
  const safeMessages = new Set(['Interactive terminal required.', 'Cancelled.', 'Username must contain 3-100 valid characters.', 'Passwords do not match.', 'Password must contain at least 12 characters.'])
  const message = error instanceof Error && safeMessages.has(error.message) ? error.message : 'Authentication configuration could not be saved.'
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}
