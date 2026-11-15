# TV frame v2: the supplied PNG has no alpha (black outside, checkerboard glass baked in). Rebuild alpha:
# outside black -> transparent (flood from border), checker glass -> translucent dark glass keeping reflections, top slot stays opaque black.
from PIL import Image
import numpy as np
from scipy import ndimage as ndi
im = Image.open('design/ref/tv-frame2-ref.png').convert('RGB')
a = np.array(im).astype(float); H, W = a.shape[:2]
mx = a.max(axis=2); mn = a.min(axis=2); lum = a.mean(axis=2); sat = (mx - mn) / np.maximum(mx, 1)
alpha = np.full((H, W), 255.0); out = a.copy()
# 1) outside
dark = mx < 60
lab, n = ndi.label(dark)
edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
outside = np.isin(lab, list(edge))
alpha[outside] = np.clip(mx[outside] / 36.0, 0, 1) * 255
# 2) glass (checkerboard grey)
pas = (sat < 0.55) & (lum < 150) & ~outside
pas = ndi.binary_opening(pas, iterations=2)
lab, n = ndi.label(pas)
g = lab == lab[H // 2 + 20, W // 2 - 10]
g = ndi.binary_closing(g, iterations=12)
g = ndi.binary_fill_holes(g)
g = ndi.binary_erosion(g, iterations=3)
gs = ndi.gaussian_filter(g.astype(float), 2.0)
ys, xs = np.where(g); print('glass bbox', xs.min(), ys.min(), xs.max(), ys.max())
w = np.clip((lum - 90) / 34.0, 0, 1)
w = np.maximum(w, np.clip((sat - 0.18) / 0.25, 0, 1)) # orange glints
dk = np.array([16, 10, 6], float)
gc = dk[None, None, :] * (1 - w[..., None]) + a * w[..., None]
ga = 34 + w * 190
for c in range(3): out[..., c] = out[..., c] * (1 - gs) + gc[..., c] * gs
alpha = alpha * (1 - gs) + ga * gs
res = np.dstack([out, alpha]).clip(0, 255).astype('uint8')
r = Image.fromarray(res, 'RGBA')
bb = np.where(alpha > 10); x0, y0, x1, y1 = bb[1].min(), bb[0].min(), bb[1].max(), bb[0].max()
print('frame', x0, y0, x1, y1)
r.crop((x0, y0, x1 + 1, y1 + 1)).save('design/tex/sk-tv.png')
open('design/tex/sk-tv.meta.txt', 'w').write(f'crop {x0} {y0} {x1+1} {y1+1}\nglass {xs.min()-x0} {ys.min()-y0} {xs.max()-x0} {ys.max()-y0}\n')
