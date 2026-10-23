import { useEffect, useState } from 'react'
import { Search, FolderPlus, Download, Trash2, Radar, CheckCircle2, Info, FolderOpen } from 'lucide-react'
import type { JavaInstall, JavaRelease } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { Spinner } from '../components/ui'

export default function JavaPage() {
  const { toast } = useStore()
  const [mode, setMode] = useState<'installed' | 'download'>('installed')
  const [javas, setJavas] = useState<JavaInstall[]>([])
  const [scanning, setScanning] = useState(false)
  const [releases, setReleases] = useState<JavaRelease[] | null>(null)
  const [relErr, setRelErr] = useState<string>()
  const [image, setImage] = useState<'jre' | 'jdk'>('jre')
  const [installing, setInstalling] = useState<number | null>(null)
  const [mc, setMc] = useState('')
  const [need, setNeed] = useState<number>()
  const [hints, setHints] = useState<Record<number, { recommendedFor: string; hint: string }>>({})

  const scan = async (): Promise<void> => {
    setScanning(true)
    try {
      setJavas(await api.detectJavas())
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    api.javas().then((j) => (j.length ? setJavas(j) : scan()))
    api.javaReleases().then(setReleases).catch((e) => setRelErr(e.message))
  }, [])
  useEffect(() => {
    for (const j of javas) if (!hints[j.major]) api.javaHint(j.major).then((h) => setHints((x) => ({ ...x, [j.major]: h })))
  }, [javas])
  useEffect(() => {
    if (!/^\d+\.\d+/.test(mc)) return setNeed(undefined)
    api.requiredJava(mc).then(setNeed)
  }, [mc])

  const addManual = async (dir: boolean): Promise<void> => {
    const p = dir ? await api.openDir() : (await api.openFile([{ name: 'Java', extensions: ['exe', '*'] }]))[0]
    if (!p) return
    try {
      const j = await api.addJava(p)
      toast(`Добавлена Java ${j.version}`, 'success')
      setJavas(await api.javas())
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const install = async (major: number): Promise<void> => {
    setInstalling(major)
    try {
      const j = await api.installJava(major, image)
      toast(`Java ${j.version} установлена`, 'success')
      setJavas(await api.javas())
      setMode('installed')
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setInstalling(null)
    }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Java</h1>
          <p>Встроенный установщик: автопоиск, ручной выбор и загрузка любой версии Eclipse Temurin</p>
        </div>
        <div className="actions">
          <div className="seg">
            <button className={mode === 'installed' ? 'active' : ''} onClick={() => setMode('installed')}><Radar size={15} /> Установленные</button>
            <button className={mode === 'download' ? 'active' : ''} onClick={() => setMode('download')}><Download size={15} /> Скачать Java</button>
          </div>
        </div>
      </div>

      <div className="card pad row" style={{ marginBottom: 18, gap: 16 }}>
        <Info size={20} color="var(--a2)" />
        <div className="grow">
          <b>Какая Java нужна?</b>
          <div className="small muted">Введите версию Minecraft — подскажу. В режиме «Авто» лаунчер сам выберет и при необходимости скачает нужную Java.</div>
        </div>
        <input className="input" style={{ width: 140 }} placeholder="например 1.20.1" value={mc} onChange={(e) => setMc(e.target.value.trim())} />
        {need && <span className="chip accent" style={{ height: 32, fontSize: 13 }}>Нужна Java {need}</span>}
      </div>

      {mode === 'installed' && (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <button className="btn primary" disabled={scanning} onClick={scan}>
              {scanning ? <Spinner /> : <Search size={16} />} Автопоиск
            </button>
            <button className="btn" onClick={() => addManual(false)}><FolderPlus size={16} /> Указать java.exe</button>
            <button className="btn" onClick={() => addManual(true)}><FolderOpen size={16} /> Указать папку</button>
          </div>
          {javas.length === 0 && !scanning && (
            <div className="empty">
              <h3>Java не найдена</h3>
              <div>Скачайте нужную версию во вкладке «Скачать Java» — это займёт минуту.</div>
              <button className="btn primary" onClick={() => setMode('download')}><Download size={15} /> Скачать</button>
            </div>
          )}
          <div className="col">
            {javas.map((j) => (
              <div key={j.path} className="card java-row">
                <div className="java-badge">{j.major}</div>
                <div style={{ minWidth: 0 }}>
                  <div className="row">
                    <b>Java {j.version}</b>
                    <span className="chip">{j.arch}</span>
                    <span className={`chip ${j.source === 'aurora' ? 'accent' : ''}`}>{j.source === 'aurora' ? 'Aurora' : j.source === 'manual' ? 'Вручную' : 'Найдена'}</span>
                    {j.vendor && <span className="small muted ellipsis">{j.vendor}</span>}
                  </div>
                  <div className="small mono muted ellipsis selectable">{j.path}</div>
                  {hints[j.major] && (
                    <div className="small" style={{ marginTop: 4 }}>
                      <CheckCircle2 size={12} color="var(--ok)" /> {hints[j.major].recommendedFor} · <span className="muted">{hints[j.major].hint}</span>
                    </div>
                  )}
                </div>
                {j.source !== 'detected' && (
                  <button className="btn sm icon danger" title={j.source === 'aurora' ? 'Удалить с диска' : 'Убрать из списка'} onClick={async () => { await api.removeJava(j.path); setJavas(await api.javas()) }}>
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {mode === 'download' && (
        <>
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="seg">
              <button className={image === 'jre' ? 'active' : ''} onClick={() => setImage('jre')}>JRE (для игры)</button>
              <button className={image === 'jdk' ? 'active' : ''} onClick={() => setImage('jdk')}>JDK (для разработки)</button>
            </div>
            <span className="muted small">Источник: Eclipse Adoptium (Temurin) — бесплатные сборки OpenJDK</span>
          </div>
          {!releases && !relErr && <div className="row muted"><Spinner /> Получаю список версий…</div>}
          {relErr && <div style={{ color: 'var(--danger)' }}>{relErr}</div>}
          <div className="grid cards">
            {releases?.map((r) => {
              const has = javas.some((j) => j.major === r.major)
              return (
                <div key={r.major} className="card release-card" style={need === r.major ? { borderColor: 'var(--a2)' } : undefined}>
                  <div className="row">
                    <div className="num grad-text">{r.major}</div>
                    {r.lts && <span className="chip accent">LTS</span>}
                    {has && <span className="chip ok">установлена</span>}
                    {need === r.major && <span className="chip warn">нужна вам</span>}
                  </div>
                  <b>{r.recommendedFor}</b>
                  <div className="small muted grow">{r.hint}</div>
                  <button className={`btn sm ${r.lts ? 'primary' : ''}`} disabled={installing !== null} onClick={() => install(r.major)}>
                    {installing === r.major ? <Spinner /> : <Download size={14} />} Скачать Java {r.major}
                  </button>
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
