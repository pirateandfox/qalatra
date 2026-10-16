"""Orders the raw simulator captures into the App Store set and builds captioned Google Play
phone screenshots (1080x1920; Play rejects anything longer than 2:1, which raw iPhone shots are).

Run from mobile/: python3 -I store/make-store-screenshots.py
"""
import shutil
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

RAW = Path('store/screenshots')
SET = [
    ('01-priority', 'See what matters today'),
    ('02-task', 'Every detail, in your pocket'),
    ('04-habits', 'Build habits alongside your tasks'),
    ('05-search', 'Find anything, fast'),
    ('00-connect', 'Your server, your data'),
]
FONT = '/System/Library/Fonts/SFNS.ttf'
BG = (13, 14, 24)

for kind in ('iphone', 'ipad'):
    out = Path('store/appstore') / kind
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob('*.png'):
        old.unlink()
    for i, (name, _) in enumerate(SET, 1):
        shutil.copy(RAW / kind / f'{name}.png', out / f'{i}-{name[3:]}.png')

out = Path('store/play/phone')
out.mkdir(parents=True, exist_ok=True)
for old in out.glob('*.png'):
    old.unlink()
title = ImageFont.truetype(FONT, 68)
title.set_variation_by_name('Bold')
W, H = 1080, 1920
for i, (name, caption) in enumerate(SET, 1):
    img = Image.new('RGB', (W, H), BG)
    glow = Image.new('L', (W, H), 0)
    ImageDraw.Draw(glow).ellipse((-200, -300, W + 200, 700), fill=70)
    img.paste(Image.new('RGB', (W, H), (130, 60, 240)), (0, 0), glow.filter(ImageFilter.GaussianBlur(160)))
    d = ImageDraw.Draw(img)
    size = 68
    font = title
    while d.textlength(caption, font=font) > W - 160:
        size -= 2
        font = ImageFont.truetype(FONT, size)
        font.set_variation_by_name('Bold')
    tw = d.textlength(caption, font=font)
    d.text(((W - tw) / 2, 160 - size // 2), caption, font=font, fill=(245, 243, 255))
    shot = Image.open(RAW / 'iphone' / f'{name}.png').convert('RGB')
    sh = 1600
    sw = round(shot.width * sh / shot.height)
    shot = shot.resize((sw, sh), Image.LANCZOS)
    mask = Image.new('L', (sw, sh), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, sw - 1, sh - 1), radius=56, fill=255)
    x, y = (W - sw) // 2, 260
    border = Image.new('L', (sw + 8, sh + 8), 0)
    ImageDraw.Draw(border).rounded_rectangle((0, 0, sw + 7, sh + 7), radius=60, fill=255)
    img.paste((60, 58, 80), (x - 4, y - 4), border)
    img.paste(shot, (x, y), mask)
    img.save(out / f'{i}-{name[3:]}.png')
print('ok')
