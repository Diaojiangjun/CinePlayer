/**
 * 主进程采集 / EPG 客户端的离线端到端验证：
 * 用本地夹具替换网络，走完整「发请求 → 解码 → 解析 → 归一化」链路。
 */
import { $mock, $requested, $reset } from 'electron'
import { fetchDetail, fetchList, fetchPics } from '../src/main/maccms'
import { fetchEpg } from '../src/main/epg'
import { clearRefererRegistry, refererFor, resolveStreamSource } from '../src/main/stream'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  \u2713 ${name}`)
  } else {
    failed++
    console.log(`  \u2717 ${name}${detail ? `  -> ${detail}` : ''}`)
  }
}

const API = 'https://demo.com/api.php/provide/vod/'

const XML_LIST = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1"><list page="1" pagecount="3" pagesize="20" recordcount="45">
<video><id>1</id><name><![CDATA[测试影片]]></name><type>电影</type><pic>/up/1.jpg</pic>
<dl><dd flag="HD"><![CDATA[HD$https://v.demo.com/1.m3u8]]></dd></dl></video>
</list><class><ty id="1">电影</ty><ty id="2">连续剧</ty></class></rss>`

const XML_DETAIL = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1"><list page="1" pagecount="1" pagesize="20" recordcount="1">
<video><id>77</id><name><![CDATA[详情影片]]></name><type>连续剧</type><pic>https://img.demo.com/77.jpg</pic>
<des><![CDATA[<p>简介文字</p>]]></des>
<dl>
<dd flag="量子"><![CDATA[第01集$https://v.demo.com/77-1.m3u8#第02集$https://v.demo.com/77-2.m3u8]]></dd>
<dd flag="备用"><![CDATA[第01集$https://v2.demo.com/77-1.m3u8]]></dd>
</dl></video>
</list></rss>`

async function main(): Promise<void> {
  /* ---------------- 列表：标准 XML ---------------- */
  console.log('\n[1] 采集列表（XML）')
  $reset()
  $mock(`${API}?ac=list&pg=1`, XML_LIST)
  const list = await fetchList('demo.com', { page: 1 })
  check('请求成功', list.ok, list.error)
  check('分类解析', JSON.stringify(list.data?.classes) === JSON.stringify([{ id: '1', name: '电影', pid: '' }, { id: '2', name: '连续剧', pid: '' }]), JSON.stringify(list.data?.classes))
  check('分页解析', list.data?.pageCount === 3 && list.data?.total === 45, `${list.data?.pageCount}/${list.data?.total}`)
  check('封面补全为绝对地址', list.data?.vods[0].pic === 'https://demo.com/up/1.jpg', list.data?.vods[0].pic)
  check('播放地址解析', list.data?.vods[0].playGroups[0].episodes[0].url === 'https://v.demo.com/1.m3u8')

  /* ---------------- 详情：多线路 ---------------- */
  console.log('\n[2] 采集详情（多线路）')
  $reset()
  $mock(`${API}?ac=detail&ids=77`, XML_DETAIL)
  const detail = await fetchDetail(API, '77')
  check('详情请求成功', detail.ok, detail.error)
  check('线路数量为 2', detail.data?.vod?.playGroups.length === 2)
  check('线路名', detail.data?.vod?.playGroups.map((g) => g.name).join(',') === '量子,备用')
  check('第二线路集数', detail.data?.vod?.playGroups[1].episodes.length === 1)
  check('简介去标签', detail.data?.vod?.content === '简介文字')

  /* ---------------- 列表封面批量补全 ---------------- */
  console.log('\n[2b] 列表不带封面时的批量补全')
  // URLSearchParams 会把 ids 里的逗号编码成 %2C，桩的 key 必须保持一致
  const picsUrl = (ids: string[]): string => `${API}?ac=detail&ids=${ids.join('%2C')}`
  const picsXml = (ids: string[]): string =>
    `<?xml version="1.0" encoding="utf-8"?><rss version="5.1"><list page="1" pagecount="1" pagesize="${ids.length}" recordcount="${ids.length}">` +
    ids.map((id) => `<video><id>${id}</id><pic>https://img.demo.com/${id}.jpg</pic></video>`).join('') +
    `</list></rss>`

  $reset()
  $mock(picsUrl(['11', '12']), picsXml(['11', '12']))
  const pics = await fetchPics(API, ['11', '12'])
  check('批量补封面请求成功', pics.ok, pics.error)
  check('封面条数', pics.data?.length === 2, String(pics.data?.length))
  check('封面 id 与顺序保持', pics.data?.map((p) => p.vodId).join(',') === '11,12', pics.data?.map((p) => p.vodId).join(','))
  check('封面地址原样返回', pics.data?.[0].pic === 'https://img.demo.com/11.jpg', pics.data?.[0].pic)

  $reset()
  $mock(picsUrl(['7']), picsXml(['7']))
  const deduped = await fetchPics(API, ['7', ' 7 ', '7', ''])
  check('重复 / 空 id 会被去掉', deduped.ok && deduped.data?.length === 1, String(deduped.data?.length))

  $reset()
  const noIds = await fetchPics(API, [])
  check('没有 id 时短路，不发请求', noIds.ok && noIds.data?.length === 0, JSON.stringify(noIds))

  // 单次请求最多 50 个 id，超出要分块，否则 URL 会被网关拒掉
  const manyIds = Array.from({ length: 51 }, (_, i) => String(100 + i))
  $reset()
  $mock(picsUrl(manyIds.slice(0, 50)), picsXml(manyIds.slice(0, 50)))
  $mock(picsUrl(manyIds.slice(50)), picsXml(manyIds.slice(50)))
  const many = await fetchPics(API, manyIds)
  check('超过单次上限时自动分块（51 → 2 次）', many.ok && many.data?.length === 51, `${many.data?.length}`)

  /* ---------------- 请求地址构造（含中文关键词） ---------------- */
  console.log('\n[3] 关键词搜索的 URL 构造')
  $reset()
  $mock(`${API}?ac=list&pg=1&wd=%E4%B8%89%E4%BD%93`, XML_LIST)
  const search = await fetchList(API, { keyword: '三体', page: 1 })
  check('中文关键词正确编码', search.ok, search.error)

  /* ---------------- JSON 返回 ---------------- */
  console.log('\n[4] 采集列表（JSON 返回）')
  $reset()
  $mock(
    `${API}?ac=list&t=2&pg=2`,
    JSON.stringify({
      code: 1,
      page: 2,
      pagecount: 5,
      total: 100,
      list: [{ vod_id: 9, vod_name: 'JSON 影片', type_id: 2, type_name: '连续剧', vod_play_from: 'ff', vod_play_url: '第1集$https://v.demo.com/9.m3u8' }],
      class: [{ type_id: 2, type_name: '连续剧', type_pid: 0 }]
    })
  )
  const jsonList = await fetchList(API, { typeId: '2', page: 2 })
  check('JSON 解析成功', jsonList.ok && jsonList.data?.vods[0].name === 'JSON 影片', jsonList.error)
  check('JSON 线路解析', jsonList.data?.vods[0].playGroups[0].episodes[0].name === '第1集')

  /* ---------------- 编码探测：GB2312 ---------------- */
  console.log('\n[5] 中文站点常见的 GB2312 编码')
  $reset()
  const head = Buffer.from('<?xml version="1.0" encoding="gb2312"?>\n<rss><list page="1" pagecount="1" pagesize="20" recordcount="1"><video><id>5</id><name>', 'latin1')
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]) // “中文”
  const tail = Buffer.from('</name><type>电影</type></video></list><class><ty id="1">', 'latin1')
  const tail2 = Buffer.from([0xb5, 0xe7, 0xd3, 0xb0]) // “电影”
  const end = Buffer.from('</ty></class></rss>', 'latin1')
  $mock(`${API}?ac=list&pg=1`, Buffer.concat([head, gbk, tail, tail2, end]))

  const gbkList = await fetchList(API, { page: 1 })
  check('GB2312 正确解码', gbkList.data?.vods[0].name === '中文', gbkList.data?.vods[0].name)
  check('GB2312 分类正确解码', gbkList.data?.classes[0].name === '电影', gbkList.data?.classes[0].name)

  /* ---------------- 异常路径 ---------------- */
  console.log('\n[6] 异常路径')
  $reset()
  const offline = await fetchList(API, { page: 1 })
  check('离线时返回可读错误', !offline.ok && offline.error === '域名无法解析，请检查接口地址', offline.error)

  $reset()
  $mock(`${API}?ac=list&pg=1`, '<!DOCTYPE html><html><body>站点已关闭</body></html>')
  const html = await fetchList(API, { page: 1 })
  check('返回网页时给出明确提示', !html.ok && html.error.includes('网页'), html.error)

  $reset()
  $mock(`${API}?ac=list&pg=1`, '')
  const empty = await fetchList(API, { page: 1 })
  check('空响应被识别', !empty.ok && empty.error.includes('空内容'), empty.error)

  $reset()
  const blank = await fetchList('', { page: 1 })
  check('空接口地址被拒绝', !blank.ok, blank.error)

  /* ---------------- EPG ---------------- */
  console.log('\n[7] EPG 下载与解析（.xml.gz）')
  const EPG_URL = 'https://demo.com/epg.xml.gz'
  $reset()
  const plain = `<?xml version="1.0" encoding="UTF-8"?><tv>
<channel id="c1"><display-name>CCTV-1</display-name></channel>
<programme start="${stamp(-30)} +0800" stop="${stamp(30)} +0800" channel="c1"><title>正在播出</title></programme>
<programme start="${stamp(30)} +0800" stop="${stamp(90)} +0800" channel="c1"><title>稍后播出</title></programme>
</tv>`
  const { gzipSync } = await import('zlib')
  $mock(EPG_URL, gzipSync(Buffer.from(plain, 'utf-8')))
  const epg = await fetchEpg(EPG_URL)
  check('gzip 节目单解析成功', epg.ok, epg.error)
  check('节目条数', epg.programmeCount === 2, String(epg.programmeCount))
  check('频道数', epg.channelCount === 1, String(epg.channelCount))
  check('频道显示名', epg.data?.channels['c1'] === 'CCTV-1')

  $reset()
  $mock(EPG_URL, 'not xml at all')
  const badEpg = await fetchEpg(EPG_URL)
  check('非 XMLTV 内容被拒绝', !badEpg.ok && badEpg.error.includes('XMLTV'), badEpg.error)

  $reset()
  const missing = await fetchEpg(EPG_URL)
  check('节目单下载失败有提示', !missing.ok, missing.error)

  /* ---------------- 播放地址解析 ---------------- */
  console.log('\n[8] 播放地址解析（分享页 → 真实 m3u8）')
  clearRefererRegistry()

  // 明确的媒体地址：不该产生任何探测请求
  $reset()
  const direct = await resolveStreamSource('https://demo.com/v/index.m3u8?sign=1')
  check('带 .m3u8 的地址直接放行', direct.ok && direct.from === 'direct' && direct.url.endsWith('index.m3u8?sign=1'))
  check('带 .m3u8 的地址没有发起探测', !$requested().length, $requested().join(','))

  // 分享页：返回 HTML，真正的地址写在脚本里（相对路径）
  const SHARE = 'https://demo.com/share/abc123'
  $reset()
  $mock(
    SHARE,
    '<!doctype html><html><head><title>x</title></head><body><script>' +
      String.raw`var main = "\/vod\/9f8e\/index.m3u8?sign=deadbeef";` +
      '</script></body></html>',
    200,
    { 'content-type': 'text/html; charset=utf-8' }
  )
  const viaPage = await resolveStreamSource(SHARE)
  check('分享页解析成功', viaPage.ok, viaPage.error)
  check('解析结果按页面地址补成绝对地址', viaPage.url === 'https://demo.com/vod/9f8e/index.m3u8?sign=deadbeef', viaPage.url)
  check('标记来源为 page', viaPage.from === 'page', viaPage.from)
  check(
    '同源请求已登记 Referer',
    refererFor('https://demo.com/vod/9f8e/index.m3u8?sign=deadbeef') === SHARE,
    refererFor('https://demo.com/vod/9f8e/index.m3u8?sign=deadbeef')
  )
  check('未登记的 origin 不补 Referer', refererFor('https://other.com/x.ts') === '')

  // 无扩展名但本身就是播放列表（IPTV 常见）：原样放行，不要误判成网页
  const LIVE = 'https://demo.com/live/10086'
  $reset()
  $mock(LIVE, '#EXTM3U\n#EXTINF:-1,CCTV-1\nhttps://demo.com/a.ts\n', 200, {
    'content-type': 'application/vnd.apple.mpegurl'
  })
  const live = await resolveStreamSource(LIVE)
  check('无扩展名的直播地址原样放行', live.ok && live.from === 'direct' && live.url === LIVE, live.url)

  // 页面里找不到地址：要给出可读错误，而不是静默失败
  const EMPTY = 'https://demo.com/share/empty'
  $reset()
  $mock(EMPTY, '<html><body>nothing</body></html>', 200, { 'content-type': 'text/html' })
  const noAddress = await resolveStreamSource(EMPTY)
  check('页面里找不到地址时明确报错', !noAddress.ok && noAddress.error.includes('没有找到'), noAddress.error)

  // 探测本身失败（断网 / 404）：不能阻断播放，按原地址继续
  $reset()
  const unreachable = await resolveStreamSource('https://demo.com/share/offline')
  check(
    '探测失败时回退为原地址（不阻断播放）',
    unreachable.ok && unreachable.from === 'direct' && unreachable.url === 'https://demo.com/share/offline',
    JSON.stringify(unreachable)
  )

  // 非法输入
  const bogus = await resolveStreamSource('not-a-url')
  check('非 http 地址被拒绝', !bogus.ok, bogus.error)

  console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项\n`)
  if (failed > 0) process.exit(1)
}

/** 生成与 `+0800` 时区匹配的 XMLTV 时间串（东八区墙钟时间） */
function stamp(offsetMinutes: number, tzHours = 8): string {
  const date = new Date(Date.now() + offsetMinutes * 60 * 1000 + tzHours * 3600 * 1000)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}00`
}

void main()
