import { useEffect, useState } from 'react'
import { FolderOpen, Github, RefreshCw, KeyRound, Sparkles, MemoryStick, Palette, Rocket, ExternalLink, Keyboard } from 'lucide-react'
import type { Settings } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { Switch } from '../components/ui'

const ACCENTS: { id: Settings['accent']; label: string; grad: string }[] = [
  { id: 'aurora', label: 'Аврора', grad: 'linear-gradient(135deg,#3dffb0,#38c6ff,#a477ff)' },
  { id: 'emerald', label: 'Изумруд', grad: 'linear-gradient(135deg,#6ee7b7,#10b981,#22d3ee)' },
  { id: 'violet', label: 'Фиалка', grad: 'linear-gradient(135deg,#f0abfc,#a855f7,#6366f1)' },
  { id: 'sunset', label: 'Закат', grad: 'linear-gradient(135deg,#fde047,#fb923c,#f43f5e)' },
  { id: 'ice', label: 'Лёд', grad: 'linear-gradient(135deg,#e0f2fe,#7dd3fc,#818cf8)' }
]

export default function SettingsPage() {
  const { settings, setSettings, toast, update } = useStore()
  const [info, setInfo] = useState<{ version: string; dataDir: string; totalMem: number }>()
  const [cfKey, setCfKey] = useState('')
  const [aiKey, setAiKey] = useState('')
  useEffect(() => {
    api.appInfo().then(setInfo)
  }, [])
  if (!settings) return null

  const patch = async (p: Partial<Settings>): Promise<void> => {
    try {
      setSettings(await api.updateSettings(p))
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const maxMem = Math.max(4096, Math.floor(((info?.totalMem || 8192) * 0.8) / 512) * 512)

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Настройки</h1>
          <p>Aurora Launcher {info?.version}</p>
        </div>
      </div>

      <div className="grid two">
        <div className="card pad">
          <h3 className="row"><Palette size={17} /> Оформление</h3>
          <div className="row" style={{ gap: 14 }}>
            {ACCENTS.map((a) => (
              <div key={a.id} className="col" style={{ alignItems: 'center', gap: 6 }}>
                <div className={`accent-dot ${settings.accent === a.id ? 'active' : ''}`} style={{ background: a.grad }} onClick={() => patch({ accent: a.id })} />
                <span className="small muted">{a.label}</span>
              </div>
            ))}
          </div>
          <div className="divider" />
          <h3 className="row"><Keyboard size={17} /> Кастомный помощник в игре</h3>
          <div className="setting-row">
            <div className="text">
              <b>Aurora Helper — меню по F6</b>
              <span>
                В игре нажмите <span className="kbd">F6</span>: список лута на земле с расстоянием и стрелкой-направлением, координаты, FPS, часы. Работает в сборках Fabric и Quilt для Minecraft 1.20.1 и 1.21.1 — мод добавляется сам при запуске.
              </span>
            </div>
            <Switch on={settings.helperEnabled} onChange={(v) => patch({ helperEnabled: v })} />
          </div>
          <div className="divider" />
          <h3 className="row"><Rocket size={17} /> Запуск</h3>
          <div className="setting-row">
            <div className="text">
              <b>После запуска игры</b>
              <span>Что делать с окном лаунчера</span>
            </div>
            <select className="select" style={{ width: 200 }} value={settings.afterLaunch} onChange={(e) => patch({ afterLaunch: e.target.value as Settings['afterLaunch'] })}>
              <option value="hide">Свернуть в фон</option>
              <option value="keep">Оставить открытым</option>
              <option value="close">Закрыть лаунчер</option>
            </select>
          </div>
          <div className="setting-row">
            <div className="text">
              <b>Автоматическая Java</b>
              <span>Скачивать нужную Java при запуске, если её нет</span>
            </div>
            <Switch on={settings.autoJava} onChange={(v) => patch({ autoJava: v })} />
          </div>
          <div className="setting-row">
            <div className="text">
              <b>Анимации интерфейса</b>
              <span>Облегчённый режим отключает анимации — для слабых ПК</span>
            </div>
            <select className="select" style={{ width: 200 }} value={settings.animations} onChange={(e) => patch({ animations: e.target.value as Settings['animations'] })}>
              <option value="full">Плавные</option>
              <option value="reduced">Облегчённые</option>
            </select>
          </div>
          <div className="setting-row">
            <div className="text">
              <b>Потоков загрузки</b>
              <span>Больше — быстрее на хорошем интернете</span>
            </div>
            <input className="input" type="number" min={1} max={64} style={{ width: 90 }} value={settings.concurrency} onChange={(e) => patch({ concurrency: Math.max(1, Math.min(64, parseInt(e.target.value) || 8)) })} />
          </div>
        </div>

        <div className="card pad">
          <h3 className="row"><MemoryStick size={17} /> Оптимизация игры</h3>
          <div className="setting-row">
            <div className="text">
              <b>Автоподбор памяти</b>
              <span>Лаунчер сам выделит память по числу модов и объёму ОЗУ (если в сборке не задано вручную)</span>
            </div>
            <Switch on={settings.memoryAuto} onChange={(v) => patch({ memoryAuto: v })} />
          </div>
          <div className="setting-row">
            <div className="text">
              <b>Профиль сборщика мусора (JVM)</b>
              <span>G1 — оптимизированные флаги для ровного FPS; ZGC — почти без фризов на Java 21+ при 8+ ГБ</span>
            </div>
            <select className="select" style={{ width: 200 }} value={settings.jvmPreset} onChange={(e) => patch({ jvmPreset: e.target.value as Settings['jvmPreset'] })}>
              <option value="g1">G1 (рекомендуется)</option>
              <option value="zgc">ZGC (Java 21+)</option>
              <option value="custom">Только свои аргументы</option>
            </select>
          </div>
          <div className="setting-row">
            <div className="text">
              <b>Высокий приоритет игры</b>
              <span>Система отдаёт игре больше процессорного времени</span>
            </div>
            <Switch on={settings.highPriority} onChange={(v) => patch({ highPriority: v })} />
          </div>
          <div className="field" style={{ opacity: settings.memoryAuto ? 0.55 : 1 }}>
            <label>Максимум памяти: {settings.memoryMax} МБ ({(settings.memoryMax / 1024).toFixed(1)} ГБ)</label>
            <input type="range" min={1024} max={maxMem} step={512} value={settings.memoryMax} onChange={(e) => setSettings({ ...settings, memoryMax: parseInt(e.target.value) })} onMouseUp={() => patch({ memoryMax: settings.memoryMax })} />
            <span className="hint">В системе {Math.round((info?.totalMem || 0) / 1024)} ГБ ОЗУ</span>
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <div className="field grow">
              <label>Минимум памяти, МБ</label>
              <input className="input" type="number" value={settings.memoryMin} onChange={(e) => patch({ memoryMin: parseInt(e.target.value) || 512 })} />
            </div>
            <div className="field grow">
              <label>Окно игры</label>
              <div className="row">
                <input className="input" type="number" value={settings.width} onChange={(e) => patch({ width: parseInt(e.target.value) || 854 })} />
                ×
                <input className="input" type="number" value={settings.height} onChange={(e) => patch({ height: parseInt(e.target.value) || 480 })} />
              </div>
            </div>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Дополнительные аргументы JVM</label>
            <textarea className="textarea" defaultValue={settings.jvmArgs} placeholder="добавляются к оптимизированному профилю" onBlur={(e) => patch({ jvmArgs: e.target.value })} />
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Папка данных (версии, библиотеки, сборки)</label>
            <div className="row">
              <input className="input mono" readOnly value={settings.dataDir} />
              <button className="btn icon" title="Открыть" onClick={() => api.openPath(settings.dataDir)}><FolderOpen size={16} /></button>
              <button className="btn" onClick={async () => { const d = await api.openDir(); if (d) { await patch({ dataDir: d }); toast('Папка изменена. Существующие сборки остались в старой папке.') } }}>Изменить</button>
            </div>
          </div>
        </div>

        <div className="card pad">
          <h3 className="row"><Sparkles size={17} /> ИИ-анализ крашей</h3>
          <div className="small muted" style={{ marginBottom: 12 }}>
            Встроенный анализатор работает всегда и без интернета. Для подробного разбора через Claude (Anthropic) добавьте свой API-ключ — лог краша отправится в Claude API только когда вы нажмёте «Спросить ИИ».
          </div>
          <div className="setting-row">
            <div className="text">
              <b>Включить ИИ-разбор</b>
              <span>{settings.hasAnthropicKey ? 'Ключ сохранён: ' + settings.anthropicKey : 'Ключ не задан'}</span>
            </div>
            <Switch on={settings.aiEnabled} onChange={(v) => patch({ aiEnabled: v })} />
          </div>
          <div className="row">
            <input className="input mono" type="password" placeholder="sk-ant-…" value={aiKey} onChange={(e) => setAiKey(e.target.value)} />
            <button className="btn primary" disabled={!aiKey} onClick={async () => { await patch({ anthropicKey: aiKey.trim() }); setAiKey(''); toast('Ключ Claude сохранён', 'success') }}>
              <KeyRound size={15} /> Сохранить
            </button>
          </div>
          <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => api.openUrl('https://platform.claude.com/settings/keys')}><ExternalLink size={13} /> Получить ключ Claude API</button>
          <div className="divider" />
          <h3 className="row"><KeyRound size={17} /> CurseForge</h3>
          <div className="small muted" style={{ marginBottom: 10 }}>{settings.hasCurseforgeKey ? 'Ключ сохранён: ' + settings.curseforgeKey : 'Нужен для поиска и установки с CurseForge.'}</div>
          <div className="row">
            <input className="input mono" type="password" placeholder="$2a$10$…" value={cfKey} onChange={(e) => setCfKey(e.target.value)} />
            <button className="btn primary" disabled={!cfKey} onClick={async () => { await patch({ curseforgeKey: cfKey.trim() }); setCfKey(''); toast('Ключ CurseForge сохранён', 'success') }}>Сохранить</button>
          </div>
          <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => api.openUrl('https://console.curseforge.com/')}><ExternalLink size={13} /> Получить ключ CurseForge</button>
        </div>

        <div className="card pad">
          <h3 className="row"><Github size={17} /> Онлайн и обновления</h3>
          <div className="setting-row">
            <div className="text">
              <b>Автообновление</b>
              <span>Новые версии скачиваются из GitHub Releases</span>
            </div>
            <Switch on={settings.autoUpdate} onChange={(v) => patch({ autoUpdate: v })} />
          </div>
          <div className="setting-row">
            <div className="text">
              <b>Статус</b>
              <span>
                {{
                  idle: 'Ожидание',
                  checking: 'Проверка…',
                  available: `Найдена версия ${update.version}, скачивание…`,
                  downloading: `Скачивание ${Math.round((update.progress || 0) * 100)}%`,
                  ready: `Версия ${update.version} готова к установке`,
                  none: 'У вас последняя версия',
                  error: 'Ошибка: ' + update.error,
                  dev: 'Режим разработки — обновления отключены'
                }[update.state]}
              </span>
            </div>
            {update.state === 'ready' ? (
              <button className="btn primary" onClick={() => api.installUpdate()}>Перезапустить</button>
            ) : (
              <button className="btn" onClick={() => api.checkUpdates()}><RefreshCw size={15} /> Проверить</button>
            )}
          </div>
          <div className="field">
            <label>Репозиторий новостей и сборок</label>
            <input className="input mono" defaultValue={settings.githubRepo} onBlur={(e) => patch({ githubRepo: e.target.value.trim() || 'KIRILLTAN/aurora-launcher' })} />
            <span className="hint">Лаунчер читает remote/news.json и remote/featured.json из этого репозитория GitHub.</span>
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>Свой Azure Client ID для входа Microsoft (необязательно)</label>
            <input className="input mono" defaultValue={settings.msClientId} placeholder="по умолчанию — встроенный" onBlur={(e) => patch({ msClientId: e.target.value.trim() })} />
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label>GitHub OAuth Client ID для облака (кнопка «Войти через GitHub»)</label>
            <input className="input mono" defaultValue={settings.githubClientId} placeholder="Ov23li…" onBlur={(e) => patch({ githubClientId: e.target.value.trim() })} />
          </div>
          <div className="row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => api.openUrl('https://github.com/KIRILLTAN/aurora-launcher')}><Github size={15} /> Страница проекта</button>
            <button className="btn ghost" onClick={() => api.openUrl('https://github.com/KIRILLTAN/aurora-launcher/issues')}>Сообщить об ошибке</button>
          </div>
        </div>
      </div>
    </div>
  )
}
