/**
 * 极简 XML 解析器。
 *
 * 采集接口（MacCMS）与 EPG（XMLTV）的 XML 结构都很简单，
 * 引入完整 DOM 库不划算，这里用栈式扫描实现，覆盖：
 * 元素嵌套、属性、自闭合标签、CDATA、注释、XML 声明、实体转义。
 */

import { decodeEntities } from './entities'

export { decodeEntities }

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const CDATA_MARK = '\u0000'
const TOKEN_RE = /<\s*(\/?)\s*([\w:.-]+)([^>]*)>/g
const ATTR_RE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  ATTR_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTR_RE.exec(raw)) !== null) {
    const value = match[2] ?? match[3] ?? ''
    attrs[match[1].toLowerCase()] = decodeEntities(value)
  }
  return attrs
}

export function parseXml(source: string): XmlNode | null {
  if (!source || source.indexOf('<') < 0) return null

  const cdata: string[] = []
  let text = source.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_whole, body: string) => {
    cdata.push(body)
    return `${CDATA_MARK}${cdata.length - 1}${CDATA_MARK}`
  })

  text = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<![^>]*>/g, '')

  const restore = (value: string): string =>
    value.replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => cdata[Number(index)] ?? '')

  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlNode[] = [root]

  const appendText = (raw: string): void => {
    if (!raw) return
    stack[stack.length - 1].text += decodeEntities(restore(raw))
  }

  TOKEN_RE.lastIndex = 0
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = TOKEN_RE.exec(text)) !== null) {
    appendText(text.slice(cursor, match.index))
    cursor = match.index + match[0].length

    const name = match[2]
    if (match[1] === '/') {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name.toLowerCase() === name.toLowerCase()) {
          stack.length = i
          break
        }
      }
      continue
    }

    let rawAttrs = match[3] ?? ''
    const selfClosing = /\/\s*$/.test(rawAttrs)
    if (selfClosing) rawAttrs = rawAttrs.replace(/\/\s*$/, '')

    const node: XmlNode = { name, attrs: parseAttrs(rawAttrs), children: [], text: '' }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }

  appendText(text.slice(cursor))
  return root
}

export function findChildren(node: XmlNode | null, name: string): XmlNode[] {
  if (!node) return []
  const target = name.toLowerCase()
  return node.children.filter((child) => child.name.toLowerCase() === target)
}

export function findChild(node: XmlNode | null, name: string): XmlNode | null {
  return findChildren(node, name)[0] ?? null
}

/** 深度优先查找第一个匹配名称的节点 */
export function findDeep(node: XmlNode | null, name: string): XmlNode | null {
  if (!node) return null
  for (const child of node.children) {
    if (child.name.toLowerCase() === name.toLowerCase()) return child
    const nested = findDeep(child, name)
    if (nested) return nested
  }
  return null
}

export function textIn(node: XmlNode | null, name: string): string {
  const target = findChild(node, name)
  return target ? target.text.trim() : ''
}

export function attrIn(node: XmlNode | null, name: string): string {
  return node?.attrs[name.toLowerCase()]?.trim() ?? ''
}
