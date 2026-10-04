import { defineStore } from 'pinia'
import { ref } from 'vue'
import { db } from '@renderer/db'
import type { FavoriteItem } from '@renderer/db/types'

export interface FavoritePayload {
  path: string
  title: string
  cover?: string
  kind: 'local' | 'stream'
}

export const useFavoriteStore = defineStore('favorite', () => {
  const items = ref<FavoriteItem[]>([])

  async function load(): Promise<void> {
    items.value = await db.favorite.orderBy('addedAt').reverse().toArray()
  }

  async function toggle(payload: FavoritePayload): Promise<boolean> {
    const existing = await db.favorite.where('path').equals(payload.path).first()
    if (existing?.id !== undefined) {
      await db.favorite.delete(existing.id)
      await load()
      return false
    }
    await db.favorite.add({ ...payload, addedAt: Date.now() })
    await load()
    return true
  }

  function has(path: string): boolean {
    return items.value.some((i) => i.path === path)
  }

  async function remove(id: number): Promise<void> {
    await db.favorite.delete(id)
    await load()
  }

  async function clear(): Promise<void> {
    await db.favorite.clear()
    await load()
  }

  return { items, load, toggle, has, remove, clear }
})
