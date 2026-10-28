import pg from 'pg'
import fs from 'node:fs'
import { config } from './config.js'

const { Pool } = pg

let poolInstance = null
let initializedPromise = null

export function isDatabaseConfigured() {
  return config.database.isConfigured
}

export function getPool() {
  if (!isDatabaseConfigured()) return null
  if (!poolInstance) {
    const poolConfig = {
      connectionString: config.database.url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    }
    if (config.database.ssl) {
      poolConfig.ssl = config.database.ssl
    }
    poolInstance = new Pool(poolConfig)
    poolInstance.on('error', (err) => {
      console.error('[Database Pool Error]:', err?.message || err)
    })
  }
  return poolInstance
}

export async function closePool() {
  if (poolInstance) {
    try {
      await poolInstance.end()
    } catch {
      // Ignore cleanup error
    }
    poolInstance = null
    initializedPromise = null
  }
}

export async function query(text, params = []) {
  const pool = getPool()
  if (!pool) throw new Error('Database is not configured. Set DATABASE_URL.')
  return pool.query(text, params)
}

/**
 * Initializes database schema idempotently and automatically migrates any legacy
 * users from the local dashboard-users.json file into PostgreSQL.
 */
export async function initDatabase() {
  if (!isDatabaseConfigured()) return false
  if (initializedPromise) return initializedPromise

  initializedPromise = (async () => {
    const pool = getPool()
    if (!pool) return false

    // 1. Create tables idempotently
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rbac_roles (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        is_system BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rbac_permissions (
        code VARCHAR(100) PRIMARY KEY,
        module VARCHAR(50) NOT NULL,
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS rbac_role_permissions (
        role_id VARCHAR(50) REFERENCES rbac_roles(id) ON DELETE CASCADE,
        permission_code VARCHAR(100) REFERENCES rbac_permissions(code) ON DELETE CASCADE,
        PRIMARY KEY (role_id, permission_code)
      );

      CREATE TABLE IF NOT EXISTS rbac_users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username VARCHAR(100) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL DEFAULT 'viewer',
        permissions TEXT[] DEFAULT '{}',
        is_active BOOLEAN DEFAULT TRUE,
        failed_attempts INT DEFAULT 0,
        locked_until TIMESTAMPTZ,
        last_login_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rbac_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        actor_username VARCHAR(100),
        action VARCHAR(100) NOT NULL,
        target_username VARCHAR(100),
        details JSONB,
        ip_address VARCHAR(50),
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS rbac_sessions (
        id VARCHAR(128) PRIMARY KEY,
        username VARCHAR(100) NOT NULL,
        credential_version VARCHAR(64),
        issued_at TIMESTAMPTZ DEFAULT NOW(),
        last_activity_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        is_revoked BOOLEAN DEFAULT FALSE
      );
    `)

    // 2. Seed system roles
    await pool.query(`
      INSERT INTO rbac_roles (id, name, description, is_system) VALUES
        ('admin', 'Administrator', 'Full system access and user management', TRUE),
        ('operations', 'Operations Lead', 'Operational access to orders, traffic, infra, sources and alerts', TRUE),
        ('analyst', 'Commerce Analyst', 'Analytical access to overview, orders, and customer journey', TRUE),
        ('viewer', 'Standard Viewer', 'Standard dashboard read access', TRUE)
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description;
    `)

    // 3. Seed system permissions
    const systemPermissions = [
      ['overview', 'overview', 'View executive revenue and OMS live order metrics'],
      ['orders', 'orders', 'View order reconciliation and payment gateway telemetry'],
      ['journey', 'journey', 'View customer funnel and conversion drop-off analytics'],
      ['traffic', 'traffic', 'View edge traffic, RPS, and status code trends'],
      ['infra', 'infra', 'View APM service health, latency, and resource metrics'],
      ['sources', 'sources', 'View data connectors inventory and diagnostic health'],
      ['alerts', 'alerts', 'View and simulate operational incident alert rules'],
      ['users', 'users', 'Manage user accounts, roles, and permissions (Admin)'],
    ]

    for (const [code, moduleName, desc] of systemPermissions) {
      await pool.query(`
        INSERT INTO rbac_permissions (code, module, description)
        VALUES ($1, $2, $3)
        ON CONFLICT (code) DO NOTHING;
      `, [code, moduleName, desc])
    }

    // 4. Seed role permissions mapping
    const roleMappings = [
      ['admin', ['overview', 'orders', 'journey', 'traffic', 'infra', 'sources', 'alerts', 'users']],
      ['operations', ['overview', 'orders', 'traffic', 'infra', 'sources', 'alerts']],
      ['analyst', ['overview', 'orders', 'journey']],
      ['viewer', ['overview', 'orders', 'journey', 'traffic', 'infra']],
    ]

    for (const [roleId, permCodes] of roleMappings) {
      for (const permCode of permCodes) {
        await pool.query(`
          INSERT INTO rbac_role_permissions (role_id, permission_code)
          VALUES ($1, $2)
          ON CONFLICT (role_id, permission_code) DO NOTHING;
        `, [roleId, permCode])
      }
    }

    // 5. Automatic Migration: Import any existing users from the JSON file into PostgreSQL
    try {
      if (fs.existsSync(config.auth.managedUsersFile)) {
        const fileContent = fs.readFileSync(config.auth.managedUsersFile, 'utf8')
        const parsed = JSON.parse(fileContent)
        if (Array.isArray(parsed?.users)) {
          for (const user of parsed.users) {
            if (user?.username && user?.passwordHash) {
              await pool.query(`
                INSERT INTO rbac_users (username, password_hash, role, permissions)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (username) DO NOTHING;
              `, [
                user.username,
                user.passwordHash,
                user.role || 'viewer',
                Array.isArray(user.permissions) ? user.permissions : ['overview', 'orders', 'journey', 'traffic', 'infra'],
              ])
            }
          }
        }
      }
    } catch (migErr) {
      console.warn('[Database Migration Notice]: Could not read legacy users file for import:', migErr?.message)
    }

    return true
  })()

  return initializedPromise
}
