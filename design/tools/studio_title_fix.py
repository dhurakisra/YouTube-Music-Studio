# Centre the ENHANCER panel title on its name plate in sk-studio.jpg (text sat ~10 px left of the plate centre).
# usage: python -I design/tools/studio_title_fix.py design/tex/sk-studio.jpg
import sys
import numpy as np
from PIL import Image
p = sys.argv[1]
a = np.asarray(Image.open(p).convert('RGB')).copy()
SHIFT, y0, y1, x0, x1 = 10, 101, 141, 2893, 3102
lab = a[y0:y1, x0:x1].copy()
a[y0:y1, x0:x0 + SHIFT] = a[y0:y1, x0 - SHIFT:x0]
a[y0:y1, x0 + SHIFT:x1 + SHIFT] = lab
Image.fromarray(a).save(p, quality=86)
