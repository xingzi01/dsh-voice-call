# dsh-voice-call

DSH 的**语音通话**插件：点一下电话按钮，直接跟 agent 说话，回复边生成边念出来，可以随时插话打断。

- 安装：以 link / junction 方式接入 `profiles\desktop\node_modules`，并在 profile 的 `dsh.profile.bundles` 里登记
- 安装脚本：`tools\install.ps1`（幂等，先备份 profile 清单再动手）
- 状态：v0.1.0，2026-10-09。Host 半边与浏览器半边均已实测通过（`state` / `sessions` 返回 200，
  自检 `match = HIT`、`listening = 127.0.0.1:19387`；输入框按钮与全屏通话层正常出现）。

## 它做了什么

| 环节 | 实现 | 花钱吗 |
| --- | --- | --- |
| 听（STT） | DSH 官方本地识别器 `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice`（SenseVoiceSmall + Silero VAD，纯 CPU） | 不花钱，录音不出本机 |
| 说（TTS） | 浏览器 `speechSynthesis`（Windows 上即系统语音，中文是 Microsoft Huihui） | 不花钱 |
| 断句 | 浏览器侧能量 VAD，静音 850 ms 判为说完 | — |
| 回复流 | Host 侧订阅 `agent/assistant-stream`，按标点切句送给朗读 | — |

通话进行中会向 systemPrompt 注入一段约束，让模型**口语化、短句、不用 Markdown/表格/代码块**——因为回复是要被念出来的。

## 界面落点

- `conversation.input.activity`：输入框工具栏里的「通话」按钮
- `shell.overlay`：全屏通话层（声波圆环 + 实时字幕 + 挂断/打断/静音 + 设置）

## 依赖与首次使用

`cordis.patch.yml` 会连带插入官方语音三件套（识别服务、SenseVoice provider、Remote API）。
其中 provider 的模型缓存目录写在 `dataRoot`（默认 `~\.dsh\speech-to-text\sensevoice`）。

**首次通话会下载约 229 MB 的识别模型**（int8 权重 239 MB + 词表 + VAD），
进度在通话层里以进度条显示，走 HuggingFace（失败会自动试 hf-mirror）。
下载完成后模型常驻磁盘，重启不再下载。

## Host 接口

浏览器半边通过 HTTP 调 Host：`POST /dsh-voice-call/<endpoint>`，JSON 请求体，
响应统一是 `{ok:true,value}` / `{ok:false,error}` 信封。端点有 `state` / `sessions` /
`start` / `stop` / `prepare` / `transcribe` / `ask` / `cancel` / `poll`。

**注册方式有讲究（踩过的坑）**：必须写成

```js
ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
```

**不要**写成 `ctx.inject(['webServer'], (c) => c.webServer.register(...))`。在 Cordis 4 里
`ctx.inject(deps, cb)` 的语义是「起一个子插件并等待依赖」，依赖没就绪时回调**静默不执行、也不报错**，
表现是插件 fiber 明明 `active`、路由却一条都没进路由表，请求全落到 SPA fallback
（POST 一律 405、GET 一律 404）。官方 `dsh-image-gen` 用的就是上面那种同步写法。

加载期会写诊断日志 `~\.dsh\dsh-voice-call-diag.log`（每次 apply 覆盖重写），
里面能看到 `apply start`、`webServer=yes/no`、`route registered`、`match = HIT/MISS`、
`listening = {...}` 这些行——路由没生效时先看它。

### 前缀千万别用 `/plugins`（第二次踩的坑）

`dsh-client-modules` 把**每个插件的浏览器 bundle** 注册在 `/plugins` 这条 prefix 路由下，
URL 形如 `/plugins/<包名>/<文件>?rev=...`；而 webserver 的匹配规则是**最长前缀优先**。

于是 API 前缀一旦取成 `/plugins/dsh-voice-call`，就会把**自己的 client.js 请求**抢走：
浏览器去取 bundle → 命中本插件路由 → GET 被回 405 → **client 半边整体加载失败**。
现象极具迷惑性：host 端点 curl 全是 200、诊断日志写着注册成功、插件 fiber 也是 `active`，
但输入框按钮和通话层完全不出现，`cordis_inspect_query` 里 `conversation.input.activity`
与 `shell.overlay` 的 occupants 都是空的。

自查一条命令（若返回本插件自己的 `{"ok":false,...}` 405，就说明又重叠了）：

    curl -i http://127.0.0.1:19387/plugins/dsh-voice-call/client.js

## 排查

浏览器 DevTools 控制台里有调试出口：

```js
__dshVoiceCall.engine.phase     // idle / connecting / listening / transcribing / thinking / speaking / error
__dshVoiceCall.selfTest()       // 自检 WAV 编码、断句、文本清洗、可用语音列表
__dshVoiceCall.voices()         // 当前浏览器可见的语音
```

常见现象：

- **按钮没出现**：插件没被加载。检查 `profiles\desktop\package.json` 的 `dsh.profile.bundles`
  里有 `dsh-voice-call`，以及 junction 是否还在。
- **点了通话报 405 / 404**：Host 路由没注册（见上面「注册方式有讲究」）。
  先看 `~\.dsh\dsh-voice-call-diag.log`；确认代码没问题就重启 DSH
  （`plugin_manager` 的禁用/启用**不会**重新加载模块代码，只改 profile 补丁）。
- **识别报错 / 一直转圈**：模型没下完，或 `speechToText` 没有 provider（三件套没生效）。
- **没有中文语音**：系统没装中文语音包，此时朗读会退回默认音色或静音。

## 卸载 / 回滚

```
Remove-Item "$env:DSH_HOME\profiles\desktop\node_modules\dsh-voice-call" -Force
# 再把 package.json 里 dependencies 的 dsh-voice-call 和 bundles 里的同名项删掉，
# 或直接用安装时的备份目录 _backup_voice-call-<时间戳> 覆盖回去
```

## 与官方语音输入 bundle 的关系

本插件 patch 里已经插入了官方语音识别三件套（id 分别是 `speech-to-text`、
`speech-to-text-sensevoice`、`api-speech-to-text`），**故意没有**插入官方那个
`@deepseek-ai/dsh-experimental-voice-input-bundle`——它与本插件 id 冲突，
两者只能有一个。本插件的通话按钮已经覆盖语音输入场景。

## 素材与授权

本仓库分两部分，授权范围不同，请分开看待。

**代码**（`lib/`、`cordis.patch.yml`、`tools/`）以 **MIT** 许可发布，见 [LICENSE](LICENSE)。

**角色立绘**（`assets/avatar.png`）**不是本插件原创**：

- 形象属于「**蓝色大肥鱼**」，即社区共用的 **DeepSeek 娘**二创形象（非某个作者的独占角色）
- 原图出自社区档案 [EDMOK/blue-fish-archive](https://github.com/EDMOK/blue-fish-archive/blob/main/media/a2353f9af593df8c76bdcd29bf47ad69.jpg)，
  并在[蓝色大肥鱼 · AI 娘二创开放档案](https://xn--pssy23qgqgbz2d718b.com/works/deepseek202609150119.html)（《头顶不锈钢盆》）中收录
- 该档案页标注「**原作者未标注 / 授权状态不明**」；本插件使用的版本是在原图基础上经 **AI 重绘与抠图**处理的派生图
- **图片版权归原作者所有**，本仓库的 MIT 许可**不覆盖**该图片。原作者如要求，将立即移除或替换
- 若你 fork 本插件，请自行确认该图片的使用范围，或替换为你自己有权使用的素材

## 关于语音

插件的 TTS 走浏览器 `speechSynthesis`（Windows 上即系统语音），**仓库内不含任何语音模型**。

部分自建玩法会接入本地 TTS 服务（如 CosyVoice、GPT-SoVITS 等）。请注意：**请只使用你自己拥有权利的声音**。
未经许可克隆他人声线并进行分发，会同时触及声音权益（《民法典》第 1023 条参照肖像权保护）与深度合成相关规定，
请务必自行评估。本插件不提供、也不分发任何第三方声线模型。
