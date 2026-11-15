# Paints the old MASTER / THRESH knobs out of the Output plate in sk-studio.jpg with randomly quilted plate texture
# (no mirror symmetry). Run on the backdrop BEFORE it had them removed (git show 64ff728:design/tex/sk-studio.jpg).
# usage: python -I design/tools/studio_outplate.py <in.jpg> <out.jpg>
import sys, numpy as np
from PIL import Image
a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.float32)
src = a[588:652, 3692:3898]; rng = np.random.default_rng(7)
def quilt(b, T=48, ov=16):
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
    al = np.clip(f / 26, 0, 1)[..., None]
    a[y0:y1, x0:x1] = a[y0:y1, x0:x1] * (1 - al) + fill * al
quilt((3425, 360, 3672, 640)); quilt((3690, 390, 3875, 610))
quilt((3500, 615, 3800, 760), T=40, ov=14)   # baked LIMITER plate (the live button sits elsewhere)
Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(sys.argv[2], quality=86)
