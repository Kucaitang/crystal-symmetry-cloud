# -*- coding: utf-8 -*-
"""合成 README 用的四联图：P1 / m-3m / Pnma / 单击高亮等价点"""
import os
from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(BASE, "shots")

def load_cropped(name, top=84, bottom=78, left=0):
    img = Image.open(os.path.join(SHOTS, name)).convert("RGB")
    w, h = img.size
    return img.crop((left, top, w, h - bottom))

def font(size, bold=False):
    path = r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc"
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()

panels = [
    ("09-clean-p1.png", "P 1", "最低对称 · 同色 = 同一个点", 0),
    ("10-clean-cubic.png", "m-3m", "48 个操作 · 同色 = 同一个轨道", 0),
    ("13-clean-pnma.png", "Pnma (No. 62)", "230 个空间群 · 含螺旋轴与滑移面", 0),
    ("11-highlight-orbit.png", "单击拾取", "一个轨道的全部等价点同时高亮", 520),
]

img_w = 780
gap = 26
x0 = 34
W = x0 * 2 + 4 * img_w + 3 * gap
y = 180
H = 760
bg = (6, 9, 17)
canvas = Image.new("RGB", (W, H), bg)
draw = ImageDraw.Draw(canvas)

f_title = font(44, True)
f_sub = font(24)

for i, (name, title, sub, left) in enumerate(panels):
    img = load_cropped(name, left=left)
    hh = int(img_w * img.height / img.width)
    img_r = img.resize((img_w, hh), Image.LANCZOS)
    x = x0 + i * (img_w + gap)
    canvas.paste(img_r, (x, y))
    draw.text((x + 4, 66), title, font=f_title, fill=(233, 240, 255))
    draw.text((x + 4, 124), sub, font=f_sub, fill=(150, 168, 205))
    draw.text((x + 4, y + hh + 18), "代表点距离越远，颜色差越大（ΔE 单调）",
              font=font(20), fill=(110, 124, 160))

out = os.path.join(SHOTS, "00-compare.png")
canvas.save(out, "PNG")
print("saved", out, canvas.size)
