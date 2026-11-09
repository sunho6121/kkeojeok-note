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
          required: ['ref', 'type', 'status', 'title', 'date', 'time', 'endTime', 'place', 'priority', 'detail'],
          properties: {
            ref: { type: 'string' },
            type: { type: 'string', enum: ['event', 'task'] },
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
    return existing.map(e => [
      e.ref,
      e.type === 'event' ? '약속' : '할 일',
      e.title,
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
      '- 일정이나 할 일이 아닌 생각·정보·아이디어는 summary에만 넣어.',
      '- title은 메모 전체를 대표하는 20자 이내 제목.',
      '- summary는 핵심 1~5개, 각 40자 이내, 개조식(~함, ~임 또는 명사형).',
      '- tags는 주제어 0~3개, 각 6자 이내, # 없이.',
      '- items의 title은 "누가/무엇을" 알 수 있게 짧게. detail에는 메모에 적힌 보충 설명이나 진행 상황만.',
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
      '이 노트의 기존 일정 (번호 | 종류 | 제목 | 날짜 | 장소 | 상태):',
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

  async function call({ apiKey, model, effort, content, signal, maxTokens, withSchema, useFallback }) {
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
    if (withSchema) body.output_config.format = { type: 'json_schema', schema: SCHEMA };
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
        return call({ apiKey, model, effort, content, signal, maxTokens, withSchema, useFallback: false });
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

  KK.claude = {
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
          type: it && it.type === 'event' ? 'event' : 'task',
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
