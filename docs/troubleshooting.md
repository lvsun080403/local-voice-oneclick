# 排错手册

按「现象 → 先查什么 → 常见原因」来。每一节都可以单独跳转。

---

## 一、安装阶段

### 双击 `install.bat` 一闪就没

`.bat` 用的是 `powershell -ExecutionPolicy Bypass`，报错会被窗口关掉吞掉。

用 `cmd` 打开该目录，手敲：

```bat
install.bat
```

报错会停在窗口里。

### 卡在"下载卡住"

脚本有 45 秒无增长检测，会判失败并切下一个源。网络断了直接**重跑**：已完成的步骤跳过，模型断点续传。

### 装 PyTorch 失败

控制台最后 30 行是关键。默认走 `download.pytorch.org`，失败自动切阿里云的 pytorch-wheels 镜像。
如果两个源都失败，通常是：

- 代理软件劫持了 `download.pytorch.org`（把该域名加白名单，或临时关代理）
- 显卡驱动太旧，CUDA 12.8 运行时初始化失败（`nvidia-smi` 看驱动版本，建议 ≥ 550）

### 磁盘不够

**装完**每个包约占 10 GB（Python 5.3 GB + 模型 4.4 GB + PyTorch 缓存）；仓库里那两个目录本身只有 94 KB，全是脚本。`install.ps1` 会先做 ≥14 GB 的空间检查。

---

## 二、启动阶段

### 启动后浏览器打不开页面

```bat
status.bat
```

- 显示"运行中" → 服务其实在跑，问题在浏览器：代理设置、或 `127.0.0.1` 被代理规则接管（把 localhost 加直连）。
- 显示"未运行" → 看 `logs\` 里最新的 `.err.log`。

日志命名：`asr-<时间戳>.out.log` / `asr-<时间戳>.err.log`（TTS 包同理，前缀 `tts-`）。

### 端口被占用

```bat
start.bat -Port 8020
```

同时把 `%USERPROFILE%\.dsh\voice-bridge\config.json` 里对应的 `port` 改掉，面板才知道新端口。

### 显存不够（OOM）

| 服务 | 粗略占用 |
| --- | --- |
| Qwen3-ASR-1.7B | 约 4 GB |
| Qwen3-TTS-12Hz-1.7B-Base | 约 5–6 GB |

两个同时常驻在 12 GB 卡上就紧了。对策：面板里用开关按需起停；把 `idleMinutes` 调小（闲置自动停服）；
或改成 CPU 推理（慢很多，但能跑）。

---

## 三、使用阶段

### 转写结果不对 / 方言识别差

先确认语种选对。默认 `自动识别` 在纯中文、中英混说时表现最好；粤语、方言建议显式指定。
音频质量比模型更影响结果：16 kHz 以上、无强背景音乐。

### 合成报 `Reference text is required when use x-vector only is NOT enabled.`

`-Base` 模型**没有内置音色**。两条路：

- 填「参考文本」（即参考音频里说的话），走完整音色克隆；
- 或勾「只用声纹」，只取音色特征、不要求参考文本。

参考音频建议 3–15 秒、干净人声。

### 第一次合成十几秒没反应

在加载模型。之后预热好了约 8 秒一句。反复冷启动说明 `idleMinutes` 设得太小。

### 面板高度固定、下面内容看不到

`plugin/lib/client.js` 顶部有个 `PANEL_H` 常量，面板高度写死。窗口比它矮时会夹到可视区内并内部滚动。
想改就改那个常量，然后**完全重启 DSH**（只改渲染层也要重启才稳）。

### 服务显示「离线」但 `status.bat` 说在跑

面板是通过 HTTP 探活的，探不到就是端口/地址对不上。检查 `config.json` 的 `port` 与 `dir`
是否指到了实际目录（`dir` 里必须有 `start.bat`）。

---

## 四、插件没生效

| 检查项 | 正确状态 |
| --- | --- |
| `package.json` 的 `dependencies` | 有 `"dsh-voice-bridge": "link:..."` |
| `package.json` 的 `bundles` | 数组里有 `"dsh-voice-bridge"` |
| `node_modules\dsh-voice-bridge` | 是指向你源码目录的 junction |
| 是否完全重启 | 关窗口不够，要结束进程 |

顺带一句：源码改完也必须完全重启。DSH 的插件宿主半边只在进程启动时加载。

---

## 五、还是不行

开 issue 时贴这三样，定位会快很多：

1. 用的是哪个包（ASR / TTS / 插件），版本或提交号；
2. `logs\` 里最新 `.err.log` 的最后 30 行；
3. 复现步骤（点了什么、期望什么、实际什么）。
