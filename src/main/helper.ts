import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type { Instance } from '@shared/types'
import { dirs, getSettings } from './settings'
import { gameDir } from './instances'
import { downloadFile } from './util/net'
import { exists, ensureDir } from './util/store'

/** Версии Minecraft, под которые собран мод Aurora Helper. */
export const HELPER_VERSIONS = ['1.20.1', '1.21.1']
export const HELPER_FILE = 'aurora-helper.jar'

export function helperSupported(inst: Pick<Instance, 'loader' | 'mcVersion'>): boolean {
  return (inst.loader === 'fabric' || inst.loader === 'quilt') && HELPER_VERSIONS.includes(inst.mcVersion)
}

function bundledDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'helper') : path.join(app.getAppPath(), 'resources', 'helper')
}

/** Jar мода: из комплекта лаунчера, из кэша или из последнего релиза на GitHub. */
async function helperJar(mc: string): Promise<string | null> {
  const bundled = path.join(bundledDir(), `aurora-helper-${mc}.jar`)
  if (exists(bundled)) return bundled
  const cached = path.join(ensureDir(path.join(dirs.cache(), 'helper')), `aurora-helper-${mc}-${app.getVersion()}.jar`)
  if (exists(cached)) return cached
  try {
    const repo = getSettings().githubRepo || 'KIRILLTAN/aurora-launcher'
    await downloadFile({ url: `https://github.com/${repo}/releases/latest/download/aurora-helper-${mc}.jar`, path: cached })
    return cached
  } catch {
    return null
  }
}

/** Кладёт мод-помощник в папку mods или убирает его — по галочке в настройках. */
export async function applyHelper(inst: Instance): Promise<boolean> {
  const modsDir = path.join(gameDir(inst.id), 'mods')
  const target = path.join(modsDir, HELPER_FILE)
  if (!getSettings().helperEnabled || !helperSupported(inst)) {
    fs.rmSync(target, { force: true })
    return false
  }
  const jar = await helperJar(inst.mcVersion)
  if (!jar) {
    fs.rmSync(target, { force: true })
    return false
  }
  ensureDir(modsDir)
  fs.copyFileSync(jar, target)
  return true
}
