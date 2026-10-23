import fs from 'fs'
import path from 'path'
import type { Instance } from '@shared/types'
import { gameDir } from './instances'
import { compareMc } from './minecraft/versions'

/** Старый мод-помощник (версии 1.1–1.2) — теперь вместо него оверлей, мод убираем из сборок. */
export const HELPER_FILE = 'aurora-helper.jar'

export function removeLegacyHelper(inst: Instance): void {
  fs.rmSync(path.join(gameDir(inst.id), 'mods', HELPER_FILE), { force: true })
}

/** Поддерживает ли оверлей-помощник эту сборку (нужны официальные маппинги Mojang, они есть с 1.14.4). */
export function helperSupported(inst: Pick<Instance, 'loader' | 'mcVersion'>): boolean {
  const modern = /^\d{2}\./.test(inst.mcVersion)
  if (modern) return true
  if (inst.loader === 'forge') return compareMc(inst.mcVersion, '1.17') >= 0
  return compareMc(inst.mcVersion, '1.14.4') >= 0
}
