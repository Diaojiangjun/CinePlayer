/**
 * 采集 / IPTV / EPG 解析逻辑的离线验证。
 * 运行：node scripts/run-verify.mjs
 */
import { groupStats, parseM3U } from '../src/shared/iptv'
import {
  buildApiUrl,
  normalizeApiUrl,
  resolveImageUrl,
  splitPlayGroups
} from '../src/shared/maccms'
import { cleanHtml, parseMacPayload, parseMacPics } from '../src/shared/maccms-parse'
import { currentProgramme, matchEpgChannel, parseXmltv, parseXmltvTime } from '../src/shared/xmltv'
import { createRateMeter, formatSpeed } from '../src/renderer/src/utils/rate'
import {
  classifyProbe,
  extractStreamUrl,
  mightBeSharePage
} from '../src/shared/stream-resolve'
import {
  basenameWithoutExt,
  cuesToVtt,
  detectSubtitleFormat,
  extensionOf,
  formatCueTime,
  normalizeCueText,
  parseSubtitle,
  parseTimestamp,
  pickSidecarSubtitles
} from '../src/shared/subtitle'
import {
  emptyProfile,
  formatSkipPoint,
  normalizeSkipWindow,
  skipAction,
  withSkipPoint
} from '../src/shared/skip'
import type { SkipProfile } from '../src/shared/skip'
import {
  hasNewEpisodes,
  localSeriesKey,
  parseEpisodeCount,
  parseVodSeriesKey,
  vodSeriesKey
} from '../src/shared/series'

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

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`)
}

/* ---------------- 1. 接口地址归一化 ---------------- */
console.log('\n[1] 苹果CMS 接口地址归一化')
eq('裸域名', normalizeApiUrl('example.com'), 'https://example.com/api.php/provide/vod/')
eq('带协议无路径', normalizeApiUrl('https://a.com/'), 'https://a.com/api.php/provide/vod/')
eq('已含 api.php', normalizeApiUrl('http://a.com/api.php/provide/vod'), 'http://a.com/api.php/provide/vod/')
eq('粘贴列表地址', normalizeApiUrl('https://a.com/api.php/provide/vod/?ac=list&pg=3'), 'https://a.com/api.php/provide/vod/')
eq('空值', normalizeApiUrl('  '), '')
eq(
  '构造查询串',
  buildApiUrl('a.com', { ac: 'list', typeId: '6', page: 2, keyword: '三体' }),
  'https://a.com/api.php/provide/vod/?ac=list&t=6&pg=2&wd=%E4%B8%89%E4%BD%93'
)
eq('封面相对协议', resolveImageUrl('//img.a.com/x.jpg', 'https://a.com/api.php/provide/vod/'), 'https://img.a.com/x.jpg')
eq('封面相对路径', resolveImageUrl('/up/1.jpg', 'https://a.com/api.php/provide/vod/'), 'https://a.com/up/1.jpg')

/* ---------------- 2. 播放地址分组 ---------------- */
console.log('\n[2] 播放地址分组（$$$ 线路 / # 集 / $ 名称）')
const groups = splitPlayGroups(
  '量子$$$非凡',
  '第1集$https://a.com/1.m3u8#第2集$https://a.com/2.m3u8$$$第1集$https://b.com/1.m3u8'
)
eq('线路数量', groups.length, 2)
eq('线路名', groups.map((g) => g.name), ['量子', '非凡'])
eq('第一线路集数', groups[0].episodes.length, 2)
eq('第一线路第一集', groups[0].episodes[0], { name: '第1集', url: 'https://a.com/1.m3u8' })

const swapped = splitPlayGroups('', 'https://a.com/only.m3u8')
eq('无线路名时兜底', swapped[0].name, '线路1')
eq('无集名时用地址', swapped[0].episodes[0].name, 'https://a.com/only.m3u8')

const reversed = splitPlayGroups('', 'https://a.com/x.m3u8$第3集')
eq('地址在前也能识别', reversed[0].episodes[0], { name: '第3集', url: 'https://a.com/x.m3u8' })

const dirty = splitPlayGroups('', '第1集$https://a.com/1.m3u8##没有地址的集')
eq('脏数据被跳过', dirty[0].episodes.length, 1)

/* ---------------- 3. 标准 MacCMS XML 报文 ---------------- */
console.log('\n[3] 苹果CMS 标准 XML 报文解析')
const XML_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1">
<list page="1" pagecount="52" pagesize="20" recordcount="1032">
<video>
<last>2026-09-30 18:00:00</last>
<id>8812</id>
<tid>6</tid>
<name><![CDATA[示例剧集 &amp; 特别篇]]></name>
<type>国产剧</type>
<pic>//img.a.com/8812.jpg</pic>
<lang>国语</lang>
<area>中国</area>
<year>2026</year>
<state>0</state>
<note><![CDATA[更新至12集]]></note>
<actor><![CDATA[张三,李四]]></actor>
<director><![CDATA[王五]]></director>
<dl>
<dd flag="量子"><![CDATA[第01集$https://v.a.com/1.m3u8#第02集$https://v.a.com/2.m3u8]]></dd>
<dd flag="非凡"><![CDATA[第01集$https://v.b.com/1.m3u8]]></dd>
</dl>
<des><![CDATA[<p>剧情简介&nbsp;第一段</p><p>第二段</p>]]></des>
</video>
<video>
<id>8813</id>
<name>另一部影片</name>
<type>电影</type>
<pic>https://img.a.com/8813.jpg</pic>
<note>HD</note>
</video>
</list>
<class>
<ty id="1">电影</ty>
<ty id="6">国产剧</ty>
<ty id="7">综艺</ty>
</class>
</rss>`

const xmlPayload = parseMacPayload(XML_SAMPLE, 'https://a.com/api.php/provide/vod/')
eq('分页信息', [xmlPayload.page.page, xmlPayload.page.pageCount, xmlPayload.page.total], [1, 52, 1032])
eq('影片数量', xmlPayload.vods.length, 2)
eq('分类数量', xmlPayload.classes.length, 3)
eq('分类解析', xmlPayload.classes[1], { id: '6', name: '国产剧', pid: '' })

const vod = xmlPayload.vods[0]
eq('vod id / name（含实体解码）', [vod.vodId, vod.name], ['8812', '示例剧集 & 特别篇'])
eq('封面补全协议', vod.pic, 'https://img.a.com/8812.jpg')
eq('线路数量', vod.playGroups.length, 2)
eq('线路名', vod.playGroups.map((g) => g.name), ['量子', '非凡'])
eq('线路1 集数', vod.playGroups[0].episodes.length, 2)
eq('线路2 集数', vod.playGroups[1].episodes.length, 1)
eq('简介去标签', vod.content, '剧情简介 第一段\n第二段')
eq('无播放地址的影片也能解析', xmlPayload.vods[1].playGroups.length, 0)

/* ---------------- 4. JSON 报文 ---------------- */
console.log('\n[4] 苹果CMS JSON 报文解析')
const JSON_SAMPLE = JSON.stringify({
  code: 1,
  msg: '数据列表',
  page: 2,
  pagecount: 8,
  limit: '20',
  total: 152,
  list: [
    {
      vod_id: 501,
      vod_name: '示例电影',
      type_id: 1,
      type_name: '动作片',
      vod_pic: '/upload/501.jpg',
      vod_remarks: 'HD国语',
      vod_year: '2025',
      vod_area: '中国香港',
      vod_lang: '国语',
      vod_actor: '演员甲,演员乙',
      vod_director: '导演丙',
      vod_score: '7.8',
      vod_total: 0,
      vod_play_from: '量子$$$非凡',
      vod_play_url:
        'HD$https://v.a.com/501.m3u8$$$HD$https://v.b.com/501.m3u8',
      vod_content: '&lt;p&gt;简介内容&lt;/p&gt;'
    }
  ],
  class: [{ type_id: 1, type_name: '动作片', type_pid: 0 }]
})

const jsonPayload = parseMacPayload(JSON_SAMPLE, 'https://a.com/api.php/provide/vod/')
eq('JSON 分页', [jsonPayload.page.page, jsonPayload.page.pageCount, jsonPayload.page.total], [2, 8, 152])
eq('JSON 分类', jsonPayload.classes[0].name, '动作片')
const jvod = jsonPayload.vods[0]
eq('JSON 片名', jvod.name, '示例电影')
eq('JSON 封面补全', jvod.pic, 'https://a.com/upload/501.jpg')
eq('JSON 线路', jvod.playGroups.map((g) => g.name), ['量子', '非凡'])
eq('JSON 第一集', jvod.playGroups[0].episodes[0], { name: 'HD', url: 'https://v.a.com/501.m3u8' })
eq('JSON 简介去实体与标签', jvod.content, '简介内容')
eq('cleanHtml 处理换行', cleanHtml('a<br/>b<p>c</p>'), 'a\nb\nc')

/* ---------------- 4b. 封面补全（列表接口不带 pic） ---------------- */
console.log('\n[4b] 列表接口不带封面时的批量补全')
// 真实站点的 ac=list 只有 id/名称/分类，封面要靠 ac=detail&ids= 补
const LIST_NO_PIC = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1"><list page="1" pagecount="1" pagesize="2" recordcount="2">
<video><id>11</id><tid>1</tid><name><![CDATA[没有封面的影片]]></name><type>动作片</type><note>HD</note></video>
<video><id>12</id><tid>1</tid><name><![CDATA[另一部]]></name><type>动作片</type></video>
</list><class><ty id="1">动作片</ty></class></rss>`

const listNoPic = parseMacPayload(LIST_NO_PIC, 'https://a.com/api.php/provide/vod/')
eq('列表接口确实没有封面', listNoPic.vods.map((v) => v.pic), ['', ''])

const PICS_XML = `<?xml version="1.0" encoding="utf-8"?>
<rss version="5.1"><list page="1" pagecount="1" pagesize="3" recordcount="3">
<video><id>11</id><name><![CDATA[没有封面的影片]]></name><pic>/upload/11.jpg</pic></video>
<video><id>12</id><name><![CDATA[另一部]]></name><pic>//img.cdn.com/12.webp</pic></video>
<video><id>13</id><name><![CDATA[图床挂了]]></name><pic></pic></video>
</list></rss>`

const picsXml = parseMacPics(PICS_XML, 'https://a.com/api.php/provide/vod/')
eq('XML 抽取 id 与封面', picsXml, [
  { vodId: '11', pic: 'https://a.com/upload/11.jpg' },
  { vodId: '12', pic: 'https://img.cdn.com/12.webp' }
])

const picsJson = parseMacPics(
  JSON.stringify({
    code: 1,
    list: [
      { vod_id: 21, vod_name: '甲', vod_pic: 'https://img.cdn.com/21.jpg' },
      { vod_id: 22, vod_name: '乙', vod_pic: '' },
      { vod_id: 23, vod_name: '丙' }
    ]
  }),
  'https://a.com/api.php/provide/vod/'
)
eq('JSON 抽取 id 与封面（丢掉空封面）', picsJson, [
  { vodId: '21', pic: 'https://img.cdn.com/21.jpg' }
])

// 补封面只取两个字段：报文里播放地址再长也不参与拆分
const HUGE = `<?xml version="1.0" encoding="utf-8"?><rss><list page="1" pagecount="1" pagesize="1" recordcount="1">
<video><id>31</id><pic>https://img.cdn.com/31.jpg</pic>
<dl><dd flag="线路">${Array.from({ length: 2000 }, (_, i) => `第${i + 1}集$https://v.cdn.com/31-${i + 1}.m3u8`).join('#')}</dd></dl>
</video></list></rss>`
const hugePics = parseMacPics(HUGE, 'https://a.com/api.php/provide/vod/')
eq('超长播放列表不影响封面抽取', hugePics, [{ vodId: '31', pic: 'https://img.cdn.com/31.jpg' }])

let picsThrew = false
try {
  parseMacPics('   ', 'https://a.com/api.php/provide/vod/')
} catch {
  picsThrew = true
}
check('空响应会被拒绝', picsThrew)

/* ---------------- 5. M3U / IPTV ---------------- */
console.log('\n[5] IPTV M3U 解析')
const M3U_SAMPLE = `#EXTM3U x-tvg-url="http://epg.example.com/e.xml.gz"
#EXTINF:-1 tvg-id="cctv1" tvg-name="CCTV-1" tvg-logo="http://logo/c1.png" group-title="央视",CCTV-1 综合
http://iptv.example.com/cctv1.m3u8
#EXTINF:-1 tvg-id="cctv2" group-title="央视",CCTV-2 财经
http://iptv.example.com/cctv2.m3u8
#EXTGRP:卫视
#EXTINF:-1 tvg-id="hunan",湖南卫视
http://iptv.example.com/hunan.m3u8
#EXTVLCOPT:network-caching=1000
#EXTINF:-1,无属性频道
rtmp://iptv.example.com/live/stream
`
const channels = parseM3U(M3U_SAMPLE)
eq('频道数量', channels.length, 4)
eq('频道1 名称', channels[0].name, 'CCTV-1 综合')
eq('频道1 tvg-id / 分组', [channels[0].tvgId, channels[0].group], ['cctv1', '央视'])
eq('频道1 logo', channels[0].logo, 'http://logo/c1.png')
eq('#EXTGRP 影响后续频道', channels[2].group, '卫视')
check('无 tvg 属性仍可解析', channels[3].url === 'rtmp://iptv.example.com/live/stream')
eq('#EXTGRP 持续生效', channels[3].group, '卫视')

const stats = groupStats(channels)
// 分组按拼音排序：卫视(w) 在 央视(y) 之前
eq('分组统计（按拼音排序）', stats, [
  { name: '卫视', count: 2 },
  { name: '央视', count: 2 }
])

/* ---------------- 6. XMLTV / EPG ---------------- */
console.log('\n[6] XMLTV 电子节目单解析')
const now = Date.UTC(2026, 9, 1, 11, 30, 0) // 2026-10-01 11:30 UTC == 19:30 +08:00
const XMLTV_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test">
<channel id="cctv1"><display-name lang="zh">CCTV-1 综合</display-name></channel>
<channel id="hunan"><display-name>湖南卫视</display-name></channel>
<programme start="20260930120000 +0800" stop="20261001010000 +0800" channel="cctv1">
<title>昨天的节目（应被窗口丢弃）</title>
</programme>
<programme start="20261001190000 +0800" stop="20261001200000 +0800" channel="cctv1">
<title lang="zh">新闻联播 &amp; 天气预报</title>
<desc>正在播出的节目</desc>
<category>新闻</category>
</programme>
<programme start="20261001200000 +0800" stop="20261001210000 +0800" channel="cctv1">
<title>焦点访谈</title>
<desc><![CDATA[下一档 <重点> 节目]]></desc>
</programme>
<programme start="20261001193000 +0800" stop="20261001203000 +0800" channel="hunan">
<title>快乐大本营</title>
</programme>
</tv>`

eq('XMLTV 时间解析（带时区）', parseXmltvTime('20261001190000 +0800'), Date.UTC(2026, 9, 1, 11, 0, 0))

const epg = parseXmltv(XMLTV_SAMPLE, now)
eq('频道表', Object.keys(epg.channels).sort(), ['cctv1', 'hunan'])
eq('cctv1 显示名', epg.channels['cctv1'], 'CCTV-1 综合')
eq('过期节目被丢弃', epg.programmes['cctv1'].length, 2)
eq('节目按时间升序', epg.programmes['cctv1'].map((p) => p.title), ['新闻联播 & 天气预报', '焦点访谈'])
eq('CDATA 描述保留尖括号', epg.programmes['cctv1'][1].desc, '下一档 <重点> 节目')
eq('分类解析', epg.programmes['cctv1'][0].category, '新闻')

const nowPlaying = currentProgramme(epg.programmes['cctv1'], now)
eq('当前节目', nowPlaying?.title, '新闻联播 & 天气预报')
eq('EPG 频道匹配 tvg-id', matchEpgChannel(epg, { tvgId: 'cctv1' }), 'cctv1')
eq('EPG 频道匹配显示名', matchEpgChannel(epg, { tvgName: 'CCTV-1 综合' }), 'cctv1')
eq('EPG 无匹配', matchEpgChannel(epg, { tvgId: 'not-exist', name: '某地方台' }), '')

/* ---------------- 7. 网络速率计量（播放器加载反馈） ---------------- */
console.log('\n[7] 网络速率计量')
/** 忙等若干毫秒，用来让 performance.now() 真的往前走 */
function spin(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    /* busy wait */
  }
}

const meterFlat = createRateMeter({ alpha: 1, staleMs: 10_000 })
meterFlat.push(10_000, 100)
check('采样后能读到速率（10KB/100ms = 100KB/s）', Math.round(meterFlat.read()) === 100_000, `${Math.round(meterFlat.read())}`)

const meterSmooth = createRateMeter({ alpha: 0.5, staleMs: 10_000 })
meterSmooth.push(1000, 100) // 10_000 B/s
meterSmooth.push(3000, 100) // 30_000 B/s → EMA = 20_000
check('EMA 压平抖动', Math.round(meterSmooth.read()) === 20_000, `${Math.round(meterSmooth.read())}`)

const meterDecay = createRateMeter({ alpha: 1, staleMs: 30 })
meterDecay.push(10_000, 100)
check('刚采样完读数非零', meterDecay.read() > 0, `${Math.round(meterDecay.read())}`)
spin(200)
check('停流后读数衰减到 0（不留僵尸速度）', meterDecay.read() === 0, `${Math.round(meterDecay.read())}`)

const meterReset = createRateMeter({ alpha: 1 })
meterReset.push(10_000, 100)
meterReset.reset()
check('reset 后归零', meterReset.read() === 0, `${meterReset.read()}`)

const meterGuard = createRateMeter()
meterGuard.push(0, 100)
meterGuard.push(100, 0)
meterGuard.push(Number.NaN, 100)
meterGuard.push(100, Number.NaN)
check('非法采样被忽略（0 / NaN 不产生读数）', meterGuard.read() === 0, `${meterGuard.read()}`)

eq('速度 0 不显示', formatSpeed(0), '')
eq('负速度不显示', formatSpeed(-1024), '')
eq('B/s 量级', formatSpeed(512), '512 B/s')
eq('KB/s 量级', formatSpeed(2048), '2.0 KB/s')
eq('MB/s 量级', formatSpeed(1.5 * 1024 * 1024), '1.5 MB/s')
eq('大数值不带小数', formatSpeed(120 * 1024 * 1024), '120 MB/s')

/* ---------------- 8. 分享页播放地址解析 ---------------- */

/**
 * 从某「分享页」站点抓取的真实 HTML 结构（域名、id 与路径均已脱敏替换，
 * 结构、变量名与 `\/` 的转义形式保持原样）。
 *
 * 用 `String.raw` 是刻意的：页面里的相对路径是 JSON 转义过的 `\/`，
 * 普通模板字符串会把 `\/` 直接吃成 `/`，那样就测不到「去转义」这一步了。
 * 紧接着有一条断言专门盯住这个转义还在。
 */
const SHARE_PAGE_HTML = String.raw`<!doctype html>
<html>

<head>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
    <meta http-equiv="X-UA-Compatible" content="IE=edge,Chrome=1" />
    <meta http-equiv="X-UA-Compatible" content="IE=9" />
    <title>分享页示例</title>
</head>
<link rel="stylesheet" type="text/css" href="/css/share.css">

<body onload="init()">

<div class="gaog" id="gaog">
    <div class="gaog-var">
    </div>
</div>

<div id="a1"></div>

<div style="display:none" name="playtime" value="1440"></div>
<div style="display:none" name="sizeview" value="393764254"></div>
<script type="text/javascript" src="/js/jquery-1.11.2.min.js" charset="utf-8"></script>
<script type="text/javascript" src="/js/ckplayerx/ckplayer.js" charset="utf-8"></script>
<link rel="stylesheet" href="/js/DPlayer/DPlayer.min.css">

<script src="/js/DPlayer/DPlayer.min.js"></script>
<script src="/js/hls.min.js?_t=250702121212"></script>
<script src="/js/artplayer.js"></script>
<script type="text/javascript">
    var video_player= 'artplayer'
    var tracker_url = ''
    var signaler_url = ''
    var auto_play = ''
    var hosts = '';
    var redirecturl = "http://ad.example.com";
    var videoid = "abc123def456";

    var id = 'abc123def456'
    var     l = ''
    var     r= ''
    var     t= '15'
    var     d= ''
    var     u= ''

    var main = "\/20260101\/12345_abcdef01\/index.m3u8?sign=0123456789abcdef";
    var xml = "\/20260101\/12345_abcdef01\/index.xml?sign=0123456789abcdef";
    var pic = "\/20260101\/12345_abcdef01\/1.jpg";
    var thumbnails = "\/uploads\/videos\/20260101\/12345_abcdef01\/original.mp4\/thumbnails.jpg";
</script>
<script type="text/javascript" src="/js/share.js" charset="utf-8"></script>


</body>

</html>`

const SHARE_PAGE_URL = 'https://share.example.com/share/abc123def456'

console.log('\n[8] 分享页播放地址解析')

// —— 判定「值不值得去探测」：只有可能产生歧义的地址才付出一次网络往返
check('带 .m3u8 的直链不必探测', mightBeSharePage('https://a.com/v/index.m3u8?sign=1') === false)
check('带 .mp4 的直链不必探测', mightBeSharePage('https://a.com/v/a.mp4') === false)
check('带 .ts 的分片不必探测', mightBeSharePage('https://a.com/v/seg-1.ts') === false)
check('分享页路径需要探测', mightBeSharePage(SHARE_PAGE_URL) === true)
check('无扩展名的直播地址要探测一次', mightBeSharePage('https://a.com/live/10086') === true)
check('本地文件不探测', mightBeSharePage('D:/videos/a.mkv') === false)
check('非 http 协议不探测', mightBeSharePage('cine-file://local/abc') === false)

console.log('')

// —— 真实分享页
check('夹具保留了真实页面的 \\/ 转义（否则等于没测）', SHARE_PAGE_HTML.includes(String.raw`\/20260101\/`))

eq(
  '从 var main 取出相对路径，并按页面地址补成绝对地址',
  extractStreamUrl(SHARE_PAGE_HTML, SHARE_PAGE_URL),
  'https://share.example.com/20260101/12345_abcdef01/index.m3u8?sign=0123456789abcdef'
)

check(
  '不会被 redirecturl 的广告地址骗走',
  extractStreamUrl(SHARE_PAGE_HTML, SHARE_PAGE_URL)?.includes('/20260101/') === true,
  `实际=${extractStreamUrl(SHARE_PAGE_HTML, SHARE_PAGE_URL)}`
)

check(
  '不会选中同页的 jpg / js / css 静态资源',
  extractStreamUrl(SHARE_PAGE_HTML, SHARE_PAGE_URL)?.endsWith('.m3u8?sign=0123456789abcdef') === true
)

console.log('')

// —— 相对路径解析：必须按页面地址（而不是站点根）算
eq(
  '子目录页面里的 ../ 相对路径',
  extractStreamUrl('<script>var main = "../video/a.m3u8"</script>', 'https://a.com/share/1/2'),
  'https://a.com/share/video/a.m3u8'
)
eq(
  '站点根路径 /live/a.m3u8',
  extractStreamUrl('<script>var url="/live/a.m3u8"</script>', 'https://a.com/x/y'),
  'https://a.com/live/a.m3u8'
)
eq(
  '协议相对地址 //cdn.a.com/v/a.m3u8',
  extractStreamUrl('<script>setSrc("//cdn.a.com/v/a.m3u8")</script>', 'https://a.com/p'),
  'https://cdn.a.com/v/a.m3u8'
)
eq(
  'HTML 实体 &amp; 会被还原',
  extractStreamUrl('<div data-x="https://a.com/v/a.m3u8?x=1&amp;y=2"></div>', 'https://a.com/p'),
  'https://a.com/v/a.m3u8?x=1&y=2'
)

console.log('')

// —— 兜底与拒绝
eq(
  '变量名不认识时靠全文扫描兜底',
  extractStreamUrl('<div data-play="https://cdn.a.com/v/9f8e.m3u8?t=1"></div>', 'https://a.com/p'),
  'https://cdn.a.com/v/9f8e.m3u8?t=1'
)
eq(
  '可信变量里的无扩展名真实流可用',
  extractStreamUrl('<script>var main="https://cdn.a.com/live/8f3a91"</script>', 'https://a.com/p'),
  'https://cdn.a.com/live/8f3a91'
)
eq(
  '只有 js / css 时宁可返回 null，也不硬凑一个地址',
  extractStreamUrl('<script src="/js/share.js"></script><link href="/css/share.css">', 'https://a.com/p'),
  null
)
eq(
  'RTMP 候选被跳过，选后面的 http 地址',
  extractStreamUrl(
    '<script>var main="rtmp://a.com/live/x"; var url="https://a.com/v/a.m3u8"</script>',
    'https://a.com/p'
  ),
  'https://a.com/v/a.m3u8'
)
eq('完全找不到地址', extractStreamUrl('<html><body>no video here</body></html>', 'https://a.com/p'), null)
eq('空文档', extractStreamUrl('', 'https://a.com/p'), null)

console.log('')

// —— 探测结果归类：决定「这是网页还是播放列表」
eq('识别播放列表', classifyProbe('#EXTM3U\n#EXT-X-VERSION:3', 'application/vnd.apple.mpegurl'), 'playlist')
eq('靠响应头识别网页', classifyProbe('<html></html>', 'text/html; charset=utf-8'), 'html')
eq('响应头缺失时看正文 <!doctype>', classifyProbe('<!DOCTYPE html>\n<html>', ''), 'html')
eq('响应头缺失时看正文 <html>', classifyProbe('  <html lang="zh">', ''), 'html')
eq('m3u8 被误标成 text/plain 也认得出', classifyProbe('#EXTM3U', 'text/plain'), 'playlist')
eq('二进制分片归为 other', classifyProbe('\u0000\u0001binary', 'video/mp2t'), 'other')

/* ---------------- 9. 外挂字幕解析 ---------------- */
console.log('\n[9] 外挂字幕解析（SRT / ASS / WebVTT）')

eq('识别 WebVTT 头', detectSubtitleFormat('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n嗨', ''), 'vtt')
eq('识别 ASS 段头', detectSubtitleFormat('[Script Info]\nTitle: x', ''), 'ass')
eq('只有 Dialogue 行也认得出 ASS', detectSubtitleFormat('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,嗨', ''), 'ass')
eq('逗号毫秒 → SRT', detectSubtitleFormat('1\n00:00:01,000 --> 00:00:02,000\n嗨', ''), 'srt')
eq('点号毫秒 → WebVTT', detectSubtitleFormat('00:00:01.000 --> 00:00:02.000\n嗨', ''), 'vtt')
eq('内容认不出时退回扩展名', detectSubtitleFormat('???', 'movie.ass'), 'ass')
eq('完全认不出', detectSubtitleFormat('随便写点什么', 'a.txt'), 'unknown')

eq('SRT 时间戳（逗号）', parseTimestamp('00:00:01,500'), 1.5)
eq('VTT 时间戳（点号）', parseTimestamp('00:01:02.345'), 62.345)
eq('ASS 时间戳（时不补零、百分秒）', parseTimestamp('0:00:02.34'), 2.34)
eq('省略小时的 VTT 时间戳', parseTimestamp('01:02.345'), 62.345)
eq('垃圾时间戳返回 NaN', Number.isNaN(parseTimestamp('nope')), true)

eq('格式化整秒', formatCueTime(0), '00:00:00.000')
eq('格式化带毫秒', formatCueTime(62.345), '00:01:02.345')
eq('格式化超一小时', formatCueTime(3661.5), '01:01:01.500')

eq('剥离 ASS 覆盖指令', normalizeCueText('{\\an8}{\\pos(10,20)}你好'), '你好')
eq('ASS 的 \\N 变成换行', normalizeCueText('上\\N下'), '上\n下')
eq('剥掉 font 标签但保留文字', normalizeCueText('<font color="#fff">白字</font>'), '白字')
eq('<br> 变成换行', normalizeCueText('一<br>二'), '一\n二')
eq('尖括号转义成实体（WebVTT 才不会被当成标签）', normalizeCueText('1 < 2'), '1 &lt; 2')

const SRT_FIXTURE = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  '第一句台词',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,000',
  '<i>第二句</i>',
  '换行也在',
  '',
  '3',
  '00:00:07,000 --> 00:00:09,000',
  '第三句',
  ''
].join('\n')

const srtCues = parseSubtitle(SRT_FIXTURE, 'a.srt')
eq('SRT 条数', srtCues.length, 3)
eq('SRT 首条起点', srtCues[0].start, 1)
eq('SRT 首条终点', srtCues[0].end, 3.5)
eq('SRT 首条文本（序号行没有混进来）', srtCues[0].text, '第一句台词')
eq('SRT 多行提示保留换行', srtCues[1].text, '第二句\n换行也在')
eq('SRT 标签被剥掉', srtCues[1].text.includes('<i>'), false)
eq('SRT 末条终点', srtCues[2].end, 9)

const ASS_FIXTURE = [
  '[Script Info]',
  'Title: 测试',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize',
  'Style: Default,Arial,20',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\pos(190,270)}第一句',
  'Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,上\\N下',
  'Dialogue: 0,0:00:07.00,0:00:09.00,Default,,0,0,0,,带,逗号的台词',
  ''
].join('\n')

const assCues = parseSubtitle(ASS_FIXTURE, 'a.ass')
eq('ASS 只取 Dialogue 行（Style 行不算）', assCues.length, 3)
eq('ASS 起点', assCues[0].start, 1)
eq('ASS 终点', assCues[0].end, 3.5)
eq('ASS 覆盖指令被剥掉', assCues[0].text, '第一句')
eq('ASS 的 \\N 转成换行', assCues[1].text, '上\n下')
eq('ASS 文本里的逗号不会被字段切分吃掉', assCues[2].text, '带,逗号的台词')

// 老式 SSA 的字段名与顺序跟 v4+ 不一样（首字段是 Marked 而不是 Layer），
// 必须按 Format 声明**字段名**定位，不能按位置猜。
const ASS_REORDERED = [
  '[Events]',
  'Format: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: Marked=0,0:00:02.00,0:00:04.00,Default,,0,0,0,,老式 SSA 也能读,带逗号',
  ''
].join('\n')
const reordered = parseSubtitle(ASS_REORDERED, 'b.ass')
eq('SSA 按 Format 字段名定位文本', reordered[0]?.text, '老式 SSA 也能读,带逗号')
eq('SSA 按 Format 字段名定位起点', reordered[0]?.start, 2)
eq('SSA 按 Format 字段名定位终点', reordered[0]?.end, 4)

const VTT_FIXTURE = [
  'WEBVTT',
  '',
  'NOTE 这是注释，不该变成字幕',
  '',
  'cue-1',
  '00:00:01.000 --> 00:00:03.500 align:middle line:90%',
  '第一句',
  '',
  '00:01:02.000 --> 00:01:04.000',
  '<v 说话人>第二句</v>',
  ''
].join('\n')

const vttCues = parseSubtitle(VTT_FIXTURE, 'a.vtt')
eq('VTT 条数（NOTE 与 WEBVTT 头都不算）', vttCues.length, 2)
eq('VTT 起点', vttCues[0].start, 1)
eq('VTT 时间轴后的定位参数不影响解析', vttCues[0].end, 3.5)
eq('VTT 省略小时的时间戳', vttCues[1].start, 62)
eq('VTT 的 <v> 标签被剥掉', vttCues[1].text, '第二句')

eq('乱序输入会按时间排好', parseSubtitle('00:00:09.000 --> 00:00:10.000\n后\n\n00:00:01.000 --> 00:00:02.000\n前', 'x.vtt')[0].text, '前')
eq('空内容返回空数组', parseSubtitle('', 'a.srt').length, 0)
eq('认不出格式返回空数组', parseSubtitle('乱七八糟', 'a.xyz').length, 0)
eq('时间戳坏掉的条目被丢弃', parseSubtitle('00:00:01,000 --> 坏\n丢我', 'a.srt').length, 0)
eq('只有时间轴没有文字的条目被丢弃', parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\n   ', 'a.srt').length, 0)

const rewrapped = parseSubtitle(cuesToVtt(srtCues), 'round.vtt')
eq('cuesToVtt 产出的 VTT 能被自己重新读回', rewrapped.length, 3)
eq('回读后时间轴一致', rewrapped[1].start, 4)
eq('回读后文本一致', rewrapped[1].text, srtCues[1].text)

eq('取不带扩展名的文件名', basenameWithoutExt('D:\\剧\\第01集.mkv'), '第01集')
eq('取小写扩展名', extensionOf('D:/a/B.MP4'), 'mp4')
eq('没有扩展名', extensionOf('D:/a/README'), '')

const sidecars = pickSidecarSubtitles('D:/剧/第01集.mkv', [
  { path: 'D:/剧/无关的字幕.srt' },
  { path: 'D:/剧/第01集.chs.ass' },
  { path: 'D:/剧/第01集.srt' },
  { path: 'D:/剧/第02集.srt' }
])
eq('完全同名的字幕排第一', sidecars[0].path, 'D:/剧/第01集.srt')
eq('同名前缀的字幕也算精确匹配', sidecars[1].exact, true)
eq('不相干的字幕排在最后且不自动挂载', sidecars[sidecars.length - 1].exact, false)

/* ---------------- 10. 跳过片头片尾 ---------------- */
console.log('\n[10] 跳过片头片尾')
const skipProfile = (patch: Partial<SkipProfile>): SkipProfile => ({ ...emptyProfile('k'), ...patch })

eq(
  '空配置两个点都是未设置、开关默认关',
  [emptyProfile('k').introEnd, emptyProfile('k').outroStart, emptyProfile('k').autoIntro, emptyProfile('k').autoOutro],
  [0, 0, false, false]
)

// skipAction 是「电平」判定：只要位置还落在片头区间里就会持续返回 intro
eq('片头区间内触发', skipAction(skipProfile({ introEnd: 90 }), { time: 12, canSkipOutro: false }), 'intro')
eq(
  '跳到片头结束点之后不再触发（否则按钮原地复活，看起来像点了没反应）',
  skipAction(skipProfile({ introEnd: 90 }), { time: 90, canSkipOutro: false }),
  ''
)
eq(
  '容差内也算越过了，不去追赶那零点几秒',
  skipAction(skipProfile({ introEnd: 90 }), { time: 89.8, canSkipOutro: false }),
  ''
)
eq('进入正片后不再触发', skipAction(skipProfile({ introEnd: 90 }), { time: 300, canSkipOutro: false }), '')
eq('没设片头就不触发', skipAction(skipProfile({}), { time: 5, canSkipOutro: true }), '')
eq('没有配置时一律不触发', skipAction(null, { time: 5, canSkipOutro: true }), '')
eq('播放位置是 NaN 时按 0 处理，仍然会跳片头', skipAction(skipProfile({ introEnd: 90 }), { time: Number.NaN, canSkipOutro: false }), 'intro')

eq(
  '到达片尾点触发片尾',
  skipAction(skipProfile({ introEnd: 90, outroStart: 1200 }), { time: 1200, canSkipOutro: true }),
  'outro'
)
eq(
  '没有下一集时片尾不出手（跳过去也无处可去）',
  skipAction(skipProfile({ introEnd: 90, outroStart: 1200 }), { time: 1300, canSkipOutro: false }),
  ''
)
eq(
  '片头判定优先于片尾',
  skipAction(skipProfile({ introEnd: 100, outroStart: 60 }), { time: 30, canSkipOutro: true }),
  'intro'
)

eq(
  '非法值一律归零',
  normalizeSkipWindow({ introEnd: Number.NaN, outroStart: -5 }),
  { introEnd: 0, outroStart: 0 }
)
eq('不超过视频时长', normalizeSkipWindow({ introEnd: 999 }, 300), { introEnd: 300, outroStart: 0 })
eq(
  '自相矛盾的组合：丢弃片尾、保留片头',
  normalizeSkipWindow({ introEnd: 100, outroStart: 102 }),
  { introEnd: 100, outroStart: 0 }
)
eq('间隔够远时两个都保留', normalizeSkipWindow({ introEnd: 100, outroStart: 200 }), {
  introEnd: 100,
  outroStart: 200
})
eq('只设了片尾也成立', normalizeSkipWindow({ outroStart: 200 }), { introEnd: 0, outroStart: 200 })

const skipBase = skipProfile({ introEnd: 30, outroStart: 300 })
eq('设置片头不会误伤足够远的片尾', withSkipPoint(skipBase, 'intro', 60, 600), {
  introEnd: 60,
  outroStart: 300
})
eq('新的片头点顶掉太近的片尾点', withSkipPoint(skipBase, 'intro', 298, 600), {
  introEnd: 298,
  outroStart: 0
})
eq('新的片尾点顶掉太近的片头点', withSkipPoint(skipBase, 'outro', 32, 600), {
  introEnd: 0,
  outroStart: 32
})
eq('设置点会被夹在视频时长内', withSkipPoint(skipBase, 'outro', 9999, 600), {
  introEnd: 30,
  outroStart: 600
})

eq('未设置显示占位符', formatSkipPoint(0), '--:--')
eq('负数与 NaN 都算未设置', [formatSkipPoint(-1), formatSkipPoint(Number.NaN)], ['--:--', '--:--'])
eq('分:秒', formatSkipPoint(90), '1:30')
eq('秒补零', formatSkipPoint(65), '1:05')
eq('不足一分钟', formatSkipPoint(8), '0:08')
eq('超过一小时带小时位', formatSkipPoint(3725), '1:02:05')

/* ---------------- 11. 剧集归属与更新状态 ---------------- */
console.log('\n[11] 剧集归属 / 更新状态')
eq('剧集 key', vodSeriesKey(3, '7788'), 'vod:3:7788')
eq('反解剧集 key', parseVodSeriesKey('vod:3:7788'), { sourceId: 3, vodId: '7788' })
eq('本地文件的 key 不参与剧集归组', parseVodSeriesKey(localSeriesKey('D:/剧/第01集.mkv')), null)
eq('缺前缀的旧式 key 不接受', parseVodSeriesKey('3:7788'), null)
eq('缺集号时不接受', parseVodSeriesKey('vod:3:'), null)
eq('源 id 不是数字时不接受', parseVodSeriesKey('vod:x:7788'), null)
eq('集号里带冒号也能反解（只按第一段切）', parseVodSeriesKey('vod:3:a:b'), {
  sourceId: 3,
  vodId: 'a:b'
})

eq('「更新至14集」', parseEpisodeCount('更新至14集'), 14)
eq('「更新至第06集」', parseEpisodeCount('更新至第06集'), 6)
eq('「全24集」', parseEpisodeCount('全24集'), 24)
eq('「12集全」', parseEpisodeCount('12集全'), 12)
eq('数字与「集」之间有空格也认得出', parseEpisodeCount('更新至 14 集'), 14)
eq('整串就是数字', parseEpisodeCount('36'), 36)
eq('「已完结」认不出集数', parseEpisodeCount('已完结'), 0)
eq('「HD」认不出集数', parseEpisodeCount('HD'), 0)
eq('空值', parseEpisodeCount(''), 0)
eq('undefined', parseEpisodeCount(undefined), 0)

eq('集数变大 = 有新集', hasNewEpisodes(12, 14), true)
eq('集数不变 = 没有新集', hasNewEpisodes(14, 14), false)
eq('集数变小 = 不算新集（站点改了备注口径）', hasNewEpisodes(14, 12), false)
eq('上次未知、这次知道了，只算信息补全不算更新', hasNewEpisodes(0, 14), false)
eq('这次未知一律不算更新', hasNewEpisodes(12, 0), false)

/* ---------------- 汇总 ---------------- */
console.log(`\n结果：通过 ${passed} 项，失败 ${failed} 项\n`)
if (failed > 0) process.exit(1)
