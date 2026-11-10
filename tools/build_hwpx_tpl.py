"""한글 회의록 양식(.hwpx) → hwpx-tpl.js

끄적노트가 회의록을 한글 파일(HWPX)로 만들 때 쓰는 양식 조각을 뽑는다.
양식의 글꼴·테두리·칸 설정(header.xml)을 그대로 쓰고, 회의록에 필요한 글자·문단 모양만 덧붙인다.
양식을 바꾸면 이 스크립트를 다시 돌리고 sw.js의 VERSION을 올린다.

usage: python tools/build_hwpx_tpl.py <회의록 양식.hwpx> hwpx-tpl.js
  (HWP 양식은 한글에서 '다른 이름으로 저장 → HWPX'로 먼저 바꾼다)
"""
import json
import re
import sys
import zipfile

src, out = sys.argv[1:3]
z = zipfile.ZipFile(src)
head = z.read("Contents/header.xml").decode("utf-8")
sec = z.read("Contents/section0.xml").decode("utf-8")


def must(pattern, text, flags=re.S):
    m = re.search(pattern, text, flags)
    if not m:
        sys.exit("양식에서 찾지 못함: " + pattern)
    return m


# ---------- 글자 모양: 8번(맑은 고딕 11pt)을 복제 ----------
c8 = must(r'<hh:charPr id="8".*?</hh:charPr>', head).group(0)
chars = {
    11: c8.replace('id="8"', 'id="11"', 1).replace("<hh:underline", "<hh:bold/><hh:underline", 1),  # 굵게
    12: c8.replace('id="8"', 'id="12"', 1).replace('height="1100"', 'height="1000"', 1)
          .replace('textColor="#000000"', 'textColor="#555555"', 1),  # 10pt 회색(참고 글)
}
head = head.replace("</hh:charProperties>", "".join(chars.values()) + "</hh:charProperties>", 1)


# ---------- 문단 모양 ----------
def para(pid, align="JUSTIFY", left=0, intent=0, prev=0, line=150):
    return (
        f'<hh:paraPr id="{pid}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" '
        'suppressLineNumbers="0" checked="0" textDir="AUTO">'
        f'<hh:align horizontal="{align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>'
        '<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" '
        'keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>'
        '<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>'
        f'<hh:margin><hc:intent value="{intent}" unit="HWPUNIT"/><hc:left value="{left}" unit="HWPUNIT"/>'
        f'<hc:right value="0" unit="HWPUNIT"/><hc:prev value="{prev}" unit="HWPUNIT"/>'
        '<hc:next value="0" unit="HWPUNIT"/></hh:margin>'
        f'<hh:lineSpacing type="PERCENT" value="{line}" unit="HWPUNIT"/>'
        '<hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" '
        'connect="0" ignoreMargin="0"/></hh:paraPr>'
    )


# 맑은 고딕 11pt 기준 너비: "○ " ≈ 1487, "- " ≈ 838 (HWPUNIT)
B1, B2 = 1490, 840
paras = {
    20: para(20),                                   # 보통 글
    21: para(21, intent=-B1),                       # ○ 항목(내어쓰기)
    22: para(22, left=B1, intent=-B2),              # - 세부 항목
    23: para(23, prev=600),                         # 안건 제목(위 간격)
    24: para(24, align="RIGHT", line=130),          # 오른쪽 맞춤 참고 글
}
head = head.replace("</hh:paraProperties>", "".join(paras.values()) + "</hh:paraProperties>", 1)


def recount(tag, item):
    global head
    n = len(re.findall(rf"<hh:{item} id=", head))
    head = re.sub(rf'<hh:{tag} itemCnt="\d+"', f'<hh:{tag} itemCnt="{n}"', head, count=1)


recount("charProperties", "charPr")
recount("paraProperties", "paraPr")

# ---------- 본문 조각 ----------
sec_open = must(r'^.*?<hs:sec[^>]*>', sec).group(0)
secpr_run = must(r'<hp:run charPrIDRef="\d+"><hp:secPr.*?</hp:ctrl></hp:run>', sec).group(0)
# 결재란 없는 판(2쪽)의 제목 표: 1×1, 테두리 없음
tbls =re.findall(r'<hp:tbl [^>]*rowCnt="1" colCnt="1".*?</hp:tbl>', sec, re.S)
title_tbl = [t for t in tbls if "회의록" in t][-1]
title_tbl = re.sub(r"<hp:t>[^<]*</hp:t>", "<hp:t>{{TITLE}}</hp:t>", title_tbl, count=1)
title_tbl = re.sub(r"<hp:linesegarray>.*?</hp:linesegarray>", "", title_tbl, flags=re.S)
title_tbl = re.sub(r'zOrder="\d+"', 'zOrder="0"', title_tbl, count=1)
main_tbl_attrs = must(r'(<hp:tbl [^>]*rowCnt="5" colCnt="4"[^>]*>)(<hp:sz[^>]*/>)(<hp:pos[^>]*/>)(<hp:outMargin[^>]*/>)(<hp:inMargin[^>]*/>)', sec)

# content.hpf: 이름공간이 담긴 여는 태그만 쓰고, 메타데이터(작성자 등)는 앱이 새로 쓴다
hpf_open = must(r'^.*?<opf:package[^>]*>', z.read("Contents/content.hpf").decode("utf-8")).group(0)

tpl = {
    "header": head,
    "hpfOpen": hpf_open,
    "secOpen": sec_open,
    "secPrRun": secpr_run,
    "titleTbl": title_tbl,
    "mainTblOpen": main_tbl_attrs.group(1),
    "mainTblPos": main_tbl_attrs.group(3),
    "mainTblOut": main_tbl_attrs.group(4),
    "mainTblIn": main_tbl_attrs.group(5),
    "version": z.read("version.xml").decode("utf-8"),
    "container": z.read("META-INF/container.xml").decode("utf-8"),
    "manifest": z.read("META-INF/manifest.xml").decode("utf-8"),
    "rdf": z.read("META-INF/container.rdf").decode("utf-8"),
    "settings": re.sub(r'listIDRef="\d+"', 'listIDRef="0"', z.read("settings.xml").decode("utf-8")),
}
with open(out, "w", encoding="utf-8", newline="\n") as f:
    f.write("'use strict';\n/* 끄적노트 — 회의록 한글(HWPX) 양식 조각. tools/build_hwpx_tpl.py로 만든 파일이니 직접 고치지 마세요. */\n")
    f.write("window.KK = window.KK || {};\nKK.hwpxTpl = ")
    f.write(json.dumps(tpl, ensure_ascii=False))
    f.write(";\n")
print("ok", out, {k: len(v) for k, v in tpl.items()})
