# Centre the ENHANCER panel title on its name plate in sk-studio.jpg (text sat ~10 px left of the plate centre).
# usage: python -I design/tools/studio_title_fix.py design/tex/sk-studio.jpg [enh] [out]  (each job once, on the current file)
import sys
import numpy as np
from PIL import Image
p = sys.argv[1]
a = np.asarray(Image.open(p).convert('RGB')).copy()
def shift(SHIFT, y0, y1, x0, x1):
    lab = a[y0:y1, x0:x1].copy()
    a[y0:y1, x0:x0 + SHIFT] = a[y0:y1, x0 - SHIFT:x0]
    a[y0:y1, x0 + SHIFT:x1 + SHIFT] = lab
for job in sys.argv[2:] or ['enh']:
    if job == 'enh': shift(10, 101, 141, 2893, 3102)      # ENHANCER: ~10 px left of its plate centre
    if job == 'out': shift(20, 104, 142, 3538, 3692)      # OUTPUT: ~20 px left
    if job == 'outplate': shift(22, 86, 152, 3412, 3862)  # OUTPUT name plate: ~22 px left of the module centre
Image.fromarray(a).save(p, quality=86)
