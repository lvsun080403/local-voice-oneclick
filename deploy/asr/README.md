> 这是 **Voice Studio** 项目的其中一个部署包。整套东西怎么串起来，先看仓库根目录的 [README.md](../../README.md)。

# Qwen3-ASR-1.7B 一键部署包

双击 `install.bat`，等它跑完，浏览器会自动打开一个能用的语音转写界面。
不需要预装 Python，不需要配环境变量，不碰系统里已有的任何东西。

---

## 一、这个包装的是什么

| 项 | 值 |
| --- | --- |
| 模型 | `Qwen/Qwen3-ASR-1.7B`（阿里 Qwen3 系列的语音识别模型，17 亿参数） |
| 模型体积 | 约 4.4 GB（12 个文件，含 `model-00001-of-00002.safetensors` 4.0 GB） |
| 推理库 | `qwen-asr 0.0.6`（PyPI 官方包，自带 Gradio 演示界面） |
| 运行时 | 包内自带 Python 3.11 嵌入式版 + PyTorch CUDA 12.8 |
| 显存占用 | 官方口径 1.7B 约 4 GB 级；本包默认用 CUDA，12 GB 卡很宽裕 |
| 默认端口 | `8010` |
| 监听地址 | `127.0.0.1`（只有本机能访问） |

它做的是**语音转文字**：给一段音频（wav/mp3/m4a 等），输出文字；中文、粤语、方言混说、中英混说都在它的能力范围内。

---

## 二、目录结构

```
Qwen3-ASR-1.7B\
├─ install.bat        ← 第一次用，双击这个
├─ start.bat          ← 以后启动
├─ stop.bat           ← 停止
├─ status.bat         ← 看是否在运行
├─ README.md          ← 本文件
├─ scripts\
│  ├─ install.ps1     ← 安装逻辑（bat 只是外壳）
│  └─ serve.ps1       ← 启停逻辑
├─ py\                ← 安装时生成：自带 Python
├─ models\            ← 安装时生成：模型文件
├─ download\          ← 安装时生成：Python 包等临时下载
└─ logs\              ← 安装时生成：运行日志
```

> `py\ models\ download\ logs\` 不用手动建，脚本会按需创建。

---

## 三、一键安装（第一次）

双击 **`install.bat`**。它会依次做：

1. **环境自检** — 64 位 Windows 10+、`curl.exe`、NVIDIA 驱动（`nvidia-smi`）、磁盘 ≥14 GB。
2. **准备 Python 3.11** — 从镜像下一个 11 MB 的嵌入式包（华为云 → npmmirror → 阿里云 → python.org 四个源依次试），解压到 `py\`，改写 `python311._pth` 让它能加载第三方包，再装 pip。
3. **装 PyTorch** — CUDA 12.8 版（约 2.5 GB），走 `download.pytorch.org`，失败自动换阿里云的 pytorch-wheels 镜像。
4. **装 qwen-asr** — 从阿里云 PyPI 装 `qwen-asr==0.0.6`（会连带 gradio、librosa 等依赖）。
5. **下模型** — 先向 `hf-mirror.com` 要文件清单（名字 + 字节数），再逐文件用 curl 下载，**每个文件都有进度条**。
6. **冒烟测试** — 打印 torch 版本、CUDA 是否可用、显卡名、`qwen_asr` 能否 import。
7. **启动** — 调 `serve.ps1` 拉起服务，等到 HTTP 200，打印地址并自动开浏览器。

全程有进度提示。**中断了直接再双击一次**：已完成的步骤会跳过，模型下载会断点续传。

预计耗时（取决于网速）：Python 20 秒、PyTorch 5–20 分钟、qwen-asr 1–3 分钟、模型 5–15 分钟。

---

## 四、日常使用

| 想做什么 | 双击 |
| --- | --- |
| 启动 | `start.bat` |
| 停止 | `stop.bat` |
| 看状态 | `status.bat` |

启动后浏览器打开 `http://127.0.0.1:8010`，界面里拖入音频文件即可转写。

命令行参数（`start.bat` 后面直接跟，例如 `start.bat -Port 8020`）：

| 参数 | 作用 |
| --- | --- |
| `-Port 8010` | 换端口 |
| `-Listen 127.0.0.1` | 换监听地址（`0.0.0.0` 才允许局域网访问） |
| `-Foreground` | 前台运行（关窗口即停，便于看日志） |
| `-NoBrowser` | 不自动开浏览器 |

---

## 五、出了问题怎么查

| 现象 | 先看 |
| --- | --- |
| 双击后闪一下就没了 | 用 `cmd` 打开该目录，手敲 `install.bat`，能看到报错逐行停住 |
| 卡在"下载卡住" | 网络断了。重跑即可续传；脚本 45 秒无增长会自动判失败 |
| 装 PyTorch 失败 | 把控制台最后 30 行发我，我看是镜像还是显卡驱动问题 |
| 启动后浏览器打不开 | 双击 `status.bat`：显示"运行中"说明服务在跑，可能是浏览器代理；显示"未运行"就把 `logs\` 里最新的 `.err.log` 发我 |
| 显存不够 | 1.7B 通常 4 GB 左右就够；如果报 OOM，把报错发我，我再给降配方案 |

日志都在 `logs\`：`asr-<时间戳>.out.log`（标准输出）、`asr-<时间戳>.err.log`（报错）。

---

## 六、这个包已验证 / 未验证的部分

**已验证**（我在这台机器上跑过）：

- 四个 `.ps1` 语法校验 0 错（PowerShell 5.1）。
- 两个 bat 的启动、传参路径正确；bat 全是纯 ASCII（避免 cmd 的中文编码坑）。
- `install.ps1 -DryRun` 能完整打印安装计划、环境自检全绿、退出码 0。
- 下载器：本地 HTTP 服务上分别测过「正常下载」「大小不符」「404」「坏源→好源自动切换」四种情形，行为正确；带进度条与 45 秒卡死检测。

**未验证**（需要你这边跑一次才能确认）：

- 真实从公网下载 Python / PyTorch / 模型（我这边的沙箱访问不了这些域名）。
- `qwen-asr` 装完之后的实际转写效果与显存占用。
- `qwen-asr-demo` 的 Gradio 界面具体长什么样（我只能从入口点确认参数名）。

跑完把结果告诉我（成功截图 / 报错原文都行），我再按实际情况改。

---

## 七、来源

- 模型：<https://huggingface.co/Qwen/Qwen3-ASR-1.7B>
- 官方包：`pip install qwen-asr`（<https://pypi.org/project/qwen-asr/>）
- 同系列还有 `Qwen3-ASR-0.6B`（更小更快）与 `Qwen3-ForcedAligner-0.6B`（词级时间戳对齐），需要的话我另外打包。
