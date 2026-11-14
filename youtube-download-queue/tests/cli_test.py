"""Tests for cli/yt-queue. A fake yt-dlp and launchctl on PATH stand in for YouTube and launchd."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import plistlib
import struct
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

CLI = Path(__file__).resolve().parent.parent / 'cli' / 'yt-queue'
A, B, C, D = 'AAAAAAAAAAA', 'BBBBBBBBBBB', 'CCCCCCCCCCC', 'DDDDDDDDDDD'
PLAYLIST = 'https://www.youtube.com/playlist?list=PLinbox0123456789'
FAKES = {
    'yt-dlp': '#!/bin/sh\necho "$@" > "$HOME/ytdlp-args"\n[ -f "$HOME/offline" ] && exit 1\n[ -f "$HOME/hang" ] && exec sleep 30\ncat "$HOME/playlist"\n',
    'launchctl': '#!/bin/sh\necho "$@" >> "$HOME/launchctl-args"\n',
}


class CliTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.home, self.queue, bin_dir = root / 'home', root / 'home' / 'queue', root / 'bin'
        for folder in (self.queue, bin_dir):
            folder.mkdir(parents=True)
        for name, body in FAKES.items():
            (bin_dir / name).write_text(body)
            (bin_dir / name).chmod(0o755)
        self.env = {**os.environ, 'HOME': str(self.home), 'PATH': f'{bin_dir}:/usr/bin:/bin'}

    def tearDown(self):
        self.temp.cleanup()

    def run_cli(self, *args, ok=True):
        result = subprocess.run([sys.executable, str(CLI), *args], env=self.env, capture_output=True, text=True)
        self.assertEqual(result.returncode == 0, ok, result.stderr + result.stdout)
        return result

    def setup_local(self, *extra):
        return self.run_cli('setup', '--queue-dir', str(self.queue), *extra)

    def host_exchange(self, *requests):
        frames = b''.join(struct.pack('=I', len(data)) + data for data in (json.dumps(r).encode() if isinstance(r, dict) else r for r in requests))
        manifest = json.loads((self.home / 'Library/Application Support/Chromium/NativeMessagingHosts/com.nematatu.yt_queue.json').read_text())
        output = subprocess.run([manifest['path'], 'chrome-extension://pnggeglmncjlcgfeenoccflfdkblnidj/'], input=frames, env=self.env, capture_output=True).stdout
        messages = []
        while output:
            size = struct.unpack('=I', output[:4])[0]
            messages.append(json.loads(output[4:4 + size]))
            output = output[4 + size:]
        return messages

    def links(self):
        return (self.queue / 'links.txt').read_text()

    def read(self, name):
        path = self.home / name
        return path.read_text() if path.exists() else None

    def test_setup_registers_host_and_ten_minute_playlist_job(self):
        output = self.setup_local('--playlist', 'https://www.youtube.com/watch?v=xyz&list=PLinbox0123456789&index=2').stdout
        self.assertIn('キューに登録済み: 0件 / ダウンロード済み: 0件', output)
        config = json.loads((self.home / '.config/yt-queue/config.json').read_text())
        self.assertEqual(config, {'queue_dir': str(self.queue.resolve()), 'playlist': PLAYLIST})
        launcher = self.home / '.config/yt-queue/yt-queue'
        for browser in ('Google/Chrome', 'Chromium'):
            manifest = json.loads((self.home / 'Library/Application Support' / browser / 'NativeMessagingHosts/com.nematatu.yt_queue.json').read_text())
            self.assertEqual(manifest['allowed_origins'], ['chrome-extension://adcpjoppcbkeibgnegfinicchhcfkfic/', 'chrome-extension://pnggeglmncjlcgfeenoccflfdkblnidj/'])
            self.assertEqual(manifest['path'], str(launcher))
        job = plistlib.loads((self.home / 'Library/LaunchAgents/com.nematatu.yt-queue.plist').read_bytes())
        self.assertEqual({key: job[key] for key in ('Label', 'ProgramArguments', 'StartInterval', 'RunAtLoad')},
                         {'Label': 'com.nematatu.yt-queue', 'ProgramArguments': [str(launcher), 'sync'], 'StartInterval': 600, 'RunAtLoad': True})
        self.assertEqual(job['EnvironmentVariables'], {'PATH': self.env['PATH'], 'HOME': str(self.home)})
        self.assertEqual(job['StandardOutPath'], str(self.home / 'Library/Logs/yt-queue.log'))
        uid = os.getuid()
        self.assertEqual(self.read('launchctl-args').splitlines(), [f'bootout gui/{uid}/com.nematatu.yt-queue', f'bootstrap gui/{uid} {self.home}/Library/LaunchAgents/com.nematatu.yt-queue.plist'])

    def test_setup_rejects_unsafe_or_missing_targets(self):
        self.run_cli('setup', '--queue-dir', str(self.home / 'missing'), ok=False)
        self.run_cli('setup', '--queue-dir', str(self.queue), '--playlist', 'https://example.com/?list=PLinbox0123456789', ok=False)
        self.run_cli('setup', '--playlist', PLAYLIST, ok=False)
        self.assertFalse((self.home / '.config/yt-queue/config.json').exists())
        self.assertIsNone(self.read('launchctl-args'))

    def test_add_skips_queued_and_downloaded_videos_in_any_url_form(self):
        self.setup_local()
        (self.queue / 'links.txt').write_text(f'https://youtu.be/{B}\nhttps://example.com/other')
        (self.queue / 'download_archive.txt').write_text(f'youtube {C}\nvimeo {D}\n')
        output = self.run_cli('add', f'https://www.youtube.com/watch?v={A}&t=4', f'https://www.youtube.com/shorts/{B}', C, D).stdout
        self.assertEqual(self.links(), f'https://youtu.be/{B}\nhttps://example.com/other\nhttps://www.youtube.com/watch?v={A}\nhttps://www.youtube.com/watch?v={D}\n')
        self.assertEqual(output.splitlines(), [f'[追加] {A}', f'[追加] {D}', '追加 2件 / 全 4件'])
        self.assertIn('追加 0件', self.run_cli('add', A, D).stdout)

    def test_add_rejects_other_sites_without_touching_links(self):
        self.setup_local()
        (self.queue / 'links.txt').write_text('keep\n')
        self.assertIn('YouTube の URL または動画 ID ではありません', self.run_cli('add', A, 'https://example.com/watch?v=' + B, ok=False).stderr)
        self.assertEqual(self.links(), 'keep\n')

    def test_playlist_url_adds_each_video_and_watch_url_with_list_adds_one(self):
        self.setup_local()
        (self.home / 'playlist').write_text(f'{A}\n{B}\n{A}\nnot-an-id\n')
        self.run_cli('add', PLAYLIST)
        self.assertEqual(self.links(), f'https://www.youtube.com/watch?v={A}\nhttps://www.youtube.com/watch?v={B}\n')
        self.assertEqual(self.read('ytdlp-args').split(), ['--flat-playlist', '--no-warnings', '--print', 'id', '--', PLAYLIST])
        (self.home / 'ytdlp-args').unlink()
        self.run_cli('add', f'https://www.youtube.com/watch?v={C}&list=PLinbox0123456789')
        self.assertIsNone(self.read('ytdlp-args'))
        (self.home / 'offline').write_text('')
        self.assertIn('再生リストを取得できませんでした', self.run_cli('add', 'https://www.youtube.com/playlist?list=PLzzzzzzzzzzzz', ok=False).stderr)

    def test_native_host_answers_state_and_add_and_rejects_anything_else(self):
        self.setup_local()
        (self.queue / 'download_archive.txt').write_text(f'youtube {C}\nyoutube bad\n')
        state, added, again, downloaded, bad_id, unknown, garbage = self.host_exchange(
            {'type': 'state'}, {'type': 'add', 'id': A}, {'type': 'add', 'id': A}, {'type': 'add', 'id': C},
            {'type': 'add', 'id': '../../etc/x'}, {'type': 'write'}, b'not json')
        self.assertEqual(state, {'ok': True, 'target': str(self.queue.resolve() / 'links.txt'), 'queued': [], 'downloaded': [C]})
        self.assertEqual((added['status'], added['queued']), ('added', [A]))
        self.assertEqual((again['status'], downloaded['status']), ('queued', 'downloaded'))
        for response in (bad_id, unknown, garbage):
            self.assertEqual(response, {'ok': False, 'error': '未対応の要求です。'})
        self.assertEqual(self.links(), f'https://www.youtube.com/watch?v={A}\n')

    def test_native_host_without_setup_explains_what_to_run(self):
        self.setup_local()
        (self.home / '.config/yt-queue/config.json').unlink()
        self.assertEqual(self.host_exchange({'type': 'state'}), [{'ok': False, 'error': '設定がありません。先に yt-queue setup を実行してください。'}])

    def test_setup_without_a_playlist_registers_no_job(self):
        self.setup_local('--playlist', PLAYLIST)
        self.assertIn(f'追加先: {self.queue.resolve()}/links.txt', self.setup_local().stdout)
        self.assertFalse((self.home / 'Library/LaunchAgents/com.nematatu.yt-queue.plist').exists())
        self.assertEqual(self.read('launchctl-args').splitlines()[-1], f'bootout gui/{os.getuid()}/com.nematatu.yt-queue')
        self.assertEqual(self.run_cli('sync').stdout, '')
        self.assertIsNone(self.read('ytdlp-args'))

    def test_job_appends_only_new_playlist_videos_and_stays_quiet_when_idle(self):
        self.setup_local('--playlist', PLAYLIST)
        (self.home / 'playlist').write_text(f'{A}\n{B}\n{C}\n{A}\n')
        (self.queue / 'links.txt').write_text(f'https://youtu.be/{B}\n')
        (self.queue / 'download_archive.txt').write_text(f'youtube {C}\n')
        self.assertRegex(self.run_cli('sync').stdout, rf'^\d{{4}}-\d\d-\d\d \d\d:\d\d 再生リストから 1件追加: {A}\n$')
        self.assertEqual(self.links(), f'https://youtu.be/{B}\nhttps://www.youtube.com/watch?v={A}\n')
        self.assertEqual(self.read('ytdlp-args').split(), ['--flat-playlist', '--no-warnings', '--print', 'id', '--', PLAYLIST])
        self.assertEqual(self.run_cli('sync').stdout, '')
        self.assertEqual(self.links().count(A), 1)

    def test_job_logs_failures_and_leaves_links_alone(self):
        self.setup_local('--playlist', PLAYLIST)
        (self.queue / 'links.txt').write_text('keep\n')
        (self.home / 'offline').write_text('')
        self.assertIn('再生リストを取得できませんでした', self.run_cli('sync').stdout)
        (self.home / 'offline').unlink()
        (self.home / 'playlist').write_text(f'{A}\n')
        (self.queue / 'links.txt').chmod(0o444)
        self.assertIn('links.txt に書き込めませんでした。', self.run_cli('sync').stdout)
        self.assertEqual(self.links(), 'keep\n')

    def test_job_gives_up_on_a_hung_yt_dlp(self):
        # launchd never starts the job while its last run is alive, so one hung yt-dlp would stop every later import.
        self.setup_local('--playlist', PLAYLIST)
        (self.home / 'hang').write_text('')
        with mock.patch.dict(os.environ, self.env):
            loader = importlib.machinery.SourceFileLoader('yt_queue', str(CLI))
            cli = importlib.util.module_from_spec(importlib.util.spec_from_loader('yt_queue', loader))
            loader.exec_module(cli)
            cli.PLAYLIST_TIMEOUT = 1
            output, started = io.StringIO(), time.monotonic()
            with contextlib.redirect_stdout(output):
                cli.sync(None)
        self.assertLess(time.monotonic() - started, 10)
        self.assertIn(f'再生リストの取得が終わらないため、1秒で打ち切りました: {PLAYLIST}', output.getvalue())
        self.assertFalse((self.queue / 'links.txt').exists())

    def test_uninstall_removes_everything_it_created(self):
        self.setup_local('--playlist', PLAYLIST)
        self.run_cli('uninstall')
        self.assertFalse((self.home / '.config/yt-queue').exists())
        self.assertFalse((self.home / 'Library/LaunchAgents/com.nematatu.yt-queue.plist').exists())
        self.assertEqual(self.read('launchctl-args').splitlines()[-1], f'bootout gui/{os.getuid()}/com.nematatu.yt-queue')
        for browser in ('Google/Chrome', 'Chromium'):
            self.assertFalse((self.home / 'Library/Application Support' / browser / 'NativeMessagingHosts/com.nematatu.yt_queue.json').exists())


@unittest.skipUnless(os.environ.get('YT_QUEUE_LIVE') == '1', 'YT_QUEUE_LIVE=1 で実際の yt-dlp と YouTube を使います')
class LiveTest(unittest.TestCase):
    PLAYLIST = 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI'

    def test_real_playlist_is_expanded_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp)
            queue = home / 'queue'
            queue.mkdir()
            fake = home / 'bin'
            fake.mkdir()
            (fake / 'launchctl').write_text('#!/bin/sh\n')  # keep the real launchd untouched
            (fake / 'launchctl').chmod(0o755)
            env = {**os.environ, 'HOME': str(home), 'PATH': f'{fake}:{os.environ["PATH"]}'}
            run = lambda *args: subprocess.run([sys.executable, str(CLI), *args], env=env, capture_output=True, text=True)
            self.assertEqual(run('setup', '--queue-dir', str(queue)).returncode, 0)
            listed = subprocess.run(['yt-dlp', '--flat-playlist', '--no-warnings', '--print', 'id', self.PLAYLIST], capture_output=True, text=True, check=True).stdout.split()
            self.assertGreaterEqual(len(listed), 3)
            (queue / 'download_archive.txt').write_text(f'youtube {listed[0]}\n')
            (queue / 'links.txt').write_text(f'https://youtu.be/{listed[1]}\n')
            result = run('add', self.PLAYLIST)
            self.assertEqual(result.returncode, 0, result.stderr)
            expected = [f'https://youtu.be/{listed[1]}'] + [f'https://www.youtube.com/watch?v={video}' for video in dict.fromkeys(listed) if video not in listed[:2]]
            self.assertEqual((queue / 'links.txt').read_text().splitlines(), expected)
            self.assertIn('追加 0件', run('add', self.PLAYLIST).stdout)


if __name__ == '__main__':
    unittest.main()
