import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 播放列表里的一项：剧集的一集，或媒体库里的一部片子 */
export interface QueueItem {
  /** 播放地址：本地磁盘路径或远程流地址 */
  src: string
  /** 列表里显示的名字，例如「第 12 集」 */
  name: string
  /** 顶栏显示的完整标题 */
  title: string
}

/**
 * 当前播放列表。
 *
 * 「选集」面板需要知道整条线路有哪些剧集，而这个列表可能上百项 ——
 * 塞进 URL query 既不合适也会污染历史记录，所以放在内存里。
 * 页面刷新后列表会丢（此时选集面板自动隐藏，播放本身不受影响）。
 */
export const useQueueStore = defineStore('queue', () => {
  const items = ref<QueueItem[]>([])
  const label = ref('')
  /**
   * 这份列表属于哪部剧（`vod:<sourceId>:<vodId>`，见 `shared/series.ts`）。
   *
   * 片头片尾配置与观看进度都按它归组 —— 同一部剧换一集不该让用户重设一遍。
   * 直接打开单个文件时为空，播放器会退化成按地址各自一份。
   */
  const seriesKey = ref('')

  function set(next: QueueItem[], nextLabel = '', nextSeriesKey = ''): void {
    items.value = next
    label.value = nextLabel
    seriesKey.value = nextSeriesKey
  }

  function clear(): void {
    items.value = []
    label.value = ''
    seriesKey.value = ''
  }

  /** 当前播放地址在列表中的下标；不在列表里返回 -1 */
  function indexOf(src: string): number {
    if (!src) return -1
    return items.value.findIndex((item) => item.src === src)
  }

  return { items, label, seriesKey, set, clear, indexOf }
})
