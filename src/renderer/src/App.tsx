import { lazy, Suspense, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { Home, Boxes, Compass, Users, Coffee, Palette, Settings as Cog, Minus, X, Download, RefreshCw, AlertTriangle, CheckCircle2, Info, Ban } from 'lucide-react'
import logo from './assets/logo.png'
import { useStore, useTasks, bindEvents, type Page } from './store'
import { api } from './api'
import { AccountAvatar, ACCOUNT_LABEL, Spinner } from './components/ui'
import HomePage from './pages/Home'
import LibraryPage from './pages/Library'
import InstancePage from './pages/Instance'
import CatalogPage from './pages/Catalog'
import AccountsPage from './pages/Accounts'
import JavaPage from './pages/Java'
import SettingsPage from './pages/Settings'
import CreateInstanceDialog from './dialogs/CreateInstance'
import CrashDialog from './dialogs/Crash'
import ImportDialog from './dialogs/Import'

// редактор скинов тянет three.js — грузим его только при открытии
const SkinsPage = lazy(() => import('./pages/Skins'))

const NAV: { id: Page; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'Главная', icon: Home },
  { id: 'library', label: 'Мои сборки', icon: Boxes },
  { id: 'catalog', label: 'Каталог', icon: Compass },
  { id: 'accounts', label: 'Аккаунты', icon: Users },
  { id: 'java', label: 'Java', icon: Coffee },
  { id: 'skins', label: 'Скины', icon: Palette },
  { id: 'settings', label: 'Настройки', icon: Cog }
]
const NAV_STEP = 48

export default function App() {
  const { page, go, refresh, instanceCount, account, toasts, dismissToast, crash, createOpen, importing, update } = useStore(
    useShallow((s) => ({
      page: s.page,
      go: s.go,
      refresh: s.refresh,
      instanceCount: s.instances.length,
      account: s.accounts.find((a) => a.id === s.settings?.selectedAccount) || s.accounts[0],
      toasts: s.toasts,
      dismissToast: s.dismissToast,
      crash: !!s.crash,
      createOpen: s.createOpen,
      importing: !!s.importing,
      update: s.update
    }))
  )
  const tasks = useTasks((s) => s.tasks)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const off = bindEvents()
    refresh()
      .catch((e) => useStore.getState().toast(String(e), 'error'))
      .finally(() => setReady(true))
    return off
  }, [])

  const navIndex = NAV.findIndex((n) => n.id === page || (n.id === 'library' && page === 'instance'))
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
            <button title="Свернуть" onClick={() => api.minimize()}>
              <Minus size={16} />
            </button>
            <button title="Закрыть" className="close" onClick={() => api.close()}>
              <X size={17} />
            </button>
          </div>
        </div>
        <div className="shell">
          <aside className="sidebar">
            <div className="nav">
              {navIndex >= 0 && <div className="nav-indicator" style={{ transform: `translateY(${navIndex * NAV_STEP}px)` }} />}
              {NAV.map((n) => (
                <div key={n.id} className={`nav-item ${NAV[navIndex]?.id === n.id ? 'active' : ''}`} onClick={() => go(n.id)}>
                  <n.icon size={18} />
                  {n.label}
                  {n.id === 'library' && instanceCount > 0 && <span className="count">{instanceCount}</span>}
                </div>
              ))}
            </div>
            <div className="grow" />
            <div className="account-card" onClick={() => go('accounts')}>
              <AccountAvatar account={account} size={38} />
              <div className="grow">
                <div className="name ellipsis">{account?.name || 'Нет аккаунта'}</div>
                <div className="type">{account ? ACCOUNT_LABEL[account.type] : 'Нажмите, чтобы добавить'}</div>
              </div>
            </div>
          </aside>
          <main className="main">
            {ready ? (
              <Suspense fallback={<div className="empty"><Spinner lg /></div>}>
                <Current key={page} />
              </Suspense>
            ) : (
              <div className="empty"><Spinner lg /></div>
            )}
          </main>
        </div>
      </div>

      <div className="tasks-dock">
        {(update.state === 'downloading' || update.state === 'available') && (
          <div className="task running">
            <div className="row">
              <Download size={18} color="var(--a2)" />
              <div className="title grow ellipsis">Обновление лаунчера {update.version ? 'до ' + update.version : ''}</div>
              <span className="small muted">{Math.round((update.progress || 0) * 100)}%</span>
            </div>
            <div className="detail">Скачивается в фоне — по готовности появится кнопка «Обновить»</div>
            <div className={`progress ${!update.progress ? 'indeterminate' : ''}`}>
              <div style={{ transform: `scaleX(${update.progress || 0})` }} />
            </div>
          </div>
        )}
        {tasks.slice(0, 4).map((t) => (
          <div key={t.id} className={`task ${t.status}`}>
            <div className="row">
              {t.status === 'running' ? (
                <div className="spinner" />
              ) : t.status === 'done' ? (
                <CheckCircle2 size={18} color="var(--ok)" />
              ) : t.status === 'cancelled' ? (
                <Ban size={18} color="var(--muted)" />
              ) : (
                <AlertTriangle size={18} color="var(--danger)" />
              )}
              <div className="title grow ellipsis">{t.title}</div>
              {t.status === 'running' && t.cancellable && (
                <button className="btn sm danger" onClick={() => api.cancelTask(t.id)}>
                  Отменить
                </button>
              )}
              {t.status !== 'running' && (
                <button className="btn ghost sm icon" onClick={() => useTasks.setState({ tasks: useTasks.getState().tasks.filter((x) => x.id !== t.id) })}>
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="detail selectable">{t.status === 'error' ? t.error : t.detail}</div>
            {t.status === 'running' && (
              <div className={`progress ${t.progress <= 0.01 ? 'indeterminate' : ''}`}>
                <div style={{ transform: `scaleX(${t.progress})` }} />
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
      {importing && <ImportDialog />}
    </>
  )
}
