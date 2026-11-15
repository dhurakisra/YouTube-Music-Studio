# Enhancer wheel rings for animation. Only the toothed rim of each wheel is cut (no spokes, hub, cross bar or straps): a clean
# wedge of the rim (a part with nothing in front of it) is tiled N times around the centre, so the ring has no bar/frame fragments
# and can spin freely. The sprite is colour-matched to the baked ring it replaces (the clean wedge is brighter than the average).
#   sk-st-gear-<n>.png        ring sprite (rotates)
#   sk-st-gear-<n>-mask.png   static alpha: ring minus the cross bar, the plate frame and (small wheels) the big wheel
# usage: python -I design/tools/studio_gears.py [name test_angle test_out.png]   (run on the live backdrop design/tex/sk-studio.jpg)
import sys
import numpy as np
from PIL import Image, ImageFilter
from scipy.ndimage import map_coordinates
src = Image.open('design/tex/sk-studio.jpg').convert('RGB'); A = np.asarray(src).astype(np.float32)
L = A.mean(axis=2)
# name: (cx, cy, inner r, outer r, wedge start deg (ccw from 3 o'clock), wedge width deg, spin speed hint)
GEARS = {'big': (3019.5, 657.5, 97, 127, 66.0, 360.0 / 7), 'r': (3149.0, 647.0, 40, 66, 22.0, 72.0), 'l': (2891.0, 654.0, 46, 72, 86.0, 72.0)}
BIG = (3019.5, 657.5, 131); BAR = (641, 677); FRAME_Y = 728
ASSET = {'l': 'design/tex/sk-gear.png', 'r': 'design/tex/sk-gear.png'}   # wheels replaced by a whole clean gear from the asset set (colour-matched), instead of a cut ring
def build_asset(n):
    CX, CY, RI, RO, W0, W = GEARS[n]
    R = int(RO + 3); S = 2 * R; x0, y0 = int(CX - R), int(CY - R)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32); px, py = xx + x0, yy + y0
    d = np.hypot(px - CX, py - CY)
    g = Image.open(ASSET[n]).convert('RGBA'); D = int(round(2 * (RO + 1)))
    g = g.resize((D, D), Image.LANCZOS)
    base = Image.new('RGBA', (S, S), (0, 0, 0, 0)); dark = Image.new('RGBA', (D, D), (13, 9, 6, 255))   # fill behind the spokes
    dark.alpha_composite(g); base.paste(dark, ((S - D) // 2, (S - D) // 2))
    arr = np.asarray(base).astype(np.float32); rgb = arr[..., :3]; ga = arr[..., 3] > 128
    m = (d <= RO).astype(np.float32)
    m[(py >= BAR[0]) & (py <= BAR[1])] = 0; m[py >= FRAME_Y] = 0; m[np.hypot(px - BIG[0], py - BIG[1]) <= BIG[2]] = 0
    ring = (m > 0.5) & (d >= RI)
    baked = L[y0:y0 + S, x0:x0 + S][ring].mean(); new = rgb.mean(axis=2)[ga & (d >= RI)].mean()
    k = float(np.clip(baked / max(new, 1), 0.35, 1.0)); rgb = rgb * k * 0.92
    # slight desaturation: the baked bronze is duller than the asset's orange copper
    gray = rgb.mean(axis=2, keepdims=True); rgb = gray + (rgb - gray) * 1.0
    alpha = np.where(ga, 255, 0).astype(np.uint8)
    sprite = Image.fromarray(np.dstack([rgb.clip(0, 255).astype(np.uint8), alpha]))
    mask = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))
    return (x0, y0, S), sprite, mask, k
_build_ring = None
def build(n):
    if n in ASSET: return build_asset(n)
    return build_ring(n)
def build_ring(n):
    CX, CY, RI, RO, W0, W = GEARS[n]
    R = int(RO + 3); S = 2 * R; x0, y0 = int(CX - R), int(CY - R)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32); px, py = xx + x0, yy + y0
    d = np.hypot(px - CX, py - CY); th = np.degrees(np.arctan2(CY - py, px - CX)) % 360
    st = np.radians(W0 + ((th - W0) % W)); sx = CX + d * np.cos(st); sy = CY - d * np.sin(st)
    rgb = np.dstack([map_coordinates(A[..., c], [sy, sx], order=1, mode='nearest') for c in range(3)])
    m = ((d >= RI) & (d <= RO)).astype(np.float32)
    m[(py >= BAR[0]) & (py <= BAR[1])] = 0; m[py >= FRAME_Y] = 0
    if n != 'big': m[np.hypot(px - BIG[0], py - BIG[1]) <= BIG[2]] = 0
    # colour match: mean luminance of the sprite ring vs the baked ring pixels that stay visible
    ring = m > 0.5
    base = L[y0:y0 + S, x0:x0 + S][ring].mean(); new = rgb.mean(axis=2)[ring].mean()
    k = float(np.clip(base / max(new, 1), 0.45, 1.0)); rgb = rgb * k
    alpha = np.where((d >= RI - 1) & (d <= RO + 1), 255, 0).astype(np.uint8)
    sprite = Image.fromarray(np.dstack([rgb.clip(0, 255).astype(np.uint8), alpha]))
    mask = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))
    return (x0, y0, S), sprite, mask, k
if len(sys.argv) > 3:
    comp = src.copy()
    for n in GEARS:
        (x0, y0, S), sprite, mask, k = build(n)
        rot = sprite.rotate(float(sys.argv[2]) * (1 if n == 'big' else -1), resample=Image.BICUBIC)
        la = np.asarray(rot.split()[3]).astype(np.float32) * np.asarray(mask).astype(np.float32) / 255.0
        rot.putalpha(Image.fromarray(la.astype(np.uint8))); comp.paste(rot, (x0, y0), rot)
    comp.crop((2760, 520, 3260, 760)).resize((1500, 720)).save(sys.argv[3])
else:
    for n in GEARS:
        (x0, y0, S), sprite, mask, k = build(n)
        sprite.save(f'design/tex/sk-st-gear-{n}.png')
        out = Image.new('RGBA', (S, S), (0, 0, 0, 0)); out.putalpha(mask); out.save(f'design/tex/sk-st-gear-{n}-mask.png')
        print(n, x0, y0, x0 + S, y0 + S, 'brightness x%.2f' % k)
