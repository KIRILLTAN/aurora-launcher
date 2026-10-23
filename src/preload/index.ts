import { contextBridge, ipcRenderer, webUtils } from 'electron'

const EVENTS = ['task:update', 'game:log', 'game:exit', 'game:state', 'instances:changed', 'update:status', 'win:maximized']

const api = {
  invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const r = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; data?: unknown; error?: string }
    if (!r.ok) throw new Error(r.error)
    return r.data
  },
  on: (channel: string, cb: (payload: unknown) => void): (() => void) => {
    if (!EVENTS.includes(channel)) throw new Error('Unknown event ' + channel)
    const listener = (_e: unknown, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  showWindow: (): void => ipcRenderer.send('win:show')
}

contextBridge.exposeInMainWorld('aurora', api)

export type AuroraBridge = typeof api
