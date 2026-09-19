"""Marketplace simgesini (media/icon.png, 256x256) üretir: python3 scripts/make-icon.py

Radar halkaları + main'den ayrılıp geri birleşen bir branch; birleşme noktasında turuncu uyarı.
Kenarların yumuşak olması için 4 kat büyük çizilip küçültülür.
"""
import os

from PIL import Image, ImageDraw, ImageFilter

S = 1024
OUT = 256
TEAL = (45, 212, 191)
ORANGE = (255, 107, 61)
WHITE = (226, 232, 240)
BG = (15, 27, 45)


def rgba(c, a):
    return (*c, a)


img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

# Arka plan: yuvarlatılmış kare
bg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(bg).rounded_rectangle([0, 0, S - 1, S - 1], radius=200, fill=rgba(BG, 255))
img.alpha_composite(bg)

cx, cy = 512, 512

# Radar taraması (yarı saydam dilim)
sweep = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(sweep).pieslice([cx - 400, cy - 400, cx + 400, cy + 400], start=-110, end=-40, fill=rgba(TEAL, 55))
img.alpha_composite(sweep)

# Radar halkaları ve artı işareti
rings = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(rings)
for r, a in ((400, 110), (280, 90), (160, 70)):
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=rgba(TEAL, a), width=14)
d.line([cx, cy - 400, cx, cy + 400], fill=rgba(TEAL, 45), width=8)
d.line([cx - 400, cy, cx + 400, cy], fill=rgba(TEAL, 45), width=8)
img.alpha_composite(rings)

# Git dalları: main dikey çizgi, feature branch ayrılıp birleşiyor
graph = Image.new('RGBA', (S, S), (0, 0, 0, 0))
g = ImageDraw.Draw(graph)
mx = 400
split_y, merge_y = 760, 300
fx = 640
line_w = 34
g.line([mx, 860, mx, 170], fill=rgba(WHITE, 255), width=line_w)
# Feature branch (yuvarlak köşeli yol: sağa çık, yukarı git, geri dön)
g.line([mx, split_y, fx, split_y - 150], fill=rgba(WHITE, 255), width=line_w, joint='curve')
g.line([fx, split_y - 150, fx, merge_y + 150], fill=rgba(WHITE, 255), width=line_w)
g.line([fx, merge_y + 150, mx, merge_y], fill=rgba(WHITE, 255), width=line_w, joint='curve')
for x, y in ((fx, split_y - 150), (fx, merge_y + 150)):
    g.ellipse([x - line_w // 2, y - line_w // 2, x + line_w // 2, y + line_w // 2], fill=rgba(WHITE, 255))
# Ayrılma noktası
r = 52
g.ellipse([mx - r, split_y - r, mx + r, split_y + r], fill=rgba(WHITE, 255))
g.ellipse([mx - 24, split_y - 24, mx + 24, split_y + 24], fill=rgba(BG, 255))
img.alpha_composite(graph)

# Birleşme noktasında turuncu uyarı + parıltı
glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
ImageDraw.Draw(glow).ellipse([mx - 150, merge_y - 150, mx + 150, merge_y + 150], fill=rgba(ORANGE, 150))
img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(60)))

blip = Image.new('RGBA', (S, S), (0, 0, 0, 0))
b = ImageDraw.Draw(blip)
r = 92
b.ellipse([mx - r, merge_y - r, mx + r, merge_y + r], fill=rgba(ORANGE, 255))
# Ünlem işareti
b.rounded_rectangle([mx - 14, merge_y - 58, mx + 14, merge_y + 18], radius=14, fill=rgba(BG, 255))
b.ellipse([mx - 16, merge_y + 32, mx + 16, merge_y + 64], fill=rgba(BG, 255))
img.alpha_composite(blip)

out = os.path.join(os.path.dirname(__file__), '..', 'media', 'icon.png')
img.resize((OUT, OUT), Image.LANCZOS).save(out)
print('yazıldı:', os.path.normpath(out))
