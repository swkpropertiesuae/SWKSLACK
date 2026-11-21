// SWK Hub web client: no framework, DOM built with h() so user text is never parsed as HTML.
const $app = document.getElementById('app')
const S = { me: null, users: [], channels: [], tables: [], records: [], view: 'grid', thread: null, filter: '' }

// ---------- helpers ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'value') el.value = v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c))
  return el
}
const kids = (...a) => a.flat(Infinity).filter(x => x != null && x !== false)
async function api(method, path, body, ctype = 'application/json') {
  const res = await fetch(path, { method, headers: body !== undefined ? { 'content-type': ctype } : {}, body: body === undefined ? undefined : ctype === 'application/json' ? JSON.stringify(body) : body })
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
  if (res.status === 401 && path !== '/api/login') { S.me = null; renderLogin(); throw new Error('Signed out') }
  if (!res.ok) throw new Error(data?.error || `Error ${res.status}`)
  return data
}
function toast(msg) {
  const t = h('div', { class: 'toast', role: 'status' }, msg)
  document.body.append(t); setTimeout(() => t.remove(), 3500)
}
const guard = fn => async (...a) => { try { await fn(...a) } catch (e) { if (e.message !== 'Signed out') toast(e.message) } }
const userName = id => S.users.find(u => u.id === Number(id))?.name || ''
const initials = n => String(n || '?').split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase()
const fmtTime = s => new Date(s.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const fmtDay = s => new Date(s.replace(' ', 'T') + 'Z').toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })
const chanLabel = c => c.is_dm ? (c.dm_with || 'Just you') : '# ' + c.name
const KIND = { crm: 'CRM', listings: 'Listings', board: 'Boards', base: 'Bases' }

function modal(title, body, actions = []) {
  const bg = h('div', { class: 'modal-bg', onclick: e => e.target === bg && bg.remove() })
  const close = () => bg.remove()
  bg.append(h('div', { class: 'modal', role: 'dialog', 'aria-label': title }, h('h2', {}, title), body,
    h('footer', {}, h('div', { class: 'row' }, actions.filter(a => a.left).map(a => h('button', { class: 'btn ' + (a.class || ''), onclick: guard(async () => { if (await a.run() !== false) close() }) }, a.label))),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: close }, 'Cancel'),
        actions.filter(a => !a.left).map(a => h('button', { class: 'btn ' + (a.class || 'primary'), onclick: guard(async () => { if (await a.run() !== false) close() }) }, a.label))))))
  document.body.append(bg)
  bg.querySelector('input,textarea,select')?.focus()
  return close
}

// Chat text: escape-safe formatting built from text nodes.
function formatText(body) {
  const out = []
  const re = /(```[\s\S]+?```|`[^`]+`|\*[^*\n]+\*|https?:\/\/\S+|@[\w.-]+)/g
  let last = 0
  for (const m of body.matchAll(re)) {
    out.push(body.slice(last, m.index)); last = m.index + m[0].length
    const t = m[0]
    if (t.startsWith('```')) out.push(h('pre', {}, t.slice(3, -3)))
    else if (t.startsWith('`')) out.push(h('code', {}, t.slice(1, -1)))
    else if (t.startsWith('*')) out.push(h('b', {}, t.slice(1, -1)))
    else if (t.startsWith('http')) out.push(h('a', { href: t, target: '_blank', rel: 'noopener noreferrer' }, t))
    else out.push(h('span', { class: 'mention' }, t))
  }
  out.push(body.slice(last))
  return out
}

// ---------- boot ----------
async function boot() {
  try { S.me = await api('GET', '/api/me') } catch { return renderLogin() }
  await refreshAll()
  connect()
  window.onhashchange = route
  route()
}
async function refreshAll() {
  ;[S.users, S.channels, S.tables] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/channels'), api('GET', '/api/tables')])
}

function renderLogin() {
  const err = h('div', { class: 'err', role: 'alert' })
  const email = h('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'you@swkpropertiesuae.com' })
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' })
  $app.replaceChildren(h('div', { class: 'login' }, h('form', {
    onsubmit: async e => {
      e.preventDefault(); err.textContent = ''
      try { await api('POST', '/api/login', { email: email.value, password: pw.value }); boot() } catch (x) { err.textContent = x.message }
    },
  }, h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'S'), h('div', {}, h('b', { style: 'color:var(--text)' }, 'SWK Hub'), h('small', {}, 'SWK Properties LLC'))),
  h('label', {}, 'Email', email), h('label', {}, 'Password', pw), err, h('button', { class: 'btn primary' }, 'Sign in'))))
}

// ---------- realtime ----------
let ws, retry = 1000
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onopen = () => { retry = 1000 }
  ws.onclose = () => { if (S.me) setTimeout(connect, retry = Math.min(retry * 2, 30000)) }
  ws.onmessage = e => onEvent(JSON.parse(e.data))
}
let pending
const later = (fn, ms = 250) => { clearTimeout(pending); pending = setTimeout(guard(fn), ms) }
function onEvent(ev) {
  const r = parseHash()
  if (ev.type === 'message') {
    const m = ev.message
    if (r.kind === 'c' && Number(r.id) === m.channel_id) {
      if (!m.parent_id) appendMessage(m, true)
      if (S.thread === m.parent_id) appendThread(m)
      if (!m.parent_id) api('GET', `/api/channels/${m.channel_id}/messages?before=0`).catch(() => {}) // marks read
    } else if (m.user_id !== S.me.id && (m.body.includes('@' + S.me.name.split(' ')[0]) || S.channels.find(c => c.id === m.channel_id)?.is_dm)) {
      toast(`${m.author}: ${m.body.slice(0, 80)}`)
    }
    later(async () => { S.channels = await api('GET', '/api/channels'); renderSide() })
  } else if (ev.type === 'message.update' || ev.type === 'message.delete') {
    if (r.kind === 'c' && Number(r.id) === ev.message?.channel_id || ev.channel_id === Number(r.id)) later(() => openChannel(r.id, true), 100)
  } else if (ev.type === 'channels') later(async () => { S.channels = await api('GET', '/api/channels'); renderSide() })
  else if (ev.type === 'tables') later(async () => { S.tables = await api('GET', '/api/tables'); renderSide(); if (r.kind === 't') openTable(r.id) })
  else if ((ev.type === 'record' || ev.type === 'record.delete') && r.kind === 't' && Number(r.id) === (ev.record?.table_id ?? ev.table_id) && !document.querySelector('.modal-bg'))
    later(async () => { S.records = await api('GET', `/api/tables/${r.id}/records`); drawTable() }, 400)
}

// ---------- layout ----------
const parseHash = () => { const [, kind = 'c', id = ''] = location.hash.split('/'); return { kind, id: decodeURIComponent(id) } }
function shell(title, sub, actions, body) {
  const side = h('nav', { class: 'side', 'aria-label': 'Workspace' })
  $app.replaceChildren(h('div', { class: 'shell' }, side, h('main', { class: 'main' },
    h('div', { class: 'top' }, h('button', { class: 'btn sm menu-btn', 'aria-label': 'Menu', onclick: () => side.classList.toggle('open') }, '☰'),
      h('div', { style: 'min-width:0' }, h('h1', {}, title), sub && h('div', { class: 'sub' }, sub)), h('div', { class: 'grow' }), actions,
      h('input', { class: 'search', type: 'search', placeholder: 'Search…', 'aria-label': 'Search', onkeydown: e => { if (e.key === 'Enter' && e.target.value.trim()) location.hash = '#/search/' + encodeURIComponent(e.target.value.trim()) } })),
    h('div', { class: 'body', id: 'body' }, body))))
  renderSide()
  return document.getElementById('body')
}
function renderSide() {
  const side = document.querySelector('.side'); if (!side) return
  const link = (hash, ico, label, extra = {}) => h('a', { class: `nav ${location.hash === hash ? 'on' : ''} ${extra.unread ? 'unread' : ''}`, href: hash, onclick: () => side.classList.remove('open') },
    h('span', { class: 'ico' }, ico), h('span', {}, label), extra.unread ? h('span', { class: 'badge' }, extra.unread) : null)
  const unreadTotal = S.channels.reduce((n, c) => n + (c.member ? c.unread : 0), 0)
  document.title = (unreadTotal ? `(${unreadTotal}) ` : '') + 'SWK Hub'
  const groups = Object.keys(KIND).map(k => [k, S.tables.filter(t => t.kind === k)]).filter(([, ts]) => ts.length)
  side.replaceChildren(...kids(
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'S'), h('div', {}, h('b', {}, 'SWK Hub'), h('small', {}, 'SWK Properties'))),
    h('div', { class: 'sec' }, 'Channels', h('button', { title: 'New channel', 'aria-label': 'New channel', onclick: newChannel }, '+')),
    S.channels.filter(c => !c.is_dm && c.member).map(c => link(`#/c/${c.id}`, c.is_private ? '🔒' : '#', c.name, { unread: c.unread })),
    S.channels.some(c => !c.is_dm && !c.member) ? link('#/browse', '…', 'Browse channels') : null,
    h('div', { class: 'sec' }, 'Direct messages', h('button', { title: 'New message', 'aria-label': 'New direct message', onclick: newDm }, '+')),
    S.channels.filter(c => c.is_dm).map(c => link(`#/c/${c.id}`, '●', c.dm_with || S.me.name + ' (you)', { unread: c.unread })),
    groups.map(([k, ts]) => [h('div', { class: 'sec' }, KIND[k], h('button', { title: 'New table', 'aria-label': 'New ' + KIND[k], onclick: () => newTable(k) }, '+')),
      ts.map(t => link(`#/t/${t.id}`, t.icon || '▦', t.name))]),
    h('div', { class: 'sec' }, 'Workspace', groups.length < 4 ? h('button', { title: 'New base', 'aria-label': 'New base', onclick: () => newTable('base') }, '+') : null),
    link('#/automations', '⚡', 'Automations'),
    S.me.role === 'admin' ? [link('#/hooks', '🔗', 'Webhooks & feeds'), link('#/team', '👥', 'Team & audit')] : null,
    h('div', { class: 'me' }, h('span', {}, S.me.name), h('span', { class: 'row' },
      h('button', { onclick: changePassword }, 'Password'), h('button', { onclick: guard(async () => { await api('POST', '/api/logout', {}); S.me = null; ws?.close(); renderLogin() }) }, 'Sign out')))))
}

function route() {
  const r = parseHash()
  S.thread = null
  const go = guard(async () => {
    if (r.kind === 'c' && r.id) return openChannel(r.id)
    if (r.kind === 't') return openTable(r.id)
    if (r.kind === 'automations') return openAutomations()
    if (r.kind === 'hooks') return openHooks()
    if (r.kind === 'team') return openTeam()
    if (r.kind === 'browse') return openBrowse()
    if (r.kind === 'search') return openSearch(r.id)
    const first = S.channels.find(c => c.name === 'general') || S.channels[0]
    location.replace(first ? `#/c/${first.id}` : '#/automations')
  })
  go()
}

// ---------- chat ----------
let lastDay = ''
function messageEl(m, inThread) {
  const mine = m.user_id === S.me.id
  const react = e => guard(() => api('POST', `/api/messages/${m.id}/react`, { emoji: e }))()
  return h('div', { class: 'msg', id: `m${m.id}` },
    h('div', { class: 'avatar' + (m.bot_name ? ' bot' : '') }, m.bot_name ? '⚡' : initials(m.author)),
    h('div', {}, h('div', {}, h('span', { class: 'who' }, m.author), h('span', { class: 'when' }, fmtTime(m.created_at), m.edited_at ? ' (edited)' : '')),
      h('div', { class: 'text' }, formatText(m.body)),
      Object.keys(m.reactions).length ? h('div', { class: 'reacts' }, Object.entries(m.reactions).map(([e, who]) =>
        h('button', { class: who.includes(S.me.id) ? 'mine' : '', title: who.map(userName).join(', '), onclick: () => react(e) }, `${e} ${who.length}`))) : null,
      !inThread && m.reply_count ? h('button', { class: 'replies', onclick: () => openThread(m) }, `${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}`) : null),
    h('div', { class: 'tools' }, ['👍', '✅', '👀', '🎉'].map(e => h('button', { title: 'React ' + e, onclick: () => react(e) }, e)),
      !inThread ? h('button', { title: 'Reply in thread', onclick: () => openThread(m) }, '💬') : null,
      mine ? h('button', { title: 'Edit', onclick: () => editMessage(m) }, '✏️') : null,
      mine || S.me.role === 'admin' ? h('button', { title: 'Delete', onclick: guard(async () => { if (confirm('Delete this message?')) await api('DELETE', `/api/messages/${m.id}`) }) }, '🗑') : null))
}
function appendMessage(m, scroll) {
  const list = document.getElementById('list'); if (!list || document.getElementById(`m${m.id}`)) return
  const day = fmtDay(m.created_at)
  if (day !== lastDay) { list.append(h('div', { class: 'day' }, day)); lastDay = day }
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 200
  list.querySelector('.empty')?.remove()
  list.append(messageEl(m))
  if (scroll && (nearBottom || m.user_id === S.me.id)) list.scrollTop = list.scrollHeight
}
function composer(onSend, placeholder) {
  const ta = h('textarea', { rows: 1, placeholder, 'aria-label': placeholder })
  const send = guard(async () => { const v = ta.value.trim(); if (!v) return; ta.value = ''; await onSend(v) })
  ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } })
  return h('div', { class: 'composer' }, h('form', { onsubmit: e => { e.preventDefault(); send() } }, ta, h('button', { class: 'btn primary' }, 'Send')))
}
async function openChannel(id, keepThread) {
  const c = S.channels.find(x => x.id === Number(id))
  if (!c) { await refreshAll(); if (!S.channels.find(x => x.id === Number(id))) return location.replace('#/') }
  const ch = S.channels.find(x => x.id === Number(id))
  const msgs = await api('GET', `/api/channels/${id}/messages`)
  ch.unread = 0
  const thread = keepThread ? S.thread : null
  const actions = h('div', { class: 'row' },
    !ch.is_dm ? h('button', { class: 'btn sm', onclick: () => editTopic(ch) }, 'Topic') : null,
    ch.is_private && !ch.is_dm ? h('button', { class: 'btn sm', onclick: () => addMember(ch) }, 'Add people') : null,
    !ch.is_dm && ch.name !== 'general' ? h('button', { class: 'btn sm', onclick: guard(async () => { await api('POST', `/api/channels/${ch.id}/leave`, {}); await refreshAll(); location.hash = '#/' }) }, 'Leave') : null)
  const body = shell(chanLabel(ch), ch.topic, actions,
    h('div', { class: 'chat', id: 'chat' }, h('section', { class: 'msgs' }, h('div', { class: 'list', id: 'list', 'aria-live': 'polite' }),
      composer(v => api('POST', `/api/channels/${id}/messages`, { body: v }), `Message ${chanLabel(ch)}`))))
  body.style.padding = '0'
  lastDay = ''
  if (!msgs.length) document.getElementById('list').append(h('p', { class: 'muted empty' }, 'No messages yet. Say hello, or use *bold*, `code` and @name.'))
  for (const m of msgs) appendMessage(m)
  const list = document.getElementById('list'); list.scrollTop = list.scrollHeight
  if (thread) { const root = msgs.find(m => m.id === thread); if (root) openThread(root) }
  renderSide()
}
async function openThread(root) {
  S.thread = root.id
  const chat = document.getElementById('chat'); chat.classList.add('thread-open')
  chat.querySelector('.thread')?.remove()
  const items = await api('GET', `/api/channels/${root.channel_id}/messages?parent=${root.id}`)
  chat.append(h('aside', { class: 'thread', 'aria-label': 'Thread' },
    h('header', {}, h('h3', {}, 'Thread'), h('button', { class: 'btn sm', onclick: () => { S.thread = null; chat.classList.remove('thread-open'); chat.querySelector('.thread').remove() } }, 'Close')),
    h('div', { class: 'list', id: 'tlist' }, items.map(m => messageEl(m, true))),
    composer(v => api('POST', `/api/channels/${root.channel_id}/messages`, { body: v, parent_id: root.id }), 'Reply…')))
}
function appendThread(m) { const l = document.getElementById('tlist'); if (l && !l.querySelector(`#m${m.id}`)) { l.append(messageEl(m, true)); l.scrollTop = l.scrollHeight } }
function editMessage(m) {
  const ta = h('textarea', { rows: 4, value: m.body })
  modal('Edit message', ta, [{ label: 'Save', run: () => api('PATCH', `/api/messages/${m.id}`, { body: ta.value }) }])
}
function editTopic(ch) {
  const i = h('input', { value: ch.topic })
  modal('Channel topic', i, [{ label: 'Save', run: async () => { await api('PATCH', `/api/channels/${ch.id}`, { topic: i.value }); ch.topic = i.value; openChannel(ch.id) } }])
}
const userSelect = (value, exclude = []) => h('select', {}, h('option', { value: '' }, '—'), S.users.filter(u => u.active && !exclude.includes(u.id)).map(u => h('option', { value: u.id, selected: Number(value) === u.id }, u.name)))
function addMember(ch) {
  const s = userSelect('')
  modal('Add to ' + chanLabel(ch), s, [{ label: 'Add', run: () => api('POST', `/api/channels/${ch.id}/members`, { user_id: Number(s.value) }) }])
}
function newChannel() {
  const name = h('input', { placeholder: 'e.g. palm-jumeirah-launch' }), topic = h('input'), priv = h('input', { type: 'checkbox' })
  modal('New channel', h('div', { class: 'stack' }, h('label', {}, 'Name', name), h('label', {}, 'Topic', topic), h('label', { class: 'row' }, priv, 'Private (invite only)')),
    [{ label: 'Create', run: async () => { const c = await api('POST', '/api/channels', { name: name.value, topic: topic.value, is_private: priv.checked }); await refreshAll(); location.hash = `#/c/${c.id}` } }])
}
function newDm() {
  const s = userSelect('')
  modal('Direct message', h('label', {}, 'Person', s), [{ label: 'Open', run: async () => { const c = await api('POST', '/api/dm', { user_id: Number(s.value) }); await refreshAll(); location.hash = `#/c/${c.id}` } }])
}
function openBrowse() {
  shell('Browse channels', 'Public channels you have not joined', null, h('div', { class: 'stack' },
    S.channels.filter(c => !c.is_dm && !c.member).map(c => h('div', { class: 'card row' }, h('b', {}, '# ' + c.name), h('span', { class: 'muted' }, c.topic), h('div', { style: 'flex:1' }),
      h('button', { class: 'btn sm', onclick: guard(async () => { await api('POST', `/api/channels/${c.id}/join`, {}); await refreshAll(); location.hash = `#/c/${c.id}` }) }, 'Join')))))
}

// ---------- tables: grid + kanban ----------
let T = null
async function openTable(id) {
  T = S.tables.find(t => t.id === Number(id))
  if (!T) { S.tables = await api('GET', '/api/tables'); T = S.tables.find(t => t.id === Number(id)); if (!T) return location.replace('#/') }
  S.records = await api('GET', `/api/tables/${id}/records`)
  S.view = T.group_field ? (localStorage.getItem('view' + id) || (T.kind === 'base' ? 'grid' : 'board')) : 'grid'
  S.filter = ''
  const fileIn = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onchange: guard(async e => {
    const f = e.target.files[0]; if (!f) return
    const r = await api('POST', `/api/tables/${T.id}/import`, await f.text(), 'text/csv'); toast(`Imported ${r.imported} rows`); openTable(T.id)
  }) })
  const actions = h('div', { class: 'row' },
    h('button', { class: 'btn sm', onclick: editFields }, 'Fields'),
    h('a', { class: 'btn sm', href: `/api/tables/${T.id}/export.csv` }, 'Export CSV'),
    h('button', { class: 'btn sm', onclick: () => fileIn.click() }, 'Import CSV'), fileIn,
    S.me.role === 'admin' ? h('button', { class: 'btn sm danger', onclick: guard(async () => { if (confirm(`Delete table "${T.name}" and all its records?`)) { await api('DELETE', `/api/tables/${T.id}`); await refreshAll(); location.hash = '#/' } }) }, 'Delete') : null)
  shell(`${T.icon || ''} ${T.name}`, `${KIND[T.kind]} · ${S.records.length} records`, actions, h('div', { id: 'tbody' }))
  drawTable()
}
const titleKey = () => T.fields[0]?.key
function visibleRecords() {
  const q = S.filter.toLowerCase()
  if (!q) return S.records
  return S.records.filter(r => T.fields.some(f => String(f.type === 'user' ? userName(r.data[f.key]) : r.data[f.key] ?? '').toLowerCase().includes(q)))
}
function drawTable() {
  const box = document.getElementById('tbody'); if (!box || !T) return
  const search = h('input', { type: 'search', placeholder: 'Filter records…', value: S.filter, 'aria-label': 'Filter records', oninput: e => { S.filter = e.target.value; later(drawView, 150) } })
  const setView = v => { S.view = v; localStorage.setItem('view' + T.id, v); drawTable() }
  box.replaceChildren(h('div', { class: 'toolbar' },
    h('button', { class: 'btn primary', onclick: guard(async () => { const r = await api('POST', `/api/tables/${T.id}/records`, { data: {} }); S.records.unshift(r); openRecord(r) }) }, '+ New record'),
    search,
    T.group_field ? h('div', { class: 'views', role: 'group', 'aria-label': 'View' }, h('button', { class: S.view === 'grid' ? 'on' : '', onclick: () => setView('grid') }, 'Grid'), h('button', { class: S.view === 'board' ? 'on' : '', onclick: () => setView('board') }, 'Board')) : null),
  h('div', { id: 'view' }))
  drawView()
}
function drawView() {
  const v = document.getElementById('view'); if (!v) return
  v.replaceChildren(S.view === 'board' && T.group_field ? boardView() : gridView())
}
const saveField = (r, key) => guard(async val => { const out = await api('PATCH', `/api/records/${r.id}`, { data: { [key]: val } }); Object.assign(r, out) })
function input(f, value, onChange) {
  const ch = e => onChange(f.type === 'checkbox' ? e.target.checked : e.target.value)
  switch (f.type) {
    case 'select': return h('select', { onchange: ch, 'aria-label': f.name }, h('option', { value: '' }, '—'), (f.options || []).map(o => h('option', { selected: o === value }, o)), value && !(f.options || []).includes(value) ? h('option', { selected: true }, value) : null)
    case 'user': { const s = userSelect(value); s.setAttribute('aria-label', f.name); s.addEventListener('change', ch); return s }
    case 'checkbox': return h('input', { type: 'checkbox', checked: !!value, onchange: ch, 'aria-label': f.name, style: 'width:auto;margin:9px' })
    case 'longtext': return h('textarea', { value: value ?? '', onchange: ch, 'aria-label': f.name })
    case 'number': return h('input', { type: 'number', step: 'any', value: value ?? '', onchange: ch, 'aria-label': f.name })
    case 'date': return h('input', { type: 'date', value: value ?? '', onchange: ch, 'aria-label': f.name })
    default: return h('input', { type: { email: 'email', phone: 'tel', url: 'url' }[f.type] || 'text', value: value ?? '', onchange: ch, 'aria-label': f.name })
  }
}
function gridView() {
  const rows = visibleRecords()
  return h('div', { class: 'grid-wrap' }, h('table', { class: 'grid' },
    h('thead', {}, h('tr', {}, h('th', {}, ''), T.fields.map(f => h('th', {}, f.name)))),
    h('tbody', {}, rows.map(r => h('tr', {}, h('td', { class: 'num' }, h('button', { title: 'Open record', onclick: () => openRecord(r) }, '↗'), ' ', r.id),
      T.fields.map(f => h('td', {}, input(f, r.data[f.key], saveField(r, f.key))))))),
    !rows.length ? h('caption', { class: 'muted', style: 'caption-side:bottom;padding:16px' }, S.filter ? 'No records match.' : 'No records yet.') : null))
}
function boardView() {
  const gf = T.fields.find(f => f.key === T.group_field)
  const rows = visibleRecords()
  const cols = ['', ...(gf.options || [])]
  const fmt = (f, v) => f.type === 'user' ? userName(v) : f.type === 'number' && v != null ? Number(v).toLocaleString() : v
  return h('div', { class: 'board' }, cols.map(opt => {
    const items = rows.filter(r => (r.data[gf.key] || '') === opt || (opt === '' && r.data[gf.key] && !gf.options.includes(r.data[gf.key])))
    if (opt === '' && !items.length) return null
    const col = h('div', { class: 'col',
      ondragover: e => { e.preventDefault(); col.classList.add('drop') }, ondragleave: () => col.classList.remove('drop'),
      ondrop: guard(async e => { col.classList.remove('drop'); const r = S.records.find(x => x.id === Number(e.dataTransfer.getData('text'))); if (r && r.data[gf.key] !== opt) { r.data[gf.key] = opt; drawView(); await saveField(r, gf.key)(opt) } }) },
    h('header', {}, h('span', {}, opt || 'No ' + gf.name.toLowerCase()), h('span', { class: 'muted' }, items.length)),
    items.map(r => h('div', { class: 'kcard', draggable: 'true', tabindex: '0', ondragstart: e => e.dataTransfer.setData('text', r.id), onclick: () => openRecord(r), onkeydown: e => e.key === 'Enter' && openRecord(r) },
      h('b', {}, r.data[titleKey()] || 'Untitled'),
      T.fields.slice(1).filter(f => f.key !== gf.key && f.type !== 'longtext' && r.data[f.key] != null && r.data[f.key] !== '').slice(0, 3).map(f => h('small', {}, `${f.name}: ${fmt(f, r.data[f.key])}`)))))
    return col
  }))
}
function openRecord(r) {
  const draft = { ...r.data }
  const form = h('div', { class: 'two' }, T.fields.map(f => h('label', { style: f.type === 'longtext' ? 'grid-column:1/-1' : '' }, f.name, input(f, draft[f.key], v => { draft[f.key] = v }))))
  modal(`${T.name} #${r.id}`, h('div', { class: 'stack' }, form, h('div', { class: 'muted' }, `Created ${r.created_at} · updated ${r.updated_at}`)), [
    { label: 'Delete', class: 'danger', left: true, run: async () => { if (!confirm('Delete this record?')) return false; await api('DELETE', `/api/records/${r.id}`); S.records = S.records.filter(x => x.id !== r.id); drawView() } },
    { label: 'Save', run: async () => { Object.assign(r, await api('PATCH', `/api/records/${r.id}`, { data: draft })); drawView() } }])
}
const TYPES = ['text', 'longtext', 'number', 'select', 'date', 'user', 'email', 'phone', 'url', 'checkbox']
function fieldsEditor(fields) {
  const box = h('div', { class: 'fields-ed' })
  const draw = () => box.replaceChildren(...kids(
    fields.map((f, i) => h('div', { class: 'frow' },
      h('input', { value: f.name, 'aria-label': 'Field name', oninput: e => { f.name = e.target.value } }),
      h('select', { 'aria-label': 'Field type', onchange: e => { f.type = e.target.value; draw() } }, TYPES.map(t => h('option', { selected: t === f.type }, t))),
      f.type === 'select' ? h('input', { value: (f.options || []).join(', '), placeholder: 'Options, comma separated', 'aria-label': 'Options', oninput: e => { f.options = e.target.value.split(',').map(s => s.trim()).filter(Boolean) } }) : h('span'),
      h('button', { class: 'btn sm', title: 'Remove field', onclick: () => { fields.splice(i, 1); draw() } }, '✕'))),
    h('button', { class: 'btn sm', onclick: () => { fields.push({ name: '', type: 'text' }); draw() } }, '+ Add field')))
  draw()
  return box
}
function editFields() {
  const fields = structuredClone(T.fields)
  const group = h('select', {}, h('option', { value: '' }, 'No board view'), T.fields.filter(f => f.type === 'select').map(f => h('option', { value: f.key, selected: f.key === T.group_field }, f.name)))
  const name = h('input', { value: T.name }), icon = h('input', { value: T.icon, maxlength: 4, style: 'width:70px' })
  modal('Table settings', h('div', { class: 'stack' }, h('div', { class: 'row' }, h('label', { style: 'flex:1' }, 'Name', name), h('label', {}, 'Icon', icon)),
    h('div', {}, h('h3', {}, 'Fields'), h('p', { class: 'muted' }, 'Removing a field hides its data; re-adding the same name brings it back.'), fieldsEditor(fields)),
    h('label', {}, 'Board columns (group by)', group)),
  [{ label: 'Save', run: async () => {
    const t = await api('PATCH', `/api/tables/${T.id}`, { name: name.value, icon: icon.value, fields, group_field: fields.some(f => (f.key || '') === group.value) ? group.value || null : null })
    S.tables = S.tables.map(x => x.id === t.id ? t : x); openTable(t.id)
  } }])
}
function newTable(kind) {
  const name = h('input', { placeholder: 'e.g. Developers, Viewings, Payroll' }), icon = h('input', { maxlength: 4, style: 'width:70px', value: { crm: '👤', listings: '🏢', board: '📋', base: '▦' }[kind] })
  const k = h('select', {}, Object.entries(KIND).map(([v, l]) => h('option', { value: v, selected: v === kind }, l)))
  const fields = [{ name: 'Name', type: 'text' }, { name: 'Status', type: 'select', options: ['To do', 'Working on it', 'Done'] }, { name: 'Owner', type: 'user' }, { name: 'Due', type: 'date' }]
  modal('New table', h('div', { class: 'stack' }, h('div', { class: 'row' }, h('label', { style: 'flex:1' }, 'Name', name), h('label', {}, 'Icon', icon), h('label', {}, 'Section', k)), fieldsEditor(fields)),
    [{ label: 'Create', run: async () => { const t = await api('POST', '/api/tables', { name: name.value, icon: icon.value, kind: k.value, fields }); await refreshAll(); location.hash = `#/t/${t.id}` } }])
}

// ---------- automations ----------
async function openAutomations() {
  const autos = await api('GET', '/api/automations')
  const isAdmin = S.me.role === 'admin'
  const body = shell('Automations', 'When something happens, do something — leads, deals, listings, chat.', isAdmin ? h('button', { class: 'btn primary', onclick: () => editAutomation() }, '+ New automation') : null, h('div', { class: 'stack' }))
  if (!autos.length) body.firstChild.append(h('p', { class: 'muted' }, 'No automations yet.'))
  for (const a of autos) {
    const runs = h('div')
    body.firstChild.append(h('div', { class: 'card auto-card' },
      h('div', { class: 'row' }, h('h3', {}, '⚡ ' + a.name), h('span', { class: 'pill' }, a.enabled ? 'On' : 'Off'), h('div', { style: 'flex:1' }),
        h('button', { class: 'btn sm', onclick: guard(async () => { const r = await api('GET', `/api/automations/${a.id}/runs`); runs.replaceChildren(r.length ? h('pre', {}, r.map(x => `${x.created_at}  ${x.status.toUpperCase()}  ${x.detail}`).join('\n')) : h('p', { class: 'muted' }, 'No runs yet.')) }) }, 'Runs'),
        isAdmin ? [h('button', { class: 'btn sm', onclick: guard(async () => { await api('PATCH', `/api/automations/${a.id}`, { enabled: !a.enabled }); openAutomations() }) }, a.enabled ? 'Turn off' : 'Turn on'),
          h('button', { class: 'btn sm', onclick: () => editAutomation(a) }, 'Edit'),
          h('button', { class: 'btn sm danger', onclick: guard(async () => { if (confirm('Delete automation?')) { await api('DELETE', `/api/automations/${a.id}`); openAutomations() } }) }, 'Delete')] : null),
      h('div', { class: 'muted' }, 'When ', describeTrigger(a.trigger), ' → ', a.actions.map(describeAction).join(', then ')), runs))
  }
}
const tName = id => S.tables.find(t => t.id === Number(id))?.name || '?'
const cName = id => { const c = S.channels.find(x => x.id === Number(id)); return c ? chanLabel(c) : '?' }
function describeTrigger(t) {
  return { 'record.created': () => `a record is added to ${tName(t.table_id)}${t.field && t.equals ? ` with ${t.field} = ${t.equals}` : ''}`,
    'record.updated': () => `${tName(t.table_id)}${t.field ? '.' + t.field : ''} changes${t.equals ? ` to ${t.equals}` : ''}`,
    'message.posted': () => `a message${t.keyword ? ` containing “${t.keyword}”` : ''} is posted${t.channel_id ? ' in ' + cName(t.channel_id) : ''}`,
    webhook: () => `webhook #${t.hook_id} is called`, schedule: () => `every ${t.every_minutes || 60} minutes` }[t.type]?.() || t.type
}
function describeAction(a) {
  return { post_message: () => `post in ${cName(a.channel_id)}`, create_record: () => `create ${tName(a.table_id)} record`, update_record: () => `update the record`,
    assign_round_robin: () => `assign ${a.field} round-robin`, webhook: () => `send webhook` }[a.type]?.() || a.type
}
const opt = (list, value, label = x => x.name, val = x => x.id) => [h('option', { value: '' }, '—'), list.map(x => h('option', { value: val(x), selected: String(val(x)) === String(value ?? '') }, label(x)))]
function editAutomation(a = { name: '', enabled: true, trigger: { type: 'record.created' }, actions: [{ type: 'post_message' }] }) {
  const d = structuredClone(a)
  const name = h('input', { value: d.name, placeholder: 'e.g. Viewing reminder' })
  const trig = h('div', { class: 'stack' }), acts = h('div', { class: 'stack' })
  const tables = S.tables, chans = S.channels.filter(c => !c.is_dm)
  const fieldsOf = id => tables.find(t => t.id === Number(id))?.fields || []
  const drawTrig = () => {
    const t = d.trigger
    const ty = h('select', { onchange: e => { d.trigger = { type: e.target.value }; drawTrig() } }, ['record.created', 'record.updated', 'message.posted', 'webhook', 'schedule'].map(x => h('option', { selected: x === t.type }, x)))
    const parts = [h('label', {}, 'Trigger', ty)]
    if (t.type.startsWith('record.')) parts.push(h('div', { class: 'two' },
      h('label', {}, 'Table', h('select', { onchange: e => { t.table_id = Number(e.target.value); drawTrig(); drawActs() } }, opt(tables, t.table_id))),
      h('label', {}, 'Field (optional)', h('select', { onchange: e => { t.field = e.target.value } }, opt(fieldsOf(t.table_id), t.field, f => f.name, f => f.key))),
      h('label', {}, 'Equals (optional)', h('input', { value: t.equals ?? '', oninput: e => { t.equals = e.target.value } }))))
    if (t.type === 'message.posted') parts.push(h('div', { class: 'two' },
      h('label', {}, 'Channel (optional)', h('select', { onchange: e => { t.channel_id = Number(e.target.value) || null } }, opt(chans, t.channel_id, chanLabel))),
      h('label', {}, 'Contains keyword', h('input', { value: t.keyword ?? '', oninput: e => { t.keyword = e.target.value } }))))
    if (t.type === 'webhook') parts.push(h('label', {}, 'Webhook ID (see Webhooks & feeds)', h('input', { type: 'number', value: t.hook_id ?? '', oninput: e => { t.hook_id = Number(e.target.value) } })))
    if (t.type === 'schedule') parts.push(h('label', {}, 'Every (minutes)', h('input', { type: 'number', min: 1, value: t.every_minutes ?? 60, oninput: e => { t.every_minutes = Number(e.target.value) } })))
    const tf = fieldsOf(t.table_id)
    if (tf.length) parts.push(h('p', { class: 'muted' }, 'Placeholders: ', tf.map(f => `{{${f.key}}}`).join(' '), ' {{record.id}}'))
    if (t.type === 'message.posted') parts.push(h('p', { class: 'muted' }, 'Placeholders: {{text}} {{user}}'))
    trig.replaceChildren(...parts)
  }
  const json = (obj, set) => h('textarea', { rows: 3, value: JSON.stringify(obj || {}, null, 1), 'aria-label': 'Field values as JSON', onchange: e => { try { set(JSON.parse(e.target.value || '{}')); e.target.style.outline = '' } catch { e.target.style.outline = '2px solid var(--danger)' } } })
  const drawActs = () => acts.replaceChildren(...d.actions.map((x, i) => {
    const ty = h('select', { onchange: e => { d.actions[i] = { type: e.target.value }; drawActs() } }, ['post_message', 'create_record', 'update_record', 'assign_round_robin', 'webhook'].map(v => h('option', { selected: v === x.type }, v)))
    const parts = [h('div', { class: 'row' }, h('label', { style: 'flex:1' }, `Step ${i + 1}`, ty), h('button', { class: 'btn sm', onclick: () => { d.actions.splice(i, 1); drawActs() } }, 'Remove'))]
    if (x.type === 'post_message') parts.push(h('label', {}, 'Channel', h('select', { onchange: e => { x.channel_id = Number(e.target.value) } }, opt(chans, x.channel_id, chanLabel))),
      h('label', {}, 'Message', h('textarea', { rows: 2, value: x.text ?? '', oninput: e => { x.text = e.target.value } })))
    if (x.type === 'create_record') parts.push(h('label', {}, 'Table', h('select', { onchange: e => { x.table_id = Number(e.target.value); drawActs() } }, opt(tables, x.table_id))),
      h('label', {}, `Values JSON — keys: ${fieldsOf(x.table_id).map(f => f.key).join(', ')}`, json(x.data, v => { x.data = v })))
    if (x.type === 'update_record') parts.push(h('label', {}, 'Set JSON, e.g. {"stage":"Contacted"}', json(x.set, v => { x.set = v })))
    if (x.type === 'assign_round_robin') parts.push(h('label', {}, 'User field', h('select', { onchange: e => { x.field = e.target.value } }, opt(fieldsOf(d.trigger.table_id).filter(f => f.type === 'user'), x.field, f => f.name, f => f.key))))
    if (x.type === 'webhook') parts.push(h('label', {}, 'URL (receives JSON: record, data, message)', h('input', { type: 'url', value: x.url ?? '', placeholder: 'https://os.swk.properties/api/hooks/…', oninput: e => { x.url = e.target.value } })))
    return h('div', { class: 'act' }, parts)
  }), h('button', { class: 'btn sm', onclick: () => { d.actions.push({ type: 'post_message' }); drawActs() } }, '+ Add step'))
  drawTrig(); drawActs()
  modal(a.id ? 'Edit automation' : 'New automation', h('div', { class: 'stack' }, h('label', {}, 'Name', name), h('h3', {}, 'When'), trig, h('h3', {}, 'Do'), acts),
    [{ label: 'Save', run: async () => { d.name = name.value; await api(a.id ? 'PATCH' : 'POST', a.id ? `/api/automations/${a.id}` : '/api/automations', d); openAutomations() } }])
}

// ---------- webhooks & feeds ----------
async function openHooks() {
  const { hooks, feed_key } = await api('GET', '/api/hooks')
  const origin = location.origin
  const name = h('input', { placeholder: 'e.g. Bayut leads' })
  const tsel = h('select', { 'aria-label': 'Save into table' }, opt(S.tables, ''))
  const csel = h('select', { 'aria-label': 'Post into channel' }, opt(S.channels.filter(c => !c.is_dm), '', chanLabel))
  shell('Webhooks & feeds', 'Bring leads in from portals, website and SWK OS; push listings out to portals.', null, h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Inbound webhooks'),
      h('p', { class: 'muted' }, 'POST JSON to the URL. Keys matching field names or keys are stored; other keys are appended to the first long-text field. Automations with a webhook trigger run too.'),
      hooks.map(k => h('div', { class: 'stack', style: 'border-top:1px solid var(--line);padding-top:10px' },
        h('div', { class: 'row' }, h('b', {}, `#${k.id} ${k.name}`), k.table_id ? h('span', { class: 'pill' }, '→ ' + tName(k.table_id)) : null, k.channel_id ? h('span', { class: 'pill' }, '→ ' + cName(k.channel_id)) : null, h('div', { style: 'flex:1' }),
          h('button', { class: 'btn sm', onclick: () => navigator.clipboard.writeText(`${origin}/hooks/${k.token}`).then(() => toast('Copied')) }, 'Copy URL'),
          h('button', { class: 'btn sm danger', onclick: guard(async () => { if (confirm('Delete webhook? Senders using it will fail.')) { await api('DELETE', `/api/hooks/${k.id}`); openHooks() } }) }, 'Delete')),
        h('pre', {}, `curl -X POST ${origin}/hooks/${k.token} \\\n  -H 'content-type: application/json' \\\n  -d '{"name":"Ali","phone":"+9715…","source":"Bayut","budget":2500000}'`))),
      h('div', { class: 'row' }, name, tsel, csel, h('button', { class: 'btn primary', onclick: guard(async () => { await api('POST', '/api/hooks', { name: name.value, table_id: Number(tsel.value) || null, channel_id: Number(csel.value) || null }); openHooks() }) }, 'Create webhook'))),
    h('div', { class: 'card stack' }, h('h2', {}, 'Portal XML feeds'),
      h('p', { class: 'muted' }, 'Records with Status = Published are exported in a Property Finder-style XML list. Give the URL to the portal’s import team and confirm their exact field mapping.'),
      S.tables.filter(t => t.kind === 'listings').map(t => h('div', { class: 'row' }, h('b', {}, t.name), h('code', {}, `${origin}/feeds/${t.id}.xml?key=${feed_key}`))))))
}

// ---------- team & audit ----------
async function openTeam() {
  const [users, log] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/audit')])
  const email = h('input', { type: 'email', placeholder: 'name@swkpropertiesuae.com' }), name = h('input', { placeholder: 'Full name' })
  const pw = h('input', { type: 'text', placeholder: 'Temporary password (8+)' }), role = h('select', {}, h('option', { value: 'member' }, 'Member'), h('option', { value: 'admin' }, 'Admin'))
  const patch = (u, body) => guard(async () => { await api('PATCH', `/api/users/${u.id}`, body); S.users = await api('GET', '/api/users'); openTeam() })
  shell('Team & audit', `${users.filter(u => u.active).length} active people`, null, h('div', { class: 'stack' },
    h('div', { class: 'card stack' }, h('h2', {}, 'Add a person'), h('div', { class: 'row' }, name, email, pw, role,
      h('button', { class: 'btn primary', onclick: guard(async () => { await api('POST', '/api/users', { name: name.value, email: email.value, password: pw.value, role: role.value }); S.users = await api('GET', '/api/users'); toast('Added. Share the temporary password privately.'); openTeam() }) }, 'Add'))),
    h('div', { class: 'grid-wrap' }, h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Status', ''].map(x => h('th', {}, x)))),
      h('tbody', {}, users.map(u => h('tr', {}, h('td', { class: 'num' }, u.name), h('td', { class: 'num' }, u.email), h('td', { class: 'num' }, u.role), h('td', { class: 'num' }, u.active ? 'Active' : 'Deactivated'),
        h('td', { class: 'num' }, h('div', { class: 'row' },
          h('button', { class: 'btn sm', onclick: patch(u, { role: u.role === 'admin' ? 'member' : 'admin' }) }, u.role === 'admin' ? 'Make member' : 'Make admin'),
          h('button', { class: 'btn sm', onclick: patch(u, { active: !u.active }) }, u.active ? 'Deactivate' : 'Reactivate'),
          h('button', { class: 'btn sm', onclick: () => { const p = prompt(`New password for ${u.name} (8+ characters)`); if (p) patch(u, { password: p })() } }, 'Reset password')))))))),
    h('div', { class: 'card' }, h('h2', {}, 'Audit log (latest 200)'),
      h('pre', {}, log.map(l => `${l.created_at}  ${l.user_name || 'automation'}  ${l.action} ${l.entity} #${l.entity_id ?? ''}  ${l.detail || ''}`).join('\n') || 'Nothing yet.'))))
}
function changePassword() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), pw = h('input', { type: 'password', autocomplete: 'new-password' })
  modal('Change password', h('div', { class: 'stack' }, h('label', {}, 'Current password', cur), h('label', {}, 'New password (8+)', pw)),
    [{ label: 'Change', run: async () => { await api('POST', '/api/me/password', { current: cur.value, password: pw.value }); toast('Password changed') } }])
}

// ---------- search ----------
async function openSearch(q) {
  const { messages, records } = await api('GET', '/api/search?q=' + encodeURIComponent(q))
  shell(`Search: ${q}`, `${messages.length} messages · ${records.length} records`, null, h('div', { class: 'stack' },
    h('h2', {}, 'Messages'), messages.length ? messages.map(m => h('a', { class: 'card', href: `#/c/${m.channel_id}`, style: 'text-decoration:none' },
      h('div', { class: 'muted' }, `${cName(m.channel_id)} · ${m.author} · ${m.created_at}`), h('div', {}, m.body))) : h('p', { class: 'muted' }, 'None.'),
    h('h2', {}, 'Records'), records.length ? records.map(r => h('a', { class: 'card', href: `#/t/${r.table_id}`, style: 'text-decoration:none' },
      h('div', { class: 'muted' }, `${r.table_name} #${r.id}`), h('div', {}, Object.values(r.data).filter(v => v != null && v !== '').slice(0, 5).join(' · ')))) : h('p', { class: 'muted' }, 'None.')))
}

boot()
