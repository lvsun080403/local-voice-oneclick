"""按显式坐标裁切 + 圆角 + 可选缩放。

用法: python shot.py <src> <dst> x0 y0 x1 y1 [radius] [maxwidth]
"""
import sys
from PIL import Image, ImageDraw

src, dst = sys.argv[1], sys.argv[2]
x0, y0, x1, y1 = (int(v) for v in sys.argv[3:7])
radius = int(sys.argv[7]) if len(sys.argv) > 7 else 18
maxw = int(sys.argv[8]) if len(sys.argv) > 8 else 900

img = Image.open(src).convert("RGB").crop((x0, y0, x1, y1))
if img.width > maxw:
    img = img.resize((maxw, round(img.height * maxw / img.width)), Image.LANCZOS)

alpha = Image.new("L", img.size, 0)
d = ImageDraw.Draw(alpha)
d.rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius=radius, fill=255)
out = img.convert("RGBA")
out.putalpha(alpha)
out.save(dst)
print(f"{dst}  {img.width}x{img.height}")
