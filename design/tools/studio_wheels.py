# Key&Tempo wheel (the Session wheels are asset gears: studio_sgears.py)  --  formerly Session and Key&Tempo wheels (baked into design/tex/sk-studio.jpg): the whole wheel except the hub is rebuilt from one clean wedge
# of itself (rim + teeth + spoke, tiled 8x), so nothing in front of the wheel (cross bar, bolts, neighbouring parts) rotates with it.
#   sk-st-wheel-<n>.png       annulus sprite (rotates);  sk-st-wheel-<n>-mask.png  static alpha (bar / frame / foreign parts / hub keep their place)
# usage: python -I design/tools/studio_wheels.py [name angle out.png]    (run on the live backdrop design/tex/sk-studio.jpg)
import sys
import numpy as np
from PIL import Image, ImageFilter
from scipy.ndimage import map_coordinates
src = Image.open('design/tex/sk-studio.jpg').convert('RGB'); A = np.asarray(src).astype(np.float32); L = A.mean(axis=2)
# c: centre (abs ref px), ri/ro: ring radii (hub .. tooth tips), w0/w: wedge start/width (deg ccw from 3 o'clock), bar: cross bar y range,
# frame: y of the plate frame hiding the lower part, excl: foreign circles in front of the wheel (cx, cy, r)
WHEELS = {
    'k': dict(c=(698.0, 657.0), ri=42, ro=116, w0=67.5, w=45.0, bar=(641, 677), frame=728, excl=[]),
}
def build(n):
    P = WHEELS[n]; CX, CY = P['c']; RI, RO = P['ri'], P['ro']
    R = int(RO + 3); S = 2 * R; x0, y0 = int(CX - R), int(CY - R)
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32); px, py = xx + x0, yy + y0
    d = np.hypot(px - CX, py - CY); th = np.degrees(np.arctan2(CY - py, px - CX)) % 360
    st = np.radians(P['w0'] + ((th - P['w0']) % P['w'])); sx = CX + d * np.cos(st); sy = CY - d * np.sin(st)
    rgb = np.dstack([map_coordinates(A[..., c], [sy, sx], order=1, mode='nearest') for c in range(3)])
    m = ((d >= RI) & (d <= RO)).astype(np.float32)
    if P['bar']: m[(py >= P['bar'][0]) & (py <= P['bar'][1])] = 0
    m[py >= P['frame']] = 0
    for ex, ey, er in P['excl']: m[np.hypot(px - ex, py - ey) <= er] = 0
    ring = m > 0.5
    k = float(np.clip(L[y0:y0 + S, x0:x0 + S][ring].mean() / max(rgb.mean(axis=2)[ring].mean(), 1), 0.45, 1.05)); rgb = rgb * k
    alpha = np.where((d >= RI - 1) & (d <= RO + 1), 255, 0).astype(np.uint8)
    sprite = Image.fromarray(np.dstack([rgb.clip(0, 255).astype(np.uint8), alpha]))
    mask = Image.fromarray((m * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.7))
    return (x0, y0, S), sprite, mask, k
if len(sys.argv) > 3:
    n = sys.argv[1]; (x0, y0, S), sprite, mask, k = build(n)
    rot = sprite.rotate(float(sys.argv[2]), resample=Image.BICUBIC)
    la = np.asarray(rot.split()[3]).astype(np.float32) * np.asarray(mask).astype(np.float32) / 255.0
    rot.putalpha(Image.fromarray(la.astype(np.uint8))); comp = src.copy(); comp.paste(rot, (x0, y0), rot)
    cx, cy = WHEELS[n]['c']; comp.crop((int(cx - 150), int(cy - 160), int(cx + 150), int(cy + 80))).resize((1200, 960)).save(sys.argv[3])
else:
    for n in WHEELS:
        (x0, y0, S), sprite, mask, k = build(n)
        sprite.save(f'design/tex/sk-st-wheel-{n}.png')
        out = Image.new('RGBA', (S, S), (0, 0, 0, 0)); out.putalpha(mask); out.save(f'design/tex/sk-st-wheel-{n}-mask.png')
        print(n, x0, y0, x0 + S, y0 + S, 'brightness x%.2f' % k)
