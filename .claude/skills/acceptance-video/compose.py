# 録画（recording.webm）の上に帯を足し、cues.json の字幕を帯に載せて mp4 にする。
# 使い方: python3 -I compose.py <recording.webm> <cues.json> <out.mp4>
#         python3 -I compose.py --spans <cues.json>    字幕を出す区間を JSON で出す（ffmpeg を使わない）
# 字幕は Pillow で画像にして overlay で重ねる。ffmpeg には subtitles と drawtext のフィルタが無い環境があるため。
# 終了コード: 0 は書けて 30 秒以内、1 は入力の誤り（cues.json、録画の大きさ）、2 は環境の問題（ffmpeg、Pillow、フォント、書き込み）、
#             3 は書いたが 30 秒を超えた
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

WIDTH, BAND_H, VIDEO_H = 1280, 80, 640
MAX_SECONDS = 30.0
# 録画を止めるまでに、最後の字幕を閉じたあとで足す秒数（record.mjs の FINISH_MS）。context を閉じるまでの静止を切り落とす
TAIL_SECONDS = 0.3
BAND_BG = (15, 15, 20)
FONT_SIZE = 32
TEXT_MARGIN = 32
FONT_CANDIDATES = [
    '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
    '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
]
USAGE = '使い方: python3 -I compose.py <recording.webm> <cues.json> <out.mp4> | --spans <cues.json>'


class SetupError(Exception):
    """入力ではなく環境の問題（終了コード 2）"""


def validate_cues(cues):
    if not isinstance(cues, list) or not cues:
        raise ValueError('cues は、{t, text} の配列')
    for i, cue in enumerate(cues):
        t = cue.get('t') if isinstance(cue, dict) else None
        if not isinstance(cue, dict) or isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) or t < 0:
            raise ValueError(f'cues[{i}] の t は 0 以上の数')
        if not isinstance(cue.get('text'), str):
            raise ValueError(f'cues[{i}] の text は文字列')
    for a, b in zip(cues, cues[1:]):
        if b['t'] < a['t']:
            raise ValueError(f"cues の時刻が戻っている: {a['t']} → {b['t']}")
        if b['t'] == a['t']:
            raise ValueError(f"cues の同じ時刻に2つの字幕がある（{a['t']}）。幅の無い区間は出せない")
    if cues[-1]['text'].strip() != '':
        raise ValueError('cues の最後は、字幕を閉じる空の文')
    if not any(cue['text'].strip() for cue in cues):
        raise ValueError('字幕が1つも無い')


def spans_from_cues(cues):
    """字幕ごとの (文, 開始, 終了) を返す。cue は次の cue の時刻まで出し、空の文は帯を空にする"""
    validate_cues(cues)
    return [
        {'text': cue['text'], 'start': cue['t'], 'end': nxt['t']}
        for cue, nxt in zip(cues, cues[1:])
        if cue['text'].strip()
    ]


def load_font():
    from PIL import ImageFont

    font_path = next((p for p in FONT_CANDIDATES if Path(p).exists()), None)
    if font_path is None:
        raise SetupError('日本語のフォントが無い（compose.py の FONT_CANDIDATES）')
    return ImageFont.truetype(font_path, FONT_SIZE)


def draw_band(text, font, dest):
    from PIL import Image, ImageDraw

    img = Image.new('RGB', (WIDTH, BAND_H), BAND_BG)
    draw = ImageDraw.Draw(img)
    width = draw.textlength(text, font=font)
    if width > WIDTH - TEXT_MARGIN * 2:
        raise ValueError(f'字幕が帯に収まらない（{width:.0f}px）: {text}')
    draw.text(((WIDTH - width) / 2, BAND_H / 2), text, font=font, fill=(255, 255, 255), anchor='lm')
    img.save(dest)


def probe(path, entries):
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', entries, '-of', 'json', str(path)],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)


def check_recording(webm):
    stream = probe(webm, 'stream=width,height')['streams'][0]
    if (stream['width'], stream['height']) != (WIDTH, VIDEO_H):
        raise ValueError(f"録画は {WIDTH}×{VIDEO_H} で撮る（この録画は {stream['width']}×{stream['height']}）")


def compose(webm, cues, out):
    spans = spans_from_cues(cues)
    check_recording(webm)
    try:
        font = load_font()
    except ImportError as err:
        raise SetupError(f'Pillow が無い（python3 -I はユーザーの site-packages を読まない）: {err}')
    with tempfile.TemporaryDirectory() as tmp:
        inputs, chain, prev = [], [f'[0:v]pad={WIDTH}:{VIDEO_H + BAND_H}:0:{BAND_H}:color=#0f0f14[base]'], 'base'
        for i, span in enumerate(spans):
            png = Path(tmp) / f'cue{i}.png'
            draw_band(span['text'], font, png)
            inputs += ['-i', str(png)]
            label = f'v{i}'
            chain.append(
                f"[{prev}][{i + 1}:v]overlay=0:0:enable='between(t,{span['start']:.3f},{span['end']:.3f})'[{label}]"
            )
            prev = label
        subprocess.run(
            ['ffmpeg', '-y', '-loglevel', 'error', '-i', str(webm), *inputs,
             '-filter_complex', ';'.join(chain), '-map', f'[{prev}]',
             '-t', f"{cues[-1]['t'] + TAIL_SECONDS:.3f}",
             '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', str(out)],
            check=True,
        )


def main(argv):
    try:
        if len(argv) == 3 and argv[1] == '--spans':
            print(json.dumps(spans_from_cues(json.loads(Path(argv[2]).read_text())), ensure_ascii=False))
            return 0
        if len(argv) != 4:
            print(USAGE, file=sys.stderr)
            return 2
        webm, cues_path, out = Path(argv[1]), Path(argv[2]), Path(argv[3])
        compose(webm, json.loads(cues_path.read_text()), out)
        seconds = float(probe(out, 'format=duration')['format']['duration'])
    except ValueError as err:
        print(err, file=sys.stderr)
        return 1
    except SetupError as err:
        print(err, file=sys.stderr)
        return 2
    except (OSError, subprocess.CalledProcessError, KeyError, IndexError) as err:
        print(f'ffmpeg か ffprobe、ファイルの読み書きで失敗した: {err}', file=sys.stderr)
        return 2
    print(f'{out} ({seconds:.1f} 秒)')
    if seconds > MAX_SECONDS:
        print(f'{MAX_SECONDS:.0f} 秒を超えた。手順書の待ちを縮めるか、場面を減らす', file=sys.stderr)
        return 3
    return 0


sys.exit(main(sys.argv))
