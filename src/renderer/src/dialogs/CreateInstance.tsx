import { useEffect, useMemo, useState } from 'react'
import { Boxes, Compass, FileArchive, Search, Sparkles } from 'lucide-react'
import type { LoaderType, LoaderVersion, McVersion } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { Modal, LOADERS, LoaderIcon, Spinner, Switch } from '../components/ui'
import { CatalogBrowser } from '../pages/Catalog'
import { beginImport } from './Import'

type Tab = 'version' | 'catalog' | 'file'

export default function CreateInstanceDialog() {
  const { setCreateOpen, settings, toast, go, refreshInstances, setSettings } = useStore()
  const [tab, setTab] = useState<Tab>('version')
  const [versions, setVersions] = useState<McVersion[] | null>(null)
  const [vErr, setVErr] = useState<string>()
  const [filter, setFilter] = useState<'release' | 'snapshot' | 'old' | 'all'>('release')
  const [clean, setClean] = useState(true)
  const [q, setQ] = useState('')
  const [mc, setMc] = useState<string>()
  const [loader, setLoader] = useState<LoaderType>('vanilla')
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersion[] | null>(null)
  const [loaderVersion, setLoaderVersion] = useState<string>('')
  const [lvErr, setLvErr] = useState<string>()
  const [name, setName] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const close = (): void => setCreateOpen(false)

  useEffect(() => {
    api.versions().then((v) => {
      setVersions(v)
      setMc(v.find((x) => x.type === 'release')?.id)
    }).catch((e) => setVErr(e.message))
  }, [])

  useEffect(() => {
    if (!mc || loader === 'vanilla') {
      setLoaderVersions(null)
      return
    }
    setLoaderVersions(null)
    setLvErr(undefined)
    api.loaderVersions(loader, mc)
      .then((l) => {
        setLoaderVersions(l)
        setLoaderVersion((l.find((x) => x.stable) || l[0])?.version || '')
      })
      .catch((e) => setLvErr(e.message))
  }, [mc, loader])

  useEffect(() => {
    if (!nameTouched && mc) setName(`${loader === 'vanilla' ? 'Minecraft' : LOADERS.find((l) => l.id === loader)!.label} ${mc}`)
  }, [mc, loader, nameTouched])

  const shown = useMemo(() => {
    if (!versions) return []
    return versions.filter((v) => {
      if (q && !v.id.includes(q)) return false
      if (filter === 'all') return true
      if (filter === 'release') return v.type === 'release'
      if (filter === 'snapshot') return v.type === 'snapshot'
      return v.type === 'old_beta' || v.type === 'old_alpha'
    })
  }, [versions, filter, q])

  const create = async (): Promise<void> => {
    if (!mc) return
    if (loader !== 'vanilla' && !loaderVersion) return toast(`Для ${mc} нет версий ${loader}`, 'error')
    setBusy(true)
    try {
      const inst = await api.createInstance({ name: name.trim() || mc, mcVersion: mc, loader, loaderVersion: loader === 'vanilla' ? undefined : loaderVersion, cleanInstall: clean || undefined })
      setSettings(await api.settings())
      await refreshInstances()
      toast(`Сборка «${inst.name}» создана. Файлы игры скачаются при первом запуске.`, 'success')
      close()
      go('instance', inst.id)
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const importPath = (p: string): void => {
    close()
    void beginImport(p)
  }

  return (
    <Modal
      title="Новая сборка"
      size="wide"
      icon={<Sparkles size={20} color="var(--a2)" />}
      onClose={close}
      footer={
        tab === 'version' ? (
          <>
            <button className="btn ghost" onClick={close}>Отмена</button>
            <button className="btn primary" disabled={!mc || busy || (loader !== 'vanilla' && !loaderVersion)} onClick={create}>
              {busy && <Spinner />} Создать сборку
            </button>
          </>
        ) : undefined
      }
    >
      <div className="tabs">
        <button className={tab === 'version' ? 'active' : ''} onClick={() => setTab('version')}><Boxes size={15} /> Выбрать версию</button>
        <button className={tab === 'catalog' ? 'active' : ''} onClick={() => setTab('catalog')}><Compass size={15} /> Готовые модпаки</button>
        <button className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}><FileArchive size={15} /> Из файла</button>
      </div>

      {tab === 'version' && (
        <div className="grid two" style={{ gridTemplateColumns: '1fr 1.1fr' }}>
          <div className="col">
            <div className="row">
              <div className="search grow">
                <Search size={16} />
                <input className="input" placeholder="Поиск версии" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
            </div>
            <div className="seg" style={{ alignSelf: 'flex-start' }}>
              <button className={filter === 'release' ? 'active' : ''} onClick={() => setFilter('release')}>Релизы</button>
              <button className={filter === 'snapshot' ? 'active' : ''} onClick={() => setFilter('snapshot')}>Снапшоты</button>
              <button className={filter === 'old' ? 'active' : ''} onClick={() => setFilter('old')}>Beta/Alpha</button>
              <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Все версии</button>
            </div>
            {!versions && !vErr && <div className="row muted"><Spinner /> Загрузка версий…</div>}
            {vErr && <div style={{ color: 'var(--danger)' }}>{vErr}</div>}
            <div className="version-list">
              {shown.map((v) => (
                <div key={v.id} className={`version-opt ${mc === v.id ? 'active' : ''}`} onClick={() => setMc(v.id)}>
                  <b>{v.id}</b>
                  {filter === 'all' && v.type !== 'release' && <span className="chip">{v.type === 'snapshot' ? 'снапшот' : v.type === 'old_beta' ? 'beta' : 'alpha'}</span>}
                  <span className="grow" />
                  <span className="small muted">{new Date(v.releaseTime).toLocaleDateString('ru-RU')}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="col" style={{ gap: 16 }}>
            <div className="field">
              <label>Название</label>
              <input className="input" value={name} onChange={(e) => (setName(e.target.value), setNameTouched(true))} />
            </div>
            <div className="field">
              <label>Загрузчик модов</label>
              <div className="loader-pick">
                {LOADERS.map((l) => (
                  <button key={l.id} className={loader === l.id ? 'active' : ''} onClick={() => setLoader(l.id)}>
                    <LoaderIcon loader={l.id} size={26} />
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
            {loader !== 'vanilla' && (
              <div className="field">
                <label>Версия {LOADERS.find((l) => l.id === loader)?.label}</label>
                {!loaderVersions && !lvErr && <div className="row muted"><Spinner /> Загрузка…</div>}
                {lvErr && <div style={{ color: 'var(--danger)' }}>{lvErr}</div>}
                {loaderVersions && loaderVersions.length === 0 && <div className="muted">Для Minecraft {mc} нет версий этого загрузчика.</div>}
                {loaderVersions && loaderVersions.length > 0 && (
                  <select className="select" value={loaderVersion} onChange={(e) => setLoaderVersion(e.target.value)}>
                    {loaderVersions.slice(0, 200).map((l) => (
                      <option key={l.version} value={l.version}>
                        {l.version} {l.stable ? '★ рекомендуется' : ''}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            <div className="row" style={{ justifyContent: 'space-between', gap: 14 }}>
              <div>
                <div style={{ fontWeight: 600 }}>Скачать заново</div>
                <div className="small muted">Не брать уже скачанные файлы этой версии, а скачать и проверить их заново. Моды, миры и настройки у каждой сборки и так свои.</div>
              </div>
              <Switch on={clean} onChange={setClean} />
            </div>
            <div className="card pad small muted">
              Minecraft <b style={{ color: 'var(--text)' }}>{mc || '—'}</b>
              {loader !== 'vanilla' && <> + {LOADERS.find((l) => l.id === loader)?.label} {loaderVersion}</>}. Нужная Java подберётся и скачается автоматически.
            </div>
          </div>
        </div>
      )}

      {tab === 'catalog' && <CatalogBrowser type="modpack" onInstalled={() => close()} />}

      {tab === 'file' && (
        <div
          className={`drop-zone ${over ? 'over' : ''}`}
          onDragOver={(e) => (e.preventDefault(), setOver(true))}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            const f = e.dataTransfer.files[0]
            if (f) importPath(api.pathForFile(f))
          }}
          onClick={async () => {
            const [f] = await api.openFile([{ name: 'Сборки', extensions: ['zip', 'mrpack'] }])
            if (f) importPath(f)
          }}
        >
          <FileArchive size={42} />
          <h3 style={{ color: 'var(--text)' }}>Перетащите файл сборки</h3>
          <div>Архив или папка сборки: Prism / MultiMC, CurseForge, ATLauncher, TLauncher (.minecraft), .mrpack — или нажмите, чтобы выбрать</div>
          <button className="btn" style={{ marginTop: 14 }} onClick={async (e) => { e.stopPropagation(); const d = await api.openDir(); if (d) importPath(d) }}>Выбрать папку</button>
        </div>
      )}
    </Modal>
  )
}
