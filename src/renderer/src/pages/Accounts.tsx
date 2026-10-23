import { useState } from 'react'
import { Plus, Trash2, Check, ShieldCheck, WifiOff, Globe, Server, ExternalLink } from 'lucide-react'
import type { AccountType } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { AccountAvatar, ACCOUNT_LABEL, Modal, Spinner } from '../components/ui'

const KINDS: { id: AccountType; title: string; desc: string; icon: typeof Globe; color: string }[] = [
  { id: 'microsoft', title: 'Microsoft', desc: 'Лицензия Minecraft: Java Edition. Онлайн-серверы, скины, Realms.', icon: ShieldCheck, color: '#3cc8ff' },
  { id: 'elyby', title: 'Ely.by', desc: 'Бесплатный аккаунт со скинами, работает на серверах с Ely.by.', icon: Globe, color: '#3dffb0' },
  { id: 'yggdrasil', title: 'Аккаунт лаунчера', desc: 'Любой сервер авторизации authlib-injector: LittleSkin или свой.', icon: Server, color: '#a477ff' },
  { id: 'offline', title: 'Оффлайн', desc: 'Просто ник. Одиночная игра и серверы без лицензии.', icon: WifiOff, color: '#ffc857' }
]

const PRESETS = [
  { name: 'LittleSkin', url: 'https://littleskin.cn/api/yggdrasil' },
  { name: 'Свой сервер', url: '' }
]

export default function AccountsPage() {
  const { accounts, settings, refreshAccounts, toast } = useStore()
  const [adding, setAdding] = useState<AccountType | 'pick' | null>(null)
  const selected = settings?.selectedAccount || accounts[0]?.id

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Аккаунты</h1>
          <p>Microsoft, Ely.by, аккаунты лаунчера (authlib-injector) и оффлайн</p>
        </div>
        <div className="actions">
          <button className="btn primary" onClick={() => setAdding('pick')}><Plus size={16} /> Добавить аккаунт</button>
        </div>
      </div>

      {accounts.length === 0 ? (
        <div className="grid two">
          {KINDS.map((k) => (
            <div key={k.id} className="card pad row" style={{ cursor: 'pointer', gap: 16 }} onClick={() => setAdding(k.id)}>
              <div className="inst-icon" style={{ background: k.color }}><k.icon size={22} /></div>
              <div className="grow">
                <b>{k.title}</b>
                <div className="small muted">{k.desc}</div>
              </div>
              <Plus size={18} />
            </div>
          ))}
        </div>
      ) : (
        <div className="card pad">
          <div className="list">
            {accounts.map((a) => (
              <div key={a.id} className="list-row" style={{ padding: 14 }}>
                <AccountAvatar account={a} size={48} />
                <div className="grow">
                  <div className="row">
                    <b style={{ fontSize: 15 }}>{a.name}</b>
                    <span className="chip">{a.type === 'yggdrasil' ? a.serverName || 'Authlib' : ACCOUNT_LABEL[a.type]}</span>
                    {a.id === selected && <span className="chip ok"><Check size={11} /> Активный</span>}
                  </div>
                  <div className="small muted mono selectable">{a.uuid}</div>
                </div>
                {a.id !== selected && (
                  <button className="btn sm" onClick={async () => { await api.selectAccount(a.id); refreshAccounts() }}>Сделать активным</button>
                )}
                <button className="btn sm icon danger" title="Удалить" onClick={async () => { await api.removeAccount(a.id); refreshAccounts(); toast('Аккаунт удалён') }}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {adding === 'pick' && (
        <Modal title="Тип аккаунта" onClose={() => setAdding(null)}>
          <div className="col">
            {KINDS.map((k) => (
              <div key={k.id} className="card pad row" style={{ cursor: 'pointer', gap: 16 }} onClick={() => setAdding(k.id)}>
                <div className="inst-icon" style={{ background: k.color }}><k.icon size={22} /></div>
                <div className="grow">
                  <b>{k.title}</b>
                  <div className="small muted">{k.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </Modal>
      )}
      {adding && adding !== 'pick' && <AddAccount kind={adding} onClose={() => setAdding(null)} />}
    </div>
  )
}

function AddAccount({ kind, onClose }: { kind: AccountType; onClose: () => void }) {
  const { refreshAccounts, toast } = useStore()
  const [name, setName] = useState('')
  const [login, setLogin] = useState('')
  const [pass, setPass] = useState('')
  const [server, setServer] = useState(PRESETS[0].url)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string>()

  const submit = async (): Promise<void> => {
    setBusy(true)
    setErr(undefined)
    try {
      let acc
      if (kind === 'offline') acc = await api.addOffline(name.trim())
      else if (kind === 'microsoft') acc = await api.loginMicrosoft()
      else if (kind === 'elyby') acc = await api.loginYggdrasil('ely.by', login.trim(), pass)
      else acc = await api.loginYggdrasil(server.trim(), login.trim(), pass, PRESETS.find((p) => p.url === server)?.name)
      await refreshAccounts()
      toast(`Добро пожаловать, ${acc.name}!`, 'success')
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const title = { microsoft: 'Вход через Microsoft', offline: 'Оффлайн-аккаунт', elyby: 'Вход в Ely.by', yggdrasil: 'Аккаунт лаунчера' }[kind]

  return (
    <Modal
      title={title}
      size="narrow"
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>Отмена</button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            {busy && <Spinner />} {kind === 'microsoft' ? 'Открыть окно входа' : kind === 'offline' ? 'Добавить' : 'Войти'}
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        {kind === 'microsoft' && (
          <div className="muted">
            Откроется официальное окно входа Microsoft. Лаунчер получает только токен для игры — пароль остаётся у Microsoft. Нужен купленный Minecraft: Java Edition.
          </div>
        )}
        {kind === 'offline' && (
          <div className="field">
            <label>Ник</label>
            <input className="input" autoFocus value={name} maxLength={16} placeholder="Steve" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
            <span className="hint">3–16 символов: латиница, цифры и «_».</span>
          </div>
        )}
        {kind === 'yggdrasil' && (
          <>
            <div className="field">
              <label>Сервер авторизации</label>
              <select className="select" value={PRESETS.some((p) => p.url === server && p.url) ? server : ''} onChange={(e) => setServer(e.target.value)}>
                {PRESETS.map((p) => <option key={p.name} value={p.url}>{p.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Адрес API (authlib-injector)</label>
              <input className="input" value={server} placeholder="https://example.com/api/yggdrasil" onChange={(e) => setServer(e.target.value)} />
            </div>
          </>
        )}
        {(kind === 'elyby' || kind === 'yggdrasil') && (
          <>
            <div className="field">
              <label>Логин или e-mail</label>
              <input className="input" autoFocus value={login} onChange={(e) => setLogin(e.target.value)} />
            </div>
            <div className="field">
              <label>Пароль</label>
              <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
              {kind === 'elyby' && <span className="hint">С 2FA введите «пароль:код». Пароль не сохраняется — только токен.</span>}
            </div>
            {kind === 'elyby' && (
              <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => api.openUrl('https://account.ely.by/register')}>
                <ExternalLink size={13} /> Регистрация на Ely.by
              </button>
            )}
          </>
        )}
        {err && <div style={{ color: 'var(--danger)' }} className="selectable">{err}</div>}
      </div>
    </Modal>
  )
}
