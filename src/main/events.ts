import { BrowserWindow } from 'electron'
import type { Task } from '@shared/types'
import { uid } from './util/store'

export function emit(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}

/** Задача с прогрессом, видимая в нижней панели загрузок. */
export class TaskHandle {
  readonly task: Task
  private last = 0

  constructor(title: string) {
    this.task = { id: uid(), title, progress: 0, status: 'running' }
    emit('task:update', this.task)
  }

  update(progress: number, detail?: string): void {
    this.task.progress = Math.max(0, Math.min(1, progress))
    if (detail !== undefined) this.task.detail = detail
    const now = Date.now()
    if (now - this.last > 120 || progress >= 1) {
      this.last = now
      emit('task:update', this.task)
    }
  }

  detail(text: string): void {
    this.task.detail = text
    emit('task:update', this.task)
  }

  done(detail?: string): void {
    this.task.status = 'done'
    this.task.progress = 1
    if (detail) this.task.detail = detail
    emit('task:update', this.task)
  }

  fail(err: unknown): void {
    this.task.status = 'error'
    this.task.error = err instanceof Error ? err.message : String(err)
    emit('task:update', this.task)
  }
}

export async function withTask<T>(title: string, fn: (t: TaskHandle) => Promise<T>): Promise<T> {
  const t = new TaskHandle(title)
  try {
    const r = await fn(t)
    t.done()
    return r
  } catch (e) {
    t.fail(e)
    throw e
  }
}
