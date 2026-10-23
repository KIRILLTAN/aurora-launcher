import Anthropic from '@anthropic-ai/sdk'
import type { CrashAnalysis, Instance } from '@shared/types'
import { getSettings } from '../settings'
import { listMods } from '../mods'

const SYSTEM = `Ты — эксперт по Minecraft: Java Edition, модам (Fabric, Quilt, Forge, NeoForge), Java и нативным сбоям.
Тебе присылают лог и краш-репорт игры, запущенной из Aurora Launcher, а также список модов сборки и предварительный автоматический разбор.

Ответь по-русски, в Markdown, коротко и по делу:
## Причина
Одним-двумя предложениями: почему игра закрылась.
## Виноватые моды
Список модов (имя и файл), которые вызвали проблему или конфликтуют друг с другом, и почему. Если моды ни при чём — так и напиши.
## Как исправить
Нумерованные конкретные шаги для игрока (что отключить/обновить/скачать, какую Java выбрать, сколько памяти выделить).

Опирайся только на то, что есть в логах. Не выдумывай имена модов, которых нет в списке или логе. Если уверенности нет — скажи, что проверить.`

function trim(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.floor(max * 0.35)) + '\n\n[... вырезано ...]\n\n' + text.slice(-Math.floor(max * 0.65))
}

export async function askAi(inst: Instance, analysis: CrashAnalysis, javaInfo: string): Promise<string> {
  const s = getSettings()
  if (!s.anthropicKey) throw new Error('Добавьте ключ Claude API в настройках, чтобы включить ИИ-анализ')
  const client = new Anthropic({ apiKey: s.anthropicKey })

  let modsList = 'нет'
  try {
    const mods = listMods(inst.id)
    if (mods.length) modsList = mods.map((m) => `- ${m.enabled ? '' : '[ОТКЛЮЧЁН] '}${m.name} ${m.version || ''} (${m.id || '?'}, ${m.file})`).join('\n')
  } catch {
    /* нет папки mods */
  }

  const user = [
    `Сборка: ${inst.name}`,
    `Minecraft ${inst.mcVersion}, загрузчик: ${inst.loader}${inst.loaderVersion ? ' ' + inst.loaderVersion : ''}`,
    `Java: ${javaInfo}`,
    `Код выхода: ${analysis.exitCode}`,
    '',
    '<mods>',
    trim(modsList, 20000),
    '</mods>',
    '',
    '<auto_analysis>',
    analysis.causes.map((c) => `- ${c.title}: ${c.detail}`).join('\n'),
    '</auto_analysis>',
    '',
    '<crash_report>',
    trim(analysis.crashReport || 'нет', 60000),
    '</crash_report>',
    '',
    '<log_tail>',
    trim(analysis.logTail, 60000),
    '</log_tail>'
  ].join('\n')

  try {
    const response = await client.beta.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      messages: [{ role: 'user', content: user }]
    })
    if (response.stop_reason === 'refusal') {
      throw new Error('ИИ отказался анализировать этот лог. Посмотрите автоматический разбор выше.')
    }
    const text = response.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim()
    if (!text) throw new Error('ИИ вернул пустой ответ')
    return text
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Неверный ключ Claude API — проверьте его в настройках')
    if (e instanceof Anthropic.RateLimitError) throw new Error('Превышен лимит запросов Claude API, попробуйте через минуту')
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Нет соединения с Claude API')
    if (e instanceof Anthropic.APIError) throw new Error(`Ошибка Claude API ${e.status}: ${e.message}`)
    throw e
  }
}
