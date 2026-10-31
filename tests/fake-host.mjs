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
    { type: 'tool/call', seq: 3, time: now - 8 * MIN, data: { name: 'bash', arguments: JSON.stringify({ command: 'pnpm test' }) } },
  ],
  s2: [
    { type: 'turn/start', seq: 1, time: now - 3 * MIN, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: now - 2 * MIN, data: { turn: 1, reason: { kind: 'error', error: { message: 'TypeScript: Cannot find module @/lib/env' } } } },
  ],
  s3: [
    { type: 'turn/start', seq: 1, time: now - 10 * MIN, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: now - 4 * MIN, data: { turn: 1, reason: { kind: 'completed' } } },
  ],
  s5: [],
  s8: [],
  s9: [
    { type: 'turn/start', seq: 1, time: now - HOUR, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: now - 50 * MIN, data: { turn: 1, reason: { kind: 'completed' } } },
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
  summary('s8', { title: titles.s8, updatedAt: now - 30 * DAY }),
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
];
const activity = {
  s1: [{ kind: 'turn' }, { kind: 'subagent', items: [{ id: 's7', label: '子代理 s7' }] }],
  s9: [{ kind: 'schedule', items: [{ id: 'sch1', label: '每周依赖升级' }, { id: 'sch2', label: '周一检查安全公告' }] }],
  s10: [],
};

function makeCtx(options = {}) {
  const ctx = {
    logger: { warn: (...args) => console.warn('[warn]', ...args) },
    effect: (fn) => { const dispose = fn(); return typeof dispose === 'function' ? dispose : () => {}; },
    get(name) {
      if (name === 'sessionController' && options.sessionController !== false) {
        return { list: async () => ({ items }) };
      }
      if (name === 'sessionQuery') {
        return {
          listSessions: async () => items.map((item) => ({ header: header(item.sessionId, item.cwd), formatStatus: item.formatStatus })),
          readTitleSnapshots: async (ids) => ids.map((id) => ({
            sessionId: id,
            status: 'fulfilled',
            value: {
              session: header(id, 'C:/work/pay'),
              ...(titles[id] ? {
                title: {
                  title: titles[id],
                  messageSeqs: [1],
                  source: { kind: 'provider', provider: 'dsh-session-title-all-prompts-llm' },
                  updatedAt: now - 10 * MIN,
                },
              } : {}),
            },
          })),
          observeSession: async (id) => ({
            header: header(id, 'C:/work/pay'),
            events: events[id] || [],
            projections: { asOfSeq: 1, values: projections[id] || {} },
          }),
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
          archivedSessionIds: ['s6'],
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
}

{
  const { response, json } = await getJson(ctx, '/task-board-api/archived');
  assert.equal(response.status, 200);
  assert.equal(json.cards.length, 1);
  assert.equal(json.cards[0].id, 's6');
  assert.equal(json.cards[0].state, 'archived');
  assert.equal(json.cards[0].canOpen, false);
}

{
  const response = await request(ctx, 'POST', '/task-board-api/cards');
  assert.equal(response.status, 405);
  assert.match(response.body, /read only/);
}

{
  const { response, json } = await getJson(ctx, '/task-board-api/board');
  assert.equal(response.status, 404);
  assert.equal(json.ok, false);
}

{
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
  const pending = ctx.registration.handler(req, res);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(res.statusCode, 200);
  const text = chunks.join('');
  assert.match(text, /event: cards/);
  assert.match(text, /"revision"/);
  req.emit('close');
  res.writableEnded = true;
  await pending;
}

console.log('fake-host: passed');
