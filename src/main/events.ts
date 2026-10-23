import { BrowserWindow } from 'electron'
import type { Task } from '@shared/types'
import { uid } from './util/store'
import { CancelledError, isCancel } from './util/cancel'

let main: BrowserWindow | null = null

/** Главное окно лаунчера (оверлеи игры — отдельные окна, им события не нужны). */
export function setMainWindow(w: BrowserWindow): void {
  main = w
}
export function mainWindow(): BrowserWindow | null {
  return main && !main.isDestroyed() ? main : null
}

export function emit(channel: string, payload?: unknown): void {
  const w = mainWindow()
  if (w) w.webContents.send(channel, payload)
}

const active = new Map<string, TaskHandle>()

/** Отмена задачи из интерфейса (кнопка «Отменить» в панели загрузок). */
export function cancelTask(id: string): void {
  active.get(id)?.cancel()
}

/** Задача с прогрессом, видимая в нижней панели загрузок. */
export class TaskHandle {
  readonly task: Task
  private readonly controller = new AbortController()
  private last = 0

  constructor(title: string, cancellable = false) {
    this.task = { id: uid(), title, progress: 0, status: 'running', cancellable }
    if (cancellable) active.set(this.task.id, this)
    emit('task:update', this.task)
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted
  }

  cancel(): void {
    if (this.task.status !== 'running') return
    this.controller.abort()
    this.task.detail = 'Отмена…'
    emit('task:update', this.task)
  }

  throwIfCancelled(): void {
    if (this.cancelled) throw new CancelledError()
  }

  update(progress: number, detail?: string): void {
    this.throwIfCancelled()
    this.task.progress = Math.max(0, Math.min(1, progress))
    if (detail !== undefined) this.task.detail = detail
    const now = Date.now()
    if (now - this.last > 120 || progress >= 1) {
      this.last = now
      emit('task:update', this.task)
    }
  }

  detail(text: string): void {
    this.throwIfCancelled()
    this.task.detail = text
    emit('task:update', this.task)
  }

  private finish(status: Task['status']): void {
    this.task.status = status
    this.task.cancellable = false
    active.delete(this.task.id)
    emit('task:update', this.task)
  }

  done(detail?: string): void {
    if (this.task.status !== 'running') return
    this.task.progress = 1
    if (detail) this.task.detail = detail
    this.finish('done')
  }

  fail(err: unknown): void {
    if (this.task.status !== 'running') return
    if (this.cancelled || isCancel(err)) {
      this.task.detail = 'Отменено'
      this.finish('cancelled')
      return
    }
    this.task.error = err instanceof Error ? err.message : String(err)
    this.finish('error')
  }
}

export async function withTask<T>(title: string, fn: (t: TaskHandle) => Promise<T>, cancellable = false): Promise<T> {
  const t = new TaskHandle(title, cancellable)
  try {
    const r = await fn(t)
    t.done()
    return r
  } catch (e) {
    t.fail(e)
    throw t.cancelled ? new CancelledError() : e
  }
}

/** Задача с кнопкой «Отменить» в интерфейсе. */
export function withCancellableTask<T>(title: string, fn: (t: TaskHandle) => Promise<T>): Promise<T> {
  return withTask(title, fn, true)
}
