"""위키 점검: 06_위키 · 05_개발기록 · 02_문서 · 03_요청서의 md를 살펴 문제를 찾는다.

- 깨진 링크: [[이름]]이 가리키는 md가 없음
- index 빠짐: 06_위키 페이지(index·log 제외)나 05_개발기록 파일이 06_위키/index.md에 없음
- 외톨이: 06_위키 페이지인데 다른 페이지(index·log 제외)에서 아무도 링크하지 않음
- 양식: 06_위키 페이지에 frontmatter(type·updated)나 '## 관련'이 없음

usage: python 04_도구/wiki_lint.py      (문제가 없으면 ok, 있으면 목록을 보이고 끝 코드 1)
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WIKI, LOG = ROOT / '06_위키', ROOT / '05_개발기록'
SCOPE = [WIKI, LOG, ROOT / '02_문서', ROOT / '03_요청서']
LINK = re.compile(r'\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]')

pages = {}
for d in SCOPE:
    if d.exists():
        for f in d.rglob('*.md'):
            pages.setdefault(f.stem, []).append(f)

problems = []
dups = {k: v for k, v in pages.items() if len(v) > 1}
for k, v in dups.items():
    problems.append('같은 이름 여러 개: ' + k + ' → ' + ', '.join(str(p.relative_to(ROOT)) for p in v))

inbound = {}
for k, files in pages.items():
    for f in files:
        text = f.read_text(encoding='utf-8')
        for m in LINK.finditer(text):
            t = m.group(1).strip()
            if t.endswith('.md'):
                t = t[:-3]
            t = t.split('/')[-1]
            if t not in pages:
                problems.append('깨진 링크: ' + str(f.relative_to(ROOT)) + ' → [[' + m.group(1) + ']]')
            elif f.parent != WIKI or f.stem not in ('index', 'log'):
                if t != f.stem:
                    inbound.setdefault(t, set()).add(f.stem)

index = (WIKI / 'index.md').read_text(encoding='utf-8') if (WIKI / 'index.md').exists() else ''
listed = {m.group(1).strip() for m in LINK.finditer(index)}
for f in sorted(WIKI.rglob('*.md')):
    if f.stem in ('index', 'log'):
        continue
    if f.stem not in listed:
        problems.append('index 빠짐(위키): ' + str(f.relative_to(ROOT)))
    if not inbound.get(f.stem):
        problems.append('외톨이(아무도 링크 안 함): ' + str(f.relative_to(ROOT)))
    text = f.read_text(encoding='utf-8')
    if not re.match(r'---\n(?:.*\n)*?type:.*\n(?:.*\n)*?---', text) or 'updated:' not in text.split('---')[1]:
        problems.append('frontmatter(type·updated) 없음: ' + str(f.relative_to(ROOT)))
    if '\n## 관련' not in text:
        problems.append("'## 관련' 없음: " + str(f.relative_to(ROOT)))
if LOG.exists():
    for f in sorted(LOG.glob('*.md')):
        if f.stem not in listed:
            problems.append('index 빠짐(개발기록): ' + str(f.relative_to(ROOT)))

n_wiki = len([f for f in WIKI.rglob('*.md')]) if WIKI.exists() else 0
n_log = len(list(LOG.glob('*.md'))) if LOG.exists() else 0
if problems:
    print('문제 ' + str(len(problems)) + '건 (위키 ' + str(n_wiki) + '쪽, 개발기록 ' + str(n_log) + '건)')
    for p in problems:
        print('- ' + p)
    sys.exit(1)
print('ok (위키 ' + str(n_wiki) + '쪽, 개발기록 ' + str(n_log) + '건)')
