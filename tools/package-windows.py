"""Build the complete Windows download without repository metadata or user media."""
from pathlib import Path
import hashlib
import sys
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parent.parent
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root.parent / 'FRAME-Windows.zip'
files = [
    'package.json', 'server.mjs', 'README.md', 'WINDOWS.md',
    'START-FRAME.cmd', 'SETUP-WINDOWS.cmd', 'tools/start-frame.mjs',
    'public/index.html', 'public/app.js', 'public/audio-editor.js', 'public/styles.css',
    'fonts/NotoSansCJK-Regular.ttc', 'fonts/LICENSE.txt',
    'tests/editor.test.mjs', 'tests/audio.test.mjs', 'tests/file_picker_test.py', 'tests/preview_test.py', 'tests/audio_browser_test.py',
]
intro = '''FRAME の起動方法（Windows）

1. この ZIP を右クリックして「すべて展開」します。
2. 展開した FRAME フォルダーで SETUP-WINDOWS.cmd をダブルクリック。
   初回のみ必要です。確認に Y を選び、必要なツールをインストールします。
3. START-FRAME.cmd をダブルクリックすると、ブラウザで FRAME が開きます。
   その画面の「動画を選択」を押してください。

index.html を直接ダブルクリックする方法では起動できません。
詳しい説明は同じフォルダーの WINDOWS.md を参照してください。
編集中は起動用の黒いウィンドウを開いたままにしてください。
完成した動画は「書き出す」から MP4 をダウンロードできます。

Windows 実機での動作は未検証です。
'''.replace('\n', '\r\n').encode('utf-8-sig')
entries = {name: (root / name).read_bytes() for name in files}
entries['README-FIRST.txt'] = intro
checksums = '\n'.join(f'{hashlib.sha256(data).hexdigest()}  {name}' for name, data in entries.items()) + '\n'
with ZipFile(output, 'w', compression=ZIP_DEFLATED) as archive:
    for name, data in entries.items():
        archive.writestr('FRAME/' + name, data)
    archive.writestr('FRAME/SHA256SUMS.txt', checksums)
with ZipFile(output) as archive:
    assert archive.testzip() is None, 'Archive validation failed'
print(f'{output} ({output.stat().st_size:,} bytes, {len(entries) + 1} files)')
