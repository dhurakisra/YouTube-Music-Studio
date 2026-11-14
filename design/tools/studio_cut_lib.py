import sys, math
import numpy as np
from PIL import Image, ImageFilter
REF, OUT = sys.argv[1], sys.argv[2]
im = Image.open(REF).convert('RGB'); A = np.asarray(im).astype(np.float32)
def crop(b): return A[b[1]:b[3], b[0]:b[2]].copy()
def save(a, n, alpha=None, q=None):
    a = np.clip(a,0,255).astype(np.uint8)
    if alpha is not None:
        img = Image.fromarray(np.dstack([a, np.clip(alpha*255,0,255).astype(np.uint8)]), 'RGBA')
    else: img = Image.fromarray(a)
    if n.endswith('.jpg'): img.save(f'{OUT}/{n}', quality=q or 88)
    else: img.save(f'{OUT}/{n}', optimize=True)
def unpoint(a, cx, cy, r, thr=28):
    """Remove a knob's indicator line: replace outliers inside radius r with the median at the same radius, nearby angles."""
    h, w = a.shape[:2]; out = a.copy()
    lum = a.mean(2)
    for y in range(h):
        for x in range(w):
            dx, dy = x-cx, y-cy; rr = math.hypot(dx, dy)
            if rr > r or rr < 1.5: continue
            t = math.atan2(dy, dx); samp = []
            for d in (-0.55,-0.42,-0.32,0.32,0.42,0.55):
                sx, sy = int(round(cx+rr*math.cos(t+d))), int(round(cy+rr*math.sin(t+d)))
                if 0<=sx<w and 0<=sy<h: samp.append(a[sy,sx])
            m = np.median(np.array(samp), 0)
            if abs(lum[y,x]-m.mean()) > thr: out[y,x] = m
    return out
def disc_alpha(h, w, cx, cy, r, feather=2.0):
    yy, xx = np.mgrid[0:h,0:w]; d = np.hypot(xx-cx, yy-cy)
    return np.clip((r - d)/feather + 0.5, 0, 1)
def knob(n, cx, cy, R, rin, thr=28):
    b = (cx-R, cy-R, cx+R, cy+R); a = crop(b)
    a = unpoint(a, R, R, rin, thr)
    save(a, n, disc_alpha(2*R, 2*R, R, R, R-1))
cmd = sys.argv[3] if len(sys.argv)>3 else 'all'
if cmd in ('knobs','all'):
    knob('sk-st-kcream.png', 1730, 1043, 50, 34)
    knob('sk-st-kred.png', 3212, 213, 50, 36)
    knob('sk-st-kdark.png', 3780, 478, 50, 34)
    knob('sk-st-kmaster.png', 3547, 470, 104, 66)
    knob('sk-st-kenh.png', 2832, 213, 50, 34)
