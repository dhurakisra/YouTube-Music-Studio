# Output MASTER / THRESH knobs from design/ref/outknobs-ref.png.
# Centre = least-squares circle fitted to the dark face edge (so it turns in place).
# cap  = face + brass bezel + pointer (a perfect disc), rotated so the pointer points up: this is what turns.
# base = the full knob incl. the outer glow ring and the two side studs: static, shown under the cap.
# usage: python -I design/tools/studio_outknobs.py design/ref/outknobs-ref.png design/tex
import sys, math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
src, out = sys.argv[1], sys.argv[2]
img = Image.open(src).convert('RGB')
lum = np.asarray(img).astype(float).mean(2)
def fit(cx, cy, rmin, rmax, thr=120):
    pts = []
    for k in range(72):
        t = math.radians(k * 5 + 2.5)
        for r in range(rmin, rmax):
            x = int(round(cx + r * math.cos(t))); y = int(round(cy + r * math.sin(t)))
            if lum[y, x] > thr: pts.append((cx + r * math.cos(t), cy + r * math.sin(t))); break
    P = np.array(pts)
    for _ in range(3):
        A = np.c_[2 * P, np.ones(len(P))]; b = (P ** 2).sum(1); sol, *_ = np.linalg.lstsq(A, b, rcond=None)
        x0, y0 = sol[:2]; R = math.sqrt(sol[2] + x0 * x0 + y0 * y0)
        d = np.hypot(P[:, 0] - x0, P[:, 1] - y0); P = P[abs(d - np.median(d)) < 3]
    return x0, y0, R
def disc(S, r, blur):
    m = Image.new('L', (S, S)); ImageDraw.Draw(m).ellipse([S / 2 - r, S / 2 - r, S / 2 + r, S / 2 + r], fill=255)
    return m.filter(ImageFilter.GaussianBlur(blur))
def knob(name, guess, rng, half, cap_k, base_r, studs, tip):
    cx, cy, Rf = fit(*guess, *rng)
    S = 2 * half
    pad = Image.new('RGB', (img.width + S, img.height + S)); pad.paste(img, (half, half))
    crop = pad.transform((S, S), Image.AFFINE, (1, 0, cx, 0, 1, cy), resample=Image.BICUBIC)  # centre lands exactly at (half, half)
    ang = math.degrees(math.atan2(tip[0] - cx, -(tip[1] - cy)))
    cap = crop.convert('RGBA'); cap.putalpha(disc(S, Rf * cap_k, 1.2))
    cap.rotate(ang, resample=Image.BICUBIC, center=(half, half)).save(f'{out}/sk-st-{name}-cap.png', optimize=True)
    m = disc(S, base_r, 3)
    d = ImageDraw.Draw(m)
    for (sx, sy, sr) in studs:
        sx, sy = sx - cx + half, sy - cy + half; d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=255)
    base = crop.convert('RGBA'); base.putalpha(m); base.save(f'{out}/sk-st-{name}-base.png', optimize=True)
    print(name, 'centre', round(cx, 1), round(cy, 1), 'face R', round(Rf, 1), 'pointer', round(ang, 1))
knob('kout-master', (518, 375), (130, 280), 372, 1.205, 352, [(171, 385, 24), (857, 385, 24)], (711, 263))
knob('kout-thresh', (1328, 410), (70, 140), 192, 1.235, 176, [(1138, 402, 17), (1506, 402, 17)], (1418, 470))
