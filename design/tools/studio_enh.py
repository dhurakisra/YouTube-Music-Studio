# Enhancer buttons from design/ref/enh-{off,on}-ref.png (off = not pressed, on = active). Text baked in.
# usage: python -I design/tools/studio_enh.py design/ref design/tex
import sys
from PIL import Image
ref, out = sys.argv[1], sys.argv[2]
boxes = {'main': (62, 518, 1084, 642), 'analog': (62, 696, 388, 824), 'vinyl': (418, 696, 740, 824), 'tape': (772, 696, 1086, 824)}
for state in ('off', 'on'):
    im = Image.open(f'{ref}/enh-{state}-ref.png').convert('RGB')
    for name, b in boxes.items(): im.crop(b).save(f'{out}/sk-st-enh-{name}-{state}.png', optimize=True)
# Centre the ENHANCER label (dot + text) on its plate: shift it right, refill the gap with the plain plate beside it.
import numpy as np
SHIFT = 16
for state in ('off', 'on'):
    p = f'{out}/sk-st-enh-main-{state}.png'
    a = np.asarray(Image.open(p).convert('RGB')).copy()
    y0, y1, x0, x1 = 28, 96, 355, 690
    lab = a[y0:y1, x0:x1].copy()
    a[y0:y1, x0:x0 + SHIFT] = a[y0:y1, x0 - SHIFT:x0]
    a[y0:y1, x0 + SHIFT:x1 + SHIFT] = lab
    Image.fromarray(a).save(p, optimize=True)
