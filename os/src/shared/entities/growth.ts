import type { EntityDef } from '../types'
import { T,TA,I,N,M,P,B,S,R,D,DT } from '../dsl'
import { LEAD_SOURCES } from './crm'

export const UAE_BANKS = ['Emirates NBD', 'Mashreq', 'First Abu Dhabi Bank', 'Abu Dhabi Commercial Bank', 'Dubai Islamic Bank', 'RAKBANK', 'HSBC', 'Standard Chartered', 'Commercial Bank of Dubai', 'Ajman Bank', 'Other']
export const MORTGAGE_STATUS = ['Referred', 'Documents Collected', 'Submitted to Bank', 'Pre-Approved', 'Valuation Done', 'Final Offer Letter', 'Offer Signed', 'Disbursed', 'Declined', 'Cancelled']
export const TARGET_METRICS = ['Leads converted', 'Calls logged', 'Viewings held', 'Deals won', 'Won value (AED)']

export const growth: EntityDef[] = [
  // Who gets a new lead. The first active rule (lowest priority number) that matches source and department picks the next person in its team.
  {
    key: 'lead_routing_rules', label: 'Lead Routing Rule', plural: 'Lead Routing Rules', module: 'crm', icon: 'Route',
    title: ['name'], panel: true,
    fields: [
      T('name', 'Rule', { required: true, list: true, search: true, section: 'Rule' }),
      B('active', 'Active', { default: true, list: true }),
      I('priority', 'Priority (1 = first)', { default: 10, list: true }),
      S('source', 'Lead source', ['Any', ...LEAD_SOURCES], { default: 'Any', list: true }),
      S('department_division', 'Department', ['Any', 'Sales of Off-Plan Projects', 'Secondary Projects', 'Leasing'], { default: 'Any', list: true }),
      S('strategy', 'Strategy', ['Round robin', 'Least open leads'], { default: 'Round robin', list: true }),
      T('team_roles', 'Team (role names, comma separated)', { default: 'Sales', list: true, help: 'Active users in these roles share the leads. Example: Sales, Manager' }),
      R('last_user_id', 'Last assigned', 'users', { readonly: true }),
    ],
    defaultSort: { field: 'priority', dir: 'asc' },
  },
  // Bank mortgage referral and its milestones (Huspy-style case tracking).
  {
    key: 'mortgage_cases', label: 'Mortgage Case', plural: 'Mortgage Cases', module: 'crm', icon: 'Landmark',
    title: ['case_no', 'client_name'], titleSep: ' – ',
    numbering: { field: 'case_no', pattern: 'MTG-{YY}{seq:5}' },
    panel: true, statusField: 'status', kanban: { field: 'status' },
    fields: [
      T('case_no', 'Case No.', { readonly: true, list: true, search: true, section: 'Case' }),
      R('lead_id', 'Lead', 'leads', { list: true }),
      R('party_id', 'Client', 'parties', { list: true }),
      T('client_name', 'Client', { required: true, list: true, search: true }),
      R('owner_id', 'Sales advisor', 'users', { default: 'me', list: true }),
      R('unit_id', 'Unit', 'units'),
      S('bank', 'Bank', UAE_BANKS, { list: true, section: 'Loan' }),
      M('property_value', 'Property value', { required: true }),
      M('loan_amount', 'Loan amount', { required: true, list: true }),
      P('ltv_pct', 'LTV %', { readonly: true, list: true }),
      N('tenor_years', 'Tenor (years)', { min: 1, max: 30, default: 25 }),
      N('rate_pct', 'Rate %', { min: 0, max: 30 }),
      S('status', 'Milestone', MORTGAGE_STATUS, { default: 'Referred', list: true, key: true, section: 'Milestones' }),
      D('submitted_date', 'Submitted to bank', { readonly: true }),
      D('preapproval_date', 'Pre-approved', { readonly: true }),
      D('offer_date', 'Offer letter', { readonly: true }),
      D('disbursed_date', 'Disbursed'),
      TA('decline_reason', 'Decline / cancel reason'),
      P('referral_commission_pct', 'Bank referral commission % of loan', { default: 0, min: 0, max: 5, section: 'Referral commission' }),
      M('referral_commission', 'Referral commission', { readonly: true, list: true }),
      B('commission_received', 'Commission received from bank'),
      TA('notes', 'Notes'),
    ],
    defaultSort: { field: 'id', dir: 'desc' },
  },
  // Reusable off-plan payment plan (down payment, instalments, handover, post-handover) that can be applied to any unit price.
  {
    key: 'payment_plan_templates', label: 'Payment Plan', plural: 'Payment Plans', module: 'properties', icon: 'ListChecks',
    title: ['name'], panel: true,
    fields: [
      T('name', 'Plan', { required: true, list: true, search: true, section: 'Plan' }),
      R('developer_id', 'Developer', 'developers', { list: true }),
      B('active', 'Active', { default: true, list: true }),
      P('booking_pct', 'Booking / down payment %', { default: 10, list: true, section: 'Split (must total 100%)' }),
      P('construction_pct', 'During construction %', { default: 50, list: true }),
      N('construction_instalments', 'Construction instalments', { min: 0, max: 60, default: 5 }),
      P('handover_pct', 'On handover %', { default: 40, list: true }),
      P('post_handover_pct', 'Post-handover %', { default: 0 }),
      N('post_handover_months', 'Post-handover months', { min: 0, max: 120, default: 0 }),
      I('instalment_gap_months', 'Months between construction instalments', { default: 3, min: 1, max: 12 }),
      TA('notes', 'Notes'),
    ],
    defaultSort: { field: 'id', dir: 'desc' },
  },
  // Monthly goals per advisor, scored against the leaderboard.
  {
    key: 'agent_targets', label: 'Target', plural: 'Targets', module: 'crm', icon: 'Target',
    title: ['user_name', 'metric', 'period'], titleSep: ' · ',
    fields: [
      R('user_id', 'Advisor', 'users', { required: true, list: true, section: 'Target' }),
      T('user_name', 'Advisor', { readonly: true, list: true }),
      T('period', 'Month (YYYY-MM)', { required: true, list: true }),
      S('metric', 'Metric', TARGET_METRICS, { required: true, list: true }),
      N('target', 'Target', { required: true, min: 0, list: true }),
    ],
    defaultSort: { field: 'period', dir: 'desc' },
  },
]

export const growth2: EntityDef[] = [
  // Messages written by sequences or staff that wait for a second person to approve before anything is sent.
  {
    key: 'message_drafts', label: 'Message Draft', plural: 'Message Drafts', module: 'crm', icon: 'MessageCircle',
    title: ['draft_no', 'to_name'], titleSep: ' – ',
    numbering: { field: 'draft_no', pattern: 'MSG-{YY}{seq:5}' },
    panel: true, statusField: 'status',
    fields: [
      T('draft_no', 'Draft No.', { readonly: true, list: true, search: true, section: 'Message' }),
      S('channel', 'Channel', ['WhatsApp', 'Email'], { required: true, default: 'WhatsApp', list: true }),
      R('lead_id', 'Lead', 'leads', { list: true }),
      T('to_name', 'To', { required: true, list: true, search: true }),
      T('to_phone', 'Phone'), T('to_email', 'Email'), T('subject', 'Subject'),
      TA('body', 'Message', { required: true, span: 3 }),
      S('status', 'Status', ['Pending approval', 'Approved', 'Sent', 'Rejected', 'Failed'], { default: 'Pending approval', list: true, key: true }),
      T('source', 'Created by', { readonly: true, list: true }), I('created_by_id', 'Created by id', { readonly: true, hidden: true }),
      R('approved_by_id', 'Approved by', 'users', { readonly: true }),
      DT('sent_at', 'Sent', { readonly: true }), TA('error', 'Send error', { readonly: true }),
    ],
    defaultSort: { field: 'id', dir: 'desc' },
  },
  // Follow-up drip: one step per line as  days after start | channel | message.  Example:  1|WhatsApp|Hi {name}, any questions?
  {
    key: 'followup_sequences', label: 'Follow-up Sequence', plural: 'Follow-up Sequences', module: 'crm', icon: 'CalendarClock',
    title: ['name'], panel: true,
    fields: [
      T('name', 'Sequence', { required: true, list: true, search: true, section: 'Sequence' }),
      B('active', 'Active', { default: true, list: true }),
      TA('steps', 'Steps (one per line: days|channel|message)', { required: true, span: 3, help: 'Example: 1|WhatsApp|Hi {name}, thanks for your enquiry. Would you like to view the unit?' }),
      N('enrolled', 'Enrolled leads', { readonly: true, list: true }), N('replied', 'Replied', { readonly: true, list: true }),
    ],
    defaultSort: { field: 'id', dir: 'desc' },
  },
  {
    key: 'sequence_enrolments', label: 'Sequence Enrolment', plural: 'Sequence Enrolments', module: 'crm', icon: 'CalendarClock',
    title: ['lead_name'], panel: true, statusField: 'status',
    fields: [
      R('sequence_id', 'Sequence', 'followup_sequences', { required: true, list: true, section: 'Enrolment' }),
      R('lead_id', 'Lead', 'leads', { required: true, list: true }),
      T('lead_name', 'Lead', { readonly: true, list: true }),
      S('status', 'Status', ['Running', 'Replied', 'Finished', 'Stopped'], { default: 'Running', list: true, key: true }),
      N('next_step', 'Next step (0 = first)', { readonly: true, default: 0 }),
      DT('next_due', 'Next due', { readonly: true, list: true }),
      T('started_local', 'Started', { readonly: true, hidden: true }),
    ],
    defaultSort: { field: 'id', dir: 'desc' },
  },
  // Simple electronic signature: signer opens a private link, types their name, and the time, IP and document hash are recorded.
  {
    key: 'esign_requests', label: 'Signature Request', plural: 'Signature Requests', module: 'documents', icon: 'FileSignature',
    title: ['request_no', 'title'], titleSep: ' – ',
    numbering: { field: 'request_no', pattern: 'SIG-{YY}{seq:5}' },
    panel: true, statusField: 'status',
    fields: [
      T('request_no', 'Request No.', { readonly: true, list: true, search: true, section: 'Request' }),
      T('title', 'Document', { required: true, list: true, search: true }),
      TA('document_text', 'Text to be signed', { required: true, span: 3 }),
      R('party_id', 'Signer (client)', 'parties', { list: true }),
      T('signer_name', 'Signer name', { required: true, list: true }), T('signer_email', 'Signer email'),
      S('status', 'Status', ['Draft', 'Sent', 'Signed', 'Declined', 'Expired'], { default: 'Draft', list: true, key: true }),
      T('sign_link', 'Signing link', { readonly: true }), T('sign_token_hash', 'Token', { readonly: true, hidden: true }),
      T('document_hash', 'Document fingerprint (SHA-256)', { readonly: true }),
      DT('signed_at', 'Signed at', { readonly: true, list: true }), T('signed_name', 'Typed signature', { readonly: true }), T('signed_ip', 'Signer IP', { readonly: true }),
    ],
    defaultSort: { field: 'id', dir: 'desc' },
  },
  {
    key: 'inspection_templates', label: 'Inspection Template', plural: 'Inspection Templates', module: 'leases', icon: 'ClipboardCheck',
    title: ['name'], panel: true,
    fields: [
      T('name', 'Template', { required: true, list: true, search: true, section: 'Template' }),
      S('kind', 'Type', ['Move-in', 'Move-out', 'Periodic', 'Snagging'], { default: 'Move-in', list: true }),
      TA('items', 'Checklist (one area or item per line)', { required: true, span: 3 }),
    ],
    defaultSort: { field: 'id', dir: 'desc' },
  },
]
