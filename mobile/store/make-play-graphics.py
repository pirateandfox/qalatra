"""Builds the Google Play icon (512x512) and feature graphic (1024x500) from assets/icon.png.

Run from mobile/: python3 -I store/make-play-graphics.py
"""
from PIL import Image, ImageDraw, ImageFont

BG = (13, 14, 24)
FONT = '/System/Library/Fonts/SFNS.ttf'

icon = Image.open('assets/icon.png').convert('RGB')
icon.resize((512, 512), Image.LANCZOS).save('store/play/icon-512.png')

W, H = 1024, 500
img = Image.new('RGB', (W, H), BG)
# Soft violet glow behind the mark.
glow = Image.new('L', (W, H), 0)
ImageDraw.Draw(glow).ellipse((40, 0, 500, 500), fill=60)
from PIL import ImageFilter
glow = glow.filter(ImageFilter.GaussianBlur(90))
img.paste(Image.new('RGB', (W, H), (150, 70, 255)), (0, 0), glow)
mark = icon.resize((360, 360), Image.LANCZOS)
# icon.png has a flat BG-coloured square; key it out so the glow shows through.
mask = Image.eval(mark.convert('L'), lambda v: 0 if v < 30 else 255)
img.paste(mark, (90, 70), mask)
d = ImageDraw.Draw(img)
title = ImageFont.truetype(FONT, 96)
title.set_variation_by_name('Bold')
tag = ImageFont.truetype(FONT, 38)
tag.set_variation_by_name('Regular')
d.text((500, 160), 'Qalatra', font=title, fill=(245, 243, 255))
d.text((504, 290), 'Tasks and agents,', font=tag, fill=(190, 180, 225))
d.text((504, 338), 'on the go.', font=tag, fill=(190, 180, 225))
img.save('store/play/feature-graphic-1024x500.png')
print('ok')
