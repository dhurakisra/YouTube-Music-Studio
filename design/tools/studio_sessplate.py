# Session gear bay of sk-studio.jpg: the old baked wheels are removed and the bay gets a dim steampunk mesh plate (design/ref/mesh-ref.png,
# frame cropped away) as its bottom layer; the live gears turn on top of it. Everything is baked into the backdrop, so the layer order is
# untouched (backdrop < gears < buttons).
# usage: python -I design/tools/studio_sessplate.py <in.jpg> <out.jpg>   (in = design/ref/sk-studio.pre-sgears.jpg)
import sys, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
X0, Y0, X1, Y1 = 76, 611, 452, 774                 # the bay (ref px)
OPACITY, DIM = 0.55, 0.62                           # mesh strength / brightness: low = faded
mesh = Image.open('design/ref/mesh-ref.png').convert('RGB').crop((200, 300, 1000, 300 + int(800 * (Y1 - Y0) / (X1 - X0))))
mesh = np.asarray(mesh.resize((X1 - X0, Y1 - Y0), Image.LANCZOS)).astype(np.float32)
base = np.array([26.0, 14.0, 8.0])                  # plain dark plate under the mesh
inside = np.zeros(a.shape[:2], np.float32); inside[Y0:Y1, X0:X1] = 1
al = gaussian_filter(inside, 4)[Y0:Y1, X0:X1][..., None]
lum = mesh.mean(axis=2, keepdims=True); tint = mesh * 0.5 + lum * np.array([1.0, 0.62, 0.34]) * 0.5   # warm bronze tint
layer = base * (1 - OPACITY) + tint * DIM * OPACITY + base * 0.0
a[Y0:Y1, X0:X1] = a[Y0:Y1, X0:X1] * (1 - al) + layer * al
Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(sys.argv[2], quality=86)
