import { useQuery } from '@tanstack/react-query'
import { get } from '../lib/api'
import { Badge,ErrorBox,Loading } from '../ui/kit'

const when = (v?: string | null) => (v ? new Date(v).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—')
const H = ({ children }: { children: string }) => <h3 className="font-display font-extrabold text-[12.5px] uppercase tracking-wider text-fold border-b border-line pb-1 mb-2.5 mt-5">{children}</h3>

/** Owner / Admin only: the role, module rights and recent use of the staff member's sign-in. */
export function EmployeeAccess({ employeeId }: { employeeId: number }) {
  const q = useQuery({ queryKey: ['employee-access', employeeId], queryFn: () => get<any>(`/api/admin/employees/${employeeId}/access`) })
  if (q.isLoading) return <Loading />
  if (q.error) return <ErrorBox error={q.error} />
  const d = q.data
  if (!d.user) return <p className="text-sm text-muted m-0">No sign-in account is linked to this employee.</p>
  const u = d.user
  const perms: [string, string[]][] = u.permissions === '*' ? [] : Object.entries(u.permissions ?? {})
  return (
    <div>
      <dl className="grid gap-x-6 gap-y-2.5 m-0 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
        {[
          ['Sign-in e-mail', u.email],
          ['Role', <Badge key="r" value={u.role || 'No role'} tone="blue" />],
          ['Account', <Badge key="a" value={u.lockedUntil && u.lockedUntil > new Date().toISOString() ? 'Locked' : u.active ? 'Active' : 'Disabled'} />],
          ['Last sign-in', when(u.lastLogin)],
          ['Open sessions', String(d.sessions)],
          ['2-step verification', u.totp ? 'On' : 'Off'],
        ].map(([k, v]) => <div key={String(k)}><dt className="text-[11.5px] font-semibold text-muted">{k}</dt><dd className="m-0 text-[14px] text-ink font-medium break-words">{v}</dd></div>)}
      </dl>

      <H>Role access</H>
      {u.permissions === '*'
        ? <p className="text-sm m-0">Full access to every module.</p>
        : perms.length
          ? <table className="w-full text-sm"><tbody>{perms.map(([m, a]) => <tr key={m} className="border-b border-line"><td className="py-1.5 font-semibold capitalize w-40">{m}</td><td className="py-1.5">{a.join(', ')}</td></tr>)}</tbody></table>
          : <p className="text-sm text-muted m-0">No module rights.</p>}

      <H>Usage – last 30 days</H>
      {d.usage.length
        ? <table className="w-full text-sm"><thead><tr className="text-left text-muted"><th className="py-1">Area</th><th>Action</th><th className="text-right">Times</th></tr></thead><tbody>{d.usage.map((r: any, i: number) => <tr key={i} className="border-b border-line"><td className="py-1.5">{r.entity}</td><td>{r.action}</td><td className="text-right">{r.n}</td></tr>)}</tbody></table>
        : <p className="text-sm text-muted m-0">No recorded activity in the last 30 days.</p>}

      <H>Recent actions</H>
      {d.recent.length
        ? <ul className="m-0 pl-0 list-none text-sm">{d.recent.map((r: any, i: number) => <li key={i} className="py-1 border-b border-line"><span className="text-muted">{when(r.at)}</span> · {r.action} · {r.entity}{r.record_label ? ` – ${r.record_label}` : ''}</li>)}</ul>
        : <p className="text-sm text-muted m-0">None yet.</p>}

      <H>Sign-in history</H>
      {d.logins.length
        ? <ul className="m-0 pl-0 list-none text-sm">{d.logins.map((r: any, i: number) => <li key={i} className="py-1 border-b border-line"><Badge value={r.success ? 'Success' : 'Failed'} tone={r.success ? 'green' : 'red'} /> <span className="text-muted">{when(r.at)}</span>{r.reason && r.reason !== 'ok' ? ` · ${r.reason}` : ''}{r.ip ? ` · ${r.ip}` : ''}</li>)}</ul>
        : <p className="text-sm text-muted m-0">No sign-ins yet.</p>}
    </div>
  )
}
