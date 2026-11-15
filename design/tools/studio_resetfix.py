# Paints the baked RESET plate (Key & Tempo, left) out of sk-studio.jpg with plain plate texture; the live RESET button (own plate + label) is placed
# centred by preload.js. usage: python -I design/tools/studio_resetfix.py <in.jpg> <out.jpg>   (in = design/ref/sk-studio.pre-resetbtn.jpg)
import sys, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
x0, y0, x1, y1 = 528, 330, 656, 400
src = a[430:500, 560:688]                      # a clean, textured stretch of the same plate below
h, w = y1 - y0, x1 - x0
fill = np.asarray(Image.fromarray(src.astype(np.uint8)).resize((w, h), Image.LANCZOS)).astype(np.float32)
m = np.zeros((h, w), np.float32); m[5:-5, 5:-5] = 1; m = gaussian_filter(m, 4)[..., None]
a[y0:y1, x0:x1] = a[y0:y1, x0:x1] * (1 - m) + fill * m
Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(sys.argv[2], quality=88)
