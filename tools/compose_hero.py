"""把两张面板图拼成一张 hero 图（透明底、带留白与投影感）。

用法: python compose_hero.py <left.png> <right.png> <out.png> [gap] [maxwidth]
"""
import sys
from PIL import Image, ImageFilter

left = Image.open(sys.argv[1]).convert("RGBA")
right = Image.open(sys.argv[2]).convert("RGBA")
out_path = sys.argv[3]
gap = int(sys.argv[4]) if len(sys.argv) > 4 else 28
maxw = int(sys.argv[5]) if len(sys.argv) > 5 else 1200

# 等高对齐
h = min(left.height, right.height)
left = left.crop((0, 0, left.width, h))
right = right.crop((0, 0, right.width, h))

pad = 36
w = left.width + gap + right.width + pad * 2
canvas = Image.new("RGBA", (w, h + pad * 2), (0, 0, 0, 0))

canvas.paste(left, (pad, pad), left)
canvas.paste(right, (pad + left.width + gap, pad), right)

if canvas.width > maxw:
    ratio = maxw / canvas.width
    canvas = canvas.resize((maxw, round(canvas.height * ratio)), Image.LANCZOS)

canvas.save(out_path)
print(f"{out_path}  {canvas.width}x{canvas.height}")
