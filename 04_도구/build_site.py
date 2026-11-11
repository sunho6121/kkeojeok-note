"""배포용 폴더 만들기: 01_앱 + 02_문서 → 배포 폴더

- 01_앱 파일을 그대로 복사하고, 02_문서의 md 파일을 docs/1.md, docs/2.md … 로 넣는다.
- docs/index.json 에 버전(sw.js VERSION)과 문서 목록(파일 이름 순)을 적는다.
- index.html 의 data-ver="" 에 버전을 채운다(앱이 자기 버전을 알고 '새 버전' 알림을 띄움).
- 04_도구/deploy.py 가 이 스크립트로 배포 폴더를 만들어 gh-pages 브랜치에 올린다.

usage: python 04_도구/build_site.py [배포 폴더]   (기본: 저장소 맨 위의 _site)
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP, DOCS = ROOT / '01_앱', ROOT / '02_문서'
OUT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / '_site'


def write(p, text):
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


# 폴더 자체는 두고 안만 비운다(미리 보기 서버가 이 폴더를 열고 있어도 되게)
OUT.mkdir(parents=True, exist_ok=True)
for x in OUT.iterdir():
    shutil.rmtree(x) if x.is_dir() else x.unlink()
shutil.copytree(APP, OUT, dirs_exist_ok=True)

ver = re.search(r"const VERSION = '([^']+)'", (APP / 'sw.js').read_text(encoding='utf-8')).group(1)

html = (OUT / 'index.html').read_text(encoding='utf-8')
assert 'data-ver=""' in html, 'index.html 에 data-ver="" 가 없음'
write(OUT / 'index.html', html.replace('data-ver=""', 'data-ver="' + ver + '"', 1))

d = OUT / 'docs'
d.mkdir()
docs = []
for i, f in enumerate(sorted(DOCS.glob('*.md')), 1):
    text = f.read_text(encoding='utf-8')
    write(d / f'{i}.md', text)
    title = re.sub(r'^\d+[_.\s-]*', '', f.stem)  # 01_사용안내 → 사용안내
    docs.append({'file': f'docs/{i}.md', 'title': title, 'name': f.name})
write(d / 'index.json', json.dumps({'version': ver, 'docs': docs}, ensure_ascii=False, indent=1))

print('ok', OUT, ver, [x['title'] for x in docs])
