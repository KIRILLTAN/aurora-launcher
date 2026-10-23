import { useEffect, useState } from 'react'
import { Server, Plus, Trash2, Play, RefreshCw, Wifi, WifiOff, Copy } from 'lucide-react'
import type { ServerStatus } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { Modal, Spinner } from './ui'

/** Список серверов с пингом и быстрым входом. */
export function ServersCard({ instanceId }: { instanceId?: string }) {
  const { settings, setSettings, play, toast } = useStore()
  const servers = settings?.servers || []
  const [status, setStatus] = useState<Record<string, ServerStatus | 'loading'>>({})
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')

  const ping = (addr: string): void => {
    setStatus((s) => ({ ...s, [addr]: 'loading' }))
    api.pingServer(addr).then((r) => setStatus((s) => ({ ...s, [addr]: r }))).catch((e) => setStatus((s) => ({ ...s, [addr]: { online: false, error: e.message } })))
  }
  useEffect(() => {
    servers.forEach((s) => ping(s.address))
  }, [servers.length])

  const save = async (): Promise<void> => {
    if (!address.trim()) return
    const list = [...servers, { name: name.trim() || address.trim(), address: address.trim() }]
    setSettings(await api.updateSettings({ servers: list }))
    setAdding(false)
    setName('')
    setAddress('')
  }
  const remove = async (addr: string): Promise<void> => setSettings(await api.updateSettings({ servers: servers.filter((s) => s.address !== addr) }))

  return (
    <div className="card pad" style={{ marginTop: 18 }}>
      <h3 className="row">
        <Server size={17} /> Мои серверы
        <span className="grow" />
        {servers.length > 0 && <button className="btn ghost sm icon" title="Обновить" onClick={() => servers.forEach((s) => ping(s.address))}><RefreshCw size={14} /></button>}
        <button className="btn sm" onClick={() => setAdding(true)}><Plus size={14} /> Добавить</button>
      </h3>
      {servers.length === 0 && <div className="muted">Добавьте любимые серверы — лаунчер покажет онлайн и пинг, а кнопка «Играть» сразу зайдёт на сервер.</div>}
      <div className="list">
        {servers.map((s) => {
          const st = status[s.address]
          return (
            <div key={s.address} className="list-row">
              {st && st !== 'loading' && st.favicon ? <img src={st.favicon} style={{ width: 44, height: 44, borderRadius: 10, imageRendering: 'pixelated' }} /> : <div className="inst-icon"><Server size={20} /></div>}
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row">
                  <b className="ellipsis">{s.name}</b>
                  <span className="small muted mono">{s.address}</span>
                </div>
                <div className="small muted ellipsis">
                  {st === 'loading' || !st ? 'Проверка…' : st.online ? st.motd || st.version : st.error}
                </div>
              </div>
              {st === 'loading' || !st ? (
                <Spinner />
              ) : st.online ? (
                <div className="col" style={{ alignItems: 'flex-end', gap: 2 }}>
                  <span className="chip ok"><Wifi size={11} /> {st.latency} мс</span>
                  <span className="small muted">{st.players}/{st.maxPlayers} игроков</span>
                </div>
              ) : (
                <span className="chip danger"><WifiOff size={11} /> офлайн</span>
              )}
              <button className="btn sm icon ghost" title="Копировать адрес" onClick={() => navigator.clipboard.writeText(s.address).then(() => toast('Адрес скопирован'))}><Copy size={14} /></button>
              <button className="btn sm icon ghost" title="Удалить" onClick={() => remove(s.address)}><Trash2 size={14} /></button>
              <button className="btn sm primary" disabled={!instanceId} title={instanceId ? 'Запустить выбранную сборку и зайти на сервер' : 'Сначала создайте сборку'} onClick={() => instanceId && play(instanceId, s.address)}>
                <Play size={13} fill="currentColor" /> Играть
              </button>
            </div>
          )
        })}
      </div>
      {adding && (
        <Modal
          title="Новый сервер"
          size="narrow"
          onClose={() => setAdding(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setAdding(false)}>Отмена</button>
              <button className="btn primary" disabled={!address.trim()} onClick={save}>Добавить</button>
            </>
          }
        >
          <div className="col" style={{ gap: 12 }}>
            <div className="field">
              <label>Название</label>
              <input className="input" value={name} placeholder="Мой сервер" onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label>Адрес</label>
              <input className="input mono" autoFocus value={address} placeholder="play.example.com:25565" onChange={(e) => setAddress(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
