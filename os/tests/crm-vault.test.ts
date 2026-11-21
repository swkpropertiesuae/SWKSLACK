import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Run against an isolated temporary SQLite database
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swk-crm-vault-test-'))
process.env.DATA_DIR = tmpDir
process.env.DATABASE_URL = ''
process.env.SWK_CRM_VAULT_KEY = process.env.SWK_CRM_VAULT_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

async function run() {
  const { syncSchema } = await import('../src/server/schema')
  const { seedReference } = await import('../src/server/seed')
  const { loadUser } = await import('../src/server/auth')
  const { q } = await import('../src/server/db')
  const {
    loadEncryptedVaultSeedIfConfigured,
    getVaultSummary,
    listVaultPropertiesForLeadership,
    assignVaultProperties,
    listAgentAssignedProperties,
    initiateMaskedBridgeCall,
  } = await import('../src/server/domain/crm-vault')

  syncSchema()
  await seedReference()

  const userByEmail = (email: string) => {
    const row = q.get<{ id: number }>(`SELECT id FROM users WHERE lower(email) = ?`, email.toLowerCase())
    assert.ok(row, `Expected user ${email}`)
    const u = loadUser(row.id)
    assert.ok(u, `Expected loadUser(${email})`)
    return u
  }

  const shabib = userByEmail('shabib@swk.properties')
  const admin = userByEmail('admin@swk.properties')
  const haseeb = userByEmail('haseeb@swk.properties')
  const saifullah = userByEmail('saifullah@swk.properties')
  const fareed = userByEmail('fareed@swk.rent')
  const sanketh = userByEmail('sanketh@swk.rent')

  // 1. Load encrypted seed bundle
  const seeded = loadEncryptedVaultSeedIfConfigured()
  assert.equal(seeded.loaded, true, 'Encrypted CRM Vault seed should load')
  assert.equal(seeded.properties, 3600, `Expected 3,600 total properties, got ${seeded.properties}`)
  assert.equal(seeded.routes, 90, `Expected 90 route tracker rows, got ${seeded.routes}`)

  // 2. Verify Leadership (Admin, Shabib, Haseeb) CAN access summary & unmasked phone numbers
  for (const leader of [shabib, admin, haseeb]) {
    const sum = getVaultSummary(leader)
    assert.equal(sum.totals.total_properties, 3600)
    assert.equal(sum.totals.with_direct_phone, 1920)
    assert.equal(sum.route_tracker_count, 90)
  }

  const page1 = listVaultPropertiesForLeadership(shabib, { dataset: 'cluster_1920', suggested_agent: 'Saifullah', pageSize: 5 })
  assert.equal(page1.total, 320)
  const firstProp = page1.rows[0]
  assert.ok(firstProp.direct_mobile && firstProp.direct_mobile.includes('+971'), 'Leadership must see unmasked direct_mobile')
  const rawPhoneDigits = firstProp.direct_mobile.replace(/\D+/g, '')

  // 3. Verify Agents (Saifullah, Fareed, Sanketh) CANNOT access Leadership Vault endpoints
  for (const agent of [saifullah, fareed, sanketh]) {
    assert.throws(() => getVaultSummary(agent), /restricted/i, `${agent.name} must be blocked from vault summary`)
    assert.throws(() => listVaultPropertiesForLeadership(agent, {}), /restricted/i, `${agent.name} must be blocked from vault list`)
    assert.throws(() => assignVaultProperties(agent, { property_ids: [firstProp.id], agent_user_id: agent.id }), /only owner shabib/i)
  }

  // 4. Leadership dispatches 2 properties to Saifullah with strict visibility policy (owner name & commission hidden)
  const assignRes = assignVaultProperties(haseeb, {
    property_ids: [page1.rows[0].id, page1.rows[1].id],
    agent_user_id: saifullah.id,
    visible_fields: {
      show_owner_name: false,
      show_exact_unit: true,
      show_deal_value: true,
      show_commission: false,
      show_playbook: true,
      allow_masked_call: true,
      allow_masked_whatsapp: true,
    },
  })
  assert.equal(assignRes.assigned, 2)

  // 5. Saifullah sees ONLY those 2 deals, ONLY allowed fields, and ZERO raw phone digits in JSON
  const saifView = listAgentAssignedProperties(saifullah, {})
  assert.equal(saifView.total, 2)
  const serialized = JSON.stringify(saifView)
  assert.ok(!serialized.includes(firstProp.direct_mobile), 'Raw phone string must NEVER appear in agent payload')
  assert.ok(!serialized.includes(rawPhoneDigits), 'Raw phone digits must NEVER appear in agent payload')
  assert.ok(!serialized.includes(firstProp.owner_name), 'Hidden owner name must NEVER appear in agent payload')
  assert.equal(saifView.rows[0].owner_name, 'Protected Owner')
  assert.equal(saifView.rows[0].est_agency_commission_aed, null)
  assert.ok(saifView.rows[0].phone_masked.startsWith('MASKED ••••'), 'Agent must only see MASKED phone shield')

  // Fareed sees 0 deals (strict isolation between agents)
  const fareedView = listAgentAssignedProperties(fareed, {})
  assert.equal(fareedView.total, 0)

  // 6. Masked Bridge Call fails closed when bridge not configured (never leaks phone number!)
  await assert.rejects(
    () => initiateMaskedBridgeCall(saifullah, firstProp.id, 'https://os.swk.properties'),
    (err: any) => err?.status === 409 && !String(err?.message || '').includes(rawPhoneDigits),
  )

  console.log('ALL CRM VAULT SECURITY & HARD-MASKING TESTS PASSED (3,600 properties + 90 routes verified)!')
}

run().catch(err => {
  console.error(err)
  process.exit(1)
})
