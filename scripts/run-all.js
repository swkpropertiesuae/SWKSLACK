// Runs SWK Hub and SWK OS side by side and wires them together.
//   node scripts/run-all.js        production (OS must be built: npm run os:build)
//   node scripts/run-all.js --dev  development (OS with hot reload on :5173, API :8080)
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const dev = process.argv.includes('--dev')
const osPort = process.env.OS_PORT || '8080'
const hubPort = process.env.PORT || '3000'

// One shared secret for OS → Hub events, generated once and kept in data/.
mkdirSync(join(root, 'data'), { recursive: true })
const secretFile = join(root, 'data', 'os-webhook-secret')
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(24).toString('hex'), { mode: 0o600 })
const secret = process.env.OS_WEBHOOK_SECRET || readFileSync(secretFile, 'utf8').trim()

if (!existsSync(join(root, 'os', 'node_modules'))) { console.error('Run `npm run os:install` first.'); process.exit(1) }
if (!dev && !existsSync(join(root, 'os', 'dist', 'server', 'index.mjs'))) { console.error('Run `npm run os:build` first (or use --dev).'); process.exit(1) }

const procs = []
function run(name, cmd, args, cwd, env) {
  // Own process group, so stopping also stops what `npm run` started underneath.
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  const tag = name === 'os' ? '\x1b[33m[os] \x1b[0m' : '\x1b[36m[hub]\x1b[0m'
  for (const s of [p.stdout, p.stderr]) s.on('data', d => process.stdout.write(String(d).replace(/^(?=.)/gm, tag + ' ')))
  p.on('exit', code => { console.log(`${tag} exited (${code}); stopping`); stop(code ?? 1) })
  procs.push(p)
}
function stop(code = 0) { for (const p of procs) try { process.kill(-p.pid, 'SIGTERM') } catch { /* already gone */ } process.exit(code) }
process.on('SIGINT', () => stop(0)); process.on('SIGTERM', () => stop(0))

const osUrl = process.env.OS_URL || (dev ? 'http://localhost:5173' : `http://localhost:${osPort}`)
run('os', 'npm', ['run', dev ? 'dev' : 'start'], join(root, 'os'), { PORT: osPort, HUB_URL: `http://localhost:${hubPort}` })
run('hub', process.execPath, ['--no-warnings', 'src/server.js'], root, {
  PORT: hubPort, OS_URL: osUrl, OS_API_URL: process.env.OS_API_URL || `http://localhost:${osPort}`, OS_WEBHOOK_SECRET: secret,
})
console.log(`\nSWK Hub  http://localhost:${hubPort}\nSWK OS   ${osUrl}\nIn SWK OS → Webhooks, point events at http://localhost:${hubPort}/os/events with secret from data/os-webhook-secret\n`)
