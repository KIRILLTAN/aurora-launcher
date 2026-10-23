import { create } from 'zustand'
import type { Account, CrashAnalysis, Instance, Task, UpdateStatus, GameLog } from '@shared/types'
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
  tasks: Task[]
  running: string[]
  logs: Record<string, GameLog[]>
  crash?: CrashAnalysis & { java?: string }
  update: UpdateStatus
  toasts: Toast[]
  createOpen: boolean
  go: (page: Page, instanceId?: string) => void
  refresh: () => Promise<void>
  refreshInstances: () => Promise<void>
  refreshAccounts: () => Promise<void>
  setSettings: (s: PublicSettings) => void
  toast: (text: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
  setCrash: (c?: State['crash']) => void
  setCreateOpen: (v: boolean) => void
  play: (instanceId: string) => Promise<void>
}

let toastId = 0

export const useStore = create<State>((set, get) => ({
  page: 'home',
  accounts: [],
  instances: [],
  tasks: [],
  running: [],
  logs: {},
  update: { state: 'idle' },
  toasts: [],
  createOpen: false,

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
    document.documentElement.dataset.accent = settings.accent
  },
  refreshInstances: async () => set({ instances: await api.instances() }),
  refreshAccounts: async () => set({ accounts: await api.accounts(), settings: await api.settings() }),
  setSettings: (settings) => {
    set({ settings })
    document.documentElement.dataset.accent = settings.accent
  },

  toast: (text, kind = 'info') => {
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, kind, text }] })
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000)
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setCrash: (crash) => set({ crash }),
  setCreateOpen: (createOpen) => set({ createOpen }),

  play: async (instanceId) => {
    const { settings, accounts, toast } = get()
    const acc = settings?.selectedAccount || accounts[0]?.id
    if (!acc) {
      toast('Сначала добавьте аккаунт', 'error')
      set({ page: 'accounts' })
      return
    }
    set({ logs: { ...get().logs, [instanceId]: [] } })
    try {
      await api.launch(instanceId, acc)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
}))

// доступ к состоянию для самопроверки в CI
;(window as unknown as { __aurora: typeof useStore }).__aurora = useStore

/** Подписка на события main-процесса. Вызывается один раз при старте. */
export function bindEvents(): () => void {
  const s = useStore
  const offs = [
    api.on<Task>('task:update', (t) => {
      const tasks = s.getState().tasks.filter((x) => x.id !== t.id)
      tasks.unshift({ ...t })
      s.setState({ tasks: tasks.slice(0, 30) })
      if (t.status === 'done') {
        setTimeout(() => s.setState({ tasks: s.getState().tasks.filter((x) => x.id !== t.id) }), 4000)
      }
    }),
    api.on<GameLog>('game:log', (l) => {
      const logs = s.getState().logs
      const arr = logs[l.instanceId] ? [...logs[l.instanceId], l] : [l]
      if (arr.length > 3000) arr.splice(0, arr.length - 3000)
      s.setState({ logs: { ...logs, [l.instanceId]: arr } })
    }),
    api.on<{ instanceId: string; running: boolean }>('game:state', () => api.running().then((running) => s.setState({ running }))),
    api.on<{ instanceId: string; code: number | null; analysis: CrashAnalysis | null; java: string }>('game:exit', (e) => {
      api.running().then((running) => s.setState({ running }))
      s.getState().refreshInstances()
      if (e.analysis) s.setState({ crash: { ...e.analysis, java: e.java } })
    }),
    api.on('instances:changed', () => s.getState().refreshInstances()),
    api.on<UpdateStatus>('update:status', (update) => s.setState({ update }))
  ]
  return () => offs.forEach((o) => o())
}
