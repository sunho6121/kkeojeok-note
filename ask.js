'use strict';
/* 끄적노트 — Claude에게 묻기
   - 노트·일정·회의록·붙인 자료를 읽고 답한다(사용자 API 키, 설정의 모델·꼼꼼함).
   - 범위: 이 노트 / 이번 달 / 전체. 이어 묻기는 같은 자료로(앞부분은 캐시해 요금을 줄임).
   - 답은 글자가 오는 대로 보이고, '노트에 붙이기'로 [질문 · …] ~ [질문 끝] 묶음을 노트 끝에 적는다. */
window.KK = window.KK || {};

(function () {
  const { $, h, svg, toast, viewStatus, VIEW_LABEL } = KK.ui;
  const D = KK.date, db = KK.db;
  const A = () => KK.app;
  const CHAT = '<path d="M5 5h14a2 2 0 012 2v8a2 2 0 01-2 2h-7l-4 3v-3H5a2 2 0 01-2-2V7a2 2 0 012-2z"/><path d="M8 10h8M8 13h5"/>';
  const TYPE_KO = { event: '약속', task: '할 일', notice: '전달', memo: '메모' };
  const PRI_KO = { high: '높음', low: '낮음' };
  const BUDGET = { notes: 120000, items: 400, texts: 150000, text1: 60000, pdf: 12 * 1048576, pdf1: 8 * 1048576, images: 8 };
  // 요금 어림(달러, 100만 토큰당): 확인한 모델만
  const PRICE = { 'claude-sonnet-5-5': { in: 2, out: 10, write: 2.5, read: 0.2 } };

  const SYSTEM = [
    "너는 '끄적노트' 사용자의 업무 비서야. 사용자는 병원 공공보건의료사업팀에서 일해.",
    '- 첫 메시지의 자료(노트·일정·회의록·붙인 자료)를 근거로 한국어로 답해.',
    '- 개조식(~함·~임·명사형)으로 짧고 명료하게. 여러 건이면 목록이나 표로.',
    '- 근거가 된 노트 이름·날짜·자료 이름을 괄호로 밝혀.',
    "- 자료에 없는 내용은 '자료에 없음'이라고 말하고, 일반 지식으로 보탤 때는 '(일반 정보)'라고 표시해.",
    '- 이번 주·다음 주 같은 날짜는 자료 맨 위의 오늘 날짜로 계산해.',
    "- 노트의 ~~ ~~ 글은 지운 내용이고, '↳ 고침' 줄은 앱에서 고친 최신 내용이야.",
    '- 환자 등 개인정보는 답에 옮겨 적지 마.',
  ].join('\n');

  /* ---------- 자료 모으기 ---------- */
  const cut = (s, n) => (s.length > n ? '…(앞부분 줄임)\n' + s.slice(-n) : s);
  function notesFor(scope) {
    const S = A().S, cm = KK.work ? KK.work.curYM() : '';
    let list = [...S.notes.values()];
    if (scope === 'note') list = S.cur && S.notes.has(S.cur) ? [S.notes.get(S.cur)] : [];
    else if (scope === 'month') list = list.filter(n => n.month === cm || n.id === S.cur);
    return list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  function itemLine(i, S, today) {
    const n = S.notes.get(i.noteId);
    const when = (i.date || '') + (i.time ? ' ' + i.time + (i.endTime ? '~' + i.endTime : '') : '');
    return [TYPE_KO[i.type] || '할 일', i.title, when || '-', [i.place, i.to && '→ ' + i.to].filter(Boolean).join(' ') || '-',
      VIEW_LABEL[viewStatus(i, today)] || '예정', PRI_KO[i.priority] || '보통', n ? KK.views.noteLabel(n) : '-',
      (i.detail || '').split('\n')[0].slice(0, 80) || '-'].join(' | ');
  }
  function b64(blob) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(blob); });
  }
  async function jpeg(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement('canvas');
      c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      return out ? b64(out) : '';
    } catch (e) { return ''; }
  }

  async function buildContext(scope, withAtt) {
    const S = A().S, today = D.today(), cm = KK.work ? KK.work.curYM() : today.slice(0, 7);
    const notes = notesFor(scope), ids = new Set(notes.map(n => n.id));
    const now = new Date();
    const out = ['오늘: ' + today + ' (' + D.DOW[now.getDay()] + ') ' + D.pad(now.getHours()) + ':' + D.pad(now.getMinutes()),
      '범위: ' + (scope === 'note' ? '지금 노트' : scope === 'month' ? (KK.work ? KK.work.monthLabel(cm) : cm) + ' 노트 전체' : '모든 노트'), ''];
    const info = { notes: 0, items: 0, mins: 0, atts: 0, skipped: [] };

    // 노트 (최근 고친 것부터, 길면 앞부분 줄임)
    let left = BUDGET.notes;
    const parts = [];
    for (const n of notes) {
      const body = (n.body || '').trim();
      if (!body || left <= 0) continue;
      const take = cut(body, Math.max(2000, Math.min(body.length, left)));
      left -= take.length;
      parts.push('### 노트 「' + KK.views.noteLabel(n) + '」 (' + (n.month || '') + ', 마지막 고침 ' + D.stamp(n.updatedAt) + ')\n' + take);
      info.notes++;
    }
    if (parts.length) out.push('## 노트', ...parts, '');

    // 일정·할 일·전달·메모
    let items = [...S.items.values()].filter(i => !i.deleted);
    if (scope === 'note') items = items.filter(i => ids.has(i.noteId));
    else if (scope === 'month') items = items.filter(i => ids.has(i.noteId) || (i.date || '').slice(0, 7) === cm || ['todo', 'doing', 'hold'].includes(i.status || 'todo'));
    items = items.sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')).slice(0, BUDGET.items);
    if (items.length) {
      out.push('## 일정·할 일·전달·메모 (종류 | 제목 | 날짜 | 장소·대상 | 상태 | 우선순위 | 노트 | 내용)', ...items.map(i => itemLine(i, S, today)), '');
      info.items = items.length;
    }

    // 회의록
    if (!db.usingFallback) {
      let recs = (await db.all()).filter(d => d.kind === 'rec' && d.minutes);
      if (scope === 'note') recs = recs.filter(r => ids.has(r.noteId));
      else if (scope === 'month') recs = recs.filter(r => ids.has(r.noteId) || D.ymd(new Date(r.startAt || r.createdAt)).slice(0, 7) === cm);
      recs = recs.sort((a, b) => (b.startAt || b.createdAt) - (a.startAt || a.createdAt)).slice(0, 30);
      if (recs.length) {
        out.push('## 회의록');
        recs.forEach(r => {
          const m = r.minutes;
          out.push('### ' + (m.title || r.name) + ' (' + (m.when || D.stamp(r.startAt || r.createdAt)) + (m.place ? ', ' + m.place : '') + ')');
          (m.summary || []).forEach(s => out.push('- ' + s));
          (m.decisions || []).forEach(s => out.push('- 결정: ' + s));
          (m.actions || []).forEach(a => out.push('- 향후조치: ' + a.task + (a.owner ? ' (' + a.owner + ')' : '') + (a.due ? ' ~' + a.due : '')));
        });
        out.push('');
        info.mins = recs.length;
      }
    }

    // 붙인 자료
    const files = [];
    if (withAtt && KK.attach) {
      const atts = await KK.attach.listFor([...ids]);
      let tLeft = BUDGET.texts, pLeft = BUDGET.pdf, imgs = 0;
      const tparts = [];
      for (const a of atts) {
        const k = a.ftype || KK.attach.kindOf(a.name, a.type), n = S.notes.get(a.noteId), from = n ? ' · 노트 「' + KK.views.noteLabel(n) + '」' : '';
        if (k === 'pdf') {
          if (a.size > BUDGET.pdf1 || a.size > pLeft) { info.skipped.push(a.name + '(커서 뺌)'); continue; }
          pLeft -= a.size;
          files.push({ type: 'text', text: '[붙인 PDF: ' + a.name + from + ']' }, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await b64(a.blob) }, title: a.name });
          info.atts++;
        } else if (k === 'image') {
          if (imgs >= BUDGET.images) { info.skipped.push(a.name + '(사진은 ' + BUDGET.images + '장까지)'); continue; }
          const data = await jpeg(a.blob);
          if (!data) { info.skipped.push(a.name + '(못 읽음)'); continue; }
          imgs++;
          files.push({ type: 'text', text: '[붙인 사진: ' + a.name + from + ']' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
          info.atts++;
        } else if (a.text && a.text.trim() && tLeft > 0) {
          const t = a.text.slice(0, Math.min(BUDGET.text1, tLeft));
          tLeft -= t.length;
          tparts.push('### 붙인 자료 「' + a.name + '」 (' + (KK.attach.KIND_KO[k] || '파일') + from + ')\n' + t + (t.length < a.text.length ? '\n…(뒷부분 줄임)' : ''));
          info.atts++;
        } else info.skipped.push(a.name + (k === 'hwp' ? '(.hwp는 못 읽음)' : '(읽을 글자 없음)'));
      }
      if (tparts.length) out.push('## 붙인 자료(글)', ...tparts, '');
    }
    const blocks = [{ type: 'text', text: out.join('\n') }, ...files];
    blocks[blocks.length - 1].cache_control = { type: 'ephemeral' }; // 이어 묻기에서 자료 부분을 다시 읽지 않게
    return { blocks, info };
  }

  /* ---------- 창 ---------- */
  let scope = 'month', conv = null, ctl = null;
  try { scope = localStorage.getItem('kk-askscope') || 'month'; } catch (e) { /* 무시 */ }
  const errText = e => ({
    bad_key: 'API 키가 맞지 않아요. 설정에서 키를 확인해 주세요.', forbidden: '이 API 키로는 쓸 수 없어요. Anthropic 콘솔에서 권한·결제를 확인해 주세요.',
    bad_model: '설정의 모델을 쓸 수 없어요.', rate: '요청이 많거나 사용 한도에 닿았어요. 잠시 뒤 다시 물어봐 주세요.', server: 'Claude 서버가 바빠요. 잠시 뒤 다시 물어봐 주세요.',
    too_large: '자료가 너무 커요. 범위를 줄이거나 붙인 자료 읽기를 끄고 물어봐 주세요.', refused: '이 질문에는 답하지 못했어요. 조금 바꿔 물어봐 주세요.',
    offline: '인터넷에 연결되지 않았어요.',
  })[e.code] || ('답을 받지 못했어요: ' + (e.message || '알 수 없는 오류'));

  function paintScope() {
    document.querySelectorAll('#qScope button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.s === scope)));
    const S = A().S;
    $('qScope').querySelector('[data-s="note"]').disabled = !S.cur;
  }
  function reset(msg) {
    if (ctl) ctl.abort();
    conv = null;
    $('qLog').textContent = '';
    $('qLog').append(h('p', { class: 'qhint' }, msg || '노트·일정·회의록·붙인 자료를 Claude가 읽고 답해요. 예) 이번 주 마감인 일은? / 운영위 관련 결정사항 정리해 줘 / 붙인 공문에서 제출 기한은?'));
  }
  function open() {
    if (scope === 'note' && !A().S.cur) scope = 'month';
    paintScope();
    if (!conv) reset();
    $('dlgAsk').showModal();
    setTimeout(() => $('qText').focus(), 50);
  }
  function usageText(u, model) {
    const inp = u.input_tokens || 0, w = u.cache_creation_input_tokens || 0, r = u.cache_read_input_tokens || 0, o = u.output_tokens || 0;
    const fmt = x => x.toLocaleString();
    let s = '입력 ' + fmt(inp + w + r) + (r ? ' (캐시 ' + fmt(r) + ')' : '') + ' · 출력 ' + fmt(o) + ' 토큰';
    const p = PRICE[model];
    if (p) s += ' · 약 $' + ((inp * p.in + w * p.write + r * p.read + o * p.out) / 1e6).toFixed(3);
    return s;
  }

  async function ask() {
    const q = $('qText').value.trim();
    if (!q || ctl) return;
    const st = A().settings;
    if (!st.apiKey) { toast('질문하려면 설정에서 Claude API 키를 넣어 주세요', '설정 열기', () => { $('dlgAsk').close(); A().openSettings(); }, 7000); return; }
    if (!navigator.onLine) { toast('인터넷이 연결되면 물어볼 수 있어요'); return; }
    const log = $('qLog');
    if (!conv) { log.textContent = ''; conv = { scope, withAtt: $('qAtt').checked, messages: [], ctx: null }; }
    $('qText').value = '';
    const qEl = h('div', { class: 'qq' }, q), aEl = h('div', { class: 'qa kdoc' }, h('span', { class: 'spin' }), ' 자료를 읽고 있어요…');
    const meta = h('div', { class: 'qmeta' });
    log.append(qEl, aEl, meta);
    log.scrollTop = log.scrollHeight;
    ctl = new AbortController();
    $('qGo').textContent = '멈추기';
    try {
      let content;
      if (!conv.ctx) {
        conv.ctx = await buildContext(conv.scope, conv.withAtt);
        const i = conv.ctx.info;
        log.insertBefore(h('p', { class: 'qinfo' }, '읽은 자료: 노트 ' + i.notes + '개 · 일정 등 ' + i.items + '건 · 회의록 ' + i.mins + '건' + (conv.withAtt ? ' · 붙인 자료 ' + i.atts + '개' : '') +
          (i.skipped.length ? ' · 뺀 자료: ' + i.skipped.join(', ') : '')), qEl);
        content = [...conv.ctx.blocks, { type: 'text', text: '질문: ' + q }];
      } else content = q;
      conv.messages.push({ role: 'user', content });
      let raf = 0;
      const out = await KK.claude.stream({
        apiKey: st.apiKey, model: st.model, effort: st.effort, system: SYSTEM, messages: conv.messages, signal: ctl.signal,
        onText: t => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { aEl.innerHTML = KK.docs.render(t); log.scrollTop = log.scrollHeight; }); },
      });
      cancelAnimationFrame(raf);
      const ans = out.text.trim() || '(답이 비었어요)';
      aEl.innerHTML = KK.docs.render(ans);
      conv.messages.push({ role: 'assistant', content: ans });
      meta.append(
        h('span', null, usageText(out.usage, st.model) + (out.stop === 'max_tokens' ? ' · 답이 길어 잘렸어요' : '')),
        h('button', { type: 'button', class: 'linkbtn', onclick: () => toNote(q, ans) }, '노트에 붙이기'),
        h('button', { type: 'button', class: 'linkbtn', onclick: () => copy(ans) }, '복사'));
    } catch (e) {
      conv.messages.pop();
      if (!conv.messages.length) conv.ctx = null; // 첫 질문이 실패하면 다음에 자료를 다시 모음
      aEl.textContent = e.code === 'cancelled' ? '멈췄어요.' : errText(e);
      aEl.classList.add('qerr');
    } finally {
      ctl = null; $('qGo').textContent = '묻기';
      log.scrollTop = log.scrollHeight;
    }
  }
  function toNote(q, a) {
    const t = new Date();
    A().ensureNote();
    A().appendToNote('[질문 · ' + (t.getMonth() + 1) + '/' + t.getDate() + ' ' + D.pad(t.getHours()) + ':' + D.pad(t.getMinutes()) + ']\nQ. ' + q + '\nA. ' + a + '\n[질문 끝]');
    toast('지금 노트 끝에 질문과 답을 붙였어요');
  }
  async function copy(a) {
    try { await navigator.clipboard.writeText(a); toast('답을 복사했어요'); } catch (e) { toast('복사하지 못했어요'); }
  }

  document.querySelectorAll('#qScope button').forEach(b => b.addEventListener('click', () => {
    if (b.disabled || b.dataset.s === scope) return;
    scope = b.dataset.s;
    try { localStorage.setItem('kk-askscope', scope); } catch (e) { /* 무시 */ }
    paintScope();
    if (conv) reset('범위를 바꿔서 새로 물어봐요.');
  }));
  $('qAtt').addEventListener('change', () => { if (conv) reset('붙인 자료 읽기를 바꿔서 새로 물어봐요.'); });
  $('qGo').addEventListener('click', () => { if (ctl) ctl.abort(); else ask(); });
  $('qText').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); ask(); } });
  $('qNew').addEventListener('click', () => reset());
  $('qClose').addEventListener('click', () => $('dlgAsk').close());
  $('btnAsk').addEventListener('click', open);
  if (!$('btnAsk').querySelector('svg')) $('btnAsk').prepend(svg(CHAT));

  KK.ask = { open, buildContext };
})();
