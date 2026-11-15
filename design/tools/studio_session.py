# Session buttons from design/ref/session-{off,on}-ref.png (off = not pressed, on = pressed/active).
# LISTEN, LISTEN WITH STEMS, KARAOKE and ADVANCED are used whole (icon + text baked in). START KARAOKE changes its text
# (STOP & SAVE, BUFFERING...), so it gets the KARAOKE plate with the text cleared and live text on top.
# usage: python -I design/tools/studio_session.py design/ref design/tex
import sys
import numpy as np
from PIL import Image
ref, out = sys.argv[1], sys.argv[2]
boxes = {'listen': (40, 236, 950, 424), 'stems': (40, 476, 950, 672), 'karaoke': (40, 722, 950, 915), 'adv': (132, 975, 862, 1155)}
for state in ('off', 'on'):
    im = Image.open(f'{ref}/session-{state}-ref.png').convert('RGB')
    for name, b in boxes.items():
        im.crop(b).save(f'{out}/sk-st-ses-{name}-{state}.png', optimize=True)
    # START KARAOKE plate: clear "KARAOKE" (x 395..700, y 768..868) with mirrored tiles of the clean plate to its right
    a = np.asarray(im).astype(np.uint8).copy()
    x0, x1, y0, y1 = 395, 705, 768, 868
    patch = a[y0:y1, 705:880]
    t = patch
    while t.shape[1] < x1 - x0: t = np.concatenate([t, t[:, ::-1]], 1)
    a[y0:y1, x0:x1] = t[:, :x1 - x0]
    Image.fromarray(a).crop(boxes['karaoke']).save(f'{out}/sk-st-ses-start-{state}.png', optimize=True)
