/**
 * SWK Properties Staff Accounts & Role-Based Access Policy
 *
 * Official Governance & Access Hierarchy:
 * - Tier 1 — Supreme Company Owner (Controls Admin & All Accounts):
 *   1. Shabib Siraj (Owner & Managing Director — shabib@swk.properties)
 *      - Role: Owner (Full System Access, Final Approver for Recycle Bin Deletions, Deal Withdrawals & Admin Decisions)
 *      - Holds direct supervisory control over admin@swk.properties (can inspect, unlock, reset password, force sign-out, suspend or re-activate admin@swk.properties).
 * - Tier 2 — Full-Access System & Operations Administrator (Controlled by Owner shabib@swk.properties):
 *   2. SWK Admin (Full-Access Administrator — admin@swk.properties)
 *      - Role: Admin (Dedicated Full-Access Admin account under Owner supervision)
 *      - Full access across all 18+ SWK OS modules (CRM, Sales, Off-Plan, Secondary, Leasing, Properties, Mandates, Finance, HR, Attendance, Studio, Compliance, AI, Reports & System Admin), operating under the direct authority and audit oversight of Owner shabib@swk.properties.
 * - Tier 3 — Operations Manager (Full Operational Access):
 *   3. Mohammad Haseeb (Operations Manager — Haseeb@swk.property)
 * - Tier 4 — Restricted Staff Access (Attendance, Company Manual, Market Pulse & General Only):
 *   - Talha@swk.property
 *   - Fareed@swk.property
 *   - Shahid@swk.property
 *   - Umar@swk.property
 *   - Saifullah@swk.property
 *   - Meenakshi@swk.properties
 *   - Fareed, Shahid, Umar, Sanketh sign in with @swk.rent (their @swk.properties address stays as an alias).
 *   - Any other staff account assigned the 'Staff (Attendance & General)' role.
 */

export interface SwkHardcodedStaffAccount {
  email: string
  displayEmail: string
  aliases: string[]
  name: string
  empNo: string
  roleName: 'Owner' | 'Admin' | 'Manager' | 'Staff (Attendance & General)'
  departmentCode: string
  designation: string
  phone: string
  fullAccess: boolean
  controlledBy?: string
}

export const SWK_OWNER_ACCOUNT: SwkHardcodedStaffAccount = {
  email: 'shabib@swk.properties',
  displayEmail: 'shabib@swk.properties',
  aliases: ['shabib@swk.property', 'shabib@swkpropertiesuae.com'],
  name: 'Shabib Siraj',
  empNo: 'EMP-OWNER',
  roleName: 'Owner',
  departmentCode: 'MGT',
  designation: 'Owner & Managing Director (Controls Admin & All Accounts)',
  phone: '+971 50 100 0001',
  fullAccess: true,
}

export const SWK_ADMIN_ACCOUNT: SwkHardcodedStaffAccount = {
  email: 'admin@swk.properties',
  displayEmail: 'admin@swk.properties',
  aliases: ['admin@swk.property'],
  name: 'SWK Admin',
  empNo: 'EMP-ADMIN',
  roleName: 'Admin',
  departmentCode: 'MGT',
  designation: 'Full-Access System & Operations Administrator (Controlled by Owner Shabib Siraj)',
  phone: '+971 50 100 0000',
  fullAccess: true,
  controlledBy: 'shabib@swk.properties',
}

export const SWK_STAFF_ACCOUNTS: readonly SwkHardcodedStaffAccount[] = [
  SWK_OWNER_ACCOUNT,
  SWK_ADMIN_ACCOUNT,
  {
    email: 'haseeb@swk.properties',
    displayEmail: 'haseeb@swk.properties',
    aliases: ['haseeb@swk.property', 'haseeb@swkpropertiesuae.com', 'manager@swkpropertiesuae.com'],
    name: 'Mohammad Haseeb',
    empNo: 'EMP-HASEEB',
    roleName: 'Manager',
    departmentCode: 'OPS',
    designation: 'Operations Manager',
    phone: '+971 50 100 0002',
    fullAccess: true,
    controlledBy: 'shabib@swk.properties',
  },
  {
    email: 'talha@swk.properties',
    displayEmail: 'talha@swk.properties',
    aliases: ['talha@swk.property', 'talha@swkpropertiesuae.com'],
    name: 'Talha Shabbir',
    empNo: 'EMP-TALHA',
    roleName: 'Staff (Attendance & General)',
    departmentCode: 'IT',
    designation: 'BDM & Digital Operations',
    phone: '+971 50 100 0003',
    fullAccess: false,
    controlledBy: 'shabib@swk.properties',
  },
  {
    email: 'fareed@swk.rent',
    displayEmail: 'fareed@swk.rent',
    aliases: ['fareed@swk.properties', 'fareed@swk.property', 'fareed@swkpropertiesuae.com'],
    name: 'Fareed',
    empNo: 'EMP-FAREED',
    roleName: 'Staff (Attendance & General)',
    departmentCode: 'SAL',
    designation: 'Property Consultant',
    phone: '+971 50 100 0004',
    fullAccess: false,
    controlledBy: 'shabib@swk.properties',
  },
  {
    email: 'shahid@swk.rent',
    displayEmail: 'shahid@swk.rent',
    aliases: ['shahid@swk.properties', 'shahid@swk.property', 'shahid@swkpropertiesuae.com'],
    name: 'Shahid',
    empNo: 'EMP-SHAHID',
    roleName: 'Staff (Attendance & General)',
    departmentCode: 'SAL',
    designation: 'Property Consultant',
    phone: '+971 50 100 0005',
    fullAccess: false,
    controlledBy: 'shabib@swk.properties',
  },
  {
    email: 'umar@swk.rent',
    displayEmail: 'umar@swk.rent',
    aliases: ['umar@swk.properties', 'umar@swk.property', 'umar@swkpropertiesuae.com'],
    name: 'Umar',
    empNo: 'EMP-UMAR',
    roleName: 'Staff (Attendance & General)',
    departmentCode: 'SAL',
    designation: 'Property Consultant',
    phone: '+971 50 100 0006',
    fullAccess: false,
    controlledBy: 'shabib@swk.properties',
  },
  {
    email: 'saifullah@swk.properties',
    displayEmail: 'saifullah@swk.properties',
    aliases: ['saifullah@swk.property', 'saifullah@swkpropertiesuae.com'],
    name: 'Saifullah',
    empNo: 'EMP-SAIFULLAH',
    roleName: 'Staff (Attendance & General)',
    departmentCode: 'SAL',
    designation: 'Property Consultant',
    phone: '+971 50 100 0007',
    fullAccess: false,
    controlledBy: 'shabib@swk.properties',
  },
  {
    email: 'samarth@swk.properties',
    displayEmail: 'samarth@swk.properties',
    aliases: ['samarth@swk.property', 'samarth@swkpropertiesuae.com'],
    name: 'Samarth',
    empNo: 'EMP-SAMARTH',
    roleName: 'Staff (Attendance & General)',
    departmentCode: 'SAL',
    designation: 'Property Consultant',
    phone: '+971 50 100 0008',
    fullAccess: false,
    controlledBy: 'shabib@swk.properties',
  },
  {
    email: 'sanketh@swk.rent',
    displayEmail: 'sanketh@swk.rent',
    aliases: ['sanketh@swk.properties', 'sanketh@swk.property', 'sanketh@swkpropertiesuae.com'],
    name: 'Sanketh',
    empNo: 'EMP-SANKETH',
    roleName: 'Staff (Attendance & General)',
    departmentCode: 'SAL',
    designation: 'Property Consultant',
    phone: '+971 50 100 0009',
    fullAccess: false,
    controlledBy: 'shabib@swk.properties',
  },
  {
    email: 'meenakshi@swk.properties',
    displayEmail: 'meenakshi@swk.properties',
    aliases: ['meenakshi@swk.property', 'meenakshi@swkpropertiesuae.com'],
    name: 'Meenakshi',
    empNo: 'EMP-MEENAKSHI',
    roleName: 'Staff (Attendance & General)',
    departmentCode: 'SAL',
    designation: 'Property Consultant',
    phone: '+971 50 100 0010',
    fullAccess: false,
    controlledBy: 'shabib@swk.properties',
  },
] as const

const OWNER_EMAILS = new Set<string>([
  'shabib@swk.properties',
  'shabib@swk.property',
  'shabib@swkpropertiesuae.com',
])

const ADMIN_EMAILS = new Set<string>([
  'admin@swk.properties',
  'admin@swk.property',
  'admin@swkpropertiesuae.com',
])

const QR_PRINT_ALLOWED_EMAILS = new Set<string>([
  ...OWNER_EMAILS,
  ...ADMIN_EMAILS,
  'haseeb@swk.properties',
  'haseeb@swk.property',
  'haseeb@swkpropertiesuae.com',
  'manager@swkpropertiesuae.com',
])

const FULL_ACCESS_EMAILS = new Set<string>([
  ...QR_PRINT_ALLOWED_EMAILS,
  'demo@swkpropertiesuae.com',
])

/** The ONLY three accounts that may see, print, regenerate or switch the attendance QR. Matched on the exact email: no role, name or domain rule can add anyone. */
const QR_VIEWER_EMAILS: ReadonlySet<string> = new Set(['shabib@swk.properties', 'admin@swk.properties', 'haseeb@swk.properties'])

/**
 * HARD RULE: ONLY Owner Shabib, Admin and Manager Haseeb can view, print or change the Office Attendance QR code.
 * Everyone else only scans it with the camera inside the check-in page.
 */
export function canPrintReceptionQr(
  user: { email?: string | null; role?: string | null; role_name?: string | null; name?: string | null; party_id?: number | null } | null | undefined,
): boolean {
  if (!user || user.party_id) return false
  return QR_VIEWER_EMAILS.has(String(user.email || '').trim().toLowerCase())
}

/**
 * HARD RULE: ONLY Owner Shabib (shabib@swk.properties), Admin (admin@swk.properties),
 * and Operations Manager Haseeb (haseeb@swk.properties) can access the Master CRM Vault,
 * view unmasked owner phone numbers, or assign/revoke deals to field agents.
 */
export function canAccessCrmVault(
  user: { email?: string | null; role?: string | null; role_name?: string | null; name?: string | null; party_id?: number | null } | null | undefined,
): boolean {
  if (!user || user.party_id) return false
  return QR_VIEWER_EMAILS.has(String(user.email || '').trim().toLowerCase())
}

/**
 * Hard check for Administration & Governance logic (Recycle Bin, Withdrawals, Universal Approvals,
 * Owner Morning Briefing, 10:30 AM Contemptor Report, System Settings, Roles & Users).
 * Visible ONLY to Owner, Haseeb, or staff who have been explicitly granted an Administrative role.
 */
export function canAccessSwkAdminLogic(
  user: {
    email?: string | null
    role?: string | null
    role_name?: string | null
    name?: string | null
    party_id?: number | null
    permissions?: '*' | Record<string, string[]> | null
  } | null | undefined,
): boolean {
  if (!user || user.party_id) return false
  if (canPrintReceptionQr(user)) return true
  if (isRestrictedStaffUser(user)) return false
  const role = String(user.role_name || user.role || '').trim().toLowerCase()
  if (role === 'admin' || role === 'owner') return true
  const perms = user.permissions
  if (perms === '*') return true
  if (perms && typeof perms === 'object' && Array.isArray(perms.admin) && perms.admin.includes('view')) {
    return true
  }
  return false
}

const RESTRICTED_STAFF_EMAILS = new Set<string>([
  'talha@swk.property',
  'talha@swk.properties',
  'talha@swkpropertiesuae.com',
  'fareed@swk.property',
  'fareed@swk.properties',
  'fareed@swkpropertiesuae.com',
  'fareed@swk.rent',
  'shahid@swk.property',
  'shahid@swk.properties',
  'shahid@swkpropertiesuae.com',
  'shahid@swk.rent',
  'umar@swk.property',
  'umar@swk.properties',
  'umar@swkpropertiesuae.com',
  'umar@swk.rent',
  'saifullah@swk.property',
  'saifullah@swk.properties',
  'saifullah@swkpropertiesuae.com',
  'samarth@swk.property',
  'samarth@swk.properties',
  'samarth@swkpropertiesuae.com',
  'sanketh@swk.property',
  'sanketh@swk.properties',
  'sanketh@swkpropertiesuae.com',
  'sanketh@swk.rent',
  'meenakshi@swk.property',
  'meenakshi@swk.properties',
  'meenakshi@swkpropertiesuae.com',
])

export const RESTRICTED_STAFF_PERMISSIONS: Record<string, string[]> = {
  dashboard: ['view'],
  hr: ['view', 'create'],
  masters: ['view'],
  ai: ['view', 'create'],
}

export const RESTRICTED_STAFF_ALLOWED_ENTITIES = new Set<string>([
  'attendance',
  'attendance_events',
  'leave_requests',
  'daily_reports',
  'knowledge_articles',
  'staff_qualifications',
  'activity_skill_rules',
  'communities',
  'developers',
  'dld_market_transactions',
  'real_estate_news',
  'branches',
  'departments',
])

export const RESTRICTED_STAFF_SELF_SCOPED_ENTITIES = new Set<string>([
  'attendance',
  'attendance_events',
  'leave_requests',
  'daily_reports',
])

export function isSwkCompanyEmail(email: string | null | undefined): boolean {
  const e = String(email || '').trim().toLowerCase()
  return e.endsWith('@swk.properties') || e.endsWith('@swk.property') || e.endsWith('@swkpropertiesuae.com') || e.endsWith('@swk.rent')
}

export function isOwnerSwkUser(
  user: { email?: string | null; role?: string | null; role_name?: string | null; name?: string | null } | null | undefined,
): boolean {
  if (!user) return false
  const email = String(user.email || '').trim().toLowerCase()
  if (OWNER_EMAILS.has(email)) return true
  const role = String(user.role_name || user.role || '').trim().toLowerCase()
  return role === 'owner'
}

export function isAdminSwkUser(
  user: { email?: string | null; role?: string | null; role_name?: string | null; name?: string | null } | null | undefined,
): boolean {
  if (!user) return false
  const email = String(user.email || '').trim().toLowerCase()
  if (ADMIN_EMAILS.has(email)) return true
  const role = String(user.role_name || user.role || '').trim().toLowerCase()
  return role === 'admin'
}

/**
 * Checks whether the user has full operational access (Owner, Admin, Operations Manager Haseeb, or explicitly promoted role).
 */
export function isFullAccessSwkUser(
  user: { email?: string | null; role?: string | null; role_name?: string | null; name?: string | null } | null | undefined,
): boolean {
  if (!user) return false
  const email = String(user.email || '').trim().toLowerCase()
  const role = String(user.role_name || user.role || '').trim().toLowerCase()
  const name = String(user.name || '').trim().toLowerCase()
  if (role === 'admin' || role === 'owner') return true
  if (role === 'staff (attendance & general)') return false
  if (FULL_ACCESS_EMAILS.has(email)) return true
  if (RESTRICTED_STAFF_EMAILS.has(email) && !role) return false
  if (role === 'manager' && (name.includes('haseeb') || email.includes('haseeb') || email.includes('manager'))) return true
  return false
}

export function isRestrictedStaffUser(
  user: { email?: string | null; role?: string | null; role_name?: string | null; name?: string | null; party_id?: number | null } | null | undefined,
): boolean {
  if (!user || user.party_id) return false
  if (canPrintReceptionQr(user)) return false
  const email = String(user.email || '').trim().toLowerCase()
  const role = String(user.role_name || user.role || '').trim().toLowerCase()
  if (role === 'staff (attendance & general)') return true
  if (role && role !== 'staff (attendance & general)') return false
  if (RESTRICTED_STAFF_EMAILS.has(email)) return true
  if (email.endsWith('@swk.property') && !FULL_ACCESS_EMAILS.has(email)) return true
  return false
}

export function isAllowedPathForRestrictedStaff(pathname: string): boolean {
  const clean = String(pathname || '/').split('?')[0] || '/'
  const exactAllowed = new Set([
    '/',
    '/home',
    '/login',
    '/swk-one',
    '/qr-checkin',
    '/reception-qr',
    '/swk/reception-qr',
    '/qr-reception',
    '/market',
    '/competency',
    '/toolkit',
    '/tools',
    '/calendar',
    '/ai',
    '/profile',
    '/my-deals',
    '/workspace-tools',
    '/handover',
    '/handover-portal',
  ])
  if (exactAllowed.has(clean)) return true
  if (
    clean.startsWith('/reception-qr/') ||
    clean.startsWith('/swk/reception-qr/') ||
    clean.startsWith('/qr-reception/') ||
    clean.startsWith('/handover/') ||
    clean.startsWith('/print/')
  ) {
    return true
  }
  if (clean.startsWith('/e/')) {
    const entity = clean.split('/')[2] || ''
    return RESTRICTED_STAFF_ALLOWED_ENTITIES.has(entity)
  }
  return false
}

/** Employee records (and the Access & usage view) open only for the Owner and the Admin. */
export function canOpenEmployeeRecords(
  user: { email?: string | null; role?: string | null; role_name?: string | null; party_id?: number | null } | null | undefined,
): boolean {
  if (!user || user.party_id) return false
  return isOwnerSwkUser(user) || isAdminSwkUser(user)
}

/** Employee records open for the Owner, the Admin and the Operations Manager (Haseeb). Handover custody and Access & usage stay Owner/Admin only (canOpenEmployeeRecords). */
export function canViewEmployeeRecords(
  user: { email?: string | null; role?: string | null; role_name?: string | null; party_id?: number | null } | null | undefined,
): boolean {
  if (!user || user.party_id) return false
  const e = String(user.email ?? '').trim().toLowerCase()
  return canOpenEmployeeRecords(user) || ['haseeb@swk.properties', 'haseeb@swk.property', 'haseeb@swkpropertiesuae.com', 'manager@swkpropertiesuae.com'].includes(e)
}

/** Password pattern for every hardcoded account except the Manager: first part of the email, capitalised, + '@swk2026' (Shabib@swk2026). */
export function swkPatternPassword(email: string): string {
  const local = String(email).split('@')[0]
  return local.charAt(0).toUpperCase() + local.slice(1).toLowerCase() + '@swk2026'
}
