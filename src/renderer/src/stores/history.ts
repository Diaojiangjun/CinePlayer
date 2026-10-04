import { defineStore } from 'pinia'
import { ref } from 'vue'
import { db } from '@renderer/db'
import type { HistoryRecord } from '@renderer/db/types'

export interface ProgressPayload {
  path: string
  title: string
  cover?: string
  position: number
  duration: number
}

export const useHistoryStore = defineStore('history', () => {
  const records = ref<HistoryRecord[]>([])

  async function load(): Promise<void> {
    records.value = await db.history.orderBy('playedAt').reverse().toArray()
  }

  async function saveProgress(payload: ProgressPayload): Promise<void> {
    const existing = await db.history.where('path').equals(payload.path).first()
    const data: HistoryRecord = {
      path: payload.path,
      title: payload.title,
      cover: payload.cover ?? existing?.cover,
      position: payload.position,
      duration: payload.duration,
      playedAt: Date.now()
    }
    if (existing?.id !== undefined) {
      await db.history.update(existing.id, data)
    } else {
      await db.history.add(data)
    }
    await load()
  }

  function positionOf(path: string): number {
    return records.value.find((r) => r.path === path)?.position ?? 0
  }

  async function remove(id: number): Promise<void> {
    await db.history.delete(id)
    await load()
  }

  async function clear(): Promise<void> {
    await db.history.clear()
    await load()
  }

  return { records, load, saveProgress, positionOf, remove, clear }
})
