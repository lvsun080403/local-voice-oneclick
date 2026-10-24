# tools

生成 README 里那几张图的脚本（Pillow，跑在 Windows 上）。

| 脚本 | 作用 |
| --- | --- |
| `shot.py` | 按坐标裁切截图 → 圆角 → 可选缩放。`python shot.py <src> <dst> x0 y0 x1 y1 [radius] [maxwidth]` |
| `compose_hero.py` | 把两张面板图左右拼成 `docs/images/hero.png`，等高对齐、透明底。 |

重做图片的步骤：

```bat
python tools\shot.py raw-asr.png docs\images\asr-panel.png 107 41 790 1204 22 820
python tools\shot.py raw-tts.png docs\images\tts-panel.png  81 42 763 1204 22 820
python tools\compose_hero.py docs\images\asr-panel.png docs\images\tts-panel.png docs\images\hero.png 30 1200
```

坐标是 900 px 宽窗口截图（Windows 缩放 100%）下的像素值，换分辨率要重新量。