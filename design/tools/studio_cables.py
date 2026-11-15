# Vocal Chain cable layer: design/ref/chain-cables-ref.png (user mock, white background) -> design/tex/sk-st-cables.png (RGBA).
# Only what is outside the module plates is kept (arcs above, cables below, the bridges between neighbouring plates); the module plates and
# their controls stay live in the DOM. White background -> transparent. The plate x ranges below also drive the module widths in preload.js.
import numpy as np
from PIL import Image
PLATES = [(27, 260), (282, 512), (534, 623), (644, 732), (753, 888), (909, 997), (1017, 1105), (1125, 1214), (1234, 1371), (1393, 1530), (1551, 1683), (1705, 1842), (1863, 2000), (2021, 2150)]
TOP, BOT, INSET = 236, 466, 8
im = np.asarray(Image.open('design/ref/chain-cables-ref.png').convert('RGB')).astype(np.float32)
H, W, _ = im.shape
m = im.min(axis=2)
alpha = np.clip((246 - m) / 36.0, 0, 1)                        # white -> transparent, the soft glow stays partly transparent
keep = np.ones((H, W), bool)
keep[TOP:BOT, :] = False                                         # the whole band beside the plates (the vertical bridges between modules) is dropped: only the cables above and below stay
for x0, x1 in PLATES: pass
# the mock's thin horizontal rail under the plates (bright yellow line) is not a cable: drop it where nothing hangs below it
white = m > 244
for x in range(W):
    if white[494:500, x].all(): keep[466:494, x] = False          # nothing hangs here: bare rail / dark background

keep[:, :20] = False; keep[:, 2160:] = False                   # the mock's outer end caps: the drawer has its own side pillars
lum = im.mean(axis=2)
band = np.zeros((H, W), bool); band[466:494, :] = True
alpha = np.where(band & (lum < 46), 0, alpha)                  # the mock's dark background behind the cables: transparent
alpha = alpha * keep
rgba = np.dstack([im, alpha * 255]).clip(0, 255).astype(np.uint8)
y0, y1 = 210, 515
sp = Image.fromarray(rgba[y0:y1]); SPLIT = 350 - y0
sp.crop((0, 0, W, SPLIT)).save('design/tex/sk-st-cables-top.png'); sp.crop((0, SPLIT, W, y1 - y0)).save('design/tex/sk-st-cables-bot.png')
print('top', W, SPLIT, 'bot', W, y1 - y0 - SPLIT, 'origin y', y0)
