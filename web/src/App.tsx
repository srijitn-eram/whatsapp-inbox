import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, displayName, getSession, mediaUrl, setSession, SESSION_WINDOW_MS, type Contact, type Message } from './api'
import TemplateDialog from './TemplateDialog'
import Setup from './Setup'

export default function App() {
  const [session, setS] = useState(getSession())
  const [connected, setConnected] = useState<boolean | null>(null)
  const [showSetup, setShowSetup] = useState(false)

  useEffect(() => {
    if (session) api<{ connected: boolean }>('/health').then((h) => setConnected(h.connected))
  }, [session, showSetup])

  if (!session) return <Login onLogin={(s) => (setSession(s), setS(s))} />
  if (connected === null) return null
  if (!connected || showSetup) return <Setup canClose={connected} onDone={() => (setShowSetup(false), setConnected(true))} />
  return <Inbox me={session.name} onLogout={() => (setSession(null), setS(null))} onSettings={() => setShowSetup(true)} />
}

function Login({ onLogin }: { onLogin: (s: { token: string; name: string }) => void }) {
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [missing, setMissing] = useState<string[]>([])

  useEffect(() => {
    api<{ missingConfig: string[] }>('/health').then((h) => setMissing(h.missingConfig)).catch(() => {})
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    try {
      onLogin(await api<{ token: string; name: string }>('/login', { method: 'POST', json: { name, password } }))
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <main className="login">
      <form className="card" onSubmit={submit}>
        <div className="brand">
          <span className="logo" aria-hidden>✆</span>
          <h1>Team Inbox</h1>
        </div>
        <p className="muted">Sign in to reply to customers on WhatsApp.</p>
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Shown on messages you send" />
        </label>
        <label>
          Team password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary" type="submit">Sign in</button>
        {missing.length > 0 && (
          <p className="warn">Server is missing settings: {missing.join(', ')}. See the README.</p>
        )}
      </form>
    </main>
  )
}

type Filter = 'all' | 'unread' | 'mine'

function Inbox({ me, onLogout, onSettings }: { me: string; onLogout: () => void; onSettings: () => void }) {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [dialog, setDialog] = useState<null | 'new-contact' | 'template' | 'broadcast'>(null)
  const [toast, setToast] = useState('')
  const [showDetails, setShowDetails] = useState(false)
  const activeRef = useRef(activeId)
  activeRef.current = activeId

  const loadContacts = useCallback(() => api<Contact[]>('/contacts').then(setContacts), [])

  useEffect(() => {
    loadContacts()
  }, [loadContacts])

  // Live updates from the server
  useEffect(() => {
    const es = new EventSource(`/api/events?token=${encodeURIComponent(getSession()?.token ?? '')}`)
    const upsert = (c: Contact) =>
      setContacts((list) => {
        const rest = list.filter((x) => x.wa_id !== c.wa_id)
        const prev = list.find((x) => x.wa_id === c.wa_id)
        return [{ ...prev, ...c }, ...rest].sort((a, b) => (b.last_message_at ?? b.created_at) - (a.last_message_at ?? a.created_at))
      })
    es.addEventListener('message', (e) => {
      const { message, contact } = JSON.parse(e.data) as { message: Message; contact: Contact }
      upsert({ ...contact, last_message: message.body || `[${message.type}]` })
      if (message.wa_id === activeRef.current) {
        setMessages((m) => (m.some((x) => x.id === message.id) ? m : [...m, message]))
        if (message.direction === 'in' && document.visibilityState === 'visible') api(`/contacts/${message.wa_id}/read`, { method: 'POST' })
      } else if (message.direction === 'in' && document.visibilityState !== 'visible' && 'Notification' in window && Notification.permission === 'granted') {
        new Notification(displayName(contact), { body: message.body })
      }
    })
    es.addEventListener('status', (e) => {
      const m = JSON.parse(e.data) as Message
      setMessages((list) => list.map((x) => (x.id === m.id ? m : x)))
    })
    es.addEventListener('contact', (e) => upsert(JSON.parse(e.data)))
    es.addEventListener('contact-deleted', (e) => {
      const { wa_id } = JSON.parse(e.data)
      setContacts((list) => list.filter((c) => c.wa_id !== wa_id))
      if (activeRef.current === wa_id) setActiveId(null)
    })
    es.onerror = () => {
      // EventSource reconnects on its own; refresh the list once it's back
      es.onopen = () => loadContacts()
    }
    return () => es.close()
  }, [loadContacts])

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission()
  }, [])

  useEffect(() => {
    if (!activeId) return
    setMessages([])
    api<Message[]>(`/contacts/${activeId}/messages`).then(setMessages)
    api(`/contacts/${activeId}/read`, { method: 'POST' })
  }, [activeId])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(''), 4000)
    return () => clearTimeout(t)
  }, [toast])

  const visible = useMemo(() => {
    const q = search.toLowerCase().replace(/^\+/, '')
    return contacts.filter((c) => {
      if (filter === 'unread' && c.unread_count === 0) return false
      if (filter === 'mine' && c.assigned_to !== me) return false
      if (!q) return true
      return [c.wa_id, c.name, c.profile_name, ...c.tags].some((v) => v?.toLowerCase().includes(q))
    })
  }, [contacts, search, filter, me])

  const active = contacts.find((c) => c.wa_id === activeId) ?? null
  const unreadTotal = contacts.reduce((n, c) => n + c.unread_count, 0)

  useEffect(() => {
    document.title = unreadTotal ? `(${unreadTotal}) WhatsApp Team Inbox` : 'WhatsApp Team Inbox'
  }, [unreadTotal])

  return (
    <div className={`app ${activeId ? 'has-active' : ''}`}>
      <aside className="sidebar">
        <header className="side-head">
          <div className="brand small">
            <span className="logo" aria-hidden>✆</span>
            <strong>Team Inbox</strong>
          </div>
          <div className="row gap">
            <button className="icon-btn" title="New broadcast" aria-label="New broadcast" onClick={() => setDialog('broadcast')}>📣</button>
            <button className="icon-btn" title="New contact" aria-label="New contact" onClick={() => setDialog('new-contact')}>＋</button>
            <button className="icon-btn" title="WhatsApp connection" aria-label="WhatsApp connection" onClick={onSettings}>⚙</button>
          </div>
        </header>
        <div className="side-tools">
          <input className="search" placeholder="Search name, number or tag" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="chips" role="tablist">
            {(['all', 'unread', 'mine'] as Filter[]).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'unread' ? `Unread${unreadTotal ? ` (${unreadTotal})` : ''}` : 'Assigned to me'}
              </button>
            ))}
          </div>
        </div>
        <ul className="conv-list">
          {visible.map((c) => (
            <li key={c.wa_id}>
              <button className={`conv ${c.wa_id === activeId ? 'active' : ''}`} onClick={() => setActiveId(c.wa_id)}>
                <Avatar name={displayName(c)} />
                <span className="conv-main">
                  <span className="row between">
                    <span className="conv-name">{displayName(c)}</span>
                    <time className="muted small">{c.last_message_at ? shortTime(c.last_message_at) : ''}</time>
                  </span>
                  <span className="row between">
                    <span className="conv-last muted">{c.last_message?.replace(/[*_~]/g, '') ?? (c.tags.length ? c.tags.join(', ') : 'No messages yet')}</span>
                    {c.unread_count > 0 && <span className="badge">{c.unread_count}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
          {visible.length === 0 && (
            <li className="empty muted">
              {contacts.length === 0 ? 'No conversations yet. Messages customers send to your WhatsApp number show up here.' : 'Nothing matches.'}
            </li>
          )}
        </ul>
        <footer className="side-foot">
          <span className="muted small">Signed in as {me}</span>
          <button className="link" onClick={onLogout}>Sign out</button>
        </footer>
      </aside>

      {active ? (
        <Chat
          key={active.wa_id}
          contact={active}
          messages={messages}
          onBack={() => setActiveId(null)}
          onTemplate={() => setDialog('template')}
          onToggleDetails={() => setShowDetails((s) => !s)}
        />
      ) : (
        <section className="chat empty-state">
          <div>
            <span className="logo big" aria-hidden>✆</span>
            <h2>WhatsApp Team Inbox</h2>
            <p className="muted">Pick a conversation, add a contact, or send a broadcast.</p>
          </div>
        </section>
      )}

      {active && showDetails && <ContactPanel contact={active} me={me} onClose={() => setShowDetails(false)} onToast={setToast} />}

      {dialog === 'new-contact' && (
        <NewContactDialog
          onClose={() => setDialog(null)}
          onCreated={(c) => {
            setDialog(null)
            loadContacts()
            setActiveId(c.wa_id)
          }}
        />
      )}
      {dialog === 'template' && active && (
        <TemplateDialog contact={active} onClose={() => setDialog(null)} onDone={(s) => (setDialog(null), setToast(s))} />
      )}
      {dialog === 'broadcast' && (
        <TemplateDialog contacts={contacts} onClose={() => setDialog(null)} onDone={(s) => (setDialog(null), setToast(s))} />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}

function Chat({
  contact,
  messages,
  onBack,
  onTemplate,
  onToggleDetails,
}: {
  contact: Contact
  messages: Message[]
  onBack: () => void
  onTemplate: () => void
  onToggleDetails: () => void
}) {
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [, setTick] = useState(0)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])

  const now = Date.now()
  const windowOpen = contact.last_inbound_at != null && now - contact.last_inbound_at < SESSION_WINDOW_MS
  const hoursLeft = contact.last_inbound_at ? Math.min(24, Math.max(1, Math.ceil((contact.last_inbound_at + SESSION_WINDOW_MS - now) / 3_600_000))) : 0

  async function send(e?: React.FormEvent) {
    e?.preventDefault()
    const body = text.trim()
    if (!body) return
    setText('')
    setError('')
    try {
      const m = await api<Message>(`/contacts/${contact.wa_id}/messages`, { method: 'POST', json: { text: body } })
      if (m.status === 'failed') setError(m.error ?? 'Message failed')
    } catch (err) {
      setError((err as Error).message)
      setText(body)
    }
  }

  let lastDay = ''
  return (
    <section className="chat">
      <header className="chat-head">
        <button className="icon-btn back" onClick={onBack} aria-label="Back to conversations">←</button>
        <button className="chat-title" onClick={onToggleDetails} title="Contact details">
          <Avatar name={displayName(contact)} />
          <span>
            <strong>{displayName(contact)}</strong>
            <span className="muted small block">
              +{contact.wa_id}
              {contact.assigned_to ? ` · assigned to ${contact.assigned_to}` : ''}
            </span>
          </span>
        </button>
        <button onClick={onTemplate}>Send template</button>
      </header>

      <div className="messages">
        {messages.map((m) => {
          const day = new Date(m.timestamp).toDateString()
          const showDay = day !== lastDay
          lastDay = day
          return (
            <div key={m.id}>
              {showDay && <div className="day">{dayLabel(m.timestamp)}</div>}
              <div className={`bubble ${m.direction}`}>
                {m.media_id && (m.type === 'image' || m.type === 'sticker') && (
                  <a href={mediaUrl(m.media_id)} target="_blank" rel="noreferrer">
                    <img src={mediaUrl(m.media_id)} alt={m.body || 'Image'} />
                  </a>
                )}
                {m.media_id && m.type === 'audio' && <audio controls src={mediaUrl(m.media_id)} />}
                {m.media_id && m.type === 'video' && <video controls src={mediaUrl(m.media_id)} />}
                {m.media_id && m.type === 'document' && (
                  <a className="block" href={mediaUrl(m.media_id)} target="_blank" rel="noreferrer">📄 {m.body || 'Document'}</a>
                )}
                {m.type !== 'document' && m.body && <span className="pre">{renderFormatting(m.body)}</span>}
                {!m.body && !m.media_id && <span className="muted">[{m.type}]</span>}
                <span className="meta">
                  {m.type === 'template' && <span title="Template message">▤ </span>}
                  {m.direction === 'out' && m.sent_by && <span>{m.sent_by} · </span>}
                  {clock(m.timestamp)}
                  {m.direction === 'out' && <Ticks status={m.status} />}
                </span>
                {m.error && <span className="msg-error">{m.error}</span>}
              </div>
            </div>
          )
        })}
        <div ref={endRef} />
      </div>

      {error && <p className="error pad">{error}</p>}
      {windowOpen ? (
        <form className="composer" onSubmit={send}>
          <textarea
            rows={1}
            placeholder={`Message (${hoursLeft}h left to reply)`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) send(e)
            }}
          />
          <button className="primary" type="submit" disabled={!text.trim()}>Send</button>
        </form>
      ) : (
        <div className="composer closed">
          <span className="muted">
            {contact.last_inbound_at
              ? 'The 24-hour reply window has closed. WhatsApp only allows approved templates until the customer writes again.'
              : 'This customer hasn’t messaged you yet. Start the conversation with an approved template.'}
          </span>
          <button className="primary" onClick={onTemplate}>Send template</button>
        </div>
      )}
    </section>
  )
}

function ContactPanel({ contact, me, onClose, onToast }: { contact: Contact; me: string; onClose: () => void; onToast: (s: string) => void }) {
  const [name, setName] = useState(contact.name ?? '')
  const [notes, setNotes] = useState(contact.notes)
  const [tags, setTags] = useState(contact.tags.join(', '))

  useEffect(() => {
    setName(contact.name ?? '')
    setNotes(contact.notes)
    setTags(contact.tags.join(', '))
  }, [contact.wa_id]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = (patch: Partial<Contact>) => api(`/contacts/${contact.wa_id}`, { method: 'PATCH', json: patch })

  return (
    <aside className="details">
      <header className="dialog-head">
        <h2>Contact</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close details">✕</button>
      </header>
      <div className="stack">
        <div className="center">
          <Avatar name={displayName(contact)} big />
          <p>
            <strong>{displayName(contact)}</strong>
            <br />
            <span className="muted">+{contact.wa_id}</span>
            {contact.profile_name && contact.name && <span className="muted block small">WhatsApp name: {contact.profile_name}</span>}
          </p>
        </div>
        <label>
          Name
          <input value={name} placeholder={contact.profile_name ?? ''} onChange={(e) => setName(e.target.value)} onBlur={() => name !== (contact.name ?? '') && save({ name })} />
        </label>
        <label>
          Tags <span className="muted small">(comma separated)</span>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            onBlur={() => save({ tags: tags.split(',').map((t) => t.trim()).filter(Boolean) })}
          />
        </label>
        <label>
          Notes
          <textarea rows={5} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== contact.notes && save({ notes })} />
        </label>
        <div className="row between">
          <span>
            Assigned to <strong>{contact.assigned_to ?? 'nobody'}</strong>
          </span>
          {contact.assigned_to === me ? (
            <button className="link" onClick={() => save({ assigned_to: null })}>Unassign</button>
          ) : (
            <button className="link" onClick={() => save({ assigned_to: me })}>Assign to me</button>
          )}
        </div>
        <button
          className="danger"
          onClick={async () => {
            if (!confirm(`Delete ${displayName(contact)} and their whole conversation history? This can't be undone.`)) return
            await api(`/contacts/${contact.wa_id}`, { method: 'DELETE' })
            onToast('Contact deleted')
          }}
        >
          Delete contact
        </button>
      </div>
    </aside>
  )
}

function NewContactDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (c: Contact) => void }) {
  const [waId, setWaId] = useState('')
  const [name, setName] = useState('')
  const [tags, setTags] = useState('')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    try {
      onCreated(
        await api<Contact>('/contacts', {
          method: 'POST',
          json: { wa_id: waId, name, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) },
        }),
      )
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="dialog" onSubmit={submit} role="dialog" aria-label="New contact">
        <header className="dialog-head">
          <h2>New contact</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="stack">
          <label>
            WhatsApp number
            <input value={waId} onChange={(e) => setWaId(e.target.value)} placeholder="+91 98765 43210" autoFocus />
          </label>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Tags <span className="muted small">(comma separated)</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vip, newsletter" />
          </label>
        </div>
        {error && <p className="error">{error}</p>}
        <footer className="dialog-foot">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" type="submit">Add contact</button>
        </footer>
      </form>
    </div>
  )
}

function Avatar({ name, big }: { name: string; big?: boolean }) {
  const initials = name.replace(/^\+/, '').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase()
  let hue = 0
  for (const ch of name) hue = (hue * 31 + ch.charCodeAt(0)) % 360
  return (
    <span className={`avatar ${big ? 'big' : ''}`} style={{ background: `hsl(${hue} 45% 45%)` }} aria-hidden>
      {initials}
    </span>
  )
}

function Ticks({ status }: { status: string }) {
  const label: Record<string, string> = { pending: '🕓', sent: '✓', delivered: '✓✓', read: '✓✓', failed: '⚠' }
  return (
    <span className={`ticks ${status}`} title={status}>
      {' '}
      {label[status] ?? ''}
    </span>
  )
}

/** WhatsApp-style *bold*, _italic_, ~strike~ */
function renderFormatting(text: string) {
  const parts = text.split(/(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g)
  return parts.map((p, i) => {
    if (/^\*.+\*$/.test(p)) return <strong key={i}>{p.slice(1, -1)}</strong>
    if (/^_.+_$/.test(p)) return <em key={i}>{p.slice(1, -1)}</em>
    if (/^~.+~$/.test(p)) return <s key={i}>{p.slice(1, -1)}</s>
    return p
  })
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function shortTime(ts: number) {
  const d = new Date(ts)
  return d.toDateString() === new Date().toDateString() ? clock(ts) : d.toLocaleDateString([], { day: 'numeric', month: 'short' })
}

function dayLabel(ts: number) {
  const d = new Date(ts).toDateString()
  if (d === new Date().toDateString()) return 'Today'
  if (d === new Date(Date.now() - 86_400_000).toDateString()) return 'Yesterday'
  return new Date(ts).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
}
