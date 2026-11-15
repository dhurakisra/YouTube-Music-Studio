# Cuts the four Vocal Chain buttons (MIC, AUTO-TUNE, CHAIN ON, REC), unpressed and pressed, out of design/ref/chainbtn-{off,on}-ref.png
# (text and LED are painted into the plates, the live label is hidden) -> design/tex/sk-st-cb-<name>-{off,on}.png with rounded-rect alpha.
# usage: python -I design/tools/studio_chainbtn.py
from PIL import Image, ImageDraw
BOX = {'mic': (78, 496, 532, 588), 'at': (618, 496, 1080, 588), 'chain': (322, 874, 824, 986), 'rec': (322, 1042, 824, 1156)}
for state in ('off', 'on'):
    src = Image.open(f'design/ref/chainbtn-{state}-ref.png').convert('RGB')
    for n, b in BOX.items():
        im = src.crop(b).convert('RGBA'); w, h = im.size; r = int(h * 0.2)
        m = Image.new('L', (w * 4, h * 4), 0); ImageDraw.Draw(m).rounded_rectangle([0, 0, w * 4 - 1, h * 4 - 1], r * 4, fill=255)
        im.putalpha(m.resize((w, h), Image.LANCZOS)); im.save(f'design/tex/sk-st-cb-{n}-{state}.png'); print(n, state, w, h)
