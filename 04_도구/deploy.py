"""배포: 01_앱 + 02_문서 → gh-pages 브랜치 (GitHub Pages가 이 브랜치를 앱 주소로 보여 줌)

- build_site.py로 임시 폴더에 배포 파일을 만들고, gh-pages 브랜치에 한 커밋으로 올린다(이전 배포는 덮어씀).
- main 브랜치는 원본(폴더 정리된 것), gh-pages 브랜치는 배포본이다.
- 앱 파일을 고쳤으면 먼저 01_앱/sw.js의 VERSION을 올리고 main에 커밋한 뒤 실행한다.

usage: python 04_도구/deploy.py
"""
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME, EMAIL = 'sunho6121', '354662991+sunho6121@users.noreply.github.com'
UTF8 = dict(os.environ, PYTHONUTF8='1')


def git(*args, cwd=ROOT):
    r = subprocess.run(['git', *args], cwd=cwd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    if r.returncode:
        sys.exit('git ' + ' '.join(args) + ' 실패:\n' + r.stderr)
    return r.stdout.strip()


remote = git('remote', 'get-url', 'origin')
head = git('rev-parse', '--short', 'HEAD')
ver = re.search(r"const VERSION = '([^']+)'", (ROOT / '01_앱' / 'sw.js').read_text(encoding='utf-8')).group(1)
dirty = git('status', '--porcelain', '--', '01_앱', '02_문서')
if dirty:
    print('주의: 01_앱·02_문서에 커밋하지 않은 변경이 있음 (그대로 배포함)\n' + dirty)

with tempfile.TemporaryDirectory() as tmp:
    site = Path(tmp) / 'site'
    r = subprocess.run([sys.executable, str(ROOT / '04_도구' / 'build_site.py'), str(site)],
                       capture_output=True, text=True, encoding='utf-8', errors='replace', env=UTF8)
    if r.returncode:
        sys.exit('build_site.py 실패:\n' + r.stderr)
    (site / '.nojekyll').write_text('', encoding='utf-8')  # md 파일을 그대로 두게(GitHub의 Jekyll 변환 끄기)
    git('init', '-q', '-b', 'gh-pages', cwd=site)
    git('add', '-A', cwd=site)
    git('-c', 'user.name=' + NAME, '-c', 'user.email=' + EMAIL, '-c', 'core.autocrlf=false',
        'commit', '-q', '-m', '배포 ' + ver + ' (main ' + head + ')', cwd=site)
    git('push', '-q', '-f', remote, 'gh-pages', cwd=site)
print('ok 배포', ver, '(main ' + head + ') → gh-pages')
