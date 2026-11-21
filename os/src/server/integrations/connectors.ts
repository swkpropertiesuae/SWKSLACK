import type { Section } from './catalog'

const t = (key: string, label: string, extra: Partial<Section['fields'][number]> = {}) => ({ key, label, type: 'text' as const, ...extra })
const pw = (key: string, label: string) => ({ key, label, type: 'password' as const })
const on = (key: string, label: string) => ({ key, label, type: 'bool' as const })

// Portal and partner connections. Credentials are stored encrypted here; each partner issues them under its own agreement.
export const CONNECTOR_SECTIONS: Section[] = [
  { key: 'meta_leads', title: 'Meta Lead Ads (Facebook / Instagram)', icon: 'Megaphone', test: true, summary: 'New Lead Ad submissions arrive as leads in the OS within seconds, de-duplicated and routed by your rules.',
    setup: 'In Meta for Developers create an app, add the Webhooks product, subscribe the Page to "leadgen" and use the callback URL and verify token below. Paste a Page access token with leads_retrieval permission.',
    webhooks: [{ key: 'meta_webhook_path', label: 'Callback URL', path: '/api/public/meta-leads' }],
    fields: [on('meta_enabled', 'Enable Meta Lead Ads'), t('meta_verify_token', 'Webhook verify token (any text you choose)'), pw('meta_page_token', 'Page access token'), pw('meta_app_secret', 'App secret (verifies signatures)')] },
  { key: 'property_finder', title: 'Property Finder', icon: 'Building2', test: true, summary: 'Listing publishing and lead sync with Property Finder.', setup: 'Ask your Property Finder account manager for API access. Enter the credentials they issue.',
    fields: [on('pf_enabled', 'Enable Property Finder'), t('pf_api_base', 'API base URL'), t('pf_client_id', 'Client / API key ID'), pw('pf_client_secret', 'Client secret / API key'), t('pf_agency_id', 'Agency ID')] },
  { key: 'bayut_dubizzle', title: 'Bayut and Dubizzle', icon: 'Building2', test: true, summary: 'Listing publishing and lead sync with Bayut and Dubizzle (Dubizzle Group).', setup: 'Request API or XML feed access from your Bayut / Dubizzle account manager. Enter what they issue.',
    fields: [on('bayut_enabled', 'Enable Bayut'), t('bayut_api_base', 'Bayut API base URL'), pw('bayut_api_key', 'Bayut API key'), t('bayut_agency_id', 'Bayut agency ID'), on('dubizzle_enabled', 'Enable Dubizzle'), t('dubizzle_api_base', 'Dubizzle API base URL'), pw('dubizzle_api_key', 'Dubizzle API key'), t('dubizzle_agency_id', 'Dubizzle agency ID')] },
  { key: 'partner_feeds', title: 'Skyloov, Reelly and Nexi', icon: 'Plug', test: true, summary: 'Partner inventory and lead exchange.',
    fields: [on('skyloov_enabled', 'Enable Skyloov'), pw('skyloov_api_key', 'Skyloov API key'), on('reelly_enabled', 'Enable Reelly'), pw('reelly_api_key', 'Reelly API key'), on('nexi_enabled', 'Enable Nexi'), pw('nexi_api_key', 'Nexi API key')] },
  { key: 'madhmoun', title: 'Madhmoun (Abu Dhabi ADREC permits)', icon: 'Stamp', test: true, summary: 'Advertising permit lookup for Abu Dhabi listings.', fields: [on('madhmoun_enabled', 'Enable Madhmoun'), t('madhmoun_api_base', 'API base URL'), t('madhmoun_client_id', 'Client ID'), pw('madhmoun_client_secret', 'Client secret')] },
  { key: 'esign', title: 'E-signature (DocuSign)', icon: 'FileSignature', test: true, summary: 'Send mandates, MOUs and leases for electronic signature.', fields: [on('docusign_enabled', 'Enable DocuSign'), t('docusign_account_id', 'Account ID'), t('docusign_integration_key', 'Integration key'), pw('docusign_secret', 'Secret key'), t('docusign_base_uri', 'Base URI', { placeholder: 'https://demo.docusign.net' })] },
  { key: 'calendar_sync', title: 'Google / Outlook calendar', icon: 'CalendarDays', test: true, summary: 'Two-way calendar sync. One-way: subscribe to your personal feed from Settings > Profile.', fields: [on('gcal_enabled', 'Enable Google Calendar'), t('gcal_client_id', 'Google client ID'), pw('gcal_client_secret', 'Google client secret'), on('outlook_enabled', 'Enable Outlook'), t('outlook_client_id', 'Microsoft client ID'), pw('outlook_client_secret', 'Microsoft client secret')] },
  { key: 'mortgage_partners', title: 'Mortgage partners (Huspy and banks)', icon: 'Landmark', test: true, summary: 'Send mortgage referrals and receive milestone updates.', fields: [on('huspy_enabled', 'Enable Huspy partner link'), t('huspy_partner_id', 'Partner ID'), pw('huspy_api_key', 'Partner API key')] },
]
export const CONNECTOR_FIELDS = CONNECTOR_SECTIONS.flatMap(s => s.fields)
export const CONNECTOR_SECRET_KEYS = CONNECTOR_FIELDS.filter(f => f.type === 'password').map(f => f.key)
