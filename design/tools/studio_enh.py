# Enhancer buttons from design/ref/enh-{off,on}-ref.png (off = not pressed, on = active). Text baked in.
# usage: python -I design/tools/studio_enh.py design/ref design/tex
import sys
from PIL import Image
ref, out = sys.argv[1], sys.argv[2]
boxes = {'main': (62, 518, 1084, 642), 'analog': (62, 696, 388, 824), 'vinyl': (418, 696, 740, 824), 'tape': (772, 696, 1086, 824)}
for state in ('off', 'on'):
    im = Image.open(f'{ref}/enh-{state}-ref.png').convert('RGB')
    for name, b in boxes.items(): im.crop(b).save(f'{out}/sk-st-enh-{name}-{state}.png', optimize=True)
