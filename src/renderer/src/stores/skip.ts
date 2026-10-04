import { defineStore } from 'pinia'
import { ref } from 'vue'
import { db } from '@renderer/db'
import type { SkipProfileRecord } from '@renderer/db/types'
import { normalizeSkipWindow } from '../../../shared/skip'
import type { SkipProfile, SkipWindow } from '../../../shared/skip'

/**
 * 跳过片头片尾的配置。
 *
 * 按**剧集**存一份（`vod:<sourceId>:<vodId>`），同一部剧换集不用重设；
 * 本地文件按路径各存一份。读出来时统一过一遍 `normalizeSkipWindow()`，
 * 老版本写坏的组合（片头点越过片尾点）在这里被就地修正。
 */
export const useSkipStore = defineStore('skip', () => {
  const profiles = ref<Record<string, SkipProfile>>({})
  const ready = ref(false)

  async function load(): Promise<void> {
    const rows = (await db.skip.toArray()) as SkipProfileRecord[]
    const next: Record<string, SkipProfile> = {}
    for (const row of rows) {
      if (!row?.key) continue
      const window = normalizeSkipWindow(row)
      next[row.key] = {
        key: row.key,
        introEnd: window.introEnd,
        outroStart: window.outroStart,
        autoIntro: row.autoIntro === true,
        autoOutro: row.autoOutro === true,
        updatedAt: row.updatedAt ?? 0
      }
    }
    profiles.value = next
    ready.value = true
  }

  function get(key: string): SkipProfile | null {
    if (!key) return null
    return profiles.value[key] ?? null
  }

  /** 是否设过任何一个点 —— 播放器据此决定要不要给出「跳过」的入口提示 */
  function configured(profile: SkipProfile | null): boolean {
    return !!profile && (profile.introEnd > 0 || profile.outroStart > 0)
  }

  /**
   * 覆盖式保存。
   *
   * 传 `null` 表示删除这条配置（两个点都清掉、开关也一并丢弃），
   * 而不是留一条全 0 的空记录 —— 空记录会让「有没有设过」判断失真。
   */
  async function save(
    key: string,
    window: SkipWindow,
    flags: { autoIntro: boolean; autoOutro: boolean }
  ): Promise<void> {
    if (!key) return
    const empty = window.introEnd <= 0 && window.outroStart <= 0

    if (empty) {
      delete profiles.value[key]
      try {
        await db.skip.delete(key)
      } catch (error) {
        console.warn('[skip] 清除跳过配置失败', error)
      }
      return
    }

    const record: SkipProfileRecord = {
      key,
      introEnd: window.introEnd,
      outroStart: window.outroStart,
      autoIntro: flags.autoIntro === true,
      autoOutro: flags.autoOutro === true,
      updatedAt: Date.now()
    }

    // 先更新内存再落盘：落盘是副作用，抛异常不该让界面停在旧值上
    profiles.value[key] = { ...record }
    try {
      await db.skip.put(record)
    } catch (error) {
      console.warn('[skip] 保存跳过配置失败，本次改动只在当前运行内生效', error)
    }
  }

  async function remove(key: string): Promise<void> {
    if (!key) return
    delete profiles.value[key]
    try {
      await db.skip.delete(key)
    } catch (error) {
      console.warn('[skip] 清除跳过配置失败', error)
    }
  }

  async function clear(): Promise<void> {
    profiles.value = {}
    try {
      await db.skip.clear()
    } catch (error) {
      console.warn('[skip] 清空跳过配置失败', error)
    }
  }

  return { profiles, ready, load, get, configured, save, remove, clear }
})
