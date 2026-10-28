import { config } from '../server/config.js'
import { initDatabase, isDatabaseConfigured, query, closePool } from '../server/db.js'

async function verifyDatabase() {
  console.log('\n======================================================')
  console.log('   MAGRABI RBAC DATABASE CONNECTIVITY CHECK')
  console.log('======================================================\n')

  const url = config.database.url

  if (!url || !isDatabaseConfigured()) {
    console.log('[STATUS: PENDING] No DATABASE_URL found in .env or environment.')
    console.log('\nCurrently, the application is using the secure local file fallback.')
    console.log('\nTo connect Neon PostgreSQL:')
    console.log('1. Go to your Neon console (https://console.neon.tech).')
    console.log('2. Copy the "Connection string" (starts with postgresql://...).')
    console.log('3. Open commerce-intelligence-platform/.env and add:')
    console.log('   DATABASE_URL=postgresql://user:password@ep-xyz.neon.tech/neondb?sslmode=require')
    console.log('4. Run: node scripts/verify-db.js\n')
    process.exit(0)
  }

  // Redact credentials for security
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    const dbName = parsed.pathname.replace(/^\//, '')
    console.log(`[INFO] Connecting to PostgreSQL host: ${host}`)
    console.log(`[INFO] Database name: ${dbName}`)
    console.log(`[INFO] SSL Mode: ${config.database.ssl ? 'Enabled (rejectUnauthorized: false)' : 'Disabled'}`)
  } catch {
    console.log('[INFO] Connecting to configured DATABASE_URL...')
  }

  try {
    console.log('[INFO] Initializing tables & migrations...')
    await initDatabase()

    const versionResult = await query('SELECT version();')
    const dbVersion = versionResult.rows[0]?.version || 'Unknown'
    console.log(`[OK] Connection successful!`)
    console.log(`[OK] Server Version: ${dbVersion.split(' ').slice(0, 2).join(' ')}`)

    const tablesResult = await query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name LIKE 'rbac_%'
      ORDER BY table_name;
    `)
    const tables = tablesResult.rows.map(r => r.table_name)
    console.log(`[OK] Verified RBAC Tables (${tables.length}): ${tables.join(', ')}`)

    const rolesResult = await query('SELECT role, description FROM rbac_roles ORDER BY role;')
    console.log(`[OK] Available Roles (${rolesResult.rowCount}): ${rolesResult.rows.map(r => r.role).join(', ')}`)

    const usersResult = await query('SELECT COUNT(*)::int AS count FROM rbac_users;')
    const userCount = usersResult.rows[0]?.count ?? 0
    console.log(`[OK] Registered RBAC Users: ${userCount}`)

    console.log('\n------------------------------------------------------')
    console.log(' [STATUS: OK] Neon PostgreSQL is WORKING and fully ready!')
    console.log('------------------------------------------------------\n')
  } catch (error) {
    console.error('\n[STATUS: FAIL] Could not connect to Neon database.')
    console.error(`[ERROR]: ${error.message || error}`)
    console.log('\nTroubleshooting tips:')
    console.log('- Verify your password in the Neon connection string.')
    console.log('- Ensure your Neon project is not suspended or paused.')
    console.log('- Verify that "?sslmode=require" is present at the end of the URL.\n')
    process.exitCode = 1
  } finally {
    await closePool().catch(() => {})
  }
}

verifyDatabase()
