# dsh-voice-bridge

把本机的 **Qwen3-ASR**（语音转文字）和 **Qwen3-TTS**（文字转语音）桥接进 DeepSeek Harness：
**输入框左侧（权限 / 计划模式那颗按钮右边）**多一个「语音」小胶囊，点开是玻璃浮层，
转写和朗读都在你自己的机器上完成，不经过任何云端。

## 为什么是"桥接"而不是"模型提供商"

DSH 设置页里的「添加模型提供商」只认对话协议（OpenAI Chat Completions / Responses /
Anthropic Messages）。ASR / TTS 不是对话模型，硬塞进去没有意义——你没法对一段音频
说"你好"。所以这里走插件路线：在 DSH 宿主里起一层很薄的 HTTP 代理，把浏览器面板的
请求翻译成 Gradio 的调用。

```
浏览器面板  ──POST /voice-bridge/api/*──▶  DSH 宿主  ──▶  Gradio 127.0.0.1:8010 / 8011
```

这么做的两个好处：不用处理浏览器跨域；端口配置只在宿主侧一份，面板不用知道细节。

## 装了什么

| 位置 | 作用 |
| --- | --- |
| `lib/index.js` | 宿主半边：`/voice-bridge/api/{status,config,transcribe,speak}`，负责上传音频、走 Gradio 的 `call` + SSE、把结果转成 JSON |
| `lib/client.js` | 浏览器半边：在输入区那一排挂一颗「语音」胶囊（`createPortal` 挂到 body，避开输入容器的 transform/overflow），点开是固定高度玻璃面板（转写 / 朗读两页，各自带开关） |
| `cordis.patch.yml` | 名册条目：`- id: voice-bridge / name: 'dsh-voice-bridge'` |

## 依赖的两个服务

| 服务 | 默认端口 | 接口 | 备注 |
| --- | --- | --- | --- |
| Qwen3-ASR-1.7B | 8010 | `POST /gradio_api/call/run` | 参数 `[音频, 语种, null]`，第三个 `null` 是隐藏 State 占位，少传会报 `didn't receive enough input values` |
| Qwen3-TTS-12Hz-1.7B-Base | 8011 | `POST /gradio_api/call/run_voice_clone` | 参数 `[参考音频, 参考文本, 是否只用声纹, 正文, 语种]` |

两个服务都由本仓库之外的一键部署包提供（`D:\1\Qwen3-ASR-1.7B`、`D:\1\Qwen3-TTS-1.7B`）。

## 用法

1. 先确保两个语音服务在跑（各自目录下的 `start.bat`）；面板里两个开关也能直接起停、显示三行运行输出
2. 完全退出 DSH 再打开（插件只在启动时加载，源码是 link 安装）
3. 输入框左侧点「语音」：
   - **转写**：选一个音频文件 → 语种 → 开始转写 → 结果出现在下面
   - **朗读**：写文字 → 给一段参考音频 + 参考文本（或勾「只用声纹」）→ 合成语音 → 播放器可直接播

> **Base 模型没有内置音色。** 想听到声音，必须提供参考音频；不勾「只用声纹」时还要
> 填参考文本（就是那段音频说了什么），否则服务端会回
> `Reference text is required when use x-vector only is NOT enabled.`

## 实测（本机 5070 Ti Laptop / 12 GB）

| 项目 | 结果 |
| --- | --- |
| 转写一句中文 | 13.8 s，逐字正确 |
| 合成一句中文（参考音色） | 7.8 s（预热后） |
| 闭环（TTS 生成 → ASR 回读） | 原文与回读**完全一致** |

## 配置

`%USERPROFILE%\.dsh\voice-bridge\config.json`（宿主每次请求都重读，面板下次打开就生效）：

```json
{
  "asr": { "port": 8010, "model": "Qwen3-ASR-1.7B", "dir": "D:\\1\\Qwen3-ASR-1.7B", "enabled": false, "idleMinutes": 10 },
  "tts": { "port": 8011, "model": "Qwen3-TTS-12Hz-1.7B-Base", "dir": "D:\\1\\Qwen3-TTS-1.7B", "enabled": true, "idleMinutes": 10 },
  "lang": "Auto",
  "xvec": false
}
```

`dir` 指向各自的一键部署目录（面板的启动/停止按钮就是读它去找 `start.bat` / `stop.bat`）；
`enabled` 是面板上那颗开关的持久状态；`idleMinutes` 是闲置自动停服的分钟数。

## 卸载

删掉 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里的
`"dsh-voice-bridge"` 依赖与 bundles 里那一行，再删 `node_modules\dsh-voice-bridge`
这个 junction，重启 DSH。
