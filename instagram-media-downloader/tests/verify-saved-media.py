"""Decode locally saved images/videos without printing account names or media URLs."""
import argparse
import collections
import json
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
parser.add_argument('--latest', type=int, help='Only inspect this many most recently saved files')
args = parser.parse_args()
if args.latest is not None and args.latest < 1:
    parser.error('--latest must be positive')
ffprobe = shutil.which('ffprobe')
ffmpeg = shutil.which('ffmpeg')
if not ffprobe or not ffmpeg:
    parser.error('ffprobe and ffmpeg are required')
results = []
files = [path for path in args.directory.rglob('*') if path.is_file() and path.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp', '.mp4'}]
files.sort(key=lambda path: path.stat().st_mtime)
if args.latest is not None:
    files = files[-args.latest:]
for path in files:
    probe = subprocess.run([ffprobe, '-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height:format=duration', '-of', 'json', str(path)], capture_output=True, text=True)
    decoded = subprocess.run([ffmpeg, '-v', 'error', '-xerror', '-i', str(path), '-f', 'null', '-'], capture_output=True, text=True)
    try:
        data = json.loads(probe.stdout)
    except ValueError:
        data = {}
    results.append({'number': len(results) + 1, 'bytes': path.stat().st_size, 'streams': data.get('streams', []), 'duration': data.get('format', {}).get('duration'), 'decoded': probe.returncode == 0 and decoded.returncode == 0 and not decoded.stderr.strip()})
print(json.dumps({'count': len(results), 'passed': sum(r['decoded'] for r in results), 'results': results}, ensure_ascii=False, indent=2))
raise SystemExit(0 if results and all(r['decoded'] for r in results) else 1)
