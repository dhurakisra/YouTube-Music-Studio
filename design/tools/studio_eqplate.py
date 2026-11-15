# Paints the baked EQ button/preset plates (EQ ON, FLAT, BASS BOOST, VOCAL, preset select, name, SAVE, DEL, Q slider) out of
# sk-studio.jpg with randomly quilted dark plate texture; the live controls draw their own plates (mode-dependent).
# usage: python -I design/tools/studio_eqplate.py <in.jpg> <out.jpg>
import sys, numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
src = a[250:650, 960:1360]; rng = np.random.default_rng(11)
def quilt(b, T=72, ov=24):
    x0, y0, x1, y1 = b; w, h = x1 - x0, y1 - y0
    acc = np.zeros((h + T, w + T, 3), np.float32); wt = np.zeros((h + T, w + T, 1), np.float32)
    ramp = np.minimum(np.arange(T) + 1, T - np.arange(T)).astype(np.float32); ramp = np.minimum(ramp / ov, 1)
    win = (ramp[:, None] * ramp[None, :])[..., None]
    for y in range(0, h, T - ov):
        for x in range(0, w, T - ov):
            sy = rng.integers(0, src.shape[0] - T + 1); sx = rng.integers(0, src.shape[1] - T + 1)
            t = src[sy:sy + T, sx:sx + T]
            if rng.random() < .5: t = t[:, ::-1]
            acc[y:y + T, x:x + T] += t * win; wt[y:y + T, x:x + T] += win
    fill = acc[:h, :w] / np.maximum(wt[:h, :w], 1e-3)
    yy, xx = np.mgrid[0:h, 0:w]; f = np.minimum.reduce([xx, yy, w - 1 - xx, h - 1 - yy]).astype(np.float32)
    al = np.clip(f / 16, 0, 1)[..., None]
    a[y0:y1, x0:x1] = a[y0:y1, x0:x1] * (1 - al) + fill * al
quilt((1560, 492, 2610, 722))
Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(sys.argv[2], quality=86)
