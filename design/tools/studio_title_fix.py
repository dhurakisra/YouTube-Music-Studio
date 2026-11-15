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
# 'outknobs': paint the old MASTER / THRESH knobs and labels out of the Output plate (live knobs + labels replace them)
if 'outknobs' in sys.argv[2:]:
    exec(open(__file__.replace('studio_title_fix.py', 'studio_cut_lib.py')).read().split("def crop(b)")[0])
    import importlib.util
    def texfill(b, src, feather=12):
        sx0, sy0, sx1, sy1 = src; p_ = a[sy0:sy1, sx0:sx1].astype(np.float32)
        w, h = b[2] - b[0], b[3] - b[1]; t = p_
        while t.shape[1] < w: t = np.concatenate([t, t[:, ::-1]], 1)
        t = t[:, :w]
        while t.shape[0] < h: t = np.concatenate([t, t[::-1]], 0)
        t = t[:h]
        yy, xx = np.mgrid[0:h, 0:w]; f = np.minimum.reduce([xx, yy, w - 1 - xx, h - 1 - yy]).astype(np.float32)
        al = np.clip(f / feather, 0, 1)[..., None]
        a[b[1]:b[3], b[0]:b[2]] = (a[b[1]:b[3], b[0]:b[2]] * (1 - al) + t * al).astype(np.uint8)
    texfill((3425, 360, 3672, 640), (3690, 585, 3900, 650))
    texfill((3715, 405, 3850, 590), (3690, 585, 3900, 650))
    Image.fromarray(a).save(p, quality=86)
