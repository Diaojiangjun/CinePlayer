import { decodeEntities } from './entities'
import {
  resolveImageUrl,
  splitPlayGroups,
  toNum,
  toStr,
  type MacClass,
  type MacPage,
  type MacPoster,
  type MacVod
} from './maccms'
import { findChild, findDeep, parseXml, textIn, type XmlNode } from './xml'

/**
 * 苹果CMS 采集接口的报文解析（纯函数，无 Electron 依赖）。
 *
 * 不同站点返回格式差异很大：标准 XML、扁平 XML、JSON 都存在，
 * 这里统一归一化成 shared/maccms.ts 定义的结构。
 */

const GROUP_SEP = '$$$'

type Json = Record<string, unknown>

/**
 * 把 HTML 描述转成纯文本。
 * JSON 接口的 vod_content 常是实体转义后的 HTML（`&lt;p&gt;…`），
 * 因此必须「先解实体、再剥标签」，顺序反了会残留标签。
 */
export function cleanHtml(input: string): string {
  if (!input) return ''
  return decodeEntities(input)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|li|tr|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 采集接口被关停时通常返回整页 HTML，需要与正常数据区分开 */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 512).toLowerCase()
  return head.includes('<!doctype html') || head.includes('<html')
}

function pick(source: Json, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return ''
}

/* ------------------------------------------------------------------ *
 * JSON 分支
 * ------------------------------------------------------------------ */

export function vodFromJson(item: Json, apiUrl: string): MacVod {
  const playFrom = toStr(pick(item, 'vod_play_from', 'vod_play_note', 'play_from'))
  const playUrl = toStr(pick(item, 'vod_play_url', 'play_url'))
  return {
    vodId: toStr(pick(item, 'vod_id', 'id')),
    name: toStr(pick(item, 'vod_name', 'name')),
    typeId: toStr(pick(item, 'type_id', 'tid')),
    typeName: toStr(pick(item, 'type_name', 'type')),
    pic: resolveImageUrl(toStr(pick(item, 'vod_pic', 'pic', 'vod_pic_thumb')), apiUrl),
    lang: toStr(pick(item, 'vod_lang', 'lang')),
    area: toStr(pick(item, 'vod_area', 'area')),
    year: toStr(pick(item, 'vod_year', 'year')),
    state: toStr(pick(item, 'vod_state', 'state')),
    note: toStr(pick(item, 'vod_remarks', 'note', 'vod_note')),
    actor: toStr(pick(item, 'vod_actor', 'actor')),
    director: toStr(pick(item, 'vod_director', 'director')),
    score: toStr(pick(item, 'vod_score', 'vod_douban_score', 'score')),
    content: cleanHtml(toStr(pick(item, 'vod_content', 'vod_blurb', 'des', 'vod_des'))),
    total: toNum(pick(item, 'vod_total', 'total')),
    serial: toNum(pick(item, 'vod_serial', 'serial')),
    playGroups: splitPlayGroups(playFrom, playUrl)
  }
}

export function classFromJson(item: Json): MacClass {
  return {
    id: toStr(pick(item, 'type_id', 'id')),
    name: toStr(pick(item, 'type_name', 'name')),
    pid: toStr(pick(item, 'type_pid', 'pid'))
  }
}

/* ------------------------------------------------------------------ *
 * XML 分支
 * ------------------------------------------------------------------ */

export function vodFromXml(node: XmlNode, apiUrl: string): MacVod {
  // 标准输出把各线路放在 <dl><dd flag="线路名">集名$地址#...</dd></dl>
  const dl = findChild(node, 'dl')
  const ddNodes = dl ? dl.children.filter((child) => child.name.toLowerCase() === 'dd') : []

  let playFrom = ''
  let playUrl = ''

  if (ddNodes.length) {
    playFrom = ddNodes.map((dd) => dd.attrs['flag'] ?? '').join(GROUP_SEP)
    playUrl = ddNodes.map((dd) => dd.text.trim()).join(GROUP_SEP)
  } else {
    // 少数站点改成了扁平字段
    playFrom = textIn(node, 'play_from') || textIn(node, 'vod_play_from')
    playUrl = textIn(node, 'play_url') || textIn(node, 'vod_play_url')
  }

  return {
    vodId: textIn(node, 'id') || textIn(node, 'vod_id'),
    name: textIn(node, 'name') || textIn(node, 'vod_name'),
    typeId: textIn(node, 'tid') || textIn(node, 'type_id'),
    typeName: textIn(node, 'type') || textIn(node, 'type_name'),
    pic: resolveImageUrl(textIn(node, 'pic') || textIn(node, 'vod_pic'), apiUrl),
    lang: textIn(node, 'lang'),
    area: textIn(node, 'area'),
    year: textIn(node, 'year'),
    state: textIn(node, 'state'),
    note: textIn(node, 'note') || textIn(node, 'vod_remarks'),
    actor: textIn(node, 'actor'),
    director: textIn(node, 'director'),
    score: textIn(node, 'score'),
    content: cleanHtml(textIn(node, 'des') || textIn(node, 'vod_content')),
    total: toNum(textIn(node, 'total')),
    serial: toNum(textIn(node, 'serial')),
    playGroups: splitPlayGroups(playFrom, playUrl)
  }
}

export function classesFromXml(root: XmlNode): MacClass[] {
  // 分类节点与列表节点同处在 <rss> 下，需要深度查找
  const classNode = findDeep(root, 'class')
  if (!classNode) return []
  const classes: MacClass[] = []
  for (const child of classNode.children) {
    const id = child.attrs['id'] ?? ''
    const name = child.text.trim()
    if (!id || !name) continue
    classes.push({ id, name, pid: child.attrs['pid'] ?? '' })
  }
  return classes
}

export function pageFromXml(root: XmlNode): MacPage {
  const list = findDeep(root, 'list')
  return {
    page: toNum(list?.attrs['page']) || 1,
    pageCount: toNum(list?.attrs['pagecount']) || 1,
    pageSize: toNum(list?.attrs['pagesize']) || 20,
    total: toNum(list?.attrs['recordcount'])
  }
}

/* ------------------------------------------------------------------ *
 * 封面补全（轻量分支）
 * ------------------------------------------------------------------ */

/**
 * 只抽取「影片 id → 封面地址」。
 *
 * 为什么单独写一条：补封面请求的是 `ac=detail&ids=1,2,3…`，报文里有整页的
 * `vod_play_url`（几十集甚至上千集）和 `vod_content`。走 `parseMacPayload`
 * 会把这些都拆成对象再扔掉 —— 一页轻松几百 KB 到几 MB。这里只取两个字段，
 * 解析开销与报文里播放地址的长度无关。
 */
export function parseMacPics(text: string, apiUrl: string): MacPoster[] {
  const trimmed = (text || '').trim()
  if (!trimmed) throw new Error('接口返回了空内容')

  const collect = (vodId: string, pic: string): MacPoster | null => {
    const id = toStr(vodId)
    const url = resolveImageUrl(toStr(pic), apiUrl)
    return id && url ? { vodId: id, pic: url } : null
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed) as Json
    const rawList = json['list'] ?? json['data'] ?? []
    if (!Array.isArray(rawList)) return []
    return (rawList as Json[])
      .map((item) =>
        collect(
          toStr(pick(item, 'vod_id', 'id')),
          toStr(pick(item, 'vod_pic', 'pic', 'vod_pic_thumb'))
        )
      )
      .filter((item): item is MacPoster => item !== null)
  }

  const root = parseXml(trimmed)
  if (!root) throw new Error('接口返回的内容无法解析')
  const list = findDeep(root, 'list')
  const nodes = list ? list.children.filter((child) => child.name.toLowerCase() === 'video') : []
  return nodes
    .map((node) =>
      collect(textIn(node, 'id') || textIn(node, 'vod_id'), textIn(node, 'pic') || textIn(node, 'vod_pic'))
    )
    .filter((item): item is MacPoster => item !== null)
}

/* ------------------------------------------------------------------ *
 * 统一入口
 * ------------------------------------------------------------------ */

export interface ParsedPayload {
  classes: MacClass[]
  vods: MacVod[]
  page: MacPage
}

export function parseMacPayload(text: string, apiUrl: string): ParsedPayload {
  const trimmed = (text || '').trim()
  if (!trimmed) throw new Error('接口返回了空内容')

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed) as Json
    const rawList = json['list'] ?? json['data'] ?? []
    const vods = Array.isArray(rawList)
      ? (rawList as Json[]).map((item) => vodFromJson(item, apiUrl)).filter((v) => v.vodId || v.name)
      : []

    const rawClass = json['class'] ?? json['classes'] ?? []
    const classes = Array.isArray(rawClass)
      ? (rawClass as Json[])
          .map((item) => classFromJson(item))
          .filter((item) => item.id && item.name)
      : []

    return {
      classes,
      vods,
      page: {
        page: toNum(json['page']) || 1,
        pageCount: toNum(json['pagecount']) || 1,
        pageSize: toNum(json['limit']) || 20,
        total: toNum(json['total'])
      }
    }
  }

  const root = parseXml(trimmed)
  if (!root) throw new Error('接口返回的内容无法解析')
  const list = findDeep(root, 'list')
  const videoNodes = list ? list.children.filter((child) => child.name.toLowerCase() === 'video') : []

  return {
    classes: classesFromXml(root),
    vods: videoNodes.map((node) => vodFromXml(node, apiUrl)),
    page: pageFromXml(root)
  }
}
