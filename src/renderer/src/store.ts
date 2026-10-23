import { create } from 'zustand'
import type { Account, CrashAnalysis, Instance, Task, UpdateStatus, GameLog, SyncStatus, SyncRemoteInstance, ImportPreview } from '@shared/types'
import { api, type PublicSettings } from './api'

export type Page = 'home' | 'library' | 'instance' | 'catalog' | 'accounts' | 'java' | 'skins' | 'settings'

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  text: string
}

interface State {
  page: Page
  openInstanceId?: string
  settings?: PublicSettings
  accounts: Account[]
  instances: Instance[]
  running: string[]
  crash?: CrashAnalysis & { java?: string }
  update: UpdateStatus
  toasts: Toast[]
  createOpen: boolean
  importing?: ImportPreview
  sync?: SyncStatus
  cloud: SyncRemoteInstance[]
  refreshCloud: () => Promise<void>
  go: (page: Page, instanceId?: string) => void
  refresh: () => Promise<void>
  refreshInstances: () => Promise<void>
  refreshAccounts: () => Promise<void>
  setSettings: (s: PublicSettings) => void
  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  setCrash: (c?: State['crash']) => void
  setCreateOpen: (v: boolean) => void
  play: (instanceId: string, server?: string) => Promise<void>
}

let toastId = 0

export const useStore = create<State>((set, get) => ({
  page: 'home',
  accounts: [],
  instances: [],
  running: [],
  update: { state: 'idle' },
  toasts: [],
  createOpen: false,
  cloud: [],

  refreshCloud: async () => {
    try {
      const sync = await api.syncStatus()
      set({ sync, cloud: sync.connected ? await api.syncList() : [] })
    } catch {
      set({ cloud: [] })
    }
  },

  go: (page, instanceId) => set({ page, openInstanceId: instanceId ?? get().openInstanceId }),

  refresh: async () => {
    const [settings, accounts, instances, running, update] = await Promise.all([
      api.settings(),
      api.accounts(),
      api.instances(),
      api.running(),
      api.updateStatus()
    ])
    set({ settings, accounts, instances, running, update })
    void get().refreshCloud()
    applyTheme(settings)
  },
  refreshInstances: async () => set({ instances: await api.instances() }),
  refreshAccounts: async () => set({ accounts: await api.accounts(), settings: await api.settings() }),
  setSettings: (settings) => {
    set({ settings })
    applyTheme(settings)
  },

  toast: (text, kind = 'info') => {
    // отмена пользователем — не ошибка
    if (text === 'Отменено') {
      text = 'Операция отменена'
      kind = 'info'
    }
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, kind, text }].slice(-5) })
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setCrash: (crash) => set({ crash }),
  setCreateOpen: (createOpen) => set({ createOpen }),

  play: async (instanceId, server) => {
    const { settings, accounts, toast } = get()
    const acc = settings?.selectedAccount || accounts[0]?.id
    if (!acc) {
      toast('Сначала добавьте аккаунт', 'error')
      set({ page: 'accounts' })
      return
    }
    useLogs.getState().clear(instanceId)
    try {
      await api.launch(instanceId, acc, server)
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== 'Отменено') toast(msg, 'error')
    }
  }
}))

function applyTheme(s: PublicSettings): void {
  const root = document.documentElement
  root.dataset.accent = s.accent
  root.classList.toggle('reduced-effects', s.animations === 'reduced')
}

/** Задачи вынесены отдельно: частые обновления прогресса не перерисовывают страницы. */
export const useTasks = create<{ tasks: Task[] }>(() => ({ tasks: [] }))

/** Логи игры: копятся в буфере и отрисовываются пачками, а не на каждую строку. */
interface LogState {
  logs: Record<string, GameLog[]>
  clear: (id: string) => void
}
export const useLogs = create<LogState>((set, get) => ({
  logs: {},
  clear: (id) => set({ logs: { ...get().logs, [id]: [] } })
}))

const pending: GameLog[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
function flushLogs(): void {
  flushTimer = null
  if (!pending.length) return
  const logs = { ...useLogs.getState().logs }
  const touched = new Set<string>()
  for (const l of pending.splice(0)) {
    // копируем массив сборки один раз за пачку, а не на каждую строку
    if (!touched.has(l.instanceId)) {
      logs[l.instanceId] = logs[l.instanceId] ? logs[l.instanceId].slice() : []
      touched.add(l.instanceId)
    }
    logs[l.instanceId].push(l)
  }
  for (const k of touched) if (logs[k].length > 3000) logs[k] = logs[k].slice(-3000)
  useLogs.setState({ logs })
}

// доступ к состоянию для самопроверки в CI
;(window as unknown as { __aurora: typeof useStore }).__aurora = useStore

/** Подписка на события main-процесса. Вызывается один раз при старте. */
export function bindEvents(): () => void {
  const s = useStore
  const setRunning = (running: string[]): void => {
    s.setState({ running })
    document.documentElement.classList.toggle('game-running', running.length > 0)
  }
  const offs = [
    api.on<Task>('task:update', (t) => {
      const tasks = useTasks.getState().tasks.filter((x) => x.id !== t.id)
      tasks.unshift({ ...t })
      useTasks.setState({ tasks: tasks.slice(0, 30) })
      if (t.status === 'done' || t.status === 'cancelled') {
        setTimeout(() => useTasks.setState({ tasks: useTasks.getState().tasks.filter((x) => x.id !== t.id) }), t.status === 'done' ? 4000 : 2500)
      }
    }),
    api.on<GameLog | GameLog[]>('game:log', (l) => {
      if (Array.isArray(l)) for (const x of l) pending.push(x)
      else pending.push(l)
      if (pending.length > 3000) pending.splice(0, pending.length - 3000)
      if (!flushTimer) flushTimer = setTimeout(flushLogs, 200)
    }),
    api.on<{ instanceId: string; running: boolean }>('game:state', () => api.running().then(setRunning)),
    api.on<{ instanceId: string; code: number | null; analysis: CrashAnalysis | null; java: string }>('game:exit', (e) => {
      flushLogs()
      api.running().then(setRunning)
      s.getState().refreshInstances()
      if (e.analysis) s.setState({ crash: { ...e.analysis, java: e.java } })
      setTimeout(() => s.getState().refreshCloud(), 15000)
    }),
    api.on('instances:changed', () => s.getState().refreshInstances()),
    api.on<UpdateStatus>('update:status', (update) => s.setState({ update }))
  ]
  return () => offs.forEach((o) => o())
}
