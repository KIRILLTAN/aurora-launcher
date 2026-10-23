import { useEffect, useState } from 'react'
import { PackageOpen, Puzzle, Globe2, HardDrive, Clock } from 'lucide-react'
import type { ImportPreview, LoaderType, LoaderVersion, McVersion } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { Modal, LOADERS, Spinner, fmtPlaytime } from '../components/ui'

/** Начинает импорт: .mrpack/CF-модпак ставится сразу, «живые» сборки — через окно предпросмотра. */
export async function beginImport(file: string): Promise<void> {
  const { toast, go, refreshInstances } = useStore.getState()
  try {
    toast('Читаю сборку…')
    const p = await api.importInspect(file)
    if (p.format === 'mrpack' || p.format === 'curseforge-pack') {
      const inst = await api.importFile(file)
      toast(`Импортирована «${inst.name}»`, 'success')
      await refreshInstances()
      go('instance', inst.id)
    } else useStore.setState({ importing: p })
  } catch (e) {
    const msg = (e as Error).message
    if (msg !== 'Отменено') toast(msg, 'error')
  }
}

export default function ImportDialog() {
  const { importing: p, toast, go, refreshInstances } = useStore()
  const [name, setName] = useState(p?.name || '')
  const [mc, setMc] = useState(p?.mcVersion || '')
  const [loader, setLoader] = useState<LoaderType>(p?.loader || 'vanilla')
  const [loaderVersion, setLoaderVersion] = useState(p?.loaderVersion || '')
  const [versions, setVersions] = useState<McVersion[]>([])
  const [loaderVersions, setLoaderVersions] = useState<LoaderVersion[] | null>(null)
  const close = (): void => useStore.setState({ importing: undefined })

  useEffect(() => {
    api.versions().then(setVersions).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!mc || loader === 'vanilla') return setLoaderVersions(null)
    api.loaderVersions(loader, mc).then((l) => {
      setLoaderVersions(l)
      if (!l.some((x) => x.version === loaderVersion)) setLoaderVersion((l.find((x) => x.stable) || l[0])?.version || '')
    }).catch(() => setLoaderVersions([]))
  }, [mc, loader])

  if (!p) return null
  const start = async (): Promise<void> => {
    close()
    try {
      const inst = await api.importRun(p.file, { name: name.trim() || p.name, mcVersion: mc, loader, loaderVersion: loader === 'vanilla' ? undefined : loaderVersion })
      toast(`Сборка «${inst.name}» импортирована`, 'success')
      await refreshInstances()
      go('instance', inst.id)
    } catch (e) {
      const msg = (e as Error).message
      if (msg !== 'Отменено') toast(msg, 'error')
      else toast('Импорт отменён')
    }
  }

  return (
    <Modal
      title="Импорт сборки"
      icon={<PackageOpen size={20} color="var(--a2)" />}
      onClose={close}
      footer={
        <>
          <button className="btn ghost" onClick={close}>Отмена</button>
          <button className="btn primary" disabled={!mc || (loader !== 'vanilla' && !loaderVersion)} onClick={start}>Импортировать</button>
        </>
      }
    >
      <div className="col" style={{ gap: 16 }}>
        <div className="row wrap">
          <span className="chip accent">{p.formatLabel}</span>
          <span className="chip"><Puzzle size={11} /> модов: {p.mods}</span>
          <span className="chip"><Globe2 size={11} /> миров: {p.worlds}</span>
          <span className="chip"><HardDrive size={11} /> {p.sizeMb} МБ</span>
          {!!p.playTime && <span className="chip"><Clock size={11} /> наиграно {fmtPlaytime(p.playTime)}</span>}
        </div>
        <div className="muted small">
          Перенесутся моды, конфиги, миры, ресурспаки, шейдеры, карты и настройки игры. Версию и загрузчик лаунчер определил сам — проверьте их.
        </div>
        <div className="field">
          <label>Название</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="field grow">
            <label>Версия Minecraft</label>
            <input className="input" list="mc-versions" value={mc} placeholder="например 1.21.1" onChange={(e) => setMc(e.target.value.trim())} />
            <datalist id="mc-versions">
              {versions.slice(0, 400).map((v) => <option key={v.id} value={v.id} />)}
            </datalist>
            {!p.mcVersion && <span className="hint" style={{ color: 'var(--warn)' }}>Версию не удалось определить — укажите её</span>}
          </div>
          <div className="field grow">
            <label>Загрузчик</label>
            <select className="select" value={loader} onChange={(e) => setLoader(e.target.value as LoaderType)}>
              {LOADERS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
          </div>
          {loader !== 'vanilla' && (
            <div className="field grow">
              <label>Версия загрузчика</label>
              {loaderVersions === null ? (
                <div className="row muted"><Spinner /> …</div>
              ) : (
                <select className="select" value={loaderVersion} onChange={(e) => setLoaderVersion(e.target.value)}>
                  {loaderVersion && !loaderVersions.some((l) => l.version === loaderVersion) && <option value={loaderVersion}>{loaderVersion}</option>}
                  {loaderVersions.slice(0, 200).map((l) => <option key={l.version} value={l.version}>{l.version}{l.version === p.loaderVersion ? ' (из сборки)' : ''}</option>)}
                </select>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
