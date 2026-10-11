/**
 * dsh-voice-call —— DSH 语音通话插件（Host 半边）。
 *
 * 职责：
 * 1. 通话会话编排：接住浏览器录音的转写结果、把文字作为 prompt 投给指定 Session、
 *    订阅该 Session 的助手流式增量并缓存，供浏览器侧轮询取走朗读。
 * 2. 通话模式提示：通话进行中向 systemPrompt 注入一段「口语化输出」约束，
 *    让模型的回复适合被念出来（短句、无 Markdown、无表格代码块）。
 * 3. loopback RPC 通道 `/dsh-voice-call`：浏览器半边的全部动作入口。
 *
 * 设计取舍：
 * - 语音识别不自己实现，直接复用 DSH 的 speechToText 注册表（官方本地 SenseVoice provider）。
 * - 助手流不订阅客户端 Remote 的 follow（要处理 replay 游标），改在 Host 侧监听
 *   `agent/assistant-stream` 事件——它与官方 session controller 用的是同一个源，
 *   天然只给「新产生的增量」。
 * - 所有非必需服务都用 ctx.get 可选获取，任何一项缺失都只降级不抛错，
 *   避免插件激活失败导致 profile 被自愈重置。
 */

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-voice-call'

/** 硬依赖：这两个服务在所有组合里都存在。其余（sessionController / speechToText）走可选获取。 */
export const inject = ['systemPrompt', 'webServer']

/**
 * 浏览器半侧共用的 HTTP 路由前缀。
 *
 * ⚠️ 千万不要用 `/plugins/...`：`dsh-client-modules` 把**每个插件的浏览器 bundle**
 * 注册在 `/plugins` 这条 prefix 路由下（URL 形如 `/plugins/<包名>/<文件>`），而
 * webserver 的路由匹配是「最长前缀优先」——用 `/plugins/<包名>` 当自己的 API 前缀会
 * 把自己 bundle 的请求全部抢走（GET bundle → 被本插件回 405），表现为 host 半边一切
 * 正常、浏览器半边的按钮却完全不出现、两个 slot 的 occupants 都是空的。
 * 顶层路径不与任何保留前缀重叠，是安全选择。
 */
const RPC_ROUTE = '/dsh-voice-call'

/**
 * CosyVoice 常驻合成服务地址（「语音克隆」项目里那份大肥鱼声线）。
 * 设环境变量 DSH_VOICE_CALL_TTS=off 可整体关掉外部合成、回退浏览器系统语音。
 */
const TTS_URL = process.env.DSH_VOICE_CALL_TTS || 'http://127.0.0.1:9881'

/** 探测 CosyVoice 服务是否就绪（没启动、模型没加载完都算不可用）。 */
async function probeTts() {
  if (TTS_URL === 'off') return { available: false, reason: 'disabled' }
  try {
    const response = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(2500) })
    if (!response.ok) return { available: false, reason: `HTTP ${response.status}` }
    const data = await response.json()
    return {
      available: !!(data && data.ready === true),
      url: TTS_URL,
      sampleRate: data && data.sampleRate,
      torch: data && data.torch,
      cuda: !!(data && data.cuda),
    }
  } catch (error) {
    return { available: false, reason: errorMessage(error) }
  }
}

/**
 * 克隆声线服务（cosy_server.py）的位置。插件探测不到服务时会**自己把它拉起来**，
 * 这样用户完全不用关心「服务有没有在跑」——DSH 一启动、第一次探测就顺手拉起。
 */
// 用 pythonw.exe 而不是 python.exe：**前者不分配控制台窗口**。用 python.exe 时
// 计划任务一启动就会弹出一个黑框，用户看到就以为出问题了（2026-10-09 他明确说
// 「我看这个窗口不顺眼,能不能把他隐藏起来」）。
// 注意：下面两个兜底路径是作者本机的布局，保留它是为了让作者那份安装不需要额外配置。
// 换到别的机器请设 DSH_VOICE_CALL_TTS_EXE / DSH_VOICE_CALL_TTS_SCRIPT（见 README），
// 否则插件找不到本地合成服务，会直接回退到浏览器自带的语音合成。
const TTS_EXE =
  process.env.DSH_VOICE_CALL_TTS_EXE || 'D:\\大肥鱼\\语音克隆\\CosyVoice-main\\.venv\\Scripts\\pythonw.exe'
const TTS_SCRIPT = process.env.DSH_VOICE_CALL_TTS_SCRIPT || 'D:\\大肥鱼\\语音克隆\\cosy_server.py'
/** 负责托管该服务的计划任务名：它启动的进程父级是 svchost，不受 DSH 的 job object 影响。 */
const TTS_TASK = process.env.DSH_VOICE_CALL_TTS_TASK || 'CosyVoiceServer'

/** 通话界面用的角色立绘：插件 assets 下的透明 PNG，由 /dsh-voice-call/avatar 回给浏览器。 */
const AVATAR_FILE = new URL('../assets/avatar.png', import.meta.url)

/** 正在进行的启动流程：并发调用共享同一个 promise，避免拉起多份服务（端口会撞）。 */
let ttsStarting = null

/**
 * 确保合成服务在跑：探测 → 不在就 detached 拉起 → 轮询等到 ready。
 * 模型加载加预热要 20~40 秒，所以调用方一般**不 await**：通话先起来、前端暂时用系统语音，
 * 服务就绪后下一次朗读自动切回克隆声线。
 */
function ensureTts() {
  if (TTS_URL === 'off') return Promise.resolve({ available: false, reason: 'disabled' })
  if (ttsStarting) return ttsStarting
  ttsStarting = (async () => {
    const first = await probeTts()
    if (first.available) return first
    diag(`tts: 服务未就绪（${first.reason || 'unknown'}），拉起 cosy_server`)
    // 优先走计划任务启动：它的父进程是 svchost，**完全不受 DSH 的 job object 影响**。
    // 插件自己 spawn 的进程仍然继承 DSH 的 job，DSH 一重启就被一起带走（实测过两次）。
    let started = false
    try {
      const exists = await new Promise((resolve) => {
        try {
          const probe = spawn('schtasks.exe', ['/query', '/tn', TTS_TASK], {
            stdio: 'ignore',
            windowsHide: true,
          })
          probe.on('close', (code) => resolve(code === 0))
          probe.on('error', () => resolve(false))
        } catch {
          resolve(false)
        }
      })
      if (exists) {
        const runner = spawn('schtasks.exe', ['/run', '/tn', TTS_TASK], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        runner.unref()
        diag(`tts: 已请求计划任务 ${TTS_TASK} 启动服务`)
        started = true
      } else {
        diag(`tts: 计划任务 ${TTS_TASK} 不存在，退回直接 spawn`)
      }
    } catch (error) {
      diag(`tts: 计划任务探测失败 ${errorMessage(error)}`)
    }
    if (!started) {
      try {
        const child = spawn(TTS_EXE, [TTS_SCRIPT], {
          cwd: path.dirname(TTS_SCRIPT),
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        child.unref()
        diag(`tts: 直接 spawned pid=${child.pid}`)
      } catch (error) {
        diag(`tts: spawn 失败 ${errorMessage(error)}`)
        return { available: false, reason: errorMessage(error) }
      }
    }
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      const probe = await probeTts()
      if (probe.available) {
        diag('tts: 服务已就绪')
        return probe
      }
    }
    diag('tts: 等待服务就绪超时')
    return { available: false, reason: 'startup timeout' }
  })()
  return ttsStarting.finally(() => {
    ttsStarting = null
  })
}

/** 请 CosyVoice 合成一句，返回 { audioBase64, sampleRate, seconds }。 */
async function requestTts(text, signal) {
  if (TTS_URL === 'off') throw new Error('外部合成已关闭')
  const response = await fetch(`${TTS_URL}/tts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  })
  if (!response.ok) throw new Error(`CosyVoice HTTP ${response.status}`)
  const data = await response.json()
  if (!data || data.ok !== true || typeof data.wavBase64 !== 'string') {
    throw new Error((data && data.error) || 'CosyVoice 返回异常')
  }
  return { audioBase64: data.wavBase64, sampleRate: data.sampleRate, seconds: data.seconds }
}

/** 加载期诊断日志（每次 apply 覆盖重写，用于排查「路由到底注册没注册」）。 */
const DIAG_FILE = path.join(os.homedir(), '.dsh', 'dsh-voice-call-diag.log')

function diagReset() {
  try {
    writeFileSync(DIAG_FILE, '', 'utf8')
  } catch {
    // 忽略
  }
}

function diag(message) {
  try {
    appendFileSync(DIAG_FILE, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // 忽略
  }
}

/** 取服务但不抛错（get 对未声明依赖会抛）。 */
function safeGet(ctx, name) {
  try {
    return ctx.get(name)
  } catch {
    return undefined
  }
}

/** 通话模式下注入的提示词。 */
const CALL_PROMPT = `【语音通话中】用户此刻正通过语音和你通话：他的话由本地语音识别转成文字（可能有同音错字），你的回复会被逐句朗读出来。

- 说人话：口语、短句，像面对面聊天，不要写报告。
- 禁止 Markdown 语法、标题、表格、代码块、链接、颜文字和 emoji——它们被念出来只是噪音。
- 一次只说要点，几句话内讲完；内容多时先给结论，再问用户要不要展开。
- 数字和缩写按口语写（例如「四零九零显卡」「大约三秒」），不要写公式或长串符号。
- 用户随时可能插话打断你。被打断不是出错，直接回应他新说的话即可。
- 需要用户做选择时，把选项说得短而清楚，方便他用「第一个」「好」这种口头回答。`

function ok(value) {
  return { ok: true, value }
}

function fail(code, message) {
  return { ok: false, error: { code, message } }
}

function errorMessage(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  return error.message || String(error)
}

/** 从 Agent 上稳妥地取出 SessionId（不同版本取法不同，做兼容）。 */
function sessionIdOf(agent) {
  try {
    if (!agent) return null
    if (agent.session && agent.session.id) return String(agent.session.id)
    if (agent.id) return String(agent.id)
    return null
  } catch {
    return null
  }
}

/** 取识别器的准备状态快照（缺失时返回 null）。 */
function describeSpeech(stt) {
  if (!stt || typeof stt.snapshot !== 'function') return { available: false }
  try {
    const snapshot = stt.snapshot()
    const selection = (snapshot && snapshot.selection) || {}
    const providers = (snapshot && snapshot.providers) || []
    const current = providers.find((item) => item && item.id === selection.providerId)
    return {
      available: providers.length > 0,
      providerId: selection.providerId || null,
      language: selection.language || null,
      providerName: (current && current.name) || null,
      preparation: (current && current.preparation) || null,
    }
  } catch (error) {
    return { available: false, error: errorMessage(error) }
  }
}

export function apply(ctx) {
  diagReset()
  const systemPrompt = safeGet(ctx, 'systemPrompt')
  const webServer = safeGet(ctx, 'webServer')
  diag(`apply start | webServer=${webServer ? 'yes' : 'no'} | systemPrompt=${systemPrompt ? 'yes' : 'no'}`)

  /**
   * 通话运行态（纯内存，不落盘）——**按会话分桶**。
   * 用户 2026-10-09 反馈「我在其他会话语音的，怎么输出到这个会话了」：原先这里是一份全局
   * 单例（sessionId / deltas / seq 全共享），谁后点开通话就把绑定覆盖成谁，增量缓冲也只有
   * 一份——两个会话或两个页面同时通话时必然串台：A 说话，B 读到回复。
   * 现在每个在通话的会话各有一份 bucket，互不干扰；state 只留「最近操作的会话」做兜底。
   */
  const callSessions = new Map()
  const state = { active: false, sessionId: null, lastError: null }

  function bucketOf(sessionId, create) {
    const id = sessionId ? String(sessionId) : ''
    if (!id) return null
    let bucket = callSessions.get(id)
    if (!bucket && create) {
      bucket = { seq: 0, deltas: [], lastDeltaAt: 0, running: false }
      callSessions.set(id, bucket)
    }
    return bucket || null
  }

  function reset(sessionId) {
    const id = sessionId ? String(sessionId) : null
    state.lastError = null
    if (!id) return
    // 开始（或重新开始）这个会话的通话：只清它自己那份缓冲，不碰别的会话。
    callSessions.set(id, { seq: 0, deltas: [], lastDeltaAt: 0, running: false })
    state.active = true
    state.sessionId = id
  }

  function clear(sessionId) {
    const id = sessionId ? String(sessionId) : state.sessionId
    if (id) callSessions.delete(String(id))
    if (state.sessionId && !callSessions.has(state.sessionId)) {
      const next = callSessions.keys().next()
      state.sessionId = next.done ? null : next.value
    }
    state.active = callSessions.size > 0
  }

  /** 这个 agent 的事件属于哪个通话会话；**不在通话中的会话一律不收集**——防串台的关键。 */
  function captureBucket(agent) {
    const id = sessionIdOf(agent)
    if (!id) return null
    return callSessions.get(id) || null
  }

  // ---- 事件订阅：助手流增量 + Agent 运行状态 -------------------------------
  ctx.effect(() => {
    const disposers = []

    disposers.push(
      ctx.on('agent/assistant-stream', (payload) => {
        try {
          const agent = payload && payload.agent
          const frame = payload && payload.frame
          if (!frame || frame.type !== 'chunk') return
          // 只收「正在通话中的会话」的增量；别的会话即使在本机跑着也不碰——这就是防串台。
          const bucket = captureBucket(agent)
          if (!bucket) return
          const chunk = frame.chunk
          if (!chunk || chunk.type !== 'text-delta') return
          const text = chunk.text
          if (typeof text !== 'string' || !text) return
          bucket.seq += 1
          bucket.deltas.push({ seq: bucket.seq, text })
          bucket.lastDeltaAt = Date.now()
          // 上限保护：一次通话不会长到需要几万条增量，超出就从头部丢弃。
          if (bucket.deltas.length > 6000) bucket.deltas.splice(0, 2000)
        } catch {
          // 事件监听永不影响主流程
        }
      }),
    )

    disposers.push(
      ctx.on('agent/status', (payload) => {
        try {
          const agent = payload && payload.agent
          const bucket = captureBucket(agent)
          if (!bucket) return
          bucket.running = (payload && payload.status) === 'running'
        } catch {
          // 忽略
        }
      }),
    )

    return () => {
      for (const dispose of disposers) {
        try {
          if (typeof dispose === 'function') dispose()
        } catch {
          // 忽略
        }
      }
    }
  })

  // ---- 通话模式提示词 -------------------------------------------------------
  ctx.effect(() => {
    if (!systemPrompt || typeof systemPrompt.section !== 'function') return () => {}
    const dispose = systemPrompt.section({
      name: 'voice-call:mode',
      order: 215,
      text: () => (state.active ? CALL_PROMPT : ''),
    })
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // 忽略
      }
    }
  })

  // ---- 浏览器半边 → Host 的 HTTP 通道 --------------------------------------
  // 走 webServer 的普通路由，而不是 connection.rpc.handle：
  // 后者的 channel 是 Host 内部 RPC 的键，浏览器侧真正发出的是 HTTP 请求，
  // POST 到未注册路径会被 SPA fallback 以 405 挡回（实测报错
  // "transport for /dsh-voice-call/start: HTTP 405"）。
  // 顶层 inject 已声明 webServer，所以这里**同步**注册就应该成立；
  // ctx.inject(deps, cb) 只作为兜底（它是「起一个子插件」，依赖不就绪时回调不执行且不报错，
  // 排查困难，不作为首选）。
  if (webServer && typeof webServer.register === 'function') {
    try {
      const dispose = webServer.register({ kind: 'prefix', path: RPC_ROUTE, handler: handleHttp })
      diag('route registered (sync)')
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
    } catch (error) {
      diag(`route register FAILED (sync): ${errorMessage(error)}`)
    }
  } else {
    diag('webServer unavailable at apply time; falling back to ctx.inject')
    try {
      ctx.inject(['webServer'], (scoped) => {
        const late = scoped && (scoped.webServer || safeGet(scoped, 'webServer'))
        diag(`ctx.inject callback fired | webServer=${late ? 'yes' : 'no'}`)
        if (!late || typeof late.register !== 'function') return
        try {
          const dispose = late.register({ kind: 'prefix', path: RPC_ROUTE, handler: handleHttp })
          diag('route registered (async fallback)')
          if (typeof ctx.effect === 'function') ctx.effect(() => dispose)
        } catch (error) {
          diag(`route register FAILED (async): ${errorMessage(error)}`)
        }
      })
    } catch (error) {
      diag(`ctx.inject call failed: ${errorMessage(error)}`)
    }
  }
  diag('apply done')

  // 自检 2：本插件的**浏览器半边**有没有被 client-modules 装配进页面。
  // clientPath 为空 = 模块没进装配图 → 页面根本不会请求它的 bundle
  //（现象就是按钮与通话层完全不出现，而 host 一切正常）。
  try {
    const clientModules = safeGet(ctx, 'clientModules')
    if (!clientModules || typeof clientModules.clientPath !== 'function') {
      diag('client-modules: 服务不可用')
    } else {
      const clientPath = clientModules.clientPath('dsh-voice-call')
      diag(`client-modules: clientPath(dsh-voice-call) = ${clientPath || 'NONE（没进装配图）'}`)
      try {
        const graph = typeof clientModules.graph === 'function' ? clientModules.graph() : undefined
        const rows = graph && graph.rows
        const ids = Array.isArray(rows)
          ? rows.map((row) => row && row.id)
          : rows && typeof rows === 'object'
            ? Object.keys(rows)
            : null
        diag(`client-modules: graph ids = ${ids ? ids.join('|') : JSON.stringify(graph).slice(0, 600)}`)
      } catch (error) {
        diag(`client-modules: graph 读取失败 ${errorMessage(error)}`)
      }
    }
  } catch (error) {
    diag(`client-modules self-check failed: ${errorMessage(error)}`)
  }

  // 自检：确认路由真的进了「这个实例」的路由表，并看它监听在哪个端口。
  // 这一步是为了区分两种情况：注册没进表（MISS），还是进了另一个 WebServer 实例（HIT 但外部访问仍 405）。
  try {
    const probe = `${RPC_ROUTE}/state`
    if (webServer && typeof webServer.match === 'function') {
      diag(`self-check match(${probe}) = ${webServer.match(probe) ? 'HIT' : 'MISS'}`)
    } else {
      diag('self-check: webServer.match 不可用')
    }
    const address =
      webServer && webServer.server && typeof webServer.server.address === 'function'
        ? webServer.server.address()
        : null
    diag(`self-check listening = ${JSON.stringify(address)}`)
    if (webServer && webServer.exact && webServer.prefixes) {
      diag(
        `self-check routes: exact=${webServer.exact.size} prefix=${webServer.prefixes.size} ` +
          `prefixKeys=${Array.from(webServer.prefixes.keys()).join('|')}`,
      )
    } else {
      diag('self-check: 路由表字段不可见')
    }
  } catch (error) {
    diag(`self-check failed: ${errorMessage(error)}`)
  }

  /** 读完整请求体（音频 base64 可能几百 KB，给 32 MB 上限）。 */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 32 * 1024 * 1024) {
          try {
            req.destroy()
          } catch {
            // 忽略
          }
          reject(new Error('请求体过大'))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /** 只放行同源请求：带 Origin 且与 Host 不同的一律拒绝（防跨站调用）。 */
  function crossSite(req) {
    const origin = req.headers && req.headers.origin
    if (!origin) return false
    const host = req.headers && req.headers.host
    try {
      return !!host && new URL(String(origin)).host !== String(host)
    } catch {
      return true
    }
  }

  async function handleHttp(req, res) {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
    }
    if (crossSite(req)) {
      send(403, fail('forbidden', '跨站请求被拒绝'))
      return
    }

    const path = String(req.url || '').split('?')[0]
    const endpoint = path.startsWith(`${RPC_ROUTE}/`) ? path.slice(RPC_ROUTE.length + 1) : ''

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'content-type': 'text/plain; charset=utf-8' })
      res.end()
      return
    }
    if (!endpoint) {
      send(400, fail('bad-request', '缺少端点名'))
      return
    }
    // 头像图片走 GET：把插件 assets 里的角色立绘直接回给浏览器，供通话界面显示。
    if (endpoint === 'avatar') {
      try {
        // 探针：记下每次请求的完整 URL，用来核对浏览器到底有没有来取、取的是哪条地址。
        diag(`avatar 请求: ${req.url}`)
        const data = await readFile(AVATAR_FILE)
        // 不缓存：改图后要能立刻看到新效果。原来写的 max-age=600 会把新图挡住十分钟，
        // 用户换完图后反馈「没区别阿」就是这个原因。
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
        res.end(data)
      } catch (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`avatar not found: ${errorMessage(error)}`)
      }
      return
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' })
      res.end(JSON.stringify(fail('method-not-allowed', '只接受 POST')))
      return
    }

    let body = {}
    try {
      const text = await readBody(req)
      if (text) body = JSON.parse(text)
    } catch (error) {
      send(400, fail('bad-request', `请求体不是合法 JSON：${errorMessage(error)}`))
      return
    }

    // 流式合成：唯一一个要「边收边转发」的端点，不能走 dispatch 的请求-响应模式。
    if (endpoint === 'tts-stream') {
      await streamTts(req, res, body)
      return
    }

    const controller = new AbortController()
    const onClose = () => {
      try {
        controller.abort()
      } catch {
        // 忽略
      }
    }
    if (typeof req.on === 'function') req.on('close', onClose)

    let result
    try {
      result = await dispatch(endpoint, body, controller.signal)
    } catch (error) {
      state.lastError = errorMessage(error)
      result = fail('internal', state.lastError)
    } finally {
      try {
        if (typeof req.off === 'function') req.off('close', onClose)
      } catch {
        // 忽略
      }
    }
    send(200, result)
  }

  /**
   * 把上游 `/tts-stream` 的 NDJSON **边收边转发**给浏览器。
   * 这里千万不能缓冲：一缓冲就等于丢掉流式的全部意义（首块本来 2.4 秒能到，
   * 缓冲完就变回 5 秒多）。
   */
  async function streamTts(req, res, body) {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(fail('bad-request', '缺少要合成的文本。')))
      return
    }
    let upstream
    try {
      upstream = await fetch(`${TTS_URL}/tts-stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (!upstream.ok) throw new Error(`CosyVoice HTTP ${upstream.status}`)
    } catch (error) {
      // 失败也可能只是服务掉了：后台再拉一次，下一句就能恢复。
      ensureTts().catch(() => {})
      res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(fail('tts-failed', errorMessage(error))))
      return
    }
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    })
    try {
      for await (const chunk of upstream.body) {
        res.write(chunk)
      }
    } catch (error) {
      diag(`tts-stream 转发中断 ${errorMessage(error)}`)
    }
    res.end()
  }

  async function dispatch(endpoint, payload, signal) {
    switch (endpoint) {
      case 'tts-status': {
        const status = await probeTts()
        // 没就绪就顺手在后台拉起服务（不阻塞这次探测的返回）。
        if (!status.available) ensureTts().catch(() => {})
        return ok(status)
      }

      case 'tts': {
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        if (!text) return fail('bad-request', '缺少要合成的文本。')
        if (text.length > 400) return fail('bad-request', '文本过长（单句上限 400 字）。')
        try {
          const result = await requestTts(text, signal)
          return ok(result)
        } catch (error) {
          // 失败也可能只是服务被关掉了：后台再拉一次，下一句就自动恢复克隆声线。
          ensureTts().catch(() => {})
          return fail('tts-failed', errorMessage(error))
        }
      }

      case 'client-report': {
        // 浏览器半边在加载/挂载各阶段往这里上报，Host 落进诊断日志。
        // 日志里一条都没有 = 浏览器半边根本没跑。
        diag(`client report: ${JSON.stringify(payload).slice(0, 600)}`)
        return ok({ logged: true })
      }

      case 'state': {
        const id = payload.sessionId ? String(payload.sessionId) : state.sessionId
        const bucket = bucketOf(id, false)
        return ok({
          active: !!bucket,
          sessionId: id || null,
          running: !!(bucket && bucket.running),
          speech: describeSpeech(ctx.get('speechToText')),
        })
      }

      case 'sessions': {
        const sessionController = ctx.get('sessionController')
        if (!sessionController || typeof sessionController.list !== 'function') return ok({ items: [] })
        const value = await sessionController.list({}, signal)
        const items = ((value && value.items) || [])
          .filter((item) => item && !item.origin)
          .slice(0, 25)
          .map((item) => {
            const projections = item.projections || {}
            const values = projections.values || {}
            return {
              sessionId: String(item.sessionId),
              updatedAt: item.updatedAt || 0,
              running: !!item.running,
              blank: !!item.blank,
              cwd: item.cwd || null,
              title: values.title || values['session-title'] || null,
            }
          })
        return ok({ items })
      }

      case 'start': {
        const sessionId = payload.sessionId ? String(payload.sessionId) : null
        // **不再猜「最近活动的会话」**：2026-10-09 用户反馈「在『教我写代码』会话说话，
        // 文字跑到『一』会话去了」——根因就是这里的兜底。主 agent 长期在某个会话里活动，
        // 「最近活动的会话」永远是那一个，于是语音被投喂到了错误的会话。拿不到就明确失败。
        if (!sessionId) return fail('bad-request', '缺少 sessionId：拿不到当前会话编号，无法开始通话。')
        reset(sessionId)
        ensurePrepared()
        // 通话开始时顺手把克隆声线服务拉起来（后台跑，不挡通话启动）。
        ensureTts().catch(() => {})
        return ok({ active: true, sessionId: state.sessionId, speech: describeSpeech(ctx.get('speechToText')) })
      }

      case 'stop': {
        // 只结束客户端自己那个会话的通话，别的会话照常。
        clear(payload.sessionId ? String(payload.sessionId) : null)
        return ok({ active: callSessions.size > 0, sessionId: state.sessionId })
      }

      case 'prepare': {
        // 手动触发识别模型准备（下载）。返回当前状态供界面显示进度。
        ensurePrepared()
        return ok({ speech: describeSpeech(ctx.get('speechToText')) })
      }

      case 'transcribe': {
        const stt = ctx.get('speechToText')
        if (!stt) return fail('no-speech-service', '语音识别服务不可用：请确认语音识别 provider 已启用。')
        const audioBase64 = typeof payload.audioBase64 === 'string' ? payload.audioBase64 : ''
        if (!audioBase64) return fail('bad-request', '缺少音频数据。')
        const bytes = Buffer.from(audioBase64, 'base64')
        if (!bytes.length) return fail('bad-request', '音频数据为空。')
        const { language } = describeSpeech(stt)
        // 实测（2026-10-09）：不指定语言时 SenseVoice 会自动判语种，短促的中文
        // （用户说「大肥鱼大肥鱼」）被误判成英文、输出 "yeah"。这是中文对话场景，
        // provider 没明确配语言时兜底锁 zh。
        const lang = language || payload.language || 'zh'
        const spec = stt.resolve({ audio: new Uint8Array(bytes), language: lang })
        const transcript = await stt.transcribe(spec, signal)
        return ok({ text: (transcript && transcript.text) || '', audioSeconds: transcript && transcript.audioSeconds })
      }

      case 'ask': {
        // 用户 2026-10-09：「你开始思考的时候就开始加载语音模型，这样会不会更快一点」——
        // 趁本鱼思考和生成回复的这几秒，提前把合成服务确认好／拉起来。平时服务常驻，这一步
        // 几乎零成本；只在服务掉了的时候救命（冷启动要 20~40 秒，那时才拉就来不及了）。
        ensureTts().catch(() => {})
        const sessionController = ctx.get('sessionController')
        if (!sessionController) return fail('no-session-service', '会话服务不可用。')
        const sessionId = payload.sessionId ? String(payload.sessionId) : state.sessionId
        if (!sessionId) return fail('bad-request', '缺少 sessionId。')
        const text = typeof payload.text === 'string' ? payload.text.trim() : ''
        if (!text) return fail('bad-request', '缺少要投喂的文字。')
        // 没 start 过就直接说话（少见）：单独给这个会话开一份 bucket，**不碰别的会话**。
        let bucket = bucketOf(sessionId, false)
        if (!bucket) {
          reset(sessionId)
          bucket = bucketOf(sessionId, false)
        }
        state.sessionId = sessionId
        const requestId = `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        await sessionController.prompt(
          { requestId, sessionId, mode: 'queue', content: [{ type: 'text', text }] },
          signal,
        )
        // 把「提问时刻的增量序号」一并返回：客户端拿它重置读取游标，于是无论它本地
        // 游标处于什么状态，这一轮都只会取到提问之后的新增量，绝不会把上一轮的回复
        // 重新捞出来再念一遍（用户 2026-10-09 反馈「我说话的时候他直接重复了上一句」）。
        return ok({ accepted: true, sessionId, cursor: bucket ? bucket.seq : 0 })
      }

      case 'cancel': {
        const sessionController = ctx.get('sessionController')
        if (!sessionController) return fail('no-session-service', '会话服务不可用。')
        const sessionId = payload.sessionId ? String(payload.sessionId) : state.sessionId
        if (!sessionId) return fail('bad-request', '缺少 sessionId。')
        sessionController.cancel({ sessionId })
        const bucket = bucketOf(sessionId, false)
        if (bucket) bucket.running = false
        return ok({ accepted: true })
      }

      case 'poll': {
        const sessionId = payload.sessionId ? String(payload.sessionId) : state.sessionId
        const cursor = Number.isFinite(payload.cursor) ? Number(payload.cursor) : 0
        // 按客户端报的 sessionId 取**自己那一桶**——不带 sessionId 的调用退化为「最近操作的会话」。
        const bucket = bucketOf(sessionId, false)
        const deltas = bucket ? bucket.deltas.filter((item) => item.seq > cursor) : []
        const lastSeq = deltas.length ? deltas[deltas.length - 1].seq : cursor
        // 「说完了」判定：Agent 不再 running，且已有 600ms 没有新增量。
        const quiet = !bucket || Date.now() - bucket.lastDeltaAt > 600
        const running = !!(bucket && bucket.running)
        return ok({
          cursor: lastSeq,
          deltas,
          active: !!bucket,
          running,
          settled: !running && quiet,
          sessionId: sessionId || null,
          speech: describeSpeech(ctx.get('speechToText')),
        })
      }

      default:
        return fail('not-found', `未知端点：${endpoint}`)
    }
  }

  /** 通信客户端没带 sessionId 时的兜底：取最近活动、可用的普通会话。 */
  async function pickDefaultSession(signal) {
    const sessionController = ctx.get('sessionController')
    if (!sessionController || typeof sessionController.list !== 'function') return null
    try {
      const value = await sessionController.list({}, signal)
      const items = ((value && value.items) || []).filter((item) => item && !item.origin)
      const usable = items.find((item) => item.agentAvailable !== false) || items[0]
      return usable ? String(usable.sessionId) : null
    } catch {
      return null
    }
  }

  /** 启动识别器的准备流程（已就绪时是空操作，未就绪时会下载模型）。 */
  function ensurePrepared() {
    const stt = ctx.get('speechToText')
    if (!stt || typeof stt.snapshot !== 'function') return
    try {
      const info = describeSpeech(stt)
      const phase = info.preparation && info.preparation.phase
      if (phase === 'ready' || phase === 'standby' || phase === 'waking') return
      if (phase === 'downloading' || phase === 'checking' || phase === 'loading') return
      if (info.providerId && typeof stt.prepare === 'function') stt.prepare(info.providerId)
    } catch {
      // 准备失败会在 poll 的 speech.preparation 里以 failed 呈现，不抛错
    }
  }
}
