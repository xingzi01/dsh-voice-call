/**
 * dsh-voice-call —— 浏览器半边（手写 __ModuleLoader__ bundle，无 JSX）。
 *
 * 界面落点（官方 Slot API）：
 * - `conversation.input.activity`：输入框工具栏里的「通话」按钮（拿到 sessionId）。
 * - `shell.overlay`：全屏通话层（帧级浮层，盖住所有列）。
 *
 * 语音链路：
 *   麦克风 → ScriptProcessor 取 PCM → 能量 VAD 自动断句 → 16k 单声道 WAV
 *   → Host RPC `transcribe`（DSH speechToText 注册表 / 本地 SenseVoice）
 *   → Host RPC `ask`（作为 prompt 投给当前 Session）
 *   → 轮询 Host RPC `poll`（Host 侧订阅 agent/assistant-stream 攒的增量）
 *   → 按标点切句送 speechSynthesis 朗读（边说边生成，可被用户插话打断）。
 *
 * 全部非关键路径都做了降级：拿不到麦克风、没有 connection、没有中文语音时，
 * 界面给出可读的错误而不是白屏。
 */
window.__ModuleLoader__.load({
  id: 'dsh-voice-call',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useRef = React.useRef

    // ================= 常量与偏好 =================
    // 顶层路径：不要用 /plugins/...——那是 dsh-client-modules 提供各插件浏览器 bundle
    // 的保留前缀，重叠会把本插件自己的 client.js 请求截胡（曾导致按钮完全不出现）。
    var RPC_CHANNEL = '/dsh-voice-call'
    var TARGET_RATE = 16000
    var MIN_SPEECH_MS = 220
    var MAX_UTTER_MS = 40000
    var POLL_INTERVAL = 140
    // v3（用户 2026-10-09「加一个我说话的时候打断思考」）：把「允许插话打断」的默认值改回 true。
    // 必须换 key：localStorage 里 v2 那份写着 bargeIn:false，会覆盖掉新默认值，不换就等于没改。
    var PREF_KEY = 'dsh.voiceCall.prefs.v3'

    var DEFAULT_PREFS = {
      /** 朗读引擎：'cosy' = 克隆声线（大肥鱼，走本地合成服务）；'system' = 浏览器系统语音。 */
      ttsEngine: 'cosy',
      /**
       * 克隆声线是否走流式。**默认关**：2026-10-09 用户实测「不顺,有明显空挡,也会有明显的卡顿和停顿」。
       * 抓音频对比过，流式与非流式的静音段几乎一样（6 段 / 1.62s vs 1.92s），说明合成端没问题，
       * 卡顿出在浏览器排队上——块粒度 1~2.6 秒音频而每块生成要 1.3~2.4 秒，晚一块就空一下。
       * 先退回「整句合成 + 预取」这条稳的路。
       */
      ttsStream: false,
      voiceName: '',
      rate: 1.05,
      vadThreshold: 0.015,
      // 用户 2026-10-09：「最好我说完话 3 秒左右你才开始思考」→ 3000ms → 他实测「太久了」
      // → 1500ms → 仍嫌久 → 定 **1000ms**（最初是 850ms，那个偏短、容易抢话）。
      silenceMs: 1000,
      // v3 默认开启插话打断。防自触发不靠「一刀切关掉」，靠 processFrame 里区分
      // 「还没出声（thinking，扬声器安静）」和「正在出声（speaking，有回灌）」两套门槛。
      bargeIn: true,
      readReplies: true,
    }

    function loadPrefs() {
      var prefs = Object.assign({}, DEFAULT_PREFS)
      try {
        var raw = window.localStorage.getItem(PREF_KEY)
        if (raw) Object.assign(prefs, JSON.parse(raw))
      } catch (e) {}
      // silenceMs 的处理（2026-10-09）：早期它会被存进 localStorage 快照，导致本鱼改默认值
      // 被旧值盖掉（「改了跟没改一样」）。但又不能无脑强制——现在设置面板里有这个滑块，
      // 用户调过就得算数。折中：**只有用户没主动调过时**才用代码里的默认值兜底。
      if (prefs.silenceMsTouched !== true) prefs.silenceMs = DEFAULT_PREFS.silenceMs
      return prefs
    }
    function savePrefs(prefs) {
      try {
        window.localStorage.setItem(PREF_KEY, JSON.stringify(prefs))
      } catch (e) {}
    }

    // ================= 按钮 ↔ 通话层 的共享状态 =================
    var bus = {
      /** 通话是否进行中（决定 startCall / endCall 的生命周期）。 */
      open: false,
      /**
       * 通话浮窗是否显示。默认 false：点按钮直接开始通话，界面上**不多出任何窗口**；
       * 想看字幕、调设置或挂断时，再点一下那个按钮把它叫出来。
       */
      panel: false,
      sessionId: null,
      subs: new Set(),
      subscribe: function (fn) {
        bus.subs.add(fn)
        return function () {
          bus.subs.delete(fn)
        }
      },
      set: function (patch) {
        Object.assign(bus, patch)
        bus.subs.forEach(function (fn) {
          try {
            fn()
          } catch (e) {}
        })
      },
    }
    function useBus() {
      var pair = useState(0)
      var tick = pair[0]
      var bump = pair[1]
      useEffect(function () {
        return bus.subscribe(function () {
          bump(function (n) {
            return n + 1
          })
        })
      }, [])
      return tick
    }

    // ================= 通用工具 =================
    function sleep(ms) {
      return new Promise(function (resolve) {
        window.setTimeout(resolve, ms)
      })
    }

    function toBase64(bytes) {
      var chunk = 0x8000
      var parts = []
      for (var i = 0; i < bytes.length; i += chunk) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)))
      }
      return window.btoa(parts.join(''))
    }

    function writeAscii(view, offset, text) {
      for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
    }

    /** Float32 PCM（任意采样率）→ 16k 单声道 16bit WAV 字节。 */
    function encodeWav16k(chunks, totalLength, sampleRate) {
      var merged = new Float32Array(totalLength)
      var offset = 0
      for (var c = 0; c < chunks.length; c++) {
        merged.set(chunks[c], offset)
        offset += chunks[c].length
      }
      var ratio = sampleRate / TARGET_RATE
      var outLength = Math.max(1, Math.floor(merged.length / ratio))
      var samples = new Int16Array(outLength)
      for (var i = 0; i < outLength; i++) {
        var pos = i * ratio
        var i0 = Math.floor(pos)
        var i1 = Math.min(i0 + 1, merged.length - 1)
        var frac = pos - i0
        var value = merged[i0] * (1 - frac) + merged[i1] * frac
        if (value > 1) value = 1
        if (value < -1) value = -1
        samples[i] = value < 0 ? value * 0x8000 : value * 0x7fff
      }
      var buffer = new ArrayBuffer(44 + samples.length * 2)
      var view = new DataView(buffer)
      writeAscii(view, 0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      writeAscii(view, 8, 'WAVE')
      writeAscii(view, 12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, TARGET_RATE, true)
      view.setUint32(28, TARGET_RATE * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeAscii(view, 36, 'data')
      view.setUint32(40, samples.length * 2, true)
      new Int16Array(buffer, 44).set(samples)
      return new Uint8Array(buffer)
    }

    /** 清掉 Markdown 符号与括号注解，让朗读不念出噪音。 */
    function speakable(text) {
      return String(text || '')
        .replace(/```[\s\S]*?```/g, '（代码块略过）')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/\*\*([^*]*)\*\*/g, '$1')
        .replace(/(^|\s)[*_#>]+/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
        .trim()
    }

    // ================= 语音合成（浏览器原生 TTS） =================
    var synth = typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null
    var voiceList = []

    function refreshVoices() {
      if (!synth || typeof synth.getVoices !== 'function') return
      try {
        voiceList = synth.getVoices() || []
      } catch (e) {
        voiceList = []
      }
    }
    if (synth) {
      refreshVoices()
      try {
        synth.addEventListener('voiceschanged', refreshVoices)
      } catch (e) {
        synth.onvoiceschanged = refreshVoices
      }
    }

    function pickVoice(prefs) {
      if (!voiceList.length) refreshVoices()
      if (prefs.voiceName) {
        for (var i = 0; i < voiceList.length; i++) {
          if (voiceList[i].name === prefs.voiceName) return voiceList[i]
        }
      }
      var zh = []
      for (var j = 0; j < voiceList.length; j++) {
        var lang = String(voiceList[j].lang || '').toLowerCase()
        if (lang.indexOf('zh') === 0 || lang.indexOf('cmn') === 0) zh.push(voiceList[j])
      }
      if (zh.length) {
        // 偏好女声/自然音色（Windows 上 Xiaoxiao/Huihui 比 Kangkang 自然）
        // 优先本地语音（localService）：Chromium/Electron 里那些「在线自然音」
        // （名字带 Online / Natural）走云端合成，speak() 常常直接静默失败——一点声都没有。
        var local = zh.filter(function (v) {
          return v.localService !== false
        })
        var pool = local.length ? local : zh
        var nice = pool.find(function (v) {
          return /xiaoxiao|xiaoyi|huihui|yaoyao|kangkang/i.test(v.name)
        })
        return nice || pool[0]
      }
      return voiceList[0] || null
    }

    // ================= 通话引擎（非 React 单例） =================
    var engine = {
      phase: 'idle', // idle | connecting | listening | transcribing | thinking | speaking | error
      level: 0,
      heard: '',
      reply: '',
      error: '',
      speech: null,
      sessionId: null,
      sessions: [],
      muted: false,
      /** 朗读引擎：'system' = 浏览器系统语音；'cosy' = CosyVoice 克隆声线（外部服务）。 */
      ttsMode: 'system',
      analyzing: false,
      prefs: loadPrefs(),
      subs: new Set(),
      subscribe: function (fn) {
        engine.subs.add(fn)
        return function () {
          engine.subs.delete(fn)
        }
      },
      emit: function () {
        engine.subs.forEach(function (fn) {
          try {
            fn()
          } catch (e) {}
        })
      },
      set: function (patch) {
        Object.assign(engine, patch)
        engine.emit()
      },
      call: null, // RPC 调用器，由 apply 注入
    }

    // 引擎内部易失状态
    var mic = null // { stream, ctx, source, processor, sink }
    var vadState = null
    /** 打断判定期间滚动保留的最近音频（约 700ms）：打断后接到新句子开头，别让用户白说。 */
    var recentFrames = []
    var recentRate = 16000
    var runId = 0
    var pollTimer = null
    /**
     * 回复流游标，必须**跨轮次保留**。Host 侧的增量缓冲是整通电话累积的，
     * 每轮都从 0 开始会把之前所有回复重新取一遍——表现就是「本鱼把上一句话又念了一遍」。
     * 只在 startCall（开始新通话）时归零。
     */
    var pollCursor = 0
    var speakQueue = []
    var speakBuffer = ''
    var speaking = false
    /** CosyVoice 模式下正在播放的 Audio 元素（打断时要 pause 掉）。 */
    var cosyAudio = null
    /**
     * 立绘的缓存版本号：页面每次加载取一次时间戳，拼在图片 URL 后面。
     * 之前用固定 URL 时，换了图浏览器还是拿缓存里的旧图（用户 2026-10-09 连问两次「没区别」）。
     */
    var avatarVersion = String(Date.now())
    /**
     * 预取：正在播放这一句的时候，就先把下一句合成好。
     * 合成速度约每秒 7~8 个字、比说话略快，所以预取之后句子之间几乎听不出等待。
     */
    var prefetch = { sentence: null, promise: null }

    // ---- 流式播放（Web Audio）：边收 PCM 块边排队播 ---------------------------------
    var streamCtx = null
    var streamSources = []

    function ensureStreamCtx() {
      if (!streamCtx) {
        var Ctor = window.AudioContext || window.webkitAudioContext
        streamCtx = new Ctor()
      }
      if (streamCtx.state === 'suspended' && typeof streamCtx.resume === 'function') {
        streamCtx.resume().catch(function () {})
      }
      return streamCtx
    }

    function base64ToInt16(b64) {
      var bin = window.atob(b64)
      var bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return new Int16Array(bytes.buffer, 0, Math.floor(bin.length / 2))
    }

    function stopStreamSources() {
      for (var i = 0; i < streamSources.length; i++) {
        try {
          streamSources[i].stop()
        } catch (e) {}
      }
      streamSources = []
    }

    /**
     * 流式朗读：一边收 PCM 块一边用 Web Audio 排队播。
     * 首块大约 2.4 秒到（整句合成完要 5 秒多），所以开口快接近一倍。
     */
    async function speakStreamed(sentence) {
      var run = runId
      speaking = true
      var firstLineOfCall = !engine.speakStartedAt
      engine.speakStartedAt = Date.now()
      if (firstLineOfCall) console.log('[dsh-voice-call] 朗读引擎 = CosyVoice（流式）')
      if (engine.phase !== 'speaking') engine.set({ phase: 'speaking' })

      var response = null
      try {
        response = await window.fetch(RPC_CHANNEL + '/tts-stream', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: sentence }),
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
      } catch (error) {
        if (run !== runId) return
        console.warn('[dsh-voice-call] 流式合成失败，回退系统语音：' + ((error && error.message) || error))
        engine.set({ error: '克隆声线服务没响应，已暂时改用系统语音' })
        report('cosy-fallback-system', (error && error.message) || 'error')
        speakQueue.unshift(sentence)
        speaking = false
        engine.ttsMode = 'system'
        engine.prefs.ttsEngine = 'system'
        drainSpeech()
        return
      }
      if (run !== runId) {
        speaking = false
        return
      }

      var ctx = ensureStreamCtx()
      var reader = response.body.getReader()
      var decoder = new window.TextDecoder()
      var buffered = ''
      // 起始留 0.35 秒缓冲：块粒度是 1~2.6 秒音频、每块生成要 1.3~2.4 秒，
      // 只要有一块晚到就会被听成「空档」。
      var scheduleAt = ctx.currentTime + 0.35
      var chunks = 0
      var startedAt = Date.now()

      try {
        while (true) {
          var part = await reader.read()
          if (run !== runId) {
            try {
              reader.cancel()
            } catch (e) {}
            stopStreamSources()
            speaking = false
            return
          }
          if (part.done) break
          buffered += decoder.decode(part.value, { stream: true })
          var lines = buffered.split('\n')
          buffered = lines.pop()
          for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim()
            if (!line) continue
            var obj = JSON.parse(line)
            if (obj.error) throw new Error(obj.error)
            if (obj.done) {
              buffered = ''
              break
            }
            var pcm = base64ToInt16(obj.pcm || '')
            if (!pcm.length) continue
            var buffer = ctx.createBuffer(1, pcm.length, obj.sampleRate || 24000)
            var data = buffer.getChannelData(0)
            for (var j = 0; j < pcm.length; j++) data[j] = pcm[j] / 32768
            var source = ctx.createBufferSource()
            source.buffer = buffer
            source.connect(ctx.destination)
            // 追赶：如果已经排到过去了（某块晚到），立刻接上，别让它越等越久。
            var now = ctx.currentTime
            if (scheduleAt < now + 0.02) scheduleAt = now + 0.02
            source.start(scheduleAt)
            streamSources.push(source)
            scheduleAt += buffer.duration
            chunks += 1
            if (chunks === 1) {
              var first = ((Date.now() - startedAt) / 1000).toFixed(2)
              console.log('[dsh-voice-call] 流式首块到达：' + first + ' 秒')
              report('cosy-stream-first', first + 's')
            }
          }
        }
      } catch (error) {
        if (run !== runId) {
          speaking = false
          return
        }
        var why = (error && error.message) || String(error)
        console.warn('[dsh-voice-call] 流式播放失败：' + why)
        report('cosy-stream-failed', why)
        engine.set({ error: '流式播放失败：' + why })
        stopStreamSources()
        speaking = false
        drainSpeech()
        return
      }

      // 等已经排进音频队列的这部分播完，再交还给 drainSpeech 播下一句。
      var remainMs = Math.max(0, (scheduleAt - ctx.currentTime) * 1000)
      await new Promise(function (resolve) {
        window.setTimeout(resolve, remainMs + 150)
      })
      if (run !== runId) {
        speaking = false
        return
      }
      console.log('[dsh-voice-call] 流式播放完成：' + chunks + ' 块')
      speaking = false
      drainSpeech()
    }

    /** 空闲时预取队首那一句（已在预取中、或队列为空就跳过）。 */
    function startPrefetch() {
      if (prefetch.promise) return
      if (engine.prefs.ttsEngine !== 'cosy') return
      // 流式模式不预取：它本来就是「边收边播」，再预取只是白烧显卡。
      if (engine.prefs.ttsStream !== false) return
      if (!speakQueue.length) return
      var next = speakQueue[0]
      prefetch = {
        sentence: next,
        promise: rpc('tts', { text: next }).catch(function () {
          return null // 预取失败不致命：真正轮到它时会再取一次
        }),
      }
      console.log('[dsh-voice-call] 预取下一句：' + next.slice(0, 20))
    }

    function resetVadState() {
      vadState = {
        inSpeech: false,
        chunks: [],
        total: 0,
        silenceMs: 0,
        speechMs: 0,
        loudMs: 0,
      }
    }
    resetVadState()

    function rpc(endpoint, payload) {
      if (typeof engine.call !== 'function') {
        return Promise.reject(new Error('Host 通道不可用（connection 服务缺失）'))
      }
      return engine.call(endpoint, payload)
    }

    // ---- 麦克风与 VAD --------------------------------------------------------

    async function openMic() {
      if (mic) return
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw new Error('当前环境不支持麦克风采集（需要 https 或 localhost）')
      }
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      var AudioCtor = window.AudioContext || window.webkitAudioContext
      var audioCtx = new AudioCtor()
      if (audioCtx.state === 'suspended' && typeof audioCtx.resume === 'function') {
        try {
          await audioCtx.resume()
        } catch (e) {}
      }
      var source = audioCtx.createMediaStreamSource(stream)
      var processor = audioCtx.createScriptProcessor(2048, 1, 1)
      var sink = audioCtx.createGain()
      sink.gain.value = 0
      source.connect(processor)
      processor.connect(sink)
      sink.connect(audioCtx.destination)
      processor.onaudioprocess = function (event) {
        if (engine.muted) return
        var input = event.inputBuffer.getChannelData(0)
        handleFrame(input, audioCtx.sampleRate)
      }
      mic = { stream: stream, ctx: audioCtx, source: source, processor: processor, sink: sink }
    }

    function closeMic() {
      if (!mic) return
      try {
        mic.processor.onaudioprocess = null
      } catch (e) {}
      try {
        mic.processor.disconnect()
        mic.source.disconnect()
        mic.sink.disconnect()
      } catch (e) {}
      try {
        mic.stream.getTracks().forEach(function (track) {
          track.stop()
        })
      } catch (e) {}
      try {
        mic.ctx.close()
      } catch (e) {}
      mic = null
    }

    /** 每个音频帧：算 RMS、跑 VAD 状态机、必要时触发一句转写。 */
    function handleFrame(input, sampleRate) {
      var sum = 0
      for (var i = 0; i < input.length; i++) sum += input[i] * input[i]
      var rms = Math.sqrt(sum / input.length)
      var frameMs = (input.length / sampleRate) * 1000
      var prefs = engine.prefs

      // 用户 2026-10-09：「我把你打断后说的话不输入」——判定插话用的那 200 多毫秒，
      // 原先只用来累计 loudMs、音频本身被丢掉了，所以打断之后说的头一两个字进不去。
      // **缓冲必须足够长**：从「用户开口」到「判定成立」可能拖一两秒（保护窗 + 重新累计），
      // 只留 700ms 中间那段照样丢——实测日志里那次滞后了 2.3 秒，所以留 2500ms。
      recentFrames.push(new Float32Array(input))
      recentRate = sampleRate
      var keepFrames = Math.max(2, Math.ceil(2500 / frameMs))
      while (recentFrames.length > keepFrames) recentFrames.shift()

      // 电平表（只在监听时刷新界面，避免高频重渲染）
      if (engine.phase === 'listening' || engine.phase === 'speaking') {
        var shown = Math.min(1, rms * 8)
        if (Math.abs(shown - engine.level) > 0.06) engine.set({ level: shown })
      }

      if (!vadState) resetVadState()

      var speakingNow = engine.phase === 'speaking' || engine.phase === 'thinking'
      // 用户 2026-10-09：「加一个我说话的时候打断思考」，随后反复反馈「还是打断不了」。
      // **diag 的 barge-level 给出了关键事实**：本鱼出声时麦克风的回灌几乎为零
      // （rms 0.0001~0.0005，用户戴了耳机），而用户插话时能到 0.08~0.19——所以门槛
      // 根本不是瓶颈，问题在判定链路里。这里门槛整体放宽，并加「触发 / 被挡」两条诊断，
      // 让日志直接指出是哪一环把它拦下的。
      var playingNow = engine.phase === 'speaking' && engine.speakStartedAt > 0
      if (playingNow) {
        var floorPrev = Number(engine.echoFloor) || 0
        engine.echoFloor = floorPrev > 0 ? floorPrev * 0.97 + rms * 0.03 : rms
      }
      var echoFloor = Number(engine.echoFloor) || 0
      // 回灌实测几乎为零（用户戴耳机），所以门槛可以压得很低——「自己打断自己」的风险不存在。
      // 2026-10-09 实测：用户插话瞬时能到 0.18，但常常只持续一两帧，所以主要是**持续时间**在挡。
      var threshold = playingNow ? Math.max(0.012, prefs.vadThreshold, echoFloor * 1.5) : prefs.vadThreshold
      var bargeNeedMs = playingNow ? 220 : 180
      // 保护窗（等 AEC 收敛）**取消**：实测回灌几乎为零，等它反而会让「用户刚开口就被挡回去、
      // 还得重新累计 220ms」——实测日志里那次滞后了 2.3 秒，用户的开头两个字就是这么丢的。
      var bargeGuardMs = 0
      var sinceStart = Date.now() - engine.speakStartedAt
      // 诊断：本鱼出声期间每 1.5 秒上报一次实测电平与阈值。
      if (playingNow && Date.now() - (Number(engine.lastFloorReport) || 0) > 1500) {
        engine.lastFloorReport = Date.now()
        report(
          'barge-level',
          'rms=' + rms.toFixed(4) + ' floor=' + echoFloor.toFixed(4) + ' thr=' + threshold.toFixed(4),
        )
      }

      if (!vadState.inSpeech) {
        if (rms > threshold) {
          var bargeWindowOpen =
            speakingNow && prefs.bargeIn && (!playingNow || sinceStart > bargeGuardMs)
          if (bargeWindowOpen) {
            vadState.loudMs += frameMs
            if (vadState.loudMs >= bargeNeedMs) {
              report('barge-triggered', 'rms=' + rms.toFixed(4) + ' phase=' + engine.phase)
              vadState.loudMs = 0
              bargeIn()
              // **关键**（2026-10-09 找到的真根因）：bargeIn 已经把 phase 改成 listening，
              // 如果这一帧继续往下走，下面「phase === listening」那段会执行
              // `vadState.chunks = [当前这一帧]`——刚接住的 seed（用户开口那几百毫秒）
              // 当场被覆盖丢掉。这正是「打断后开头一两个字识别不到」的原因。
              return
            }
          } else {
            vadState.loudMs = 0
            // 有声音却没走打断：**只在「本鱼正在忙」时**上报（限流 1.5 秒），免得聆听状态下
            // 的正常说话也刷进来（2026-10-09 实测刷了两条 phase=listening 的无用记录）。
            if (speakingNow && Date.now() - (Number(engine.lastBlockReport) || 0) > 1500) {
              engine.lastBlockReport = Date.now()
              report(
                'barge-blocked',
                'rms=' + rms.toFixed(4) + ' thr=' + threshold.toFixed(4) +
                  ' phase=' + engine.phase + ' bargeIn=' + !!prefs.bargeIn +
                  ' playingNow=' + playingNow + ' sinceStart=' + Math.round(sinceStart),
              )
            }
          }
          if (engine.phase === 'listening') {
            vadState.inSpeech = true
            vadState.chunks = [new Float32Array(input)]
            vadState.total = input.length
            vadState.speechMs = frameMs
            vadState.silenceMs = 0
          }
        } else {
          vadState.loudMs = 0
        }
        return
      }

      // 已经在收集这一句
      vadState.chunks.push(new Float32Array(input))
      vadState.total += input.length
      if (rms > threshold) {
        vadState.silenceMs = 0
        vadState.speechMs += frameMs
      } else {
        vadState.silenceMs += frameMs
      }

      if (vadState.silenceMs >= prefs.silenceMs || vadState.total / sampleRate * 1000 >= MAX_UTTER_MS) {
        var chunks = vadState.chunks
        var total = vadState.total
        var speechMs = vadState.speechMs
        resetVadState()
        if (speechMs >= MIN_SPEECH_MS) {
          var run = runId
          finishUtterance(chunks, total, sampleRate, run)
        }
      }
    }

    /** 一句话说完：编码 WAV → Host 转写 → 投喂 Session。 */
    async function finishUtterance(chunks, total, sampleRate, run) {
      engine.set({ phase: 'transcribing', level: 0 })
      // 这句已经完整收进 chunks 了，滚动缓冲要清掉，免得下一轮打断时把上一句的尾巴
      // 又接到新句子开头。
      recentFrames.length = 0
      var text = ''
      // 诊断（2026-10-09）：用户反馈「打断之后说的『大肥鱼大肥鱼』不识别」。光看播放日志
      // 分不清是「音频压根没送出去」还是「送出去了但识别成空」，所以两头都上报。
      report(
        'stt-input',
        'chunks=' + chunks.length + ' ms=' + Math.round((total / sampleRate) * 1000) + ' rate=' + sampleRate,
      )
      try {
        var wav = encodeWav16k(chunks, total, sampleRate)
        var result = await rpc('transcribe', { audioBase64: toBase64(wav) })
        if (run !== runId) return
        text = (result && result.text) || ''
        report(
          'stt-result',
          'text=' + JSON.stringify(String(text).slice(0, 60)) + ' audioSec=' + (result && result.audioSeconds),
        )
      } catch (error) {
        if (run !== runId) return
        report('stt-error', String((error && error.message) || error).slice(0, 120))
        engine.set({ phase: 'listening', error: '识别失败：' + ((error && error.message) || error) })
        return
      }
      var cleaned = String(text).replace(/[\s。，,.!！?？]+$/g, '').trim()
      if (!cleaned) {
        // 识别成空是一条**静默**路径：用户只会觉得「本鱼不理我」。必须留痕。
        report('stt-empty', 'raw=' + JSON.stringify(String(text).slice(0, 40)))
        engine.set({ phase: 'listening', error: '' })
        return
      }
      // 用户已经开口说新的一句了：立刻掐掉上一轮还在念的朗读。
      // 关掉自动打断之后朗读不会被用户说话中断，旧内容会一直播到结尾——
      // 用户听起来就是「我说话的时候他把上一句又重复了一遍」（2026-10-09 反馈）。
      try {
        stopSpeaking()
      } catch (e) {}
      engine.set({ heard: cleaned, error: '', phase: 'thinking', reply: '' })
      turnSentences = 0
      try {
        // 诊断（2026-10-09）：把这一句投喂给了哪个会话记下来，串台时一眼就能对上。
        report('ask-session', 'sessionId=' + String(engine.sessionId) + ' text=' + cleaned.slice(0, 16))
        var asked = await rpc('ask', { sessionId: engine.sessionId, text: cleaned })
        // 用服务端给的序号对齐全局游标：这一轮只读提问之后的新增量，
        // 免得本地游标一旦对不齐就把上一轮的回复重新念一遍。
        if (asked && Number.isFinite(asked.cursor)) pollCursor = asked.cursor
      } catch (error) {
        if (run !== runId) return
        engine.set({ phase: 'listening', error: '发送失败：' + ((error && error.message) || error) })
        return
      }
      if (run !== runId) return
      startPolling(run)
    }

    /** 用户插话：立刻停朗读、取消当前 turn，回到聆听。 */
    function bargeIn() {
      console.log('[dsh-voice-call] 判定为用户插话：停止朗读并取消当前回合')
      try {
        stopSpeaking()
      } catch (e) {}
      var abandoned = runId
      runId += 1
      stopPolling()
      // 用户 2026-10-09：「我把你打断后说的话不输入」——把刚才用于判定的那段音频
      // （滚动缓冲）接到新句子开头，否则打断之后说的头一两个字会被吃掉。
      var seed = recentFrames.slice()
      recentFrames.length = 0
      // 但**不能把前面那一大段静音一起带上**：实测（2026-10-09）用户说「大肥鱼大肥鱼」
      // 被识别成 "yeah"——2.5 秒缓冲里绝大多数是静音、只有末尾一点人声，识别直接跑偏
      // （还自动判成了英文）。所以从第一帧「超过阈值」的地方开始截。
      var seedThr = (engine.prefs && engine.prefs.vadThreshold) || 0.015
      var firstLoud = -1
      for (var si = 0; si < seed.length; si++) {
        var seedAcc = 0
        for (var sj = 0; sj < seed[si].length; sj++) seedAcc += seed[si][sj] * seed[si][sj]
        if (Math.sqrt(seedAcc / seed[si].length) > seedThr) {
          firstLoud = si
          break
        }
      }
      // 往前多退 2 帧（约 250ms）：实测（2026-10-09）只从「第一帧超阈值」切，会把开头的
      // 字切掉半截——用户说「大肥鱼大肥鱼」，识别成「鱼大肥鱼」，第一个字丢了。
      if (firstLoud >= 0) seed = seed.slice(Math.max(0, firstLoud - 2))
      else seed = seed.slice(Math.max(0, seed.length - 8))
      resetVadState()
      if (seed.length) {
        vadState.inSpeech = true
        vadState.chunks = seed
        vadState.total = seed.reduce(function (n, c) { return n + c.length }, 0)
        vadState.speechMs = (vadState.total / (recentRate || 16000)) * 1000
        vadState.silenceMs = 0
      }
      engine.set({ phase: 'listening', error: '' })
      report('barge-seeded', 'frames=' + seed.length + ' ms=' + Math.round(vadState.speechMs || 0))
      Promise.resolve(rpc('cancel', { sessionId: engine.sessionId })).catch(function () {})
      void abandoned
    }

    // ---- 回复流轮询 + 朗读 ---------------------------------------------------

    function startPolling(run) {
      var startedAt = Date.now()
      stopPolling()
      var tick = async function () {
        if (run !== runId) return
        var data = null
        try {
          // 带上自己的 sessionId：host 现在按会话分桶，不带的话会退化成「最近操作的会话」，
          // 两个会话同时通话时又会串台（用户 2026-10-09 反馈的正是这个）。
          data = await rpc('poll', { cursor: pollCursor, sessionId: engine.sessionId })
        } catch (error) {
          if (run !== runId) return
          engine.set({ phase: 'listening', error: '读取回复失败：' + ((error && error.message) || error) })
          return
        }
        if (run !== runId) return
        if (data) {
          if (data.speech) engine.set({ speech: data.speech })
          var deltas = data.deltas || []
          if (deltas.length) {
            var appended = ''
            for (var i = 0; i < deltas.length; i++) appended += deltas[i].text || ''
            pollCursor = data.cursor || pollCursor
            if (appended) {
              engine.set({ reply: engine.reply + appended })
              feedSpeech(appended)
            }
          }
          // 收尾判定：至少跑 1.5s（避免 prompt 刚提交、agent 还没转 running 时误判结束），
          // 之后 Agent 不再运行、无新增量、朗读队列也空了，才算这一轮说完。
          var longEnough = Date.now() - startedAt > 1500
          if (longEnough && data.settled && !deltas.length && !speaking && !speakQueue.length) {
            // 收尾：把缓冲里剩下的最后半句也念掉。以前这里要求 speakBuffer === '' 才算完，
            // 残留半句时永远不满足，轮询就一直挂着（表现为「卡在我在想」）。
            if (speakBuffer) {
              enqueueSentence(speakBuffer)
              speakBuffer = ''
            }
            if (!speaking) {
              engine.set({ phase: 'listening' })
              stopPolling()
              return
            }
          }
        }
        pollTimer = window.setTimeout(tick, POLL_INTERVAL)
      }
      tick()
    }

    function stopPolling() {
      if (pollTimer) {
        window.clearTimeout(pollTimer)
        pollTimer = null
      }
    }

    /** 把增量文本按标点切句塞进朗读队列。 */
    function feedSpeech(text) {
      // 不再要求 synth 存在：CosyVoice 模式播放的是 Audio 元素，跟 speechSynthesis 无关。
      if (!engine.prefs.readReplies) return
      speakBuffer += text
      var guard = 0
      while (guard++ < 40) {
        // 第一句用 FIRST_CHUNK（快点出声），之后用 NEXT_CHUNK（少付固定开销）。
        var index = findBreak(speakBuffer, turnSentences === 0 ? FIRST_CHUNK : NEXT_CHUNK)
        if (index < 0) break
        var sentence = speakBuffer.slice(0, index + 1)
        speakBuffer = speakBuffer.slice(index + 1)
        turnSentences += 1
        enqueueSentence(sentence)
      }
      // 兜底：整段没有句末标点时也不能无限等（90 字约 15 秒音频）。
      if (speakBuffer.length > 90) {
        enqueueSentence(speakBuffer)
        speakBuffer = ''
      }
    }

    /**
     * 找第一个适合断句的位置；返回下标，找不到返回 -1。
     * **只在句末标点切，逗号一律不切**：CosyVoice 每合成一句都有约 2.5 秒固定开销
     * （每句都要重新处理一遍参考音频），句子越碎总开销越大，短句甚至「合成比朗读还慢」
     * ——用户听到的就是逗号处的空档（2026-10-09 实测：2 字 3.0 秒、14 字 3.7 秒、
     * 44 字 7.6 秒）。少切一句就少付一次这 2.5 秒。
     */
    // 用户 2026-10-09「你回话的响应速度能不能」：**首句**用更短的门槛（7 字）——越早切出
    // 第一句就越早出声；**后续句子**仍用 12 字，免得每句都多付约 2.5 秒的固定开销。
    var FIRST_CHUNK = 7
    var NEXT_CHUNK = 12
    /** 本轮已切出去的句子数：0 表示第一句还没发（feedSpeech 用它选门槛，finishUtterance 重置）。 */
    var turnSentences = 0

    function findBreak(text, minChunk) {
      var MIN_CHUNK = minChunk || NEXT_CHUNK
      for (var i = 0; i < text.length; i++) {
        if (i < MIN_CHUNK) continue
        var ch = text[i]
        if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '\n') return i
        if ((ch === '.' || ch === '!' || ch === '?') && i > MIN_CHUNK) return i
      }
      return -1
    }

    function enqueueSentence(text) {
      var clean = speakable(text)
      if (!clean || clean.length < 2) return
      speakQueue.push(clean)
      if (!speaking) drainSpeech()
    }

    function drainSpeech() {
      if (speaking) return
      if (!speakQueue.length) {
        if (engine.phase === 'speaking') {
          engine.set({ phase: 'thinking' })
        }
        return
      }
      var sentence = speakQueue.shift()
      // 用户在下拉里选了「大肥鱼（克隆声线）」就走本地合成服务；失败会自动回退系统语音并提示。
      if (engine.prefs.ttsEngine === 'cosy') {
        // 这一句如果已经被预取过，直接用它的结果，省掉一次等待。
        var ready = prefetch.sentence === sentence ? prefetch.promise : null
        prefetch = { sentence: null, promise: null }
        speakViaCosy(sentence, ready)
        return
      }
      if (!synth) return
      var utterance = new window.SpeechSynthesisUtterance(sentence)
      var voice = pickVoice(engine.prefs)
      if (voice) {
        utterance.voice = voice
        utterance.lang = voice.lang || 'zh-CN'
      } else {
        utterance.lang = 'zh-CN'
      }
      utterance.rate = engine.prefs.rate
      speaking = true
      var firstLineOfCall = !engine.speakStartedAt
      engine.speakStartedAt = Date.now()
      if (firstLineOfCall) {
        console.log(
          '[dsh-voice-call] 朗读语音 = ' +
            (voice ? voice.name + ' / ' + voice.lang + ' / 本地=' + (voice.localService !== false) : '系统默认'),
        )
      }
      console.log('[dsh-voice-call] 开始朗读：' + sentence.slice(0, 40))
      if (engine.phase !== 'speaking') engine.set({ phase: 'speaking' })
      utterance.onend = function () {
        speaking = false
        drainSpeech()
      }
      utterance.onerror = function () {
        speaking = false
        drainSpeech()
      }
      try {
        synth.speak(utterance)
      } catch (error) {
        speaking = false
        engine.set({ phase: 'listening', error: '朗读失败：' + ((error && error.message) || error) })
      }
    }

    /**
     * 用 CosyVoice 服务念一句：先请 Host 转去合成，拿到 wav 再本地播放。
     * 合成失败会自动回退到系统语音（并把这一句放回队首，不丢内容）。
     */
    async function speakViaCosy(sentence, ready) {
      var run = runId
      speaking = true
      var firstLineOfCall = !engine.speakStartedAt
      engine.speakStartedAt = Date.now()
      if (firstLineOfCall) console.log('[dsh-voice-call] 朗读引擎 = CosyVoice（克隆声线）')
      console.log('[dsh-voice-call] CosyVoice 合成中：' + sentence.slice(0, 30))
      if (engine.phase !== 'speaking') engine.set({ phase: 'speaking' })

      var result = null
      // 流式优先：首块 2.4 秒就能出声，比「整句合成完再播」快一倍。
      // 只有预取来的（ready 非空）才走非流式播放。
      if (!ready && engine.prefs.ttsStream !== false) {
        return speakStreamed(sentence)
      }
      try {
        if (ready) {
          console.log('[dsh-voice-call] 用预取结果播放：' + sentence.slice(0, 20))
          result = await ready
          if (!result) throw new Error('预取结果为空')
        } else {
          result = await rpc('tts', { text: sentence })
        }
      } catch (error) {
        if (run !== runId) return
        console.warn('[dsh-voice-call] CosyVoice 合成失败，回退系统语音：' + ((error && error.message) || error))
        engine.ttsMode = 'system'
        // 静默回退会让用户以为「音色坏了」，这里明确说出来：
        engine.set({ error: '克隆声线服务没响应，已暂时改用系统语音（请检查 cosy_server 是否在运行）' })
        report('cosy-fallback-system', (error && error.message) || 'error')
        speakQueue.unshift(sentence)
        speaking = false
        drainSpeech()
        return
      }
      if (run !== runId) {
        speaking = false
        return
      }

      try {
        var audio = new window.Audio('data:audio/wav;base64,' + result.audioBase64)
        cosyAudio = audio
        audio.onended = function () {
          if (cosyAudio === audio) cosyAudio = null
          speaking = false
          drainSpeech()
        }
        audio.onerror = function () {
          if (cosyAudio === audio) cosyAudio = null
          speaking = false
          engine.set({ error: 'CosyVoice 音频播放失败' })
          drainSpeech()
        }
        audio.volume = engine.prefs.volume === undefined ? 1 : engine.prefs.volume
        await audio.play()
        console.log('[dsh-voice-call] CosyVoice 播放中（这次合成耗时 ' + (result.seconds || '?') + ' 秒）')
        // 已经在出声了，趁这段时间把下一句先合成好。
        startPrefetch()
        report('cosy-playing', 'seconds=' + (result.seconds || '?') + ' b64len=' + (result.audioBase64 || '').length)
      } catch (error) {
        if (cosyAudio) {
          cosyAudio = null
        }
        speaking = false
        var why = (error && error.name ? error.name + ': ' : '') + ((error && error.message) || error)
        console.warn('[dsh-voice-call] CosyVoice 播放失败：' + why)
        report('cosy-play-failed', why)
        engine.set({ error: '播放失败：' + why })
        drainSpeech()
      }
    }

    /**
     * 用一段极短的静音 wav 解锁浏览器音频播放权限。
     * Chromium 要求播放动作挂在「用户手势」上，而通话是「点按钮 → 若干秒后才播放」，
     * 手势早过期了、play() 会被 NotAllowedError 拒掉；所以趁点击还有效先播一次静音。
     */
    function unlockAudio() {
      try {
        var silent = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA='
        var probe = new window.Audio(silent)
        probe.volume = 0
        var played = probe.play()
        if (played && typeof played.then === 'function') {
          played
            .then(function () {
              report('audio-unlocked', 'ok')
            })
            .catch(function (error) {
              report('audio-unlock-failed', (error && error.name) || 'error')
            })
        }
      } catch (error) {
        report('audio-unlock-threw', (error && error.message) || String(error))
      }
    }

    function stopSpeaking() {
      speakQueue = []
      speakBuffer = ''
      speaking = false
      engine.speakStartedAt = 0
      prefetch = { sentence: null, promise: null }
      stopStreamSources()
      if (cosyAudio) {
        try {
          cosyAudio.pause()
        } catch (e) {}
        cosyAudio = null
      }
      if (synth) {
        try {
          synth.cancel()
        } catch (e) {}
      }
    }

    // ---- 通话生命周期 --------------------------------------------------------

    async function startCall(sessionId) {
      runId += 1
      var run = runId
      pollCursor = 0 // 新通话：Host 侧缓冲同步清空，从头取
      var target = sessionId || bus.sessionId || null
      // 诊断（2026-10-09 串台排查）：记下这次通话绑到哪个会话、这个 id 是哪来的——
      // 如果 target 为空，host 会退化成「最近活动的会话」，那就可能串到别的会话去。
      report(
        'call-start',
        'target=' + String(target) + ' arg=' + String(sessionId || '') + ' bus=' + String(bus.sessionId || ''),
      )
      // 拉一次会话列表，只用于界面上「正在和谁通话」的显示。
      try {
        var list = await rpc('sessions')
        if (list && list.items) engine.set({ sessions: list.items })
      } catch (e) {}
      // **绝不能**在拿不到 sessionId 时退化成「最近活动的会话」（原来这里取 list.items[0]）——
      // 用户 2026-10-09 反馈「我在『教我写代码』会话说话，文字跑到『一』会话去了」，根因就是这：
      // 主 agent 长期在某个会话里活动，于是「最近活动的会话」永远是那一个，语音识别出来的话
      // 就被投喂到了错误的会话。拿不到就明说，不要猜。
      if (!target) {
        engine.set({
          phase: 'error',
          error: '拿不到当前会话编号，无法开始通话（这是插件的 bug，请把这句话告诉大肥鱼）',
        })
        return
      }
      engine.set({
        phase: 'connecting',
        error: '',
        heard: '',
        reply: '',
        sessionId: target,
        level: 0,
      })
      stopSpeaking()
      // 趁「点通话按钮」这次用户手势还有效，先播一段静音把音频通道解锁。
      unlockAudio()
      try {
        await openMic()
      } catch (error) {
        engine.set({ phase: 'error', error: '麦克风打开失败：' + ((error && error.message) || error) })
        return
      }
      try {
        var state = await rpc('start', { sessionId: engine.sessionId })
        if (run !== runId) return
        if (state && state.sessionId) engine.set({ sessionId: state.sessionId })
        if (state && state.speech) engine.set({ speech: state.speech })
      } catch (error) {
        engine.set({ phase: 'error', error: '启动通话失败：' + ((error && error.message) || error) })
        return
      }
      if (run !== runId) return

      // 探测外部合成服务（CosyVoice / 大肥鱼声线）：可用就切过去，否则用系统语音。
      try {
        var tts = await rpc('tts-status')
        if (tts && tts.available) {
          engine.ttsMode = 'cosy'
          console.log(
            '[dsh-voice-call] 朗读引擎 = CosyVoice 外部服务（' +
              (tts.url || '') +
              ' torch=' +
              (tts.torch || '?') +
              ' cuda=' +
              !!tts.cuda +
              '）',
          )
        } else {
          engine.ttsMode = 'system'
          console.log('[dsh-voice-call] 外部合成不可用，用系统语音：' + ((tts && tts.reason) || '未知原因'))
        }
      } catch (error) {
        engine.ttsMode = 'system'
        console.log('[dsh-voice-call] 外部合成探测失败，用系统语音：' + ((error && error.message) || error))
      }
      if (run !== runId) return

      engine.set({ phase: 'listening' })
      startStateWatch(run)
    }

    var stateTimer = null
    function startStateWatch(run) {
      stopStateWatch()
      var tick = async function () {
        if (run !== runId) return
        try {
          var state = await rpc('state', {})
          if (run !== runId) return
          if (state && state.speech) engine.set({ speech: state.speech })
        } catch (e) {}
        if (run !== runId) return
        stateTimer = window.setTimeout(tick, 1500)
      }
      tick()
    }
    function stopStateWatch() {
      if (stateTimer) {
        window.clearTimeout(stateTimer)
        stateTimer = null
      }
    }

    function endCall() {
      runId += 1
      stopPolling()
      stopStateWatch()
      stopSpeaking()
      closeMic()
      resetVadState()
      resetEngineCallState()
      Promise.resolve(rpc('stop', {})).catch(function () {})
      bus.set({ open: false })
    }

    function resetEngineCallState() {
      engine.set({ phase: 'idle', level: 0, heard: '', reply: '', error: '' })
    }

    // ================= React 组件 =================

    function Icon(props) {
      var size = props.size || 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: props.strokeWidth || 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        props.children,
      )
    }

    function PhoneIcon(props) {
      return h(
        Icon,
        props,
        h('path', { d: 'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z' }),
      )
    }

    function MicIcon(props) {
      return h(
        Icon,
        props,
        h('path', { d: 'M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z' }),
        h('path', { d: 'M19 10v1a7 7 0 0 1-14 0v-1' }),
        h('path', { d: 'M12 19v3' }),
      )
    }

    /**
     * 通话进行中，用户切到了另一个会话——把通话也跟着切过去。
     * 用户 2026-10-09：「我在那个会话说话后切来你这边说话，文字输出的还是在那个会话」——
     * 通话原本绑死在「点开通话那一刻」的会话上，切会话不会跟着走，说出来的话就进了旧会话。
     */
    function switchCallSession(next) {
      var target = next ? String(next) : ''
      if (!target || target === engine.sessionId) return
      report('call-switch', 'from=' + String(engine.sessionId || '') + ' to=' + target)
      engine.set({ sessionId: target, heard: '', reply: '' })
      pollCursor = 0
      // 让 host 把这个会话也开成通话态，并清掉它自己的增量缓冲。
      Promise.resolve(rpc('start', { sessionId: target })).catch(function () {})
    }

    /**
     * DSH 设置面板里的「语音通话」页。
     * 用户 2026-10-09：「我想加在左下角的设置这里给这个语音通话搞一个设置界面」。
     * 槽位 settings.section（list；注册参数 id/order/label；owner props 带 close）。
     */
    function VoiceCallSettings(props) {
      var prefsPair = useState(engine.prefs)
      var prefs = prefsPair[0]
      var setPrefs = prefsPair[1]
      var tickPair = useState(0)
      var setTick = tickPair[1]

      useEffect(function () {
        // 系统语音列表是异步加载的，进来刷一次，加载完再触发一次重渲染。
        refreshVoices()
        setTick(function (n) {
          return n + 1
        })
      }, [])

      var updatePrefs = function (patch) {
        var next = Object.assign({}, prefs, patch)
        setPrefs(next)
        engine.prefs = next
        savePrefs(next)
      }

      var voices = voiceList.filter(function (v) {
        var lang = String(v.lang || '').toLowerCase()
        return lang.indexOf('zh') === 0 || lang.indexOf('cmn') === 0
      })
      if (!voices.length) voices = voiceList

      var rowStyle = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '16px',
        padding: '11px 0',
        borderBottom: '1px solid var(--dsh-border, rgba(127,127,127,.16))',
      }
      var controlStyle = {
        minWidth: '180px',
        padding: '5px 8px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1, rgba(127,127,127,.3))',
        background: 'var(--dsw-alias-bg-overlay, #1b2430)',
        color: 'var(--dsw-alias-label-primary, #e8f1ff)',
        fontSize: '12px',
      }
      // <option> **必须显式配色**：不给的话深色主题下浏览器会退回系统默认的「白底白字」，
      // 未选中项直接看不见（用户 2026-10-09 截图反馈「未选中的是白色的」）。
      var optionStyle = {
        background: 'var(--dsw-alias-bg-overlay, #1b2430)',
        color: 'var(--dsw-alias-label-primary, #e8f1ff)',
      }

      var row = function (key, label, hint, control) {
        return h(
          'div',
          { key: key, style: rowStyle },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', maxWidth: '60%' } },
            h('span', { style: { fontSize: '13px', fontWeight: 500 } }, label),
            hint ? h('span', { style: { fontSize: '11px', opacity: 0.5, marginTop: '2px', lineHeight: 1.5 } }, hint) : null,
          ),
          control,
        )
      }

      var select = function (value, options, onChange) {
        return h(
          'select',
          {
            value: value,
            onChange: function (e) {
              onChange(e.target.value)
            },
            style: controlStyle,
          },
          options.map(function (o) {
            return h('option', { key: o.value, value: o.value, style: optionStyle }, o.label)
          }),
        )
      }

      var check = function (checked, onChange) {
        return h('input', {
          type: 'checkbox',
          checked: !!checked,
          onChange: function (e) {
            onChange(e.target.checked)
          },
          // 勾选框也给个主色，免得深色主题下跟背景糊在一起。
          style: {
            width: '16px',
            height: '16px',
            cursor: 'pointer',
            accentColor: 'var(--dsw-alias-brand-primary, #38bdf8)',
          },
        })
      }

      var range = function (value, min, max, step, onChange, fmt) {
        return h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '180px' } },
          h('input', {
            type: 'range',
            min: min,
            max: max,
            step: step,
            value: value,
            onChange: function (e) {
              onChange(Number(e.target.value))
            },
            style: { flex: 1 },
          }),
          h(
            'span',
            { style: { fontSize: '11px', opacity: 0.6, minWidth: '52px', textAlign: 'right' } },
            fmt ? fmt(value) : String(value),
          ),
        )
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', padding: '4px 0' } },
        h('div', { style: { fontSize: '15px', fontWeight: 600 } }, '和大肥鱼说话'),
        h(
          'div',
          { style: { fontSize: '12px', opacity: 0.55, margin: '6px 0 14px', lineHeight: 1.6 } },
          '创作者 B 站 UID：34156344，有问题或者有 bug 私信喵。',
        ),
        row(
          'engine',
          '朗读引擎',
          '克隆声线更自然，但需要本机跑着合成服务；系统语音不需要任何额外进程。',
          select(
            prefs.ttsEngine,
            [
              { value: 'cosy', label: '大肥鱼（克隆声线）' },
              { value: 'system', label: '系统语音' },
            ],
            function (v) {
              updatePrefs({ ttsEngine: v })
            },
          ),
        ),
        prefs.ttsEngine === 'system'
          ? row(
              'voice',
              '系统音色',
              '只列中文语音。名字带「在线」的那种在桌面端常常不出声，优先选本地的。',
              select(
                prefs.voiceName || '',
                [{ value: '', label: '自动（优先本地）' }].concat(
                  voices.map(function (v) {
                    return { value: v.name, label: v.name + (v.localService === false ? '（在线）' : '') }
                  }),
                ),
                function (v) {
                  updatePrefs({ voiceName: v })
                },
              ),
            )
          : null,
        row(
          'rate',
          '语速',
          null,
          range(
            prefs.rate,
            0.5,
            2,
            0.05,
            function (v) {
              updatePrefs({ rate: v })
            },
            function (v) {
              return v.toFixed(2) + '×'
            },
          ),
        ),
        row(
          'silence',
          '停顿多久算说完',
          '太短会抢话，太长会觉得迟钝。',
          range(
            prefs.silenceMs,
            400,
            3000,
            50,
            function (v) {
              // 标记「用户调过」，否则下次加载会被默认值盖回来。
              updatePrefs({ silenceMs: v, silenceMsTouched: true })
            },
            function (v) {
              return v + ' ms'
            },
          ),
        ),
        row(
          'vad',
          '识别灵敏度',
          '环境吵就调高一点。',
          range(
            prefs.vadThreshold,
            0.005,
            0.08,
            0.005,
            function (v) {
              updatePrefs({ vadThreshold: v })
            },
            function (v) {
              return v.toFixed(3)
            },
          ),
        ),
        row(
          'barge',
          '允许插话打断',
          '你说话时立刻停下——既打断朗读，也打断思考。',
          check(prefs.bargeIn, function (v) {
            updatePrefs({ bargeIn: v })
          }),
        ),
        row(
          'read',
          '朗读回复',
          '关掉就只在界面显示文字，不出声。',
          check(prefs.readReplies, function (v) {
            updatePrefs({ readReplies: v })
          }),
        ),
        row(
          'stream',
          '流式合成',
          '首字更快，但句子之间可能出现空档（实测过，默认建议关）。',
          check(prefs.ttsStream, function (v) {
            updatePrefs({ ttsStream: v })
          }),
        ),
        h(
          'div',
          { style: { marginTop: '18px', display: 'flex', alignItems: 'center', gap: '12px' } },
          h(
            'button',
            {
              type: 'button',
              onClick: function () {
                var defaults = Object.assign({}, DEFAULT_PREFS)
                setPrefs(defaults)
                engine.prefs = defaults
                savePrefs(defaults)
              },
              style: overlayGhostButton,
            },
            '恢复默认',
          ),
          h('span', { style: { fontSize: '11px', opacity: 0.5 } }, '克隆声线用的是你训练的那套音色。'),
        ),
      )
    }

    /** 输入框工具栏里的通话按钮。 */
    function VoiceCallButton(props) {
      useBus()
      var sessionId =
        (props && (props.sessionId || (props.session && props.session.id))) || null
      var ref = useRef(sessionId)
      ref.current = sessionId
      useEffect(
        function () {
          if (!sessionId) return
          bus.set({ sessionId: sessionId })
          // 通话进行中切了会话 → 通话跟着切过去（否则说出来的话还进旧会话）。
          if (bus.open) switchCallSession(sessionId)
        },
        [sessionId],
      )
      var active = engine.phase !== 'idle' && engine.phase !== 'error'
      var style = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        height: '28px',
        padding: '0 10px',
        borderRadius: '999px',
        border: '1px solid ' + (active ? 'rgba(56,189,248,.55)' : 'var(--dsh-border, rgba(127,127,127,.3))'),
        background: active ? 'rgba(56,189,248,.14)' : 'transparent',
        color: active ? 'rgb(56,189,248)' : 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: 1,
        whiteSpace: 'nowrap',
      }
      return h(
        'button',
        {
          type: 'button',
          style: style,
          title: active ? '通话中：点一下挂断' : '语音通话（点击开始）',
          onClick: function () {
            if (!bus.open) {
              // 开始通话。浮窗现在只有一个角色立绘，点一次她就出现。
              bus.set({ open: true, panel: true, sessionId: ref.current || bus.sessionId })
            } else {
              // 已在通话：界面上没有别的挂断入口了，这一下就是挂断。
              bus.set({ open: false })
            }
          },
        },
        h(PhoneIcon, { size: 14 }),
        h('span', null, active ? '通话中' : '通话'),
      )
    }

    /** 状态文案。 */
    function phaseText(phase, speech) {
      switch (phase) {
        case 'connecting':
          return '正在接通…'
        case 'listening':
          return '我在听，你说话就行'
        case 'transcribing':
          return '听到了，正在转成文字…'
        case 'thinking':
          return '我在想…'
        case 'speaking':
          return '我在说（插话可以直接打断我）'
        case 'error':
          return '出问题了'
        default:
          return speech && speech.available ? '准备好了' : '待接通'
      }
    }

    /** 当前通话对象的可读名字。 */
    function sessionLabel(state) {
      var id = state && state.sessionId
      if (!id) return '（自动选择会话）'
      var found = null
      var list = (state && state.sessions) || []
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].sessionId === id) {
          found = list[i]
          break
        }
      }
      if (found && found.title) return found.title
      if (found && found.cwd) {
        var parts = String(found.cwd).split(/[\\/]/).filter(Boolean)
        if (parts.length) return parts[parts.length - 1]
      }
      return String(id).slice(0, 8)
    }

    /** 全屏通话层。 */
    function VoiceCallOverlay(props) {
      useBus()
      var tick = useState(0)
      var bump = tick[1]
      useEffect(function () {
        return engine.subscribe(function () {
          bump(function (n) {
            return n + 1
          })
        })
      }, [])
      var settingsPair = useState(false)
      var settingsOpen = settingsPair[0]
      var setSettingsOpen = settingsPair[1]
      var prefsPair = useState(engine.prefs)
      var prefs = prefsPair[0]
      var setPrefs = prefsPair[1]
      // 浮窗位置：null = 停在默认的右下角；拖过标题栏后变成绝对坐标。
      var posPair = useState(null)
      var pos = posPair[0]
      var setPos = posPair[1]
      var startDrag = function (event) {
        var card = event.currentTarget.closest('[data-voice-call-card]')
        if (!card) return
        event.preventDefault()
        var rect = card.getBoundingClientRect()
        var offsetX = event.clientX - rect.left
        var offsetY = event.clientY - rect.top
        var move = function (e) {
          setPos({
            x: Math.min(Math.max(0, e.clientX - offsetX), window.innerWidth - 120),
            y: Math.min(Math.max(0, e.clientY - offsetY), window.innerHeight - 60),
          })
        }
        var up = function () {
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }

      var open = bus.open
      var prevOpen = useRef(false)
      useEffect(
        function () {
          if (open && !prevOpen.current) {
            prevOpen.current = true
            startCall(bus.sessionId)
          } else if (!open && prevOpen.current) {
            prevOpen.current = false
            endCall()
          }
          return function () {}
        },
        [open],
      )

      // 卸载（插件停用 / 页面卸载）时收尾
      useEffect(function () {
        return function () {
          endCall()
        }
      }, [])

      if (!open) return null

      var phase = engine.phase
      var speech = engine.speech
      var prep = speech && speech.preparation
      var downloading = prep && prep.phase === 'downloading'
      var failed = prep && prep.phase === 'failed'
      // 默认不弹窗（用户明确说「不想要这个黑色的小窗口」）；只有他主动叫出来、
      // 或者有非说不可的信息（错误、模型下载进度）时才出现。
      if (!bus.panel && !engine.error && !downloading && !failed) return null
      var percent =
        downloading && prep.totalBytes ? Math.min(100, Math.round((prep.completedBytes / prep.totalBytes) * 100)) : null
      var accent = phase === 'speaking' ? 'rgb(56,189,248)' : phase === 'listening' ? 'rgb(52,211,153)' : 'rgb(148,163,184)'

      var updatePrefs = function (patch) {
        var next = Object.assign({}, prefs, patch)
        setPrefs(next)
        engine.prefs = next
        savePrefs(next)
      }

      var voices = voiceList.filter(function (v) {
        var lang = String(v.lang || '').toLowerCase()
        return lang.indexOf('zh') === 0 || lang.indexOf('cmn') === 0
      })
      if (!voices.length) voices = voiceList

      // ── 极简形态（用户 2026-10-09 选定：只留角色本人，什么按钮都不要）──────────
      // 界面上只有她：没有卡片、没有圆环、没有按钮、没有字幕。按住她可以拖走。
      // 要挂断就再点一下输入框那个「通话」按钮。
      // 只有出错或识别模型下载中才额外显示一行小字——否则真出问题你无从察觉。
      // 注意：下面那套完整浮窗（状态栏/字幕/按钮/设置）保留但不执行；
      // 想恢复原样，把这个 return 整段删掉即可。
      return h(
        'div',
        {
          'data-voice-call-card': '1',
          style: {
            position: 'fixed',
            left: pos ? pos.x + 'px' : 'auto',
            top: pos ? pos.y + 'px' : 'auto',
            right: pos ? 'auto' : '24px',
            bottom: pos ? 'auto' : '24px',
            zIndex: 2000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '10px',
            cursor: 'move',
            userSelect: 'none',
            background: 'transparent',
          },
        },
        h('img', {
          src: RPC_CHANNEL + '/avatar?v=' + avatarVersion,
          alt: '大肥鱼',
          draggable: false,
          onMouseDown: startDrag,
          // 探针：把实际请求的地址与加载结果报到 host 日志，用来定位「换了图却看不到」——
          // 到底是浏览器压根没请求、请求失败，还是请求了另一个地址。
          onLoad: function () {
            report('avatar-loaded', RPC_CHANNEL + '/avatar?v=' + avatarVersion)
          },
          onError: function (event) {
            report('avatar-error', String((event && event.target && event.target.src) || 'unknown').slice(0, 200))
          },
          title: '按住可以拖走；要挂断就点输入框那个「通话」按钮',
          style: {
            width: '190px',
            height: '190px',
            objectFit: 'contain',
            // 说话时轻轻放大一点，像在应声；不说话时回到原大小。
            transform: 'scale(' + (1 + engine.level * 0.18).toFixed(3) + ')',
            transition: 'transform .12s ease',
            // 用户 2026-10-09：「为什么那个黑圈还在」——就是这里的 drop-shadow 黑色投影，
            // 它沿立绘的 alpha 轮廓描了一圈黑边。立绘本身是干净的（白底检查过，边缘无黑边）。
            // 说话时只留一点蓝色光晕做状态提示，其余时候一点阴影都不加。
            filter: phase === 'speaking' ? 'drop-shadow(0 0 18px rgba(56,189,248,.55))' : 'none',
          },
        }),
        engine.error
          ? h(
              'div',
              {
                style: {
                  maxWidth: '260px',
                  padding: '6px 10px',
                  borderRadius: '10px',
                  background: 'rgba(12,20,36,.92)',
                  border: '1px solid rgba(248,113,113,.45)',
                  color: '#fca5a5',
                  fontSize: '12px',
                  lineHeight: 1.5,
                  textAlign: 'center',
                },
              },
              engine.error,
            )
          : null,
        downloading
          ? h(
              'div',
              {
                style: {
                  maxWidth: '260px',
                  padding: '6px 10px',
                  borderRadius: '10px',
                  background: 'rgba(12,20,36,.92)',
                  border: '1px solid rgba(120,170,255,.35)',
                  color: '#cfe2ff',
                  fontSize: '12px',
                  textAlign: 'center',
                },
              },
              '正在下载本地识别模型…' + (percent === null ? '' : ' ' + percent + '%'),
            )
          : null,
      )

      // ── 以下是原来的完整浮窗（当前不可达，留作回退）──────────────────────────
      return h(
        'div',
        {
          'data-voice-call-card': '1',
          style: {
            position: 'fixed',
            // 右下角小浮窗：不遮住主界面，可以一边通话一边看别的内容；标题栏可拖动。
            left: pos ? pos.x + 'px' : 'auto',
            top: pos ? pos.y + 'px' : 'auto',
            right: pos ? 'auto' : '18px',
            bottom: pos ? 'auto' : '18px',
            width: '340px',
            maxHeight: '74vh',
            zIndex: 2000,
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
            padding: '12px',
            borderRadius: '16px',
            border: '1px solid rgba(120,170,255,.22)',
            background: 'linear-gradient(180deg, rgba(14,25,45,.97), rgba(6,12,24,.985))',
            boxShadow: '0 18px 48px rgba(0,0,0,.55)',
            color: '#e8f1ff',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
            backdropFilter: 'blur(8px)',
            overflow: 'hidden',
          },
        },
        // 顶部：状态 + 设置 + 收起
        h(
          'div',
          {
            onMouseDown: startDrag,
            title: '按住这里可以拖动窗口',
            style: {
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '8px',
              cursor: 'move',
              userSelect: 'none',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
            h('span', {
              style: {
                width: '9px',
                height: '9px',
                borderRadius: '50%',
                background: accent,
                boxShadow: '0 0 12px ' + accent,
              },
            }),
            h('span', { style: { fontSize: '13px', letterSpacing: '.4px', opacity: 0.85 } }, phaseText(phase, speech)),
            h('span', { style: { fontSize: '12px', opacity: 0.5 } }, '· 通话对象：' + sessionLabel(engine)),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            h(
              'button',
              {
                type: 'button',
                style: overlayGhostButton,
                onClick: function () {
                  setSettingsOpen(!settingsOpen)
                },
              },
              '设置',
            ),
            h(
              'button',
              {
                type: 'button',
                style: overlayGhostButton,
                onClick: function () {
                  // 只隐藏窗口，通话继续。（以前这里误写成 open:false —— 点「收起」等于挂断。）
                  bus.set({ panel: false })
                },
              },
              '隐藏窗口（通话继续）',
            ),
          ),
        ),

        // 中部：声波 + 字幕
        h(
          'div',
          { style: { flex: 1, width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', minHeight: '140px' } },
          h(
            'div',
            {
              style: {
                position: 'relative',
                width: '104px',
                height: '104px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(120,180,255,.18)',
                background: 'radial-gradient(circle at 50% 45%, rgba(56,189,248,.16), rgba(8,16,32,.2) 65%)',
                boxShadow: 'inset 0 0 60px rgba(56,189,248,.10)',
                transition: 'transform .12s ease',
                transform: 'scale(' + (1 + engine.level * 0.10).toFixed(3) + ')',
              },
            },
            h(
              'div',
              {
                style: {
                  position: 'absolute',
                  inset: '-14px',
                  borderRadius: '50%',
                  border: '1px solid ' + accent,
                  opacity: 0.15 + Math.min(0.55, engine.level * 1.4),
                  transition: 'opacity .1s linear',
                },
              },
            ),
            // 抠好的角色立绘（host 的 /dsh-voice-call/avatar 提供），随音量轻微缩放，像在应声。
            h('img', {
              src: RPC_CHANNEL + '/avatar?v=' + avatarVersion,
              alt: '大肥鱼',
              draggable: false,
              style: {
                width: '88px',
                height: '88px',
                objectFit: 'contain',
                filter: 'drop-shadow(0 6px 18px rgba(0,0,0,.5))',
                transform: 'scale(' + (1 + engine.level * 0.16).toFixed(3) + ')',
                transition: 'transform .12s ease',
                pointerEvents: 'none',
                userSelect: 'none',
              },
            }),
          ),
          h(
            'div',
            { style: { width: '100%', textAlign: 'left', minHeight: '56px' } },
            engine.heard
              ? h(
                  'div',
                  { style: { fontSize: '14px', opacity: 0.6, marginBottom: '10px' } },
                  '你说：',
                  engine.heard,
                )
              : null,
            h(
              'div',
              {
                style: {
                  fontSize: '14px',
                  lineHeight: 1.6,
                  minHeight: '40px',
                  color: engine.reply ? '#eaf4ff' : 'rgba(232,241,255,.35)',
                  whiteSpace: 'pre-wrap',
                  maxHeight: '24vh',
                  overflowY: 'auto',
                },
              },
              engine.reply || (phase === 'listening' ? '（我在听，说完停顿一下就行）' : ''),
            ),
          ),
          engine.error
            ? h(
                'div',
                { style: { fontSize: '13px', color: '#fca5a5', textAlign: 'center', maxWidth: '520px' } },
                engine.error,
              )
            : null,
          downloading
            ? h(
                'div',
                { style: { width: '100%', maxWidth: '420px', textAlign: 'center' } },
                h('div', { style: { fontSize: '13px', opacity: 0.8, marginBottom: '8px' } }, '首次使用：正在下载本地语音识别模型（约 229 MB）…'),
                h(
                  'div',
                  { style: { height: '6px', borderRadius: '999px', background: 'rgba(255,255,255,.12)', overflow: 'hidden' } },
                  h('div', {
                    style: {
                      height: '100%',
                      width: (percent === null ? 8 : percent) + '%',
                      background: accent,
                      transition: 'width .3s ease',
                    },
                  }),
                ),
                percent === null
                  ? null
                  : h('div', { style: { fontSize: '12px', opacity: 0.6, marginTop: '6px' } }, percent + '%'),
              )
            : null,
          failed
            ? h(
                'div',
                { style: { fontSize: '13px', color: '#fca5a5', textAlign: 'center', maxWidth: '520px' } },
                '识别模型准备失败：',
                prep.message || '未知原因',
              )
            : null,
        ),

        // 底部：控制
        h(
          'div',
          { style: { width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' } },
          settingsOpen
            ? h(
                'div',
                {
                  style: {
                    width: '100%',
                    borderRadius: '14px',
                    border: '1px solid rgba(148,163,184,.25)',
                    background: 'rgba(10,18,32,.72)',
                    padding: '14px 16px',
                    display: 'grid',
                    gap: '12px',
                    fontSize: '13px',
                  },
                },
                h(
                  'label',
                  { style: settingsRow },
                  h('span', null, '朗读音色'),
                  h(
                    'select',
                    {
                      style: settingsControl,
                      value: prefs.ttsEngine === 'cosy' ? '__cosy__' : 'sys:' + prefs.voiceName,
                      onChange: function (event) {
                        var value = event.target.value
                        if (value === '__cosy__') {
                          updatePrefs({ ttsEngine: 'cosy' })
                        } else {
                          updatePrefs({ ttsEngine: 'system', voiceName: value.slice(4) })
                        }
                      },
                    },
                    h('option', { value: '__cosy__' }, '大肥鱼（克隆声线）'),
                    h('option', { value: 'sys:' }, '系统默认（自动挑中文女声）'),
                    voices.map(function (voice) {
                      return h('option', { key: voice.name, value: 'sys:' + voice.name }, voice.name + ' · ' + voice.lang)
                    }),
                  ),
                ),
                h(
                  'label',
                  { style: settingsRow },
                  h('span', null, '语速 ' + prefs.rate.toFixed(2) + '×'),
                  h('input', {
                    type: 'range',
                    min: '0.7',
                    max: '1.6',
                    step: '0.05',
                    value: prefs.rate,
                    style: { width: '120px' },
                    onChange: function (event) {
                      updatePrefs({ rate: Number(event.target.value) })
                    },
                  }),
                ),
                h(
                  'label',
                  { style: settingsRow },
                  h('span', null, '麦克风灵敏度 ' + prefs.vadThreshold.toFixed(3)),
                  h('input', {
                    type: 'range',
                    min: '0.004',
                    max: '0.05',
                    step: '0.001',
                    value: prefs.vadThreshold,
                    style: { width: '120px' },
                    onChange: function (event) {
                      updatePrefs({ vadThreshold: Number(event.target.value) })
                    },
                  }),
                ),
                h(
                  'label',
                  { style: settingsRow },
                  h('span', null, '停顿多久算说完 ' + prefs.silenceMs + ' ms'),
                  h('input', {
                    type: 'range',
                    min: '400',
                    max: '2000',
                    step: '50',
                    value: prefs.silenceMs,
                    style: { width: '120px' },
                    onChange: function (event) {
                      updatePrefs({ silenceMs: Number(event.target.value) })
                    },
                  }),
                ),
                h(
                  'label',
                  { style: settingsRow },
                  h('span', null, '允许插话打断'),
                  h('input', {
                    type: 'checkbox',
                    checked: !!prefs.bargeIn,
                    onChange: function (event) {
                      updatePrefs({ bargeIn: event.target.checked })
                    },
                  }),
                ),
                h(
                  'label',
                  { style: settingsRow },
                  h('span', null, '朗读回复'),
                  h('input', {
                    type: 'checkbox',
                    checked: !!prefs.readReplies,
                    onChange: function (event) {
                      updatePrefs({ readReplies: event.target.checked })
                    },
                  }),
                ),
              )
            : null,
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '12px' } },
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, pillButton, {
                  opacity: engine.muted ? 0.55 : 1,
                }),
                title: engine.muted ? '取消静音' : '静音麦克风',
                onClick: function () {
                  engine.set({ muted: !engine.muted })
                },
              },
              h(MicIcon, { size: 18 }),
            ),
            h(
              'button',
              {
                type: 'button',
                style: Object.assign({}, pillButton, {
                  background: 'rgba(239,68,68,.9)',
                  borderColor: 'rgba(239,68,68,.9)',
                  color: '#fff',
                  padding: '0 26px',
                }),
                title: '挂断',
                onClick: function () {
                  bus.set({ open: false })
                },
              },
              h(PhoneIcon, { size: 18, style: { transform: 'rotate(135deg)' } }),
              h('span', { style: { marginLeft: '6px' } }, '挂断'),
            ),
            h(
              'button',
              {
                type: 'button',
                style: pillButton,
                title: '打断当前回复',
                onClick: function () {
                  bargeIn()
                },
              },
              '打断',
            ),
          ),
          h(
            'div',
            { style: { fontSize: '11px', opacity: 0.45, textAlign: 'center' } },
            '语音识别在本机运行，录音不出这台机器；朗读使用系统语音。',
          ),
        ),
      )
    }

    var overlayGhostButton = {
      padding: '6px 12px',
      borderRadius: '999px',
      border: '1px solid rgba(148,163,184,.3)',
      background: 'transparent',
      color: 'inherit',
      fontSize: '12px',
      cursor: 'pointer',
    }
    var pillButton = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '46px',
      minWidth: '46px',
      padding: '0 16px',
      borderRadius: '999px',
      border: '1px solid rgba(148,163,184,.32)',
      background: 'rgba(20,32,52,.85)',
      color: 'inherit',
      fontSize: '14px',
      cursor: 'pointer',
    }
    var settingsRow = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '14px',
    }
    var settingsControl = {
      minWidth: '110px',
      maxWidth: '150px',
      padding: '4px 8px',
      borderRadius: '8px',
      border: '1px solid rgba(148,163,184,.3)',
      background: 'rgba(8,14,26,.9)',
      color: 'inherit',
    }

    // ================= 插件入口 =================

    /**
     * client → host 调用器。
     * 直接 POST 到插件自己注册的 HTTP 路由（同源、随浏览器凭据），
     * 不用 connection.rpc —— 那条通道是 Host 内部 RPC 的键，浏览器侧发真 HTTP 会被
     * SPA fallback 以 405 挡回。
     */
    function makeCaller(ctx) {
      void ctx
      return function call(endpoint, payload) {
        return window
          .fetch(RPC_CHANNEL + '/' + endpoint, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload || {}),
          })
          .then(function (response) {
            if (!response.ok) {
              if (response.status === 405 || response.status === 404) {
                throw new Error(
                  'Host 没有这个路由（HTTP ' +
                    response.status +
                    '）——插件的 Host 半边可能没加载，重启一次 DSH 再试',
                )
              }
              if (response.status === 401 || response.status === 403) {
                throw new Error('没有通过 DSH 鉴权（HTTP ' + response.status + '）')
              }
              throw new Error('HTTP ' + response.status)
            }
            return response.json()
          })
          .then(function (data) {
            if (data && typeof data === 'object' && 'ok' in data) {
              if (!data.ok) throw new Error((data.error && data.error.message) || '调用失败')
              return data.value
            }
            return data
          })
      }
    }

    /**
     * 向 Host 上报一行诊断（Host 写进 `~\.dsh\dsh-voice-call-diag.log`）。
     * 用途：确认浏览器半边到底有没有跑起来——如果模块压根没被装配进页面，
     * 日志里一行 `client report` 都不会出现，据此可把「Host 侧问题」与
     * 「浏览器侧问题」一刀切开。
     */
    function report(stage, detail) {
      try {
        if (typeof engine.call !== 'function') return
        Promise.resolve(engine.call('client-report', { stage: stage, detail: detail || '' })).catch(function () {})
      } catch (e) {}
    }

    /** slots 服务是否可用。 */
    function isSlots(value) {
      return !!value && typeof value.inject === 'function' && typeof value.register === 'function'
    }

    /** 真正把两个槽位挂上去：三条取用路径最后都汇到这里。 */
    function registerSlots(slots, via) {
      console.log('[dsh-voice-call] slots 已取得（' + via + '），开始挂载界面')
      report('slots-ok', via)
      try {
        slots.inject('conversation.input.activity', function () {
          return slots.register(
            // single slot：注册参数只有 name（官方语音输入在同一个槽位也是这么注册的）。
            { name: 'conversation.input.activity' },
            VoiceCallButton,
          )
        })
      } catch (error) {
        console.warn('[dsh-voice-call] 通话按钮挂载失败', (error && error.message) || error)
        report('button-failed', (error && error.message) || String(error))
      }
      try {
        slots.inject('shell.overlay', function () {
          return slots.register(
            { name: 'shell.overlay', id: 'voice-call-overlay', order: 20, label: '语音通话层' },
            VoiceCallOverlay,
          )
        })
      } catch (error) {
        console.warn('[dsh-voice-call] 通话层挂载失败', (error && error.message) || error)
        report('overlay-failed', (error && error.message) || String(error))
      }
      try {
        slots.inject('settings.section', function () {
          return slots.register(
            // list 槽位：id 必须用自己的（撞上现成的 id 会顶掉那一格），order 决定在设置左侧的位置。
            // 现有占用：general 0 / models 10 / plugins 15 / agent-presets 20 / meow-memory 35 / market 40。
            { name: 'settings.section', id: 'voice-call', order: 30, label: '和大肥鱼说话' },
            VoiceCallSettings,
          )
        })
      } catch (error) {
        console.warn('[dsh-voice-call] 设置页挂载失败', (error && error.message) || error)
        report('settings-failed', (error && error.message) || String(error))
      }
      report('slots-registered')
    }

    function apply(ctx) {
      engine.call = makeCaller(ctx)
      engine.prefs = loadPrefs()
      report('apply-start')

      // 取 slots 的三条路径，按可靠性排序（都不成立才放弃）：
      //  1) ctx.slots —— 靠模块底部 exports.inject = ['slots'] 声明，Cordis 会等它就绪再调 apply；
      //  2) ctx.get('slots') —— 受限 Context 下未声明依赖时会返回 undefined；
      //  3) ctx.inject(['slots'], cb) —— 运行时等待，官方客户端插件的 mountVoiceInput 也用这招。
      var direct = (ctx && ctx.slots) || (ctx && ctx.get ? ctx.get('slots') : undefined)
      if (isSlots(direct)) {
        registerSlots(direct, 'ctx.slots')
        return
      }
      if (ctx && typeof ctx.inject === 'function') {
        report('slots-wait-via-inject')
        try {
          ctx.inject(['slots'], function (scoped) {
            var late = (scoped && scoped.slots) || (scoped && scoped.get ? scoped.get('slots') : undefined)
            if (isSlots(late)) registerSlots(late, 'ctx.inject')
            else {
              console.warn('[dsh-voice-call] ctx.inject 回调里仍然拿不到 slots 服务')
              report('slots-still-missing')
            }
          })
          return
        } catch (error) {
          console.warn('[dsh-voice-call] ctx.inject 调用失败', (error && error.message) || error)
          report('inject-call-failed', (error && error.message) || String(error))
        }
      }
      console.warn('[dsh-voice-call] slots 服务不可用，通话界面未挂载')
      report('slots-unavailable')
    }

    exports.apply = apply
    // 硬依赖声明：受限 Context 下必须先导出 inject，Cordis 才会等 slots 就绪再调用 apply，
    // 否则 ctx.get('slots') 恒为 undefined。官方客户端插件同样导出 inject，
    // 形如 const inject = ["remote","slots","locale","pluginNavigation"]。
    exports.inject = ['slots']

    // 调试出口：在 DevTools 里可直接自检音频链路（手工点按钮不方便时用）。
    //   __dshVoiceCall.engine.phase           当前阶段
    //   __dshVoiceCall.selfTest()             跑一遍 WAV 编码 / 分句 / 语音列表自检
    try {
      window.__dshVoiceCall = {
        engine: engine,
        bus: bus,
        encodeWav16k: encodeWav16k,
        speakable: speakable,
        findBreak: findBreak,
        voices: function () {
          refreshVoices()
          return voiceList.map(function (v) {
            return { name: v.name, lang: v.lang, local: v.localService }
          })
        },
        selfTest: function () {
          var rate = 48000
          var seconds = 1
          var chunks = [new Float32Array(rate * seconds)]
          for (var i = 0; i < chunks[0].length; i++) {
            chunks[0][i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5
          }
          var wav = encodeWav16k(chunks, chunks[0].length, rate)
          var head = String.fromCharCode(wav[0], wav[1], wav[2], wav[3])
          var view = new DataView(wav.buffer)
          return {
            wavBytes: wav.length,
            expectBytes: 44 + TARGET_RATE * seconds * 2,
            head: head,
            sampleRate: view.getUint32(24, true),
            breakAt: findBreak('这是一句测试。后面还有'),
            speakable: speakable('**加粗** `代码` 你好 🐋'),
            voices: window.__dshVoiceCall.voices(),
          }
        },
      }
    } catch (e) {}

    return module.exports
  },
})
