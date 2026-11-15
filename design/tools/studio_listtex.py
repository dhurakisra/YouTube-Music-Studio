# song-list plate fill: mirror-tiled (seamless) rust texture from design/ref/list-texture-ref.png
from PIL import Image, ImageOps
im = Image.open('design/ref/list-texture-ref.png').convert('RGB').resize((600, 600), Image.LANCZOS)
t = Image.new('RGB', (1200, 1200))
t.paste(im, (0, 0)); t.paste(ImageOps.mirror(im), (600, 0))
t.paste(ImageOps.flip(im), (0, 600)); t.paste(ImageOps.flip(ImageOps.mirror(im)), (600, 600))
t.save('design/tex/sk-listtex.jpg', quality=88)
