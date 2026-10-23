import { useState } from 'react'
import { Globe, ShieldCheck, Activity, CheckCircle2, XCircle } from 'lucide-react'
import type { ProxyConfig, Settings } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { Spinner, Switch } from './ui'

const EMPTY: ProxyConfig = { enabled: false, type: 'socks5', host: '127.0.0.1', port: 10808, game: false }

/** Сеть: зеркала для России и свой VPN/прокси. */
export function NetworkCard() {
  const { settings, setSettings, toast } = useStore()
  const [px, setPx] = useState<ProxyConfig>({ ...EMPTY, ...(settings?.proxy || {}) })
  const [results, setResults] = useState<{ name: string; ok: boolean; ms: number; error?: string }[] | null>(null)
  const [testing, setTesting] = useState(false)
  if (!settings) return null

  const patch = async (p: Partial<Settings>): Promise<void> => setSettings(await api.updateSettings(p))
  const saveProxy = async (next: ProxyConfig): Promise<void> => {
    setPx(next)
    await patch({ proxy: next })
  }
  const test = async (): Promise<void> => {
    setTesting(true)
    try {
      setResults(await api.netTest())
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="card pad">
      <h3 className="row"><Globe size={17} /> Сеть: зеркала и VPN</h3>
      <div className="setting-row">
        <div className="text">
          <b>Зеркала Modrinth, CurseForge и Mojang</b>
          <span>Если сайты плохо открываются (например, в России) — лаунчер скачает через зеркала MCIM и BMCLAPI. CurseForge через зеркало работает даже без ключа.</span>
        </div>
        <select className="select" style={{ width: 190 }} value={settings.mirrors} onChange={(e) => patch({ mirrors: e.target.value as Settings['mirrors'] })}>
          <option value="auto">Авто (при ошибке)</option>
          <option value="always">Всегда через зеркала</option>
          <option value="never">Только напрямую</option>
        </select>
      </div>

      <div className="setting-row">
        <div className="text">
          <b className="row" style={{ gap: 6 }}><ShieldCheck size={15} /> Свой VPN / прокси</b>
          <span>Укажите адрес из вашего VPN-клиента (v2rayN, Hiddify, Clash, Outline и т.п. дают локальный SOCKS5/HTTP-порт). Без этого используется системный прокси.</span>
        </div>
        <Switch on={px.enabled} onChange={(v) => saveProxy({ ...px, enabled: v })} />
      </div>
      <div className="row wrap" style={{ opacity: px.enabled ? 1 : 0.5, gap: 8 }}>
        <select className="select" style={{ width: 110 }} value={px.type} onChange={(e) => saveProxy({ ...px, type: e.target.value as ProxyConfig['type'] })}>
          <option value="socks5">SOCKS5</option>
          <option value="http">HTTP</option>
        </select>
        <input className="input mono" style={{ width: 170 }} placeholder="127.0.0.1" value={px.host} onChange={(e) => setPx({ ...px, host: e.target.value.trim() })} onBlur={() => saveProxy(px)} />
        <input className="input mono" style={{ width: 100 }} type="number" placeholder="порт" value={px.port || ''} onChange={(e) => setPx({ ...px, port: parseInt(e.target.value) || 0 })} onBlur={() => saveProxy(px)} />
        <input className="input" style={{ width: 130 }} placeholder="логин (если есть)" value={px.user || ''} onChange={(e) => setPx({ ...px, user: e.target.value })} onBlur={() => saveProxy(px)} />
        <input className="input" style={{ width: 130 }} type="password" placeholder="пароль" value={px.pass || ''} onChange={(e) => setPx({ ...px, pass: e.target.value })} onBlur={() => saveProxy(px)} />
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <Switch on={px.game} onChange={(v) => saveProxy({ ...px, game: v })} />
        <span className="small">Передавать прокси игре (вход, скины, Realms; только SOCKS5)</span>
      </div>
      <div className="divider" />
      <div className="row">
        <button className="btn" disabled={testing} onClick={test}>
          {testing ? <Spinner /> : <Activity size={15} />} Проверить соединение
        </button>
        <span className="small muted">Проверит Modrinth, Mojang, GitHub и зеркала с текущими настройками</span>
      </div>
      {results && (
        <div className="list" style={{ marginTop: 10 }}>
          {results.map((r) => (
            <div key={r.name} className="list-row" style={{ padding: '6px 8px' }}>
              {r.ok ? <CheckCircle2 size={16} color="var(--ok)" /> : <XCircle size={16} color="var(--danger)" />}
              <span className="grow">{r.name}</span>
              <span className={`small ${r.ok ? 'muted' : ''}`} style={r.ok ? undefined : { color: 'var(--danger)' }}>{r.ok ? `${r.ms} мс` : r.error || 'нет ответа'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
