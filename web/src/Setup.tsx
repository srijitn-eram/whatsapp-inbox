import { useEffect, useState } from 'react'
import { api } from './api'

interface SetupState {
  connected: boolean
  phone: { display_phone_number: string; verified_name: string; quality_rating?: string } | null
  phoneError: string | null
  webhookUrl: string
  verifyToken: string
  appId: string
}

interface PhoneOption {
  id: string
  display_phone_number: string
  verified_name: string
  waba_id: string
}

const META_APPS = 'https://developers.facebook.com/apps/creation/'
const SYSTEM_USERS = 'https://business.facebook.com/settings/system-users'

export default function Setup({ onDone, canClose }: { onDone: () => void; canClose: boolean }) {
  const [state, setState] = useState<SetupState | null>(null)
  const [token, setToken] = useState('')
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [numbers, setNumbers] = useState<PhoneOption[] | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [chosen, setChosen] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ webhook: boolean; webhookError?: string } | null>(null)
  const [editing, setEditing] = useState(false)

  const load = () =>
    api<SetupState>('/setup').then((s) => {
      setState(s)
      if (s.appId) setAppId((a) => a || s.appId)
    })

  useEffect(() => {
    load()
  }, [])

  async function check() {
    setBusy(true)
    setError('')
    setNumbers(null)
    try {
      const r = await api<{ numbers: PhoneOption[]; expiresAt: number | null }>('/setup/discover', {
        method: 'POST',
        json: { token, appId, appSecret },
      })
      if (!r.numbers.length) throw new Error('That token works, but no WhatsApp phone numbers were found on its account. Add a number under WhatsApp > API Setup first.')
      setNumbers(r.numbers)
      setExpiresAt(r.expiresAt)
      setChosen(r.numbers[0].id)
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  async function connect() {
    const n = numbers?.find((x) => x.id === chosen)
    if (!n) return
    setBusy(true)
    setError('')
    try {
      const r = await api<{ webhook: boolean; webhookError?: string }>('/setup/connect', {
        method: 'POST',
        json: { token, appId, appSecret, phoneNumberId: n.id, wabaId: n.waba_id },
      })
      setResult(r)
      setEditing(false)
      setNumbers(null)
      setToken('')
      setAppSecret('')
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
    setBusy(false)
  }

  if (!state) return <main className="setup"><p className="muted">Loading…</p></main>

  const showForm = !state.connected || editing

  return (
    <main className="setup">
      <div className="card setup-card">
        <header className="row between">
          <div className="brand">
            <span className="logo" aria-hidden>✆</span>
            <h1>Connect WhatsApp</h1>
          </div>
          {canClose && <button className="icon-btn" onClick={onDone} aria-label="Close">✕</button>}
        </header>

        {state.connected && !editing && (
          <section className="stack">
            <div className="connected">
              <span className="dot ok" aria-hidden />
              <div>
                <strong>{state.phone ? `${state.phone.verified_name} · ${state.phone.display_phone_number}` : 'Connected'}</strong>
                {state.phoneError && <p className="error">Meta says: {state.phoneError}</p>}
              </div>
            </div>
            {result && !result.webhook && <WebhookManual state={state} reason={result.webhookError} />}
            {result?.webhook && <p className="ok-text">Webhook connected. Messages sent to your number will now appear in the inbox.</p>}
            <div className="row gap">
              <button className="primary" onClick={onDone}>Open inbox</button>
              <button onClick={() => (setEditing(true), setResult(null))}>Change connection</button>
            </div>
            <details>
              <summary className="muted small">Webhook details</summary>
              <WebhookManual state={state} />
            </details>
          </section>
        )}

        {showForm && (
          <section className="stack">
            <ol className="steps">
              <li>
                <a href={META_APPS} target="_blank" rel="noreferrer">Create a Meta app</a> (type <b>Business</b>), then add the <b>WhatsApp</b> product. Meta gives you a free test number right away.
              </li>
              <li>
                In the app, open <b>App settings › Basic</b> and copy the <b>App ID</b> and <b>App secret</b>.
              </li>
              <li>
                Get an access token. Quickest: <b>WhatsApp › API Setup › Generate access token</b> (lasts 24 hours, fine for trying it). For everyday use, make a permanent one in{' '}
                <a href={SYSTEM_USERS} target="_blank" rel="noreferrer">Business settings › System users</a>: add a user, assign your app, generate a token with <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>.
              </li>
            </ol>
            <label>
              App ID
              <input value={appId} onChange={(e) => setAppId(e.target.value)} inputMode="numeric" />
            </label>
            <label>
              App secret
              <input type="password" value={appSecret} onChange={(e) => setAppSecret(e.target.value)} autoComplete="off" />
            </label>
            <label>
              Access token
              <input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" />
            </label>

            {!numbers && (
              <button className="primary" disabled={busy || !token || !appId || !appSecret} onClick={check}>
                {busy ? 'Checking with Meta…' : 'Check'}
              </button>
            )}

            {numbers && (
              <div className="stack">
                {expiresAt && (
                  <p className="warn">
                    This token expires {new Date(expiresAt).toLocaleString()}. Swap in a permanent System User token before then.
                  </p>
                )}
                <fieldset className="numbers">
                  <legend>Which number should the inbox use?</legend>
                  {numbers.map((n) => (
                    <label key={n.id} className="check">
                      <input type="radio" name="num" checked={chosen === n.id} onChange={() => setChosen(n.id)} />
                      <span>
                        <strong>{n.verified_name}</strong> <span className="muted">{n.display_phone_number}</span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <button className="primary" disabled={busy} onClick={connect}>
                  {busy ? 'Connecting…' : 'Connect this number'}
                </button>
              </div>
            )}
            {error && <p className="error">{error}</p>}
            {editing && <button className="link" onClick={() => setEditing(false)}>Cancel</button>}
          </section>
        )}
      </div>
    </main>
  )
}

function WebhookManual({ state, reason }: { state: SetupState; reason?: string }) {
  return (
    <div className="stack manual">
      {reason && (
        <p className="warn">
          Your details are saved, but the webhook couldn't be set automatically: {reason}
        </p>
      )}
      <p className="small muted">
        {reason ? 'You can set it by hand' : 'If you ever need to set it by hand'}: in your Meta app open <b>WhatsApp › Configuration</b>, paste these, press <b>Verify and save</b>, and subscribe to <b>messages</b>.
      </p>
      <CopyField label="Callback URL" value={state.webhookUrl} />
      <CopyField label="Verify token" value={state.verifyToken} />
    </div>
  )
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <label>
      {label}
      <span className="row gap">
        <input readOnly value={value} onFocus={(e) => e.target.select()} />
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(value)
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </label>
  )
}
