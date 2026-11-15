# song-list plate fill: user's seamless rust texture at native size (no resize/mirroring), CSS repeats it
from PIL import Image
im = Image.open('design/ref/list-texture-ref.png').convert('RGB')
print(im.size)
im.save('design/tex/sk-listtex.jpg', quality=90)
