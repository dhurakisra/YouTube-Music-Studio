# Lengthens the left status plate (Separation model) of sk-studio.jpg to the right: the plate's middle is repeated and the end cap with the
# start of the pipes is moved right. usage: python -I design/tools/studio_statusplate.py <in.jpg> <out.jpg>   (in = design/ref/sk-studio.pre-statusplate.jpg)
import sys, numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
Y0, Y1 = 1346, 1434; CAP0, CAP1 = 480, 780; SHIFT = 130; FEATHER = 70
orig = a[Y0:Y1].copy()
cap = orig[:, CAP0:CAP1].copy()                           # end cap + the start of the pipes
mid = orig[:, 300:420]                                    # clean plate middle (rails + dark field)
n = SHIFT
new = np.tile(mid, (1, int(np.ceil(n / 120)), 1))[:, :n]
bl = np.clip(np.arange(n) / 14.0, 0, 1)[None, :, None]    # soft join with the original plate on the left
a[Y0:Y1, CAP0:CAP0 + n] = orig[:, CAP0:CAP0 + n] * (1 - bl) + new * bl
w = np.ones(CAP1 - CAP0, np.float32); w[-FEATHER:] = np.linspace(1, 0, FEATHER)   # the moved pipes fade back into the original ones
w = w[None, :, None]
dst = slice(CAP0 + SHIFT, CAP1 + SHIFT)
a[Y0:Y1, dst] = a[Y0:Y1, dst] * (1 - w) + cap * w
Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(sys.argv[2], quality=88)
