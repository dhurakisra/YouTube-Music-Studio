# Brass toggle switch (design/ref/toggle-ref.png): left = lever up (ON), right = lever down (OFF).
# Cut by shape (base ellipse + lever where it is lit); the glow is left out (CSS adds it). Both sprites share the same
# size with the base at the same spot, so switching state does not move the switch.
# usage: python -I design/tools/studio_toggle.py design/ref/toggle-ref.png design/tex
import sys
import numpy as np
from PIL import Image, ImageFilter
src, out = sys.argv[1], sys.argv[2]
A = np.asarray(Image.open(src).convert('RGB')).astype(np.float32)
W, H, BY = 230, 300, 160   # sprite size; base centre at (W/2, BY)
def cut(name, cx, cy, rx, ry, ball, stem):
    x0, y0 = cx - W // 2, cy - BY
    a = A[y0:y0 + H, x0:x0 + W]
    yy, xx = np.mgrid[0:H, 0:W]
    base = ((xx - W / 2) / rx) ** 2 + ((yy - BY) / ry) ** 2 <= 1
    bx, by, br = ball; sx0, sy0, sx1, sy1 = stem
    lev = (np.hypot(xx - (bx - x0), yy - (by - y0)) <= br) | ((xx >= sx0 - x0) & (xx < sx1 - x0) & (yy >= sy0 - y0) & (yy < sy1 - y0))
    m = Image.fromarray(((base | lev) * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.2))
    Image.fromarray(np.dstack([a, np.asarray(m)]).astype(np.uint8), 'RGBA').save(f'{out}/{name}', optimize=True)
cut('sk-st-toggle-on.png', 562, 511, 106, 106, (558, 397, 44), (531, 400, 588, 520))
cut('sk-st-toggle-off.png', 898, 505, 103, 108, (903, 579, 44), (870, 470, 935, 580))
