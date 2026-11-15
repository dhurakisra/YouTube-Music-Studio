# Output VU dials from design/ref/vu-{l,r}-ref.png (no needle; the needle is drawn live).
# Writes the dial and a cover sprite (the dark bezel + "L/R" hump, alpha) that sits above the needle so its pivot hides under it.
# usage: python -I design/tools/studio_vu.py design/ref design/tex
import sys, os
import numpy as np
from PIL import Image, ImageFilter
ref, out = sys.argv[1], sys.argv[2]
for side in ('l', 'r'):
    src = f'{ref}/vu-{side}-ref.png'
    if not os.path.exists(src): src = f'{ref}/vu-l-ref.png'   # until a separate R dial is supplied
    im = Image.open(src).convert('RGB'); im.save(f'{out}/sk-st-vu-{side}.png', optimize=True)
    a = np.asarray(im).astype(np.float32); h = a.shape[0]
    lum = a.mean(2); yy = np.mgrid[0:h, 0:a.shape[1]][0]
    m = ((lum < 120) & (yy > h * 0.72)).astype(np.uint8) * 255
    m = Image.fromarray(m).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.GaussianBlur(1.5))
    Image.fromarray(np.dstack([a, np.asarray(m)]).astype(np.uint8), 'RGBA').save(f'{out}/sk-st-vu-{side}-cover.png', optimize=True)
