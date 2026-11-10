'use strict';
/* 끄적노트 — Claude API 호출 (사용자 본인 API 키, 브라우저에서 직접) */
window.KK = window.KK || {};

(function () {
  const URL_MESSAGES = 'https://api.anthropic.com/v1/messages';
  const API_VERSION = '2026-10-21';
  const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
  const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];

  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'transcript', 'summary', 'tags', 'items'],
    properties: {
      title: { type: 'string' },
      transcript: { type: 'string' },
      summary: { type: 'array', items: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['ref', 'type', 'status', 'title', 'date', 'time', 'endTime', 'place', 'to', 'priority', 'detail'],
          properties: {
            ref: { type: 'string' },
            type: { type: 'string', enum: ['event', 'task', 'notice', 'memo'] },
            to: { type: 'string' },
            status: { type: 'string', enum: ['todo', 'doing', 'hold', 'done', 'cancel'] },
            title: { type: 'string' },
            date: { type: 'string' },
            time: { type: 'string' },
            endTime: { type: 'string' },
            place: { type: 'string' },
            priority: { type: 'string', enum: ['high', 'normal', 'low'] },
            detail: { type: 'string' },
          },
        },
      },
    },
  };

  const STATUS_KO = { todo: '예정', doing: '진행중', hold: '보류', done: '완결', cancel: '취소' };

  function existingText(existing) {
    if (!existing || !existing.length) return '(없음 — 처음 정리하는 노트)';
    const TYPE_KO = { event: '약속', task: '할 일', notice: '전달사항', memo: '중요 메모' };
    return existing.map(e => [
      e.ref,
      TYPE_KO[e.type] || '할 일',
      e.title + (e.to ? ' (대상: ' + e.to + ')' : ''),
      (e.date || '날짜 없음') + (e.time ? ' ' + e.time : ''),
      e.place || '-',
      e.deleted ? '삭제됨 — 사용자가 지움, 다시 만들지 말 것'
        : '상태: ' + STATUS_KO[e.status || 'todo'] + (e.locked ? ' (사용자가 직접 정함 — 바꾸지 말 것)' : ''),
    ].join(' | ')).join('\n');
  }

  function attachRule(att) {
    const rules = [];
    if (att.file) rules.push('- 첨부 파일(PDF 또는 이미지)은 사용자가 삼성 노트에서 가져온 기존 노트야. 글이든 손글씨든 transcript에 내용을 줄바꿈을 살려 빠짐없이 옮겨 적고(읽기 어려운 글자는 [?]), 그 내용도 정리에 포함해.');
    if (att.ink) rules.push('- 첨부 이미지 중 흰 바탕 손글씨는 사용자가 방금 S Pen으로 쓴 필기야. transcript에 줄바꿈을 살려 그대로 옮겨 적고(읽기 어려운 글자는 [?]), 그 내용도 정리에 포함해.');
    if (att.file && att.ink) rules.push('- transcript에는 가져온 노트 내용을 먼저, 그다음 필기 내용을 적어.');
    if (!rules.length) rules.push('- 첨부가 없으니 transcript는 "".');
    return rules.join('\n');
  }

  function buildPrompt(text, att, existing) {
    const cal = KK.date.calendarText();
    return [
      '아래는 사용자가 태블릿의 한 노트에 계속 이어 쓰는 메모야. 메모 전체를 읽고 일정과 할 일을 정리해 줘.',
      '이 노트에서 전에 정리한 일정 목록도 함께 줄게. 새로 만들기보다 기존 일정을 최신 상태로 고쳐 가는 게 목적이야.',
      '',
      '지금: ' + cal.now + ' (한국 시간)',
      '이번 주: ' + cal.thisWeek,
      '다음 주: ' + cal.nextWeek,
      '날짜 참고표:',
      cal.lines,
      '',
      '규칙',
      '- 날짜 표현(내일, 모레, 이번 주 금, 다음주 화, 11/20, 20일 등)은 위 표를 기준으로 YYYY-MM-DD로 바꿔. "다음주 X요일"은 위의 "다음 주" 범위 안의 X요일이야.',
      '- 시간은 24시간제 HH:MM. "오후 2시" → "14:00", "아침 9시 반" → "09:30". 시간이 없으면 "".',
      '- 시간이나 장소가 정해진 약속·회의·예약·행사는 type "event".',
      '- 해야 할 일, 마감, 제출, 연락할 일은 type "task". 마감일이 있으면 date에 넣어.',
      '- 메모에 없는 내용은 지어내지 마. 알 수 없는 칸은 "" 로 둬.',
      '- 급하다는 표현(급함, 꼭, 중요, !!, ★)이 있으면 priority "high", 아니면 "normal".',
      '- 다른 사람에게 알려야 할 내용(공지, 지시·요청 전달, "○○에게 전달", "공유할 것", "안내", "전달사항")은 type "notice". to에 대상(사람·부서·전체 등)을, date에 전달 기한이 있으면 넣어. 같은 대상에게 전할 내용이 여러 개면 하나씩 따로.',
      '- 일정·할 일·전달사항은 아니지만 나중에 꼭 다시 봐야 할 주요사항(결정된 내용, 기준·원칙, 숫자·금액, 연락처, 주의할 점 등)은 type "memo". title은 핵심 한 줄, detail에 설명. 매우 중요하면 priority "high".',
      '- 사소한 생각이나 이미 일정·메모로 정리된 내용은 summary에만 넣어.',
      '- notice의 status: todo=아직 전달 안 함, done=전달함, cancel=전달할 필요 없어짐. memo의 status: todo=유효, done=더 이상 필요 없음.',
      '- title은 메모 전체를 대표하는 20자 이내 제목.',
      '- summary는 핵심 1~5개, 각 40자 이내, 개조식(~함, ~임 또는 명사형).',
      '- tags는 주제어 0~3개, 각 6자 이내, # 없이.',
      '- items의 title은 "누가/무엇을" 알 수 있게 짧게. detail에는 메모에 적힌 보충 설명이나 진행 상황만. notice가 아니면 to는 "".',
      '- notice와 memo는 개조식으로 간결·명료하게: title은 핵심 한 줄 25자 이내, 명사형으로 끝냄(~제출, ~확정, ~필요, ~안내). detail은 꼭 필요한 보충만 줄바꿈(\\n)으로 나눈 1~3줄, 각 40자 이내, ~함·~임·명사형으로 끝냄. 날짜·숫자는 남기고 인사·반복·군더더기는 빼. date·to에 넣은 기한·대상은 detail에 다시 쓰지 마.',
      '',
      '기존 일정과 상태 규칙',
      '- 기존 일정과 같은 일이면 ref에 그 번호(e1 등)를 넣고, 바뀐 내용(날짜·시간·장소·상태 등)을 반영해서 돌려줘. 새로 생긴 일만 ref를 "" 로.',
      '- 바뀐 것이 없는 기존 일정은 돌려주지 않아도 돼. 그대로 유지돼.',
      '- 같은 일을 두 번 만들지 마.',
      '- status: todo=예정(아직 안 함), doing=진행중(시작함·하는 중·반쯤 함), hold=보류(미룸·보류·나중에), done=완결(완료·끝냄·제출함·다녀옴), cancel=취소(취소됨·안 하기로 함).',
      '- 메모는 아래쪽이 나중에 쓴 내용이야. 같은 일에 대해 상태가 여러 번 적혀 있으면 가장 아래쪽 내용을 따라.',
      '- 상태 변화가 메모에 분명히 적혀 있을 때만 바꾸고, 아니면 기존 상태를 그대로 둬. 새 일정은 보통 todo.',
      '- "사용자가 직접 정함" 표시된 일정의 status는 바꾸지 말고 기존 값을 그대로 써.',
      '- "삭제됨" 표시된 일정은 다시 만들지 말고 돌려주지도 마.',
      '',
      '이 노트에서 전에 정리한 항목 (번호 | 종류 | 제목 | 날짜 | 장소 | 상태):',
      existingText(existing),
      attachRule(att),
      '',
      '메모:',
      '"""',
      text && text.trim() ? text.trim() : '(글자 메모 없음 — 첨부 내용만 있음)',
      '"""',
    ].join('\n');
  }

  function fail(code, message) { const e = new Error(message || code); e.code = code; return e; }

  async function call({ apiKey, model, effort, content, signal, maxTokens, withSchema, schema, useFallback }) {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true',
    };
    const body = {
      model,
      max_tokens: maxTokens || 16000,
      output_config: { effort: ['low', 'medium', 'high'].includes(effort) ? effort : 'high' },
      messages: [{ role: 'user', content }],
    };
    if (withSchema || schema) body.output_config.format = { type: 'json_schema', schema: schema || SCHEMA };
    if (useFallback) { headers['anthropic-beta'] = FALLBACK_BETA; body.fallbacks = 'default'; }

    let res;
    try {
      res = await fetch(URL_MESSAGES, { method: 'POST', headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw fail('cancelled');
      throw fail('offline', '인터넷에 연결할 수 없어요');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 무시 */ }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
      if (res.status === 400 && useFallback && /fallback|beta/i.test(msg)) {
        return call({ apiKey, model, effort, content, signal, maxTokens, withSchema, schema, useFallback: false });
      }
      if (res.status === 401) throw fail('bad_key', msg);
      if (res.status === 403) throw fail('forbidden', msg);
      if (res.status === 404) throw fail('bad_model', msg);
      if (res.status === 413) throw fail('too_large', msg);
      if (res.status === 429) throw fail('rate', msg);
      if (res.status >= 500) throw fail('server', msg);
      throw fail('bad_request', msg);
    }
    if (data.stop_reason === 'refusal') throw fail('refused');
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    return { text, stop: data.stop_reason };
  }

  function parseJSON(text) {
    try { return JSON.parse(text); } catch (e) { /* 아래에서 다시 */ }
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) { try { return JSON.parse(fence[1]); } catch (e) { /* 무시 */ } }
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) { /* 무시 */ } }
    throw fail('bad_output', '정리 결과를 읽지 못했어요');
  }

  /* ---------- 회의록 ---------- */
  const STR = { type: 'string' }, STRS = { type: 'array', items: STR };
  const obj = (props) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props });
  const MINUTES_SCHEMA = obj({
    title: STR, place: STR, attendees: STR,
    summary: STRS,
    agenda: { type: 'array', items: obj({ title: STR, points: { type: 'array', items: obj({ text: STR, subs: STRS }) } }) },
    decisions: STRS,
    actions: { type: 'array', items: obj({ task: STR, owner: STR, due: STR, dueDate: STR }) },
    next: STR,
    attachments: STRS,
  });

  function minutesPrompt(text, meta) {
    const D = KK.date, cal = D.calendarText();
    const v = s => (s && String(s).trim()) || '(비어 있음 — 글에서 찾아 채워)';
    const base = meta.date && D.isValid(meta.date) ? D.parse(meta.date) : new Date();
    const days = [];
    for (let i = 0; i < 35; i++) { const d = D.addDays(base, i); days.push(D.ymd(d) + ' (' + D.DOW[d.getDay()] + ')' + (i === 0 ? ' ← 회의 날' : '')); }
    return [
      '아래는 회의를 녹음해 글로 옮긴 녹취록과 회의 중에 적은 메모야. 이걸로 병원 내부 보고용 회의록을 간결하게 정리해 줘.',
      '',
      '회의 기본 정보 (사용자가 적은 값):',
      '- 회의명: ' + v(meta.title),
      '- 일시: ' + v(meta.when),
      '- 장소: ' + v(meta.place),
      '- 참석자: ' + v(meta.attendees),
      '',
      '오늘: ' + cal.now + ' (한국 시간). 회의 날짜: ' + (meta.date || '알 수 없음') + '. "다음 주 금요일" 같은 말은 회의 날짜를 기준으로 계산해.',
      '날짜 참고표:',
      days.join('\n'),
      '',
      '쓰는 법',
      '- 문체는 개조식 명사형 종결(~함, ~임, ~예정, ~필요). 존댓말·구어체·"~했습니다"는 쓰지 마.',
      '- 간결하게. summary는 회의 전체의 핵심 3~5개, 각 60자 이내.',
      '- agenda는 다룬 주제(안건)별로 묶어. 안건마다 points 2~5개, 각 1~2줄. subs는 꼭 필요한 세부만 0~3개.',
      '- 인사·잡담·같은 말 반복·말 더듬은 빼고, 결정·합의·수치·일정·담당 위주로 남겨.',
      '- 녹취록은 음성 인식이라 잘못 옮긴 말이 있을 수 있어. 문맥으로 바로잡되, 확실하지 않은 이름·숫자·날짜는 뒤에 "(확인 필요)"를 붙여.',
      '- 글에 없는 내용은 지어내지 마.',
      '- 환자 이름·등록번호·생년월일·연락처 같은 개인정보가 나오면 "환자 A"처럼 가려서 적어.',
      '- 날짜는 "11. 14.(금)"처럼, 시간은 "14:00"처럼 적어.',
      '- agenda의 title은 안건 이름만(번호 없이). points.text와 subs 앞에 ○, -, 번호 같은 기호를 붙이지 마.',
      '- decisions: 회의에서 정해진 것만. 없으면 [].',
      '- actions: 누가 언제까지 무엇을 하기로 했는지. task는 할 일(짧게), owner는 담당(부서·사람), due는 기한("11. 14.(금)"처럼), dueDate는 같은 기한을 YYYY-MM-DD로. 모르는 칸은 "".',
      '- next: 다음 회의 일정이 나오면 한 줄로, 없으면 "".',
      '- attachments: 회의에서 나눠 준 자료나 참고한 문서 이름. 없으면 [].',
      '- title: 사용자가 회의명을 적었으면 그대로, 아니면 글에서 알 수 있는 회의 이름(30자 이내). "회의록"이라는 말은 붙이지 마.',
      '- place·attendees: 사용자가 적었으면 그대로, 아니면 글에서 확인되는 것만(참석자는 부서·직위·이름을 쉼표로). 모르면 "".',
      '',
      '녹취록·메모:',
      '"""',
      text.trim(),
      '"""',
    ].join('\n');
  }

  /* ---------- 월간 업무 요약 ---------- */
  const MONTHLY_SCHEMA = obj({
    headline: STR,
    areas: { type: 'array', items: obj({ area: STR, points: STRS }) },
    done: STRS, carry: STRS, notes: STRS,
  });
  function monthlyPrompt(label, text, partial) {
    return [
      '아래는 사용자가 ' + label + '에 노트에 적은 업무 기록과, 그 달의 일정·할 일 상태, 회의록 요약이야.',
      '이걸로 ' + label + ' 월간 업무 요약을 만들어 줘. ' + (partial ? '아직 달이 끝나지 않았으니 지금까지의 내용으로 정리해.' : '다음 달로 넘어가면서 지난달에 무슨 일을 했고 무엇이 남았는지 한눈에 보려는 용도야.'),
      '',
      '쓰는 법',
      '- 문체는 개조식 명사형 종결(~함, ~임, ~완료, ~진행 중). 짧고 간결하게.',
      '- headline: 이 달 업무 전체를 한 문장(50자 이내)으로.',
      '- areas: 업무 분야(사업·프로젝트·회의체·행정 등)별로 묶어 2~6개. area는 분야 이름(15자 이내), points는 그 분야에서 한 일과 진행 상황 1~4개(각 50자 이내).',
      '- done: 이 달에 끝낸 주요 업무 최대 8개.',
      '- carry: 아직 안 끝나서 다음 달로 넘어가는 업무 최대 8개. 기한이 있으면 끝에 "(~12. 5.)"처럼 붙여.',
      '- notes: 다음 달에도 기억해야 할 결정·기준·숫자 최대 5개. 없으면 [].',
      '- 병원 진료 예약, 장보기처럼 업무와 관계없는 개인 일은 빼.',
      '- 기록에 없는 내용은 지어내지 마. 환자 개인정보는 쓰지 마.',
      '',
      '기록:',
      '"""',
      text.trim(),
      '"""',
    ].join('\n');
  }

  /* ---------- 전달사항·중요 메모 다듬기 (개조식) ---------- */
  const POLISH_SCHEMA = obj({ items: { type: 'array', items: obj({ ref: STR, title: STR, points: STRS }) } });
  function polishPrompt(list) {
    return [
      '아래는 사용자의 업무 노트에서 뽑은 전달사항과 중요 메모야. 각 항목을 핵심만 남겨 간결·명료한 개조식으로 다시 써 줘.',
      '',
      '쓰는 법',
      '- title: 핵심 한 줄, 25자 이내. 명사형으로 끝내(~제출, ~확정, ~필요, ~안내, ~변경). "~합니다", "~해야 함" 같은 문장형은 쓰지 마.',
      '- points: 꼭 필요한 보충만 0~3개, 각 40자 이내. ~함·~임·명사형으로 끝내. 제목과 같은 말을 되풀이하지 마. 기한과 대상은 화면에 따로 나오니 points에 다시 쓰지 마.',
      '- 날짜·숫자·금액·대상·장소는 그대로 남기고, 인사·반복·군더더기는 빼.',
      '- 원래 내용에 없는 사실을 더하거나 숫자·날짜·이름을 바꾸지 마.',
      '- ref는 받은 그대로 쓰고, 받은 항목을 모두 돌려줘.',
      '',
      '항목 (ref | 종류 | 대상 | 기한 | 제목 | 내용):',
      list.map(i => [i.ref, i.type === 'notice' ? '전달사항' : '중요 메모', i.to || '-', i.date || '-', i.title, (i.detail || '-').replace(/\n/g, ' / ')].join(' | ')).join('\n'),
    ].join('\n');
  }

  KK.claude = {
    /* 전달사항·중요 메모를 개조식으로 다듬기: [{ref,type,to,date,title,detail}] → [{ref,title,points}] */
    async polish({ apiKey, model, effort, items, signal }) {
      const out = await call({
        apiKey, model, effort, signal, schema: POLISH_SCHEMA, maxTokens: 12000,
        content: [{ type: 'text', text: polishPrompt(items) }],
        useFallback: FALLBACK_MODELS.includes(model),
      });
      if (out.stop === 'max_tokens') throw fail('bad_output', '항목이 너무 많아 결과가 잘렸어요');
      const r = parseJSON(out.text);
      const str = v => (typeof v === 'string' ? v.trim() : '');
      return (Array.isArray(r.items) ? r.items : []).map(x => ({
        ref: str(x && x.ref), title: str(x && x.title).slice(0, 60),
        points: (Array.isArray(x && x.points) ? x.points : []).map(str).filter(Boolean).slice(0, 4).map(s => s.replace(/^[-○•·]\s*/, '')),
      })).filter(x => x.ref && x.title);
    },
    /* 월간 업무 요약: 한 달 기록 → { headline, areas, done, carry, notes } */
    async monthly({ apiKey, model, effort, label, text, partial, signal }) {
      const out = await call({
        apiKey, model, effort, signal, schema: MONTHLY_SCHEMA, maxTokens: 12000,
        content: [{ type: 'text', text: monthlyPrompt(label, text, partial) }],
        useFallback: FALLBACK_MODELS.includes(model),
      });
      if (out.stop === 'max_tokens') throw fail('bad_output', '요약이 너무 길어 결과가 잘렸어요');
      const r = parseJSON(out.text);
      const str = v => (typeof v === 'string' ? v.trim() : '');
      const arr = v => (Array.isArray(v) ? v : []);
      const strs = v => arr(v).map(str).filter(Boolean);
      return {
        headline: str(r.headline).slice(0, 120),
        areas: arr(r.areas).map(a => ({ area: str(a && a.area).slice(0, 30), points: strs(a && a.points).slice(0, 5) })).filter(a => a.area && a.points.length).slice(0, 8),
        done: strs(r.done).slice(0, 10), carry: strs(r.carry).slice(0, 10), notes: strs(r.notes).slice(0, 6),
      };
    },
    /* 회의록: 녹취록·메모 글 → 회의록 내용(JSON) */
    async minutes({ apiKey, model, effort, text, meta, signal }) {
      const out = await call({
        apiKey, model, effort, signal, schema: MINUTES_SCHEMA, maxTokens: 20000,
        content: [{ type: 'text', text: minutesPrompt(text, meta || {}) }],
        useFallback: FALLBACK_MODELS.includes(model),
      });
      if (out.stop === 'max_tokens') throw fail('bad_output', '회의록이 너무 길어 결과가 잘렸어요');
      const r = parseJSON(out.text);
      const str = v => (typeof v === 'string' ? v.trim() : '');
      const arr = v => (Array.isArray(v) ? v : []);
      const strs = v => arr(v).map(str).filter(Boolean);
      return {
        title: str(r.title).slice(0, 80),
        place: str(r.place).slice(0, 80),
        attendees: str(r.attendees).slice(0, 400),
        summary: strs(r.summary).slice(0, 7),
        agenda: arr(r.agenda).map(a => ({
          title: str(a && a.title),
          points: arr(a && a.points).map(p => ({ text: str(p && p.text), subs: strs(p && p.subs) })).filter(p => p.text || p.subs.length),
        })).filter(a => a.title || a.points.length),
        decisions: strs(r.decisions),
        actions: arr(r.actions).map(a => ({ task: str(a && a.task), owner: str(a && a.owner), due: str(a && a.due), dueDate: KK.date.isValid(str(a && a.dueDate)) ? str(a.dueDate) : '' })).filter(a => a.task),
        next: str(r.next),
        attachments: strs(r.attachments),
      };
    },

    /* file: 삼성 노트에서 가져온 파일 {kind:'document'|'image', media_type, data(base64)} */
    async organize({ apiKey, model, effort, text, imageB64, file, existing, signal }) {
      const content = [];
      if (file) content.push({ type: file.kind === 'document' ? 'document' : 'image', source: { type: 'base64', media_type: file.media_type, data: file.data } });
      if (imageB64) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageB64 } });
      content.push({ type: 'text', text: buildPrompt(text, { ink: !!imageB64, file: !!file }, existing) });
      const out = await call({
        apiKey, model, effort, content, signal, withSchema: true,
        useFallback: FALLBACK_MODELS.includes(model),
      });
      if (out.stop === 'max_tokens') throw fail('bad_output', '메모가 너무 길어 결과가 잘렸어요');
      const r = parseJSON(out.text);
      const str = v => (typeof v === 'string' ? v.trim() : '');
      const arr = v => (Array.isArray(v) ? v : []);
      return {
        title: str(r.title).slice(0, 40),
        transcript: str(r.transcript),
        summary: arr(r.summary).map(str).filter(Boolean).slice(0, 6),
        tags: arr(r.tags).map(str).map(t => t.replace(/^#/, '')).filter(Boolean).slice(0, 4),
        items: arr(r.items).map(it => ({
          ref: str(it && it.ref),
          type: ['event', 'task', 'notice', 'memo'].includes(it && it.type) ? it.type : 'task',
          to: str(it && it.to).slice(0, 40),
          status: ['todo', 'doing', 'hold', 'done', 'cancel'].includes(it && it.status) ? it.status : 'todo',
          title: str(it && it.title).slice(0, 80),
          date: KK.date.isValid(str(it && it.date)) ? str(it.date) : '',
          time: KK.date.isTime(str(it && it.time)) ? str(it.time) : '',
          endTime: KK.date.isTime(str(it && it.endTime)) ? str(it.endTime) : '',
          place: str(it && it.place).slice(0, 60),
          priority: it && it.priority === 'high' ? 'high' : 'normal',
          detail: str(it && it.detail).slice(0, 200),
        })).filter(it => it.title),
      };
    },
    async test({ apiKey, model }) {
      const out = await call({ apiKey, model, effort: 'low', content: [{ type: 'text', text: '연결 확인이야. "확인"이라고만 답해.' }], maxTokens: 2000 });
      return out.text;
    },
  };
})();
