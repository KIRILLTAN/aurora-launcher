import { useEffect, useState } from 'react'
import { Home, Boxes, Compass, Users, Coffee, Palette, Settings as Cog, Minus, Square, X, Download, RefreshCw, AlertTriangle, CheckCircle2, Info, Loader2 } from 'lucide-react'
import logo from './assets/logo.png'
import { useStore, bindEvents, type Page } from './store'
import { api } from './api'
import { AccountAvatar, ACCOUNT_LABEL } from './components/ui'
import HomePage from './pages/Home'
import LibraryPage from './pages/Library'
import InstancePage from './pages/Instance'
import CatalogPage from './pages/Catalog'
import AccountsPage from './pages/Accounts'
import JavaPage from './pages/Java'
import SkinsPage from './pages/Skins'
import SettingsPage from './pages/Settings'
import CreateInstanceDialog from './dialogs/CreateInstance'
import CrashDialog from './dialogs/Crash'

const NAV: { id: Page; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'Главная', icon: Home },
  { id: 'library', label: 'Мои сборки', icon: Boxes },
  { id: 'catalog', label: 'Каталог', icon: Compass },
  { id: 'accounts', label: 'Аккаунты', icon: Users },
  { id: 'java', label: 'Java', icon: Coffee },
  { id: 'skins', label: 'Скины', icon: Palette },
  { id: 'settings', label: 'Настройки', icon: Cog }
]

export default function App() {
  const { page, go, refresh, instances, accounts, settings, toasts, dismissToast, tasks, crash, createOpen, update } = useStore()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const off = bindEvents()
    refresh()
      .catch((e) => useStore.getState().toast(String(e), 'error'))
      .finally(() => setReady(true))
    return off
  }, [])

  const account = accounts.find((a) => a.id === settings?.selectedAccount) || accounts[0]
  const Current = { home: HomePage, library: LibraryPage, instance: InstancePage, catalog: CatalogPage, accounts: AccountsPage, java: JavaPage, skins: SkinsPage, settings: SettingsPage }[page]

  return (
    <>
      <div className="aurora-bg">
        <div className="stars" />
        <div className="blob b1" />
        <div className="blob b2" />
        <div className="blob b3" />
      </div>
      <div className="app">
        <div className="titlebar">
          <div className="brand">
            <img src={logo} />
            Aurora Launcher
          </div>
          <div className="spacer" />
          {update.state === 'ready' && (
            <button className="btn sm primary update-pill" onClick={() => api.installUpdate()}>
              <RefreshCw size={14} /> Обновить до {update.version}
            </button>
          )}
          {update.state === 'downloading' && (
            <span className="chip accent update-pill">
              <Download size={12} /> Обновление {Math.round((update.progress || 0) * 100)}%
            </span>
          )}
          <div className="win-btns">
            <button onClick={() => api.minimize()}>
              <Minus size={16} />
            </button>
            <button onClick={() => api.maximize()}>
              <Square size={13} />
            </button>
            <button className="close" onClick={() => api.close()}>
              <X size={17} />
            </button>
          </div>
        </div>
        <div className="shell">
          <aside className="sidebar">
            {NAV.map((n) => (
              <div key={n.id} className={`nav-item ${page === n.id || (n.id === 'library' && page === 'instance') ? 'active' : ''}`} onClick={() => go(n.id)}>
                <n.icon size={18} />
                {n.label}
                {n.id === 'library' && instances.length > 0 && <span className="count">{instances.length}</span>}
              </div>
            ))}
            <div className="grow" />
            <div className="account-card" onClick={() => go('accounts')}>
              <AccountAvatar account={account} size={38} />
              <div className="grow">
                <div className="name ellipsis">{account?.name || 'Нет аккаунта'}</div>
                <div className="type">{account ? ACCOUNT_LABEL[account.type] : 'Нажмите, чтобы добавить'}</div>
              </div>
            </div>
          </aside>
          <main className="main">{ready ? <Current key={page} /> : <div className="empty"><Loader2 className="spin" /></div>}</main>
        </div>
      </div>

      <div className="tasks-dock">
        {tasks.slice(0, 4).map((t) => (
          <div key={t.id} className={`task ${t.status}`}>
            <div className="row">
              {t.status === 'running' ? <div className="spinner" /> : t.status === 'done' ? <CheckCircle2 size={18} color="var(--ok)" /> : <AlertTriangle size={18} color="var(--danger)" />}
              <div className="title grow ellipsis">{t.title}</div>
              {t.status !== 'running' && (
                <button className="btn ghost sm icon" onClick={() => useStore.setState({ tasks: useStore.getState().tasks.filter((x) => x.id !== t.id) })}>
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="detail selectable">{t.status === 'error' ? t.error : t.detail}</div>
            {t.status === 'running' && (
              <div className={`progress ${t.progress <= 0.01 ? 'indeterminate' : ''}`}>
                <div style={{ width: `${t.progress * 100}%` }} />
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => dismissToast(t.id)}>
            {t.kind === 'error' ? <AlertTriangle size={18} color="var(--danger)" /> : t.kind === 'success' ? <CheckCircle2 size={18} color="var(--ok)" /> : <Info size={18} color="var(--a2)" />}
            <div className="grow">{t.text}</div>
          </div>
        ))}
      </div>

      {createOpen && <CreateInstanceDialog />}
      {crash && <CrashDialog />}
    </>
  )
}
