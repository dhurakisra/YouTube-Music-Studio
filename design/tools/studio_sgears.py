# Session panel gears: the three baked wheels are covered by whole gears from the asset set (design/tex/sk-gear.png), colour-matched to
# the backdrop. big = LISTEN, right = + LISTEN WITH STEMS, top = + KARAOKE (they start turning in that order).
#   sk-st-sgear-<n>.png (rotates)   sk-st-sgear-<n>-mask.png (static alpha: keeps the plate frame above/below and the big gear in front)
# usage: python -I design/tools/studio_sgears.py [test_angle out.png]   (run on design/tex/sk-studio.jpg)
import sys
import numpy as np
from PIL import Image, ImageFilter
src = Image.open('design/tex/sk-studio.jpg').convert('RGB'); A = np.asarray(src).astype(np.float32)
L = A.mean(axis=2)
GEARS = {'big': (219.0, 724.0, 119), 'right': (392.0, 712.0, 70), 'top': (345.0, 640.0, 48)}   # cx, cy, outer radius (tooth tips)
BIG = (219.0, 724.0, 119); TOP_Y = 603; FRAME_Y = 779
def build(n):
    CX, CY, RO = GEARS[n]
    R = int(RO + 3); S = 2 * R; x0, y0 = int(CX - R), int(CY - R)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32); px, py = xx + x0, yy + y0; d = np.hypot(px - CX, py - CY)
    D = int(round(2 * (RO + 1))); g = Image.open('design/tex/sk-gear.png').convert('RGBA').resize((D, D), Image.LANCZOS)
    base = Image.new('RGBA', (S, S), (0, 0, 0, 0)); base.paste(g, ((S - D) // 2, (S - D) // 2))   # real transparency between teeth and spokes
    arr = np.asarray(base).astype(np.float32); rgb = arr[..., :3]; ga = arr[..., 3] > 128
    m = (d <= RO).astype(np.float32); m[py < TOP_Y] = 0; m[py >= FRAME_Y] = 0
    # (no clipping by the big gear: it is stacked on top in the DOM, so its transparent tooth gaps show the neighbours behind it)
    k = 0.66   # darkened to sit in the backdrop (the raw asset is far brighter than the painted scene)
    rgb = rgb * k
    gray = rgb.mean(axis=2, keepdims=True); rgb = gray + (rgb - gray) * 1.45   # darker but richer: saturation up, not washed out
    sprite = Image.fromarray(np.dstack([rgb.clip(0, 255).astype(np.uint8), np.where(ga, 255, 0).astype(np.uint8)]))
    mask = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))
    return (x0, y0, S), sprite, mask, k
if len(sys.argv) > 2:
    comp = src.copy()
    for i, n in enumerate(GEARS):
        (x0, y0, S), sprite, mask, k = build(n); rot = sprite.rotate(float(sys.argv[1]) * (1 if i == 0 else -1), resample=Image.BICUBIC)
        la = np.asarray(rot.split()[3]).astype(np.float32) * np.asarray(mask).astype(np.float32) / 255.0
        rot.putalpha(Image.fromarray(la.astype(np.uint8))); comp.paste(rot, (x0, y0), rot)
    comp.crop((20, 560, 480, 800)).resize((1380, 720)).save(sys.argv[2])
else:
    for n in GEARS:
        (x0, y0, S), sprite, mask, k = build(n)
        sprite.save(f'design/tex/sk-st-sgear-{n}.png')
        out = Image.new('RGBA', (S, S), (0, 0, 0, 0)); out.putalpha(mask); out.save(f'design/tex/sk-st-sgear-{n}-mask.png')
        print(n, x0, y0, x0 + S, y0 + S, 'brightness x%.2f' % k)
