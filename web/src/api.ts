export interface Contact {
  wa_id: string
  name: string | null
  profile_name: string | null
  notes: string
  tags: string[]
  assigned_to: string | null
  unread_count: number
  last_message_at: number | null
  last_inbound_at: number | null
  created_at: number
  last_message?: string | null
}

export interface Message {
  id: number
  wa_message_id: string | null
  wa_id: string
  direction: 'in' | 'out'
  type: string
  body: string
  media_id: string | null
  status: string
  error: string | null
  sent_by: string | null
  timestamp: number
}

export interface Template {
  id: string
  name: string
  language: string
  status: string
  category: string
  components: { type: string; format?: string; text?: string }[]
}

export interface TemplateSend {
  name: string
  language: string
  components: { type: 'header' | 'body'; parameters: { type: 'text'; text: string }[] }[]
  preview: string
}

const TOKEN_KEY = 'wa-inbox-session'

export function getSession(): { token: string; name: string } | null {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) ?? 'null')
  } catch {
    return null
  }
}

export function setSession(s: { token: string; name: string } | null) {
  try {
    if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s))
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable */
  }
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const res = await fetch(`/api${path}`, {
    ...rest,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getSession()?.token ?? ''}`,
      ...rest.headers,
    },
    body: json === undefined ? rest.body : JSON.stringify(json),
  })
  if (res.status === 401 && path !== '/login') {
    setSession(null)
    location.reload()
  }
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined)
  if (!res.ok && !(data && typeof data === 'object' && 'status' in data)) {
    throw new ApiError((data as { error?: string })?.error ?? res.statusText, res.status)
  }
  return data as T
}

export function mediaUrl(mediaId: string) {
  return `/api/media/${encodeURIComponent(mediaId)}?token=${encodeURIComponent(getSession()?.token ?? '')}`
}

export function displayName(c: Contact) {
  return c.name || c.profile_name || `+${c.wa_id}`
}

/** Variables like {{1}} in a template component */
export function templateVars(text = ''): string[] {
  return [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))]
}

export function fillTemplate(text = '', values: Record<string, string>) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] || `{{${k}}}`)
}

export const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000
