export interface AuroraBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  on: (channel: string, cb: (payload: unknown) => void) => () => void
  pathForFile: (file: File) => string
  showWindow: () => void
}

declare global {
  interface Window {
    aurora: AuroraBridge
  }
}
