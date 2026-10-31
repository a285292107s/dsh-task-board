import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apply } from '../index.js';

const now = Date.now();
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;

function header(id, cwd, extra) {
  return { version: 4, id, createdAt: now - DAY, isSeeded: false, cwd, ...(extra || {}) };
}

function summary(id, opts) {
  const o = opts || {};
  return {
    sessionId: id,
    updatedAt: o.updatedAt || now - MIN,
    running: !!o.running,
    blank: !!o.blank,
    agentAvailable: o.agentAvailable !== false,
    cwd: o.cwd || 'C:/work/pay',
    origin: o.origin,
    parentSessionId: o.parent,
    formatStatus: o.formatStatus || 'current',
    projections: {
      kind: 'sequenced',
      values: {
        title: o.title === undefined ? '会话 ' + id : o.title,
        sessionListMetadata: { blank: !!o.blank, lastPromptAt: o.lastPromptAt || o.updatedAt || now - MIN },
        goal: o.goal || null,
        tokenUsage: o.tokens || { uncachedInputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
        ...(o.origin === 'subagent'
          ? {
            subagent: { mode: 'continuable', label: '子代理 ' + id, seq: 1 },
            subagentTiming: { settledMs: 0, active: { since: now - 2 * MIN, through: now } },
          }
          : {}),
        ...(o.extraProjections || {}),
      },
    },
  };
}

const titles = {
  s1: '迁移用户表到新 schema',
  s2: '修复构建失败',
  s3: '修复登录重定向循环',
  s5: null,
  s6: '旧版支付网关迁移',
  s8: '很早以前的会话',
  s9: '每周依赖升级',
  s10: '迁移支付网关',
};
const events = {
  s1: [
    { type: 'turn/start', seq: 1, time: now - 12 * MIN, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: now - 12 * MIN, data: {} },
    { type: 'session/title', seq: 3, time: now - 30 * 1000, data: { title: titles.s1, messageSeqs: [2], source: { kind: 'provider', provider: 'session-title-all-prompts-llm' } } },
    { type: 'tool/call', seq: 4, time: now - 8 * MIN, data: { name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) } },
  ],
  s2: [
    { type: 'turn/start', seq: 1, time: now - 3 * MIN, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: now - 2 * MIN, data: { turn: 1, reason: { kind: 'error', error: { message: 'TypeScript: Cannot find module @/lib/env' } } } },
    { type: 'session/title', seq: 3, time: now - 10 * MIN, data: { title: titles.s2, messageSeqs: [1], source: { kind: 'provider', provider: 'session-title-all-prompts-llm' } } },
  ],
  s3: [
    { type: 'turn/start', seq: 1, time: now - 10 * MIN, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: now - 4 * MIN, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/title', seq: 3, time: now - 6 * MIN, data: { title: titles.s3, messageSeqs: [], source: { kind: 'user' } } },
  ],
  s5: [],
  s8: [],
  s9: [
    { type: 'turn/start', seq: 1, time: now - HOUR, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: now - 50 * MIN, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'session/title', seq: 3, time: now - 50 * MIN, data: { title: titles.s9, messageSeqs: [1], source: { kind: 'provider', provider: 'session-title-all-prompts-llm' } } },
  ],
  s10: [],
};
const projections = {
  s1: {
    turnOutline: [{ turn: 1, seq: 1, prompt: '迁移用户表', response: '' }],
    todos: [
      { content: '读取旧表结构', status: 'completed' },
      { content: '更新 0042_users.sql', status: 'in_progress' },
      { content: '跑迁移测试', status: 'pending' },
    ],
  },
  s2: { turnOutline: [{ turn: 1, seq: 1, prompt: '修复构建', response: '' }], todos: null },
  s3: { turnOutline: [{ turn: 1, seq: 1, prompt: '修复登录重定向', response: '已修复重定向循环，新增回归测试；pnpm test 通过。' }], todos: [{ content: '写回归测试', status: 'completed' }] },
  s5: { turnOutline: [], todos: null },
  s8: { turnOutline: [], todos: null },
  s9: { turnOutline: [{ turn: 1, seq: 1, prompt: '每周依赖升级', response: '已完成本周升级。' }], todos: null },
  s10: { turnOutline: [], todos: null },
};
const items = [
  summary('s1', { title: titles.s1, running: true, updatedAt: now - MIN }),
  summary('s2', { title: titles.s2, updatedAt: now - 2 * MIN }),
  summary('s3', { title: titles.s3, updatedAt: now - 4 * MIN }),
  summary('s5', { title: null, blank: true, updatedAt: now - 30 * 1000 }),
  summary('s6', { title: titles.s6, updatedAt: now - 3 * DAY }),
  summary('s7', { title: '子代理 s7', origin: 'subagent', parent: 's1', running: true, updatedAt: now - MIN }),
  summary('s8', { title: titles.s8, updatedAt: now - 30 * DAY, agentAvailable: false }),
  summary('s9', { title: titles.s9, updatedAt: now - 50 * MIN }),
  summary('s10', {
    title: titles.s10,
    updatedAt: now - 5 * MIN,
    goal: {
      goal: { objective: '迁移支付网关', phase: 'blocked', maxGoalRounds: 8, blockedReason: { code: 'needs-decision', message: '需要决定是否停用旧网关' } },
      roundsStarted: 2,
      createdAt: now - DAY,
      updatedAt: now - 5 * MIN,
    },
  }),
  summary('s11', { title: '归档子代理', origin: 'subagent', parent: 's1', updatedAt: now - DAY, extraProjections: { subagentTiming: null } }),
];
const activity = {
  s1: [{ kind: 'turn' }, { kind: 'subagent', items: [{ id: 's7', label: '子代理 s7' }] }],
  s2: [{ kind: 'job', items: [{ id: 'job-1', label: '构建任务' }] }],
  s9: [{ kind: 'schedule', items: [{ id: 'sch1', label: '每周依赖升级' }, { id: 'sch2', label: '周一检查安全公告' }] }],
  s10: [],
};

function makeCtx(options = {}) {
  const state = { listCalls: 0, observations: 0, disposed: 0 };
  const ctx = {
    logger: { warn: (...args) => console.warn('[warn]', ...args) },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    get(name) {
      if (name === 'sessionController' && options.sessionController !== false) {
        return {
          list: async () => {
            state.listCalls += 1;
            if (options.listDelay) await new Promise((resolve) => setTimeout(resolve, options.listDelay));
            return { items };
          },
        };
      }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => items.map((item) => ({
            header: header(item.sessionId, item.cwd, {
              createdAt: item.updatedAt,
              origin: item.origin,
              parentSession: item.parentSessionId,
            }),
            formatStatus: item.formatStatus,
          })),
          readTitleSnapshots: async () => {
            throw new Error('readTitleSnapshots is not part of the read model');
          },
          observeSession: async (id) => {
            state.observations += 1;
            return {
              [Symbol.dispose]() { state.disposed += 1; },
              header: header(id, 'C:/work/pay'),
              events: events[id] || [],
              projections: { asOfSeq: 1, values: projections[id] || {} },
            };
          },
        };
      }
      if (name === 'workspaceRegistry') {
        return {
          list: () => [{
            id: 'w1',
            title: '支付服务',
            path: 'C:/work/pay',
            sessionIds: items.map((item) => item.sessionId),
          }],
          archivedSessionIds: ['s6', 's11'],
          pinnedSessionIds: ['s3'],
        };
      }
      if (name === 'webServer') return ctx.webServer;
      return undefined;
    },
    waterfall: async (_name, payload) => activity[payload.sessionId] || [],
    webServer: {
      register(registration) {
        ctx.registration = registration;
        return () => {};
      },
    },
  };
  ctx.state = state;
  apply(ctx);
  return ctx;
}

function request(ctx, method, pathname) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = method;
    req.url = pathname;
    const res = {
      statusCode: 0,
      headers: {},
      chunks: [],
      writableEnded: false,
      setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
      writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
      write(chunk) { this.chunks.push(String(chunk)); return true; },
      end(chunk) {
        if (chunk) this.chunks.push(String(chunk));
        this.writableEnded = true;
        resolve({ status: this.statusCode, headers: this.headers, body: this.chunks.join('') });
      },
    };
    try { ctx.registration.handler(req, res); } catch (error) { reject(error); }
  });
}

async function getJson(ctx, pathname) {
  const response = await request(ctx, 'GET', pathname);
  return { response, json: JSON.parse(response.body) };
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

const ctx = makeCtx();
assert.equal(ctx.registration.kind, 'prefix');
assert.equal(ctx.registration.path, '/task-board-api');

{
  const { response, json } = await getJson(ctx, '/task-board-api/health');
  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.readOnly, true);
}

{
  const warming = await getJson(ctx, '/task-board-api/cards');
  assert.equal(warming.response.status, 200);
  assert.equal(warming.json.ok, true);
  assert.equal(warming.json.warming, true);
  assert.equal(warming.json.cards.length, 0);

  let cardsJson = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = await getJson(ctx, '/task-board-api/cards');
    if (next.json.cards.length > 0) { cardsJson = next; break; }
  }
  assert.ok(cardsJson, 'snapshot build completes in the background');
  const { response, json } = cardsJson;
  assert.equal(response.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.archivedCount, 1);
  assert.equal(json.titleFollow, true);
  assert.ok(Array.isArray(json.cards));
  assert.equal(json.cards.length, 6, 'non-archived, non-subagent, non-blank cards only');
  assert.equal(json.cards.some((card) => card.id === 's7'), false, 'subagent has no card');
  assert.equal(json.cards.some((card) => card.id === 's6'), false, 'archived excluded from /cards');
  assert.equal(json.cards.some((card) => card.id === 's5'), false, 'blank card is synthesized by the client');

  const byId = new Map(json.cards.map((card) => [card.id, card]));
  assert.equal(byId.get('s1').state, 'running');
  assert.equal(byId.get('s1').workspace.title, '支付服务');
  assert.equal(byId.get('s1').activity.todoDone, 1);
  assert.equal(byId.get('s1').activity.todoTotal, 3);
  assert.match(byId.get('s1').activity.currentStep, /0042_users/);
  assert.equal(byId.get('s1').activity.subagents, 1);
  assert.deepEqual(byId.get('s1').activity.labels, ['子代理 s7'], 'activity labels are deduped');

  assert.equal(byId.get('s2').state, 'failed');
  assert.equal(byId.get('s2').activity.jobs, 1, '失败不会因为后台任务而退回「进行中」');
  assert.match(byId.get('s2').outcome.error, /Cannot find module/);
  assert.equal(byId.get('s2').titleStale, true, 'title snapshot is older than the latest prompt');

  assert.equal(byId.get('s3').state, 'completed');
  assert.equal(byId.get('s3').pinned, true);
  assert.match(byId.get('s3').outcome.lastResponse, /pnpm test 通过/);
  assert.equal(byId.get('s3').outcome.reason, 'completed');

  assert.equal(byId.has('s5'), false);
  assert.equal(byId.get('s8').compact, true);
  assert.equal(byId.get('s8').state, 'unknown');

  assert.equal(byId.get('s9').state, 'scheduled');
  assert.equal(byId.get('s9').activity.scheduled, 2);

  assert.equal(byId.get('s10').state, 'blocked');
  assert.match(byId.get('s10').goal.blockedReason, /停用旧网关/);

  assert.equal(byId.get('s1').titleSource, 'provider');
  assert.equal(byId.get('s1').provisional, false);
  assert.equal(byId.get('s1').titleStale, false);
  assert.equal(byId.get('s2').titleStale, true, '标题早于最后一条人类指令');
  assert.equal(byId.get('s3').titleSource, 'user', '用户 pin 的标题来自 session/title 事件');
  assert.equal(byId.get('s10').provisional, true, '没有 session/title 事件时回退列表标题');
  assert.equal(byId.get('s10').title, titles.s10);
  assert.ok(ctx.state.observations > 0);
  assert.equal(ctx.state.disposed, ctx.state.observations, 'observation 租约用完即释放');
}

{
  const { response, json } = await getJson(ctx, '/task-board-api/archived');
  assert.equal(response.status, 200);
  assert.equal(json.cards.length, 1);
  assert.equal(json.cards[0].id, 's6');
  assert.equal(json.cards[0].state, 'archived');
  assert.equal(json.cards[0].canOpen, false);
  assert.equal(ctx.state.listCalls, 1, '归档快照复用主快照的会话摘要，不重复全量扫描');
}

{
  const warming = await getJson(ctx, '/task-board-api/cards?days=1');
  assert.equal(warming.json.warming, true);
  let day1 = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = await getJson(ctx, '/task-board-api/cards?days=1');
    if (next.json.warming !== true) { day1 = next; break; }
  }
  assert.ok(day1, '1 天窗口快照在后台建好');
  assert.equal(day1.response.status, 200);
  assert.equal(day1.json.days, 1);
  assert.equal(day1.json.cards.some((card) => card.id === 's8'), false, '30 天前的卡不在 1 天窗口内');
  assert.equal(day1.json.cards.some((card) => card.id === 's1'), true);
  assert.equal(ctx.state.listCalls, 1, '时间窗口共享 10s 内的会话摘要');
}

{
  const { response, json } = await getJson(ctx, '/task-board-api/cards?days=7&refresh=1');
  assert.equal(response.status, 200);
  assert.equal(json.warming, undefined);
  assert.equal(json.cards.length, 5);
  assert.equal(ctx.state.listCalls, 2, 'refresh=1 重新读会话列表');
}

{
  const degraded = makeCtx({ sessionController: false });
  let snapshot = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const next = await getJson(degraded, '/task-board-api/cards?days=1');
    if (next.json.warming !== true) { snapshot = next; break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(snapshot, '降级快照也能建好');
  assert.equal(snapshot.json.source, 'sessionQuery');
  assert.equal(snapshot.json.archivedCount, 1);
  assert.equal(snapshot.json.cards.some((card) => card.id === 's8'), true, '降级快照不按创建时间裁掉旧会话');
  assert.equal(snapshot.json.cards.some((card) => card.id === 's5'), true, '降级快照无法识别空白会话');
}

{
  const response = await request(ctx, 'POST', '/task-board-api/cards');
  assert.equal(response.status, 405);
  assert.equal(response.headers.allow, 'GET');
  assert.match(response.body, /read only/);
}

{
  const ranges = [0, 7, 30, 90];
  for (const range of ranges) {
    let built = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const next = await getJson(ctx, '/task-board-api/cards?days=' + range);
      if (next.json.warming !== true) { built = next; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(built, '时间范围 ' + range + ' 快照可建好');
  }
  for (const range of ranges) {
    const { json } = await getJson(ctx, '/task-board-api/cards?days=' + range);
    assert.notEqual(json.warming, true, '时间范围 ' + range + ' 与归档快照共同驻留');
  }
}

{
  const { response, json } = await getJson(ctx, '/task-board-api/board');
  assert.equal(response.status, 404);
  assert.equal(json.ok, false);
}

{
  const req = new EventEmitter();
  req.method = 'GET';
  req.url = '/task-board-api/events?days=7';
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    flushHeaders() {},
    write(chunk) { chunks.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
    on() {},
  };
  const pending = ctx.registration.handler(req, res);
  await waitFor(() => chunks.join('').includes('event: cards'), 2000);
  assert.equal(res.statusCode, 200);
  const text = chunks.join('');
  assert.match(text, /event: cards/);
  assert.match(text, /"full":true/, '每个连接的第一帧是全量快照');
  assert.match(text, /"days":7/, 'SSE 帧带时间窗');
  assert.match(text, /"revision"/);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal((chunks.join('').match(/event: cards/g) || []).length, 1, '快照未变时不重复推帧');
  req.emit('close');
  res.writableEnded = true;
  await pending;
}

{
  const delayed = makeCtx({ listDelay: 300 });
  const req = new EventEmitter();
  req.method = 'GET';
  req.url = '/task-board-api/events';
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    writableEnded: false,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    writeHead(code, headers) { this.statusCode = code; Object.assign(this.headers, headers || {}); },
    flushHeaders() {},
    write(chunk) { chunks.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
    on() {},
  };
  const pending = delayed.registration.handler(req, res);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.doesNotMatch(chunks.join(''), /event: cards/, 'SSE 不推送 warming 空快照');
  await waitFor(() => chunks.join('').includes('event: cards'), 2500);
  assert.match(chunks.join(''), /event: cards/, '快照就绪后才推送');
  assert.match(chunks.join(''), /"full":true/, 'warming 后的第一帧标记为全量');
  req.emit('close');
  res.writableEnded = true;
  await pending;
}

console.log('fake-host: passed');
