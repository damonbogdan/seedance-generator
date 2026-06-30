#!/usr/bin/env python3
# Генерирует master-иконку 1024x1024 (squircle, градиент бренда + play-треугольник).
import sys, math
from PIL import Image, ImageDraw, ImageFilter

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# вертикальный градиент blue -> purple (бренд: #6d8bff -> #b06dff), затемнённый снизу
top = (109, 139, 255)
bot = (176, 109, 255)
grad = Image.new("RGB", (S, S))
gd = grad.load()
for y in range(S):
    t = y / (S - 1)
    # лёгкое затемнение к низу для объёма
    dark = 1.0 - 0.12 * t
    r = int((top[0] + (bot[0] - top[0]) * t) * dark)
    g = int((top[1] + (bot[1] - top[1]) * t) * dark)
    b = int((top[2] + (bot[2] - top[2]) * t) * dark)
    for x in range(S):
        gd[x, y] = (r, g, b)

# squircle-маска (скруглённый прямоугольник в стиле macOS, с отступом)
pad = 90
radius = 230
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=255)

base = Image.composite(grad.convert("RGBA"), img, mask)

# верхний глянцевый блик
gloss = Image.new("L", (S, S), 0)
ImageDraw.Draw(gloss).ellipse([pad - 40, pad - 360, S - pad + 40, pad + 300], fill=70)
gloss = gloss.filter(ImageFilter.GaussianBlur(60))
gloss = Image.composite(gloss, Image.new("L", (S, S), 0), mask)
white = Image.new("RGBA", (S, S), (255, 255, 255, 255))
base = Image.composite(white, base, gloss)

# play-треугольник по центру (белый, мягкие углы)
draw = ImageDraw.Draw(base)
cx, cy = S // 2 + 30, S // 2
w = 250
h = 290
tri = [(cx - w // 2, cy - h // 2), (cx - w // 2, cy + h // 2), (cx + w // 2, cy)]
# тень
sh = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(sh).polygon([(x + 8, y + 10) for x, y in tri], fill=(0, 0, 0, 90))
sh = sh.filter(ImageFilter.GaussianBlur(14))
base = Image.alpha_composite(base, sh)
ImageDraw.Draw(base).polygon(tri, fill=(255, 255, 255, 245))

base.save(sys.argv[1] if len(sys.argv) > 1 else "icon_1024.png")
print("icon written")
