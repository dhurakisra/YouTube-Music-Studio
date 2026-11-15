# Output MASTER / THRESHOLD knobs from design/ref/outknobs2-ref.png (the whole artwork incl. name plate is the knob):
#   sk-st-ko2-<n>-base.png    artwork without the needle (needle painted out with a 180-degree copy of the dial face)
#   sk-st-ko2-<n>-needle.png  needle only, square, centred on the hub, pre-rotated to point UP (CSS rotates it by --a)
#   sk-st-ko2-<n>-hub.png     hub disc (lies above the needle)
# prints the placement numbers (relative to the hub centre, in image px) used by preload.js.
# usage: python -I design/tools/studio_outknobs2.py
import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage as ndi
im = Image.open('design/ref/outknobs2-ref.png').convert('RGBA'); A = np.asarray(im).astype(np.float32); H, W = A.shape[:2]
# name: hub centre, hub radius, needle angle (deg clockwise from up), needle length range, perp range, dial face radius, art x range
KN = {'master': dict(c=(530, 415), rh=57, ang=58.0, along=(40, 262), perp=(-26, 32), face=262, xr=(0, 1000)),
      'thresh': dict(c=(1350, 455), rh=30, ang=126.0, along=(20, 152), perp=(-18, 20), face=148, xr=(1000, 1705))}
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
for n, P in KN.items():
    cx, cy = P['c']; t = np.radians(P['ang']); dx, dy = np.sin(t), -np.cos(t)
    px, py = xx - cx, yy - cy; al = px * dx + py * dy; pe = -px * dy + py * dx
    d = np.hypot(px, py)
    rect = (al > P['along'][0]) & (al < P['along'][1]) & (pe > P['perp'][0]) & (pe < P['perp'][1]) & (d > P['rh'] - 2)
    lum = A[..., :3].mean(axis=2)
    needle = rect & (lum > 62) & (A[..., 3] > 200)
    needle = ndi.binary_closing(needle, iterations=3); needle = ndi.binary_fill_holes(needle)
    nm = ndi.gaussian_filter(needle.astype(np.float32), 0.8)
    wide = (al > P['along'][0] - 8) & (al < P['along'][1] + 4) & (np.abs(pe) < P['perp'][1] * 2.1) & (d > P['rh'] + 1)
    halo = wide & ((A[..., 0] - A[..., 1]) > 15) & (A[..., 3] > 200) & (d < P['face'])     # the red glow / shadow smear around the needle
    grown = ndi.binary_dilation(ndi.binary_closing(halo | needle, iterations=3), iterations=6)
    # base: paint the needle out with the opposite side of the dial (rotate 180 about the hub)
    cxi, cyi = int(round(cx)), int(round(cy)); R = int(P['face'] + 10)
    sub = A[cyi - R:cyi + R, cxi - R:cxi + R].copy(); rot = sub[::-1, ::-1]
    gmask = grown[cyi - R:cyi + R, cxi - R:cxi + R]; gm = ndi.gaussian_filter(gmask.astype(np.float32), 1.5)[..., None]
    base = A.copy(); region = base[cyi - R:cyi + R, cxi - R:cxi + R]
    # smooth diffusion fill from the surrounding face (a lit gradient, no copied wedge) + grain like the face texture
    rr = np.hypot(*np.mgrid[-R:R, -R:R]); gy, gx = np.mgrid[-R:R, -R:R]
    th = (np.degrees(np.arctan2(gx, -gy)) % 360)                      # clockwise from up, like the needle angle
    known = (~gmask & (rr < P['face'] - 12) & (rr > P['rh'] + 6) & (sub[..., :3].mean(axis=2) < 75) & ((sub[..., 0] - sub[..., 1]) < 16))
    fill = sub.copy()
    # polar interpolation: for every radius, blend the closest known pixels on both sides of the needle angle
    for ri in range(int(P['rh'] + 6), int(P['face'] - 10)):
        ring = (rr >= ri) & (rr < ri + 1)
        ang_known = th[ring & known]; 
        if ang_known.size < 8: continue
        for c in range(3):
            vals = sub[..., c][ring & known]
            o = np.argsort(ang_known); xa, va = ang_known[o], vals[o]
            fill[..., c][ring & gmask] = np.interp(th[ring & gmask], np.r_[xa - 360, xa, xa + 360], np.r_[va, va, va])
    for c in range(3): fill[..., c] = np.where(gmask, ndi.gaussian_filter(fill[..., c], 6), fill[..., c])
    # re-add the face's grain (high frequencies) from the opposite side of the dial, so the patch is not a smooth smear
    for c in range(3):
        grain = rot[..., c] - ndi.gaussian_filter(rot[..., c], 3)
        fill[..., c] = fill[..., c] + np.where(gmask, np.clip(grain, -12, 12), 0)
    # gold ticks that sat under the needle: take them from the opposite side (ticks are 180-degree symmetric)
    gold = (rot[..., 0] > 170) & (rot[..., 0] - rot[..., 2] > 80) & gmask
    gold = ndi.binary_dilation(gold, iterations=1) & gmask
    fill = np.where(gold[..., None], rot, fill)
    region[:] = region * (1 - gm) + fill * gm
    xr = P['xr']; ys, xs = np.nonzero((A[..., 3] > 10)[:, xr[0]:xr[1]]); bx0, bx1, by0, by1 = xs.min() + xr[0], xs.max() + xr[0] + 1, ys.min(), ys.max() + 1
    Image.fromarray(base[by0:by1, bx0:bx1].clip(0, 255).astype(np.uint8)).save(f'design/tex/sk-st-ko2-{n}-base.png')
    # needle sprite: square around the hub, rotated so the needle points up
    N = int(2 * (P['along'][1] + 6)); nx0, ny0 = cxi - N // 2, cyi - N // 2
    nsp = np.dstack([A[ny0:ny0 + N, nx0:nx0 + N, :3], (nm[ny0:ny0 + N, nx0:nx0 + N] * 255)]).clip(0, 255).astype(np.uint8)
    Image.fromarray(nsp).rotate(P['ang'], resample=Image.BICUBIC).save(f'design/tex/sk-st-ko2-{n}-needle.png')
    # hub disc
    r = P['rh'] + 2; hs = A[cyi - r:cyi + r, cxi - r:cxi + r, :3]; yy2, xx2 = np.mgrid[0:2 * r, 0:2 * r]
    ha = np.clip((r - 1 - np.hypot(xx2 - r + .5, yy2 - r + .5)) * 255, 0, 255)
    Image.fromarray(np.dstack([hs, ha]).astype(np.uint8)).save(f'design/tex/sk-st-ko2-{n}-hub.png')
    print(n, 'hub', (cx, cy), 'art bbox', (bx0, by0, bx1, by1), 'needle sprite', N, 'hub disc', 2 * r)
