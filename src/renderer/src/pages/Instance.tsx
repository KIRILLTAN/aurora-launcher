import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Play, Square, FolderOpen, Copy, Trash2, RefreshCw, Package, Settings2, Terminal, Puzzle, Plus, Search, FileUp, Download, Image, Sun, UploadCloud, Zap, ArrowUpCircle, Globe2, Camera, Archive, Keyboard } from "lucide-react"
import type { Instance, JavaInstall, ModInfo, ModUpdate, WorldInfo, ScreenshotInfo } from '@shared/types'
import { api } from '../api'
import { useStore, useLogs } from '../store'
import { InstanceIcon, loaderLabel, fmtPlaytime, Switch, Spinner, Modal } from '../components/ui'
import { CatalogBrowser } from './Catalog'
import { PullButton } from "../components/Cloud"

type Tab = "mods" | "resourcepacks" | "shaders" | "worlds" | "screenshots" | "settings" | "console"

export default function InstancePage() {
  const { openInstanceId, instances, running, play, go, toast, sync, cloud, settings, refreshCloud } = useStore()
  const inst = instances.find((i) => i.id === openInstanceId)
  const [tab, setTab] = useState<Tab>('mods')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [helperOk, setHelperOk] = useState(false)
  useEffect(() => {
    if (openInstanceId) api.helperSupported(openInstanceId).then(setHelperOk).catch(() => setHelperOk(false))
  }, [openInstanceId])

  if (!inst) {
    return (
      <div className="page">
        <button className="btn ghost" onClick={() => go('library')}>
          <ArrowLeft size={16} /> К сборкам
        </button>
        <div className="empty">Сборка не найдена</div>
      </div>
    )
  }
  const isRun = running.includes(inst.id)
  const remote = cloud.find((c) => c.id === inst.id)

  return (
    <div className="page">
      <button className="btn ghost sm" onClick={() => go('library')} style={{ marginBottom: 12 }}>
        <ArrowLeft size={15} /> Мои сборки
      </button>
      <div className="card pad row" style={{ gap: 18, marginBottom: 20 }}>
        <InstanceIcon inst={inst} size="lg" />
        <div className="grow">
          <h1 style={{ margin: 0, fontSize: 26 }}>{inst.name}</h1>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <span className="chip accent">Minecraft {inst.mcVersion}</span>
            <span className="chip">{loaderLabel(inst.loader)} {inst.loaderVersion || ''}</span>
            <span className="chip">Наиграно: {fmtPlaytime(inst.playTime)}</span>
            {inst.source?.name && <span className="chip">{inst.source.type}: {inst.source.name}</span>}
            {settings?.helperEnabled && helperOk && <span className="chip ok"><Keyboard size={11} /> F6 помощник</span>}
            {remote?.state === "synced" && <span className="chip accent">в облаке</span>}
          </div>
        </div>
        <div className="row">
          {remote?.state === "cloud-newer" && <PullButton item={remote} />}
          {sync?.connected && (
            <button className="btn icon" title="Отправить в облако" onClick={() => api.syncPush([inst.id]).then(() => { toast("Сборка отправлена в облако", "success"); refreshCloud() }).catch((e) => toast(e.message, "error"))}><UploadCloud size={17} /></button>
          )}
          <button className="btn icon" title="Открыть папку" onClick={() => api.openInstanceFolder(inst.id)}><FolderOpen size={17} /></button>
          <button className="btn icon" title="Экспорт в .mrpack" onClick={() => api.exportInstance(inst.id).then((ok) => ok && toast('Сборка экспортирована', 'success')).catch((e) => toast(e.message, 'error'))}><Download size={17} /></button>
          <button className="btn icon" title="Дублировать" onClick={() => api.duplicateInstance(inst.id).then(() => toast('Копия создана', 'success'))}><Copy size={17} /></button>
          <button className="btn icon" title="Переустановить версию" onClick={() => api.reinstall(inst.id).then(() => toast('Версия переустановлена', 'success')).catch((e) => toast(e.message, 'error'))}><RefreshCw size={17} /></button>
          <button className="btn icon danger" title="Удалить" onClick={() => setConfirmDelete(true)}><Trash2 size={17} /></button>
          {isRun ? (
            <button className="btn lg danger" onClick={() => api.stop(inst.id)}><Square size={16} /> Закрыть</button>
          ) : (
            <button className="btn lg primary" onClick={() => { setTab('console'); play(inst.id) }}><Play size={17} fill="currentColor" /> Играть</button>
          )}
        </div>
      </div>

      <div className="tabs">
        {inst.loader !== 'vanilla' && <button className={tab === 'mods' ? 'active' : ''} onClick={() => setTab('mods')}><Puzzle size={15} /> Моды</button>}
        <button className={tab === 'resourcepacks' ? 'active' : ''} onClick={() => setTab('resourcepacks')}><Image size={15} /> Ресурспаки</button>
        <button className={tab === 'shaders' ? 'active' : ''} onClick={() => setTab('shaders')}><Sun size={15} /> Шейдеры</button>
        <button className={tab === "worlds" ? "active" : ""} onClick={() => setTab("worlds")}><Globe2 size={15} /> Миры</button>
        <button className={tab === "screenshots" ? "active" : ""} onClick={() => setTab("screenshots")}><Camera size={15} /> Скриншоты</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}><Settings2 size={15} /> Настройки</button>
        <button className={tab === 'console' ? 'active' : ''} onClick={() => setTab('console')}><Terminal size={15} /> Консоль {isRun && <span className="chip ok">live</span>}</button>
      </div>

      {tab === 'mods' && inst.loader !== 'vanilla' && <ModsTab inst={inst} />}
      {tab === 'mods' && inst.loader === 'vanilla' && <SettingsTab inst={inst} />}
      {tab === 'resourcepacks' && <ContentTab inst={inst} type="resourcepack" folder="resourcepacks" />}
      {tab === 'shaders' && <ContentTab inst={inst} type="shader" folder="shaderpacks" />}
      {tab === "worlds" && <WorldsTab inst={inst} />}
      {tab === "screenshots" && <ScreenshotsTab inst={inst} />}
      {tab === 'settings' && <SettingsTab inst={inst} />}
      {tab === 'console' && <ConsoleTab inst={inst} />}

      {confirmDelete && (
        <Modal
          title="Удалить сборку?"
          size="narrow"
          onClose={() => setConfirmDelete(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>Отмена</button>
              <button className="btn danger" onClick={async () => { await api.deleteInstance(inst.id); setConfirmDelete(false); go('library') }}>
                <Trash2 size={15} /> Удалить навсегда
              </button>
            </>
          }
        >
          Папка сборки «{inst.name}» со всеми мирами, модами и настройками будет удалена. Это нельзя отменить.
        </Modal>
      )}
    </div>
  )
}

function ModsTab({ inst }: { inst: Instance }) {
  const { toast } = useStore()
  const [mods, setMods] = useState<ModInfo[] | null>(null)
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [boosting, setBoosting] = useState(false)
  const [checking, setChecking] = useState(false)
  const [updates, setUpdates] = useState<ModUpdate[] | null>(null)
  const load = (): void => void api.mods(inst.id).then(setMods).catch((e) => toast(e.message, 'error'))
  useEffect(load, [inst.id])

  const filtered = useMemo(() => (mods || []).filter((m) => (m.name + m.file).toLowerCase().includes(q.toLowerCase())), [mods, q])
  const enabledCount = mods?.filter((m) => m.enabled).length || 0

  return (
    <div className="card pad">
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="search grow" style={{ maxWidth: 340 }}>
          <Search size={16} />
          <input className="input" placeholder="Поиск мода" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <span className="muted small">{mods ? `${enabledCount} из ${mods.length} включено` : ''}</span>
        <span className="grow" />
        <button className="btn" onClick={() => api.openInstanceFolder(inst.id, 'mods')}><FolderOpen size={15} /> Папка</button>
        <button className="btn" onClick={async () => {
          const files = await api.openFile([{ name: 'Моды', extensions: ['jar'] }], true)
          if (files.length) { await api.addModFiles(inst.id, files); load() }
        }}><FileUp size={15} /> Из файла</button>
        <button className="btn primary" onClick={() => setAdding(true)}><Plus size={15} /> Добавить моды</button>
      </div>
      <div className="row wrap" style={{ marginBottom: 14 }}>
        <button className="btn sm" disabled={boosting} onClick={async () => {
          setBoosting(true)
          try {
            const r = await api.boostFps(inst.id)
            toast(r.installed.length ? `Установлено для FPS: ${r.installed.join(', ')}` : 'Всё уже установлено', 'success')
            load()
          } catch (e) {
            toast((e as Error).message, 'error')
          } finally {
            setBoosting(false)
          }
        }}>{boosting ? <Spinner /> : <Zap size={14} />} Ускорить FPS</button>
        <button className="btn sm" disabled={checking} onClick={async () => {
          setChecking(true)
          try {
            const u = await api.modUpdates(inst.id)
            setUpdates(u)
            if (!u.length) toast('Все моды последних версий', 'success')
          } catch (e) {
            toast((e as Error).message, 'error')
          } finally {
            setChecking(false)
          }
        }}>{checking ? <Spinner /> : <ArrowUpCircle size={14} />} Проверить обновления</button>
        <span className="small muted">«Ускорить FPS» ставит Sodium/Embeddium, Lithium, FerriteCore, EntityCulling и другие оптимизации</span>
      </div>
      {updates && updates.length > 0 && (
        <div className="card pad" style={{ marginBottom: 14, background: 'rgba(56,198,255,0.06)' }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <ArrowUpCircle size={18} color="var(--a2)" />
            <b className="grow">Доступны обновления: {updates.length}</b>
            <button className="btn sm primary" onClick={async () => {
              try {
                await api.applyModUpdates(inst.id, updates)
                toast(`Обновлено модов: ${updates.length}`, 'success')
                setUpdates(null)
                load()
              } catch (e) {
                toast((e as Error).message, 'error')
              }
            }}>Обновить все</button>
          </div>
          {updates.map((u) => (
            <div key={u.file} className="small muted">{u.file} → <span style={{ color: 'var(--text)' }}>{u.version}</span></div>
          ))}
        </div>
      )}
      {!mods && <div className="row muted"><Spinner /> Чтение модов…</div>}
      {mods && mods.length === 0 && (
        <div className="empty">
          <Package size={46} />
          <h3>Модов нет</h3>
          <div>Найдите моды в Modrinth или CurseForge — зависимости установятся автоматически</div>
        </div>
      )}
      <div className="list">
        {filtered.map((m) => (
          <div key={m.file} className={`list-row ${m.enabled ? '' : 'disabled'}`}>
            <Switch on={m.enabled} onChange={async (v) => { await api.toggleMod(inst.id, m.file, v); load() }} />
            <div className="grow">
              <div className="row">
                <b className="ellipsis">{m.name}</b>
                {m.version && <span className="small muted">{m.version}</span>}
                {m.loaders.map((l) => <span key={l} className="chip">{l}</span>)}
              </div>
              <div className="small muted ellipsis">{m.description || m.file}</div>
            </div>
            <span className="small muted">{(m.size / 1048576).toFixed(1)} МБ</span>
            <button className="btn ghost sm icon" title="Удалить" onClick={async () => { await api.deleteMod(inst.id, m.file); load() }}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
      {adding && (
        <Modal title={`Моды для ${inst.name}`} size="wide" onClose={() => { setAdding(false); load() }}>
          <CatalogBrowser type="mod" instance={inst} />
        </Modal>
      )}
    </div>
  )
}

function ContentTab({ inst, type, folder }: { inst: Instance; type: 'resourcepack' | 'shader'; folder: string }) {
  return (
    <div className="col">
      <div className="row">
        <span className="muted">Файлы лежат в папке {folder}. Нажмите «Установить» у нужного пакета.</span>
        <span className="grow" />
        <button className="btn" onClick={() => api.openInstanceFolder(inst.id, folder)}><FolderOpen size={15} /> Открыть папку</button>
      </div>
      <CatalogBrowser type={type} instance={inst} />
    </div>
  )
}

function SettingsTab({ inst }: { inst: Instance }) {
  const { toast, settings } = useStore()
  const [form, setForm] = useState<Instance>(inst)
  const [javas, setJavas] = useState<JavaInstall[]>([])
  const [required, setRequired] = useState<number>()
  const [totalMem, setTotalMem] = useState(16384)
  useEffect(() => {
    api.javas().then(setJavas)
    api.requiredJava(inst.mcVersion).then(setRequired)
    api.appInfo().then((i) => setTotalMem(i.totalMem))
  }, [inst.id])
  const set = <K extends keyof Instance>(k: K, v: Instance[K]): void => setForm((f) => ({ ...f, [k]: v }))
  const save = async (): Promise<void> => {
    try {
      await api.updateInstance(inst.id, form)
      toast('Настройки сохранены', 'success')
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }
  const memMax = form.memoryMax || settings?.memoryMax || 4096

  return (
    <div className="grid two">
      <div className="card pad col" style={{ gap: 14 }}>
        <h3>Общее</h3>
        <div className="field">
          <label>Название</label>
          <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label>Иконка (ссылка на картинку)</label>
          <input className="input" value={form.icon || ''} placeholder="https://…" onChange={(e) => set('icon', e.target.value || undefined)} />
        </div>
        <div className="field">
          <label>Память: {memMax} МБ ({(memMax / 1024).toFixed(1)} ГБ)</label>
          <input type="range" min={1024} max={Math.max(4096, Math.floor(totalMem * 0.75 / 512) * 512)} step={512} value={memMax} onChange={(e) => set('memoryMax', parseInt(e.target.value))} />
          <span className="hint">Ванилле хватает 2–3 ГБ, модпакам — 6–8 ГБ. В системе {Math.round(totalMem / 1024)} ГБ.</span>
        </div>
        <div className="row">
          <div className="field grow">
            <label>Ширина окна</label>
            <input className="input" type="number" value={form.width || ''} placeholder={String(settings?.width || 1280)} onChange={(e) => set('width', parseInt(e.target.value) || undefined)} />
          </div>
          <div className="field grow">
            <label>Высота окна</label>
            <input className="input" type="number" value={form.height || ''} placeholder={String(settings?.height || 720)} onChange={(e) => set('height', parseInt(e.target.value) || undefined)} />
          </div>
        </div>
        <div className="row">
          <Switch on={!!form.fullscreen} onChange={(v) => set('fullscreen', v)} /> Полноэкранный режим
        </div>
      </div>
      <div className="card pad col" style={{ gap: 14 }}>
        <h3>Java и запуск</h3>
        <div className="field">
          <label>Java</label>
          <select className="select" value={form.javaPath || ''} onChange={(e) => set('javaPath', e.target.value || undefined)}>
            <option value="">Авто (нужна Java {required ?? '…'}, скачается сама)</option>
            {javas.map((j) => (
              <option key={j.path} value={j.path}>
                Java {j.version} — {j.vendor || ''} {j.major === required ? '✓ подходит' : ''} ({j.path})
              </option>
            ))}
          </select>
          <span className="hint">Для Minecraft {inst.mcVersion} рекомендуется Java {required}.</span>
        </div>
        <div className="field">
          <label>Аргументы JVM</label>
          <textarea className="textarea" value={form.jvmArgs ?? ''} placeholder={settings?.jvmArgs} onChange={(e) => set('jvmArgs', e.target.value || undefined)} />
          <span className="hint">Пусто — используются глобальные из настроек.</span>
        </div>
        <div className="field">
          <label>Аргументы игры</label>
          <input className="input mono" value={form.gameArgs || ''} placeholder="--server play.example.com" onChange={(e) => set('gameArgs', e.target.value || undefined)} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary" onClick={save}>Сохранить</button>
        </div>
      </div>
    </div>
  )
}

function ConsoleTab({ inst }: { inst: Instance }) {
  const live = useLogs((s) => s.logs[inst.id])
  const [history, setHistory] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!live?.length) api.gameLog(inst.id).then(setHistory)
  }, [inst.id])
  const lines = live?.length ? live : history.map((line) => ({ instanceId: inst.id, line, level: /ERROR|Exception|^\s+at /.test(line) ? ('error' as const) : undefined }))
  const shown = filter ? lines.filter((l) => l.line.toLowerCase().includes(filter.toLowerCase())) : lines
  useEffect(() => {
    const el = ref.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [shown.length])
  return (
    <div className="card pad">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="search grow" style={{ maxWidth: 340 }}>
          <Search size={16} />
          <input className="input" placeholder="Фильтр строк" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <span className="grow" />
        <button className="btn" onClick={() => navigator.clipboard.writeText(lines.map((l) => l.line).join('\n'))}><Copy size={15} /> Копировать</button>
        <button className="btn" onClick={() => api.openInstanceFolder(inst.id, 'logs')}><FolderOpen size={15} /> Логи</button>
      </div>
      <div className="console" ref={ref}>
        {shown.length === 0 && <span className="muted">Лог появится после запуска игры.</span>}
        {shown.slice(-1500).map((l, i) => (
          <div key={i} className={l.level || 'info'}>{l.line}</div>
        ))}
      </div>
    </div>
  )
}

function WorldsTab({ inst }: { inst: Instance }) {
  const { toast, play } = useStore()
  const [worlds, setWorlds] = useState<WorldInfo[] | null>(null)
  useEffect(() => {
    api.worlds(inst.id).then(setWorlds).catch((e) => toast(e.message, 'error'))
  }, [inst.id])
  return (
    <div className="card pad">
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted">Миры сборки и их резервные копии</span>
        <span className="grow" />
        <button className="btn" onClick={() => api.openInstanceFolder(inst.id, 'saves')}><FolderOpen size={15} /> Папка миров</button>
        <button className="btn" onClick={() => api.openInstanceFolder(inst.id, '../backups')}><Archive size={15} /> Бэкапы</button>
      </div>
      {!worlds && <div className="row muted"><Spinner /> Загрузка…</div>}
      {worlds?.length === 0 && (
        <div className="empty">
          <Globe2 size={44} />
          <h3>Миров пока нет</h3>
          <div>Создайте мир в игре — он появится здесь</div>
          <button className="btn primary" onClick={() => play(inst.id)}><Play size={15} fill="currentColor" /> Играть</button>
        </div>
      )}
      <div className="list">
        {worlds?.map((w) => (
          <div key={w.folder} className="list-row">
            {w.icon ? <img src={w.icon} style={{ width: 48, height: 48, borderRadius: 10, imageRendering: 'pixelated' }} /> : <div className="inst-icon"><Globe2 size={20} /></div>}
            <div className="grow">
              <b>{w.folder}</b>
              <div className="small muted">
                {new Date(w.lastPlayed).toLocaleString('ru-RU')} · {(w.size / 1048576).toFixed(1)} МБ
              </div>
            </div>
            <button className="btn sm" onClick={() => api.backupWorld(inst.id, w.folder).then((p) => { toast('Бэкап сохранён', 'success'); api.showItem(p) }).catch((e) => toast(e.message, 'error'))}>
              <Archive size={14} /> Бэкап
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function ScreenshotsTab({ inst }: { inst: Instance }) {
  const { toast } = useStore()
  const [shots, setShots] = useState<ScreenshotInfo[] | null>(null)
  const [open, setOpen] = useState<ScreenshotInfo | null>(null)
  useEffect(() => {
    api.screenshots(inst.id).then(setShots).catch((e) => toast(e.message, 'error'))
  }, [inst.id])
  return (
    <div className="card pad">
      <div className="row" style={{ marginBottom: 12 }}>
        <span className="muted">Скриншоты делаются в игре клавишей <span className="kbd">F2</span></span>
        <span className="grow" />
        <button className="btn" onClick={() => api.openInstanceFolder(inst.id, 'screenshots')}><FolderOpen size={15} /> Папка</button>
      </div>
      {!shots && <div className="row muted"><Spinner /> Загрузка…</div>}
      {shots?.length === 0 && <div className="empty"><Camera size={44} /><h3>Скриншотов нет</h3></div>}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
        {shots?.map((s) => (
          <img key={s.file} src={s.thumb} title={s.file} onClick={() => setOpen(s)} style={{ width: '100%', aspectRatio: '16/9', objectFit: 'cover', borderRadius: 12, cursor: 'zoom-in', border: '1px solid var(--border)' }} />
        ))}
      </div>
      {open && (
        <Modal title={open.file} size="wide" onClose={() => setOpen(null)} footer={<button className="btn" onClick={() => api.showItem(open.path)}><FolderOpen size={15} /> Показать в папке</button>}>
          <img src={open.thumb} style={{ width: '100%', borderRadius: 12, imageRendering: 'auto' }} />
        </Modal>
      )}
    </div>
  )
}
