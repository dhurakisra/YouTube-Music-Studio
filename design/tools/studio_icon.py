# App icon: black tile, brass rim, amber YouTube-style play badge (black triangle) + tiny equalizer bars. Writes build/icon.png (1024) and build/icon.ico
from PIL import Image, ImageDraw, ImageFilter, ImageChops
S = 1024
def rr(d, box, r, fill=None, outline=None, width=1): d.rounded_rectangle(box, r, fill=fill, outline=outline, width=width)
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
# tile
tile = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(tile)
rr(d, (24, 24, S - 24, S - 24), 190, fill=(12, 8, 6, 255))
# subtle rust glow bottom
glow = Image.new('RGBA', (S, S), (0, 0, 0, 0)); gd = ImageDraw.Draw(glow)
gd.ellipse((140, 520, S - 140, 1100), fill=(190, 90, 20, 70)); glow = glow.filter(ImageFilter.GaussianBlur(90))
tile = Image.alpha_composite(tile, ImageChops.multiply(glow, Image.new('RGBA', (S, S), (255, 255, 255, 255))))
mask = Image.new('L', (S, S), 0); ImageDraw.Draw(mask).rounded_rectangle((24, 24, S - 24, S - 24), 190, fill=255)
tile.putalpha(ImageChops.multiply(tile.getchannel('A'), mask))
# brass rim
d = ImageDraw.Draw(tile)
rr(d, (24, 24, S - 24, S - 24), 190, outline=(201, 138, 58, 255), width=14)
rr(d, (52, 52, S - 52, S - 52), 165, outline=(120, 74, 28, 255), width=5)
img = Image.alpha_composite(img, tile)
# play badge glow
bx0, by0, bx1, by1 = 170, 235, S - 170, 640
g = Image.new('RGBA', (S, S), (0, 0, 0, 0)); ImageDraw.Draw(g).rounded_rectangle((bx0, by0, bx1, by1), 130, fill=(255, 150, 30, 190))
img = Image.alpha_composite(img, g.filter(ImageFilter.GaussianBlur(38)))
# badge with vertical amber gradient
grad = Image.new('RGBA', (S, S)); gp = grad.load()
for y in range(S):
    t = min(1, max(0, (y - by0) / (by1 - by0)))
    c = (int(255 - 20 * t), int(222 - 62 * t), int(98 - 60 * t), 255)
    for x in range(S): gp[x, y] = c
bm = Image.new('L', (S, S), 0); ImageDraw.Draw(bm).rounded_rectangle((bx0, by0, bx1, by1), 130, fill=255)
badge = Image.new('RGBA', (S, S), (0, 0, 0, 0)); badge.paste(grad, (0, 0), bm); img = Image.alpha_composite(img, badge)
# triangle (rounded corners via supersampled polygon + blur-threshold)
cx, cy = S // 2 + 12, (by0 + by1) // 2
tri = Image.new('L', (S, S), 0); ImageDraw.Draw(tri).polygon([(cx - 95, cy - 120), (cx - 95, cy + 120), (cx + 120, cy)], fill=255)
tri = tri.filter(ImageFilter.GaussianBlur(14)).point(lambda v: 255 if v > 128 else 0).filter(ImageFilter.GaussianBlur(1.2))
black = Image.new('RGBA', (S, S), (16, 10, 6, 255)); black.putalpha(tri); img = Image.alpha_composite(img, black)
# equalizer bars
d = ImageDraw.Draw(img); hs = [70, 120, 185, 135, 215, 150, 95, 60]; bw, gap = 50, 28
x0 = (S - (len(hs) * bw + (len(hs) - 1) * gap)) // 2; base = 880
for i, h in enumerate(hs):
    x = x0 + i * (bw + gap); rr(d, (x, base - h, x + bw, base), 14, fill=(255, 181, 46, 255))
barsg = Image.new('RGBA', (S, S), (0, 0, 0, 0)); gd = ImageDraw.Draw(barsg)
for i, h in enumerate(hs):
    x = x0 + i * (bw + gap); gd.rounded_rectangle((x, base - h, x + bw, base), 14, fill=(255, 140, 20, 150))
img = Image.alpha_composite(img, barsg.filter(ImageFilter.GaussianBlur(18)))
d = ImageDraw.Draw(img)
for i, h in enumerate(hs):
    x = x0 + i * (bw + gap); rr(d, (x, base - h, x + bw, base), 14, fill=(255, 196, 70, 255))
img.save('build/icon.png')
img.save('build/icon.ico', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)])
print('ok')
