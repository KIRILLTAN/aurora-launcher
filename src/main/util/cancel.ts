/** Ошибка отмены операции пользователем. */
export class CancelledError extends Error {
  constructor() {
    super('Отменено')
    this.name = 'CancelledError'
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CancelledError()
}

export function isCancel(e: unknown): boolean {
  return e instanceof CancelledError || (e instanceof Error && e.name === 'AbortError')
}
