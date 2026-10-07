import { useEffect, useMemo, useState } from 'react'
import { api, fillTemplate, templateVars, type Contact, type Template, type TemplateSend, displayName } from './api'

interface Props {
  /** Single recipient; omit for a broadcast where contacts are picked in the dialog */
  contact?: Contact
  contacts?: Contact[]
  onClose: () => void
  onDone: (summary: string) => void
}

export default function TemplateDialog({ contact, contacts = [], onClose, onDone }: Props) {
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Template | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [recipients, setRecipients] = useState<Set<string>>(new Set())
  const [tagFilter, setTagFilter] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    api<Template[]>('/templates')
      .then((t) => {
        setTemplates(t)
        if (t.length) setSelected(t[0])
      })
      .catch((e) => setError(e.message))
  }, [])

  const header = selected?.components.find((c) => c.type === 'HEADER' && c.format === 'TEXT')
  const body = selected?.components.find((c) => c.type === 'BODY')
  const footer = selected?.components.find((c) => c.type === 'FOOTER')
  const headerVars = templateVars(header?.text)
  const bodyVars = templateVars(body?.text)

  const allTags = useMemo(() => [...new Set(contacts.flatMap((c) => c.tags))].sort(), [contacts])
  const visibleContacts = tagFilter ? contacts.filter((c) => c.tags.includes(tagFilter)) : contacts

  const key = (part: string, v: string) => `${part}:${v}`
  const filled = (part: string, text?: string) =>
    fillTemplate(text, Object.fromEntries(templateVars(text).map((v) => [v, values[key(part, v)] ?? ''])))
  const missing = [...headerVars.map((v) => key('header', v)), ...bodyVars.map((v) => key('body', v))].some((k) => !values[k]?.trim())

  async function send() {
    if (!selected) return
    const components: TemplateSend['components'] = []
    if (headerVars.length) components.push({ type: 'header', parameters: headerVars.map((v) => ({ type: 'text', text: values[key('header', v)] })) })
    if (bodyVars.length) components.push({ type: 'body', parameters: bodyVars.map((v) => ({ type: 'text', text: values[key('body', v)] })) })
    const payload: TemplateSend = {
      name: selected.name,
      language: selected.language,
      components,
      preview: [header && `*${filled('header', header.text)}*`, filled('body', body?.text), footer?.text].filter(Boolean).join('\n'),
    }
    setSending(true)
    setError('')
    try {
      if (contact) {
        const m = await api<{ status: string; error: string | null }>(`/contacts/${contact.wa_id}/template`, { method: 'POST', json: payload })
        if (m.status === 'failed') throw new Error(m.error ?? 'Send failed')
        onDone(`Template sent to ${displayName(contact)}`)
      } else {
        const r = await api<{ sent: number; failed: number }>('/broadcast', { method: 'POST', json: { ...payload, wa_ids: [...recipients] } })
        onDone(`Broadcast sent to ${r.sent} contact${r.sent === 1 ? '' : 's'}${r.failed ? `, ${r.failed} failed` : ''}`)
      }
    } catch (e) {
      setError((e as Error).message)
      setSending(false)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog wide" role="dialog" aria-label="Send template">
        <header className="dialog-head">
          <h2>{contact ? `Send template to ${displayName(contact)}` : 'New broadcast'}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        {templates === null && !error && <p className="muted">Loading approved templates…</p>}
        {templates?.length === 0 && (
          <p className="muted">No approved templates found. Create one in WhatsApp Manager, or check WHATSAPP_BUSINESS_ACCOUNT_ID.</p>
        )}

        {selected && (
          <div className="template-grid">
            <div className="stack">
              <label>
                Template
                <select
                  value={selected.id}
                  onChange={(e) => {
                    setSelected(templates!.find((t) => t.id === e.target.value) ?? null)
                    setValues({})
                  }}
                >
                  {templates!.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.language} · {t.category.toLowerCase()}
                    </option>
                  ))}
                </select>
              </label>
              {headerVars.map((v) => (
                <label key={`h${v}`}>
                  Header {`{{${v}}}`}
                  <input value={values[key('header', v)] ?? ''} onChange={(e) => setValues({ ...values, [key('header', v)]: e.target.value })} />
                </label>
              ))}
              {bodyVars.map((v) => (
                <label key={`b${v}`}>
                  Body {`{{${v}}}`}
                  <input value={values[key('body', v)] ?? ''} onChange={(e) => setValues({ ...values, [key('body', v)]: e.target.value })} />
                </label>
              ))}

              {!contact && (
                <div className="recipients">
                  <div className="row between">
                    <strong>Recipients ({recipients.size})</strong>
                    <span className="row gap">
                      {allTags.length > 0 && (
                        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Filter by tag">
                          <option value="">All tags</option>
                          {allTags.map((t) => (
                            <option key={t}>{t}</option>
                          ))}
                        </select>
                      )}
                      <button className="link" onClick={() => setRecipients(new Set(visibleContacts.map((c) => c.wa_id)))}>Select all</button>
                      <button className="link" onClick={() => setRecipients(new Set())}>Clear</button>
                    </span>
                  </div>
                  <ul className="pick-list">
                    {visibleContacts.map((c) => (
                      <li key={c.wa_id}>
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={recipients.has(c.wa_id)}
                            onChange={(e) => {
                              const next = new Set(recipients)
                              if (e.target.checked) next.add(c.wa_id)
                              else next.delete(c.wa_id)
                              setRecipients(next)
                            }}
                          />
                          {displayName(c)} <span className="muted">+{c.wa_id}</span>
                        </label>
                      </li>
                    ))}
                    {visibleContacts.length === 0 && <li className="muted">No contacts yet.</li>}
                  </ul>
                </div>
              )}
            </div>

            <div className="preview">
              <div className="bubble out">
                {header && <strong className="block">{filled('header', header.text)}</strong>}
                <span className="pre">{filled('body', body?.text)}</span>
                {footer && <small className="block muted">{footer.text}</small>}
              </div>
            </div>
          </div>
        )}

        {error && <p className="error">{error}</p>}
        <footer className="dialog-foot">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!selected || missing || sending || (!contact && recipients.size === 0)} onClick={send}>
            {sending ? 'Sending…' : contact ? 'Send' : `Send to ${recipients.size}`}
          </button>
        </footer>
      </div>
    </div>
  )
}
