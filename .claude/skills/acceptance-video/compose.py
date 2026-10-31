# 録画（recording.webm）の上に帯を足し、cues.json の字幕を帯に載せて mp4 にする。
# 使い方: python3 -I compose.py <recording.webm> <cues.json> <out.mp4>
#         python3 -I compose.py --spans <cues.json>    字幕を出す区間を JSON で出す（ffmpeg を使わない）
# 字幕は Pillow で画像にして overlay で重ねる。ffmpeg には subtitles と drawtext のフィルタが無い環境があるため。
# 終了コード: 0 は書けて 30 秒以内、3 は書いたが 30 秒を超えた、1 は cues.json の誤り、2 は引数の誤りか ffmpeg の失敗
import json
import subprocess
import sys
from pathlib import Path

WIDTH, BAND_H, VIDEO_H = 1280, 80, 640
MAX_SECONDS = 30.0
BAND_BG = (15, 15, 20)
FONT_CANDIDATES = [
    '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
    '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
]
USAGE = '使い方: python3 -I compose.py <recording.webm> <cues.json> <out.mp4> | --spans <cues.json>'


def spans_from_cues(cues):
    """字幕ごとの (文, 開始, 終了) を返す。cue は次の cue の時刻まで出し、空の文は帯を空にする"""
    for a, b in zip(cues, cues[1:]):
        if b['t'] < a['t']:
            raise ValueError(f"cues の時刻が戻っている: {a['t']} → {b['t']}")
    return [
        {'text': cue['text'], 'start': cue['t'], 'end': nxt['t']}
        for cue, nxt in zip(cues, cues[1:])
        if cue['text']
    ]


def load_cues(path):
    cues = json.loads(Path(path).read_text())
    if not cues or cues[-1]['text'] != '':
        raise ValueError('cues の最後は、字幕を閉じる空の文')
    return cues


def draw_band(text, dest):
    from PIL import Image, ImageDraw, ImageFont

    font_path = next((p for p in FONT_CANDIDATES if Path(p).exists()), None)
    if font_path is None:
        raise ValueError('日本語のフォントが無い（compose.py の FONT_CANDIDATES）')
    img = Image.new('RGB', (WIDTH, BAND_H), BAND_BG)
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(font_path, 32)
    width = draw.textlength(text, font=font)
    draw.text(((WIDTH - width) / 2, BAND_H / 2), text, font=font, fill=(255, 255, 255), anchor='lm')
    img.save(dest)


def duration_of(path):
    probe = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(probe.stdout)


def compose(webm, cues, out):
    spans = spans_from_cues(cues)
    bands = out.parent / f'{out.stem}-bands'
    bands.mkdir(exist_ok=True)
    inputs, chain, prev = [], [f'[0:v]pad={WIDTH}:{VIDEO_H + BAND_H}:0:{BAND_H}:color=#0f0f14[base]'], 'base'
    for i, span in enumerate(spans):
        png = bands / f'cue{i}.png'
        draw_band(span['text'], png)
        inputs += ['-i', str(png)]
        label = f'v{i}'
        chain.append(
            f"[{prev}][{i + 1}:v]overlay=0:0:enable='between(t,{span['start']:.3f},{span['end']:.3f})'[{label}]"
        )
        prev = label
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-i', str(webm), *inputs,
         '-filter_complex', ';'.join(chain), '-map', f'[{prev}]',
         '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', str(out)],
        check=True,
    )


def main(argv):
    try:
        if len(argv) == 3 and argv[1] == '--spans':
            print(json.dumps(spans_from_cues(load_cues(argv[2])), ensure_ascii=False))
            return 0
        if len(argv) != 4:
            print(USAGE, file=sys.stderr)
            return 2
        webm, cues_path, out = Path(argv[1]), argv[2], Path(argv[3])
        compose(webm, load_cues(cues_path), out)
    except ValueError as err:
        print(err, file=sys.stderr)
        return 1
    except (OSError, subprocess.CalledProcessError) as err:
        print(f'書けなかった: {err}', file=sys.stderr)
        return 2
    seconds = duration_of(out)
    print(f'{out} ({seconds:.1f} 秒)')
    if seconds > MAX_SECONDS:
        print(f'{MAX_SECONDS:.0f} 秒を超えた。手順書の待ちを縮めるか、場面を減らす', file=sys.stderr)
        return 3
    return 0


sys.exit(main(sys.argv))
