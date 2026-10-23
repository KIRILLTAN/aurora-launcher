import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import type { Account, Instance, LoaderType } from '@shared/types'
import { api } from '../api'

export const LOADERS: { id: LoaderType; label: string; color: string }[] = [
  { id: 'vanilla', label: 'Vanilla', color: '#7bd88f' },
  { id: 'fabric', label: 'Fabric', color: '#dbb98a' },
  { id: 'quilt', label: 'Quilt', color: '#c79bff' },
  { id: 'forge', label: 'Forge', color: '#8ea6ff' },
  { id: 'neoforge', label: 'NeoForge', color: '#ff9a62' }
]
export const loaderLabel = (l: LoaderType): string => LOADERS.find((x) => x.id === l)?.label || l

export const ACCOUNT_LABEL: Record<Account['type'], string> = {
  microsoft: 'Microsoft',
  offline: 'Оффлайн',
  elyby: 'Ely.by',
  yggdrasil: 'Authlib'
}

export function fmtNum(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace('.0', '') + ' млн'
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace('.0', '') + ' тыс'
  return String(n)
}

export function fmtPlaytime(sec = 0): string {
  if (sec < 60) return 'не играли'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h ? `${h} ч ${m} мин` : `${m} мин`
}

export function timeAgo(ts?: number): string {
  if (!ts) return 'ещё не запускали'
  const d = (Date.now() - ts) / 1000
  if (d < 60) return 'только что'
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} дн назад`
  return new Date(ts).toLocaleDateString('ru-RU')
}

export function Modal(props: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'wide' | 'narrow'; icon?: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') props.onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [props.onClose])
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.size || ''}`}>
        <div className="modal-head">
          {props.icon}
          <h2>{props.title}</h2>
          <button className="btn ghost icon close" onClick={props.onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  )
}

export function Switch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />
}

/** Голова игрока, нарисованная из текстуры скина (лицо + слой шапки). */
export function SkinHead({ src, size = 40, className = '' }: { src?: string; size?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, 8, 8)
    if (!src) {
      drawDefaultHead(ctx)
      return
    }
    const img = new Image()
    img.onload = () => {
      ctx.clearRect(0, 0, 8, 8)
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, 8, 8)
      ctx.drawImage(img, 40, 8, 8, 8, 0, 0, 8, 8)
    }
    img.onerror = () => drawDefaultHead(ctx)
    img.src = src
  }, [src])
  return <canvas ref={ref} width={8} height={8} className={`avatar ${className}`} style={{ width: size, height: size }} />
}

function drawDefaultHead(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#6b4a2f'
  ctx.fillRect(0, 0, 8, 8)
  ctx.fillStyle = '#c99a72'
  ctx.fillRect(0, 2, 8, 6)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(1, 4, 2, 1)
  ctx.fillRect(5, 4, 2, 1)
  ctx.fillStyle = '#3b6cd8'
  ctx.fillRect(2, 4, 1, 1)
  ctx.fillRect(5, 4, 1, 1)
  ctx.fillStyle = '#8a5a3c'
  ctx.fillRect(3, 6, 2, 1)
}

const skinCache = new Map<string, Promise<string>>()
/** Загружает скин аккаунта через main-процесс (обход CORS). */
export function useSkin(account?: Account): string | undefined {
  const [data, setData] = useState<string>()
  useEffect(() => {
    setData(undefined)
    if (!account?.skinUrl) return
    let p = skinCache.get(account.skinUrl)
    if (!p) {
      p = api.fetchImage(account.skinUrl)
      skinCache.set(account.skinUrl, p)
      p.catch(() => skinCache.delete(account.skinUrl!))
    }
    p.then(setData).catch(() => undefined)
  }, [account?.skinUrl])
  return data
}

export function AccountAvatar({ account, size = 40 }: { account?: Account; size?: number }) {
  const skin = useSkin(account)
  return <SkinHead src={skin} size={size} />
}

export function InstanceIcon({ inst, size }: { inst: Pick<Instance, 'name' | 'icon'>; size?: 'lg' }) {
  const [broken, setBroken] = useState(false)
  return (
    <div className={`inst-icon ${size || ''}`}>
      {inst.icon && !broken ? <img src={inst.icon} onError={() => setBroken(true)} /> : inst.name.slice(0, 1).toUpperCase()}
    </div>
  )
}

/** Мини-рендер Markdown без innerHTML: заголовки, списки, жирный, код. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  const lines = text.split(/\r?\n/)
  let list: { ordered: boolean; items: string[] } | null = null
  let code: string[] | null = null
  const flush = (): void => {
    if (list) {
      const items = list.items.map((t, i) => <li key={i}>{inline(t)}</li>)
      blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>)
      list = null
    }
  }
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (code) {
        blocks.push(<pre key={blocks.length}><code>{code.join('\n')}</code></pre>)
        code = null
      } else {
        flush()
        code = []
      }
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    const h = /^(#{1,4})\s+(.*)/.exec(line)
    const ul = /^\s*[-*•]\s+(.*)/.exec(line)
    const ol = /^\s*\d+[.)]\s+(.*)/.exec(line)
    if (h) {
      flush()
      blocks.push(<h3 key={blocks.length}>{inline(h[2])}</h3>)
    } else if (ul || ol) {
      const ordered = !!ol
      if (!list || list.ordered !== ordered) {
        flush()
        list = { ordered, items: [] }
      }
      list.items.push((ul || ol)![1])
    } else if (line.trim()) {
      flush()
      blocks.push(<p key={blocks.length}>{inline(line)}</p>)
    } else flush()
  }
  flush()
  return <div className="md selectable">{blocks}</div>
}

function inline(t: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) {
    if (m.index > last) out.push(t.slice(last, m.index))
    const s = m[0]
    if (s.startsWith('**')) out.push(<b key={m.index}>{s.slice(2, -2)}</b>)
    else if (s.startsWith('`')) out.push(<code key={m.index}>{s.slice(1, -1)}</code>)
    else {
      const lm = /\[([^\]]+)\]\(([^)]+)\)/.exec(s)!
      out.push(
        <a key={m.index} href="#" onClick={(e) => (e.preventDefault(), api.openUrl(lm[2]))}>
          {lm[1]}
        </a>
      )
    }
    last = m.index + s.length
  }
  if (last < t.length) out.push(t.slice(last))
  return out
}

export function Spinner({ lg }: { lg?: boolean }) {
  return <div className={`spinner ${lg ? 'lg' : ''}`} />
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true })
  const [n, setN] = useState(0)
  useEffect(() => {
    let alive = true
    setState((s) => ({ ...s, loading: true, error: undefined }))
    fn()
      .then((data) => alive && setState({ data, loading: false }))
      .catch((e) => alive && setState({ error: (e as Error).message, loading: false }))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n])
  return { ...state, reload: () => setN((x) => x + 1) }
}
