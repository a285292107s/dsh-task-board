// 假宿主测试台：用假 ctx 驱动真实 index.js；不依赖任何 npm 包。
// 在插件包根运行：node tests/fake-host.mjs（临时产物只写 tests/.fixtures/，已 gitignore）。
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const FIXTURES = path.join(HERE, '.fixtures');
export const REPO = path.join(FIXTURES, 'repo');
export const PLAIN = path.join(FIXTURES, 'plain');
export const HOME = path.join(FIXTURES, 'home');
export const REMOTE = path.join(FIXTURES, 'remote.git');
export const INDEX_FILE = path.join(ROOT, 'index.js');
export const ROUTE_PREFIX = '/task-board-api';

export const WS_REPO = 'ws-repo';
export const WS_PLAIN = 'ws-plain';

// 插件包根是 git 仓库；不设天花板时 tests/.fixtures/plain 会被 git 向上认成仓库的一部分。
process.env.GIT_CEILING_DIRECTORIES = FIXTURES;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- git helpers

function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: opts.cwd || REPO,
      timeout: opts.timeout || 30000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
        err: err ? String(err.message || err) : null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

export function git(args, cwd = REPO) {
  return execFileP('git', args, { cwd });
}

async function setupFixtures() {
  let lastError = null;
  for (let i = 0; i < 6; i += 1) {
    try { await fs.rm(FIXTURES, { recursive: true, force: true }); lastError = null; break; }
    catch (e) { lastError = e; await sleep(250); }
  }
  if (lastError) throw new Error('清理 tests/.fixtures 失败（可能有其他进程正在使用）: ' + (lastError.message || lastError));
  await fs.mkdir(REPO, { recursive: true });
  await fs.mkdir(PLAIN, { recursive: true });
  await fs.mkdir(HOME, { recursive: true });

  const init = await git(['init', '-b', 'main'], REPO);
  if (init.code !== 0) throw new Error('git init 失败: ' + (init.stderr || init.err));
  await git(['config', 'user.email', 'fixture@example.com'], REPO);
  await git(['config', 'user.name', 'Fixture Bot'], REPO);
  await git(['config', 'commit.gpgsign', 'false'], REPO);

  await fs.writeFile(path.join(REPO, '.gitignore'), '.agents/\n', 'utf8');
  await fs.writeFile(path.join(REPO, 'README.md'), '# fixture repo\n', 'utf8');
  await fs.mkdir(path.join(REPO, 'src'), { recursive: true });
  await fs.writeFile(path.join(REPO, 'src', 'app.txt'), 'hello\n', 'utf8');
  await git(['add', '-A'], REPO);
  const commit = await git(['commit', '-m', '初始提交'], REPO);
  if (commit.code !== 0) throw new Error('git commit 失败: ' + (commit.stderr || commit.err));

  const remoteInit = await git(['init', '--bare', REMOTE], REPO);
  if (remoteInit.code !== 0) throw new Error('git init --bare 失败: ' + (remoteInit.stderr || remoteInit.err));
  await git(['remote', 'add', 'origin', REMOTE], REPO);

  await fs.writeFile(path.join(PLAIN, 'note.txt'), 'not a git repository\n', 'utf8');
}

// ------------------------------------------------------------- fake ctx pieces

function makeRes(onEnd) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.chunks = [];
  res.finished = false;
  res.setHeader = (k, v) => { res.headers[String(k).toLowerCase()] = v; };
  res.getHeader = (k) => res.headers[String(k).toLowerCase()];
  res.writeHead = (code, headers) => {
    res.statusCode = code;
    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) res.headers[String(k).toLowerCase()] = v;
    }
    return res;
  };
  res.write = (chunk) => {
    if (chunk !== undefined && chunk !== null) {
      res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return true;
  };
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.write(chunk);
    if (!res.finished) { res.finished = true; onEnd && onEnd(); }
    return res;
  };
  res.destroy = () => { if (!res.finished) { res.finished = true; onEnd && onEnd(); } };
  return res;
}

function makeReq(method, url, payload) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1', 'content-type': 'application/json' };
  req.destroy = () => {};
  req.setTimeout = () => req;
  process.nextTick(() => {
    if (payload) req.emit('data', Buffer.from(payload));
    req.emit('end');
  });
  return req;
}

/**
 * 建假宿主：临时 git 仓库 + DSH_HOME 隔离 + 假 ctx，加载真实 index.js。
 * 返回的 host 供本文件的测试用例复用。
 */
export async function createFakeHost(options = {}) {
  if (options.freshFixtures !== false) await setupFixtures();
  else {
    await fs.mkdir(HOME, { recursive: true }).catch(() => {});
  }
  process.env.DSH_HOME = HOME;

  const errors = [];
  const listeners = new Map();      // 主 ctx.on(...)
  const routes = [];
  const created = [];               // 所有创建过的 agent 记录（agents.create / agentLoop.create）
  const agentsById = new Map();
  const toolCalls = [];
  let toolCallSeq = 0;

  const logger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: (...a) => { if (options.verbose) console.error('[host]', ...a); },
    log: () => {},
  };

  const host = {
    options,
    REPO, PLAIN, HOME, REMOTE, WS_REPO, WS_PLAIN,
    errors,
    listeners,
    routes,
    created,
    toolCalls,
    logger,
    autoTurnEnd: options.autoTurnEnd !== false,
    turnEndDelay: options.turnEndDelay || 0,
    startedAt: Date.now(),
  };

  // ---- 根级 tools 服务：index.js 在 apply 时通过 ctx.get('tools') 注册根工具 create_task_card ----
  const rootTools = {
    registrations: [],
    register(def, opts) {
      if (def && def.name) rootTools.registrations.push({ def, opts });
      return () => {};
    },
  };
  host.rootTools = rootTools;

  const workspaces = [
    { id: WS_REPO, workspaceId: WS_REPO, title: 'Fixture Repo', path: REPO, sessionIds: [] },
    { id: WS_PLAIN, workspaceId: WS_PLAIN, title: 'Fixture Plain', path: PLAIN, sessionIds: [] },
  ];
  // 工具按 sessionId 回退归属工作区的分支（契约：registry.list() 的 sessionIds）。
  host.mapSessionToWorkspace = (workspaceId, sessionId) => {
    const target = workspaces.find((w) => String(w.id) === String(workspaceId));
    if (!target) throw new Error('mapSessionToWorkspace: 未知工作区 ' + workspaceId);
    target.sessionIds.push(String(sessionId));
    return target;
  };

  // ---- session projections（token 用量） ----
  const projections = {
    behavior: 'ok', // ok | throw
    calls: 0,
    snapshot(session, keys) {
      projections.calls += 1;
      if (projections.behavior === 'throw') throw new Error('sessionProjections unavailable (fixture)');
      return {
        values: {
          tokenUsage: {
            totals: { input: 1234, output: 567, total: 1801, cached: 0 },
          },
        },
      };
    },
  };
  host.projections = projections;

  // ---- 主 ctx ----
  const ctx = {
    effect(fn) {
      let d;
      try { d = fn(); } catch (e) { errors.push(e); }
      return typeof d === 'function' ? d : () => {};
    },
    on(event, cb) {
      if (typeof cb !== 'function') return () => {};
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(cb);
      return () => {
        const arr = listeners.get(event);
        if (!arr) return;
        const i = arr.indexOf(cb);
        if (i >= 0) arr.splice(i, 1);
      };
    },
    emit(event, ...args) {
      for (const cb of listeners.get(event) || []) {
        try { cb(...args); } catch (e) { errors.push(e); }
      }
    },
    get(name) {
      if (name === 'agents') return agentsService;
      if (name === 'agentLoop') return legacyLoop;
      if (name === 'sessionProjections') return projections;
      if (name === 'forgeSession') return host.forgeSession;
      if (name === 'tools') return rootTools;
      if (name === 'logger') return logger;
      if (name === 'webServer') return webServer;
      if (name === 'workspaceRegistry') return workspaceRegistry;
      if (name === 'sessions') return undefined;
      if (name === 'homePaths') return undefined;
      return undefined;
    },
    logger,
    webServer: null,
    workspaceRegistry: null,
  };

  const webServer = {
    register(route) {
      if (route && typeof route.handler === 'function') {
        routes.push({ kind: route.kind || 'prefix', path: route.path, handler: route.handler });
      }
      return () => {
        const i = routes.findIndex((r) => r.handler === (route && route.handler));
        if (i >= 0) routes.splice(i, 1);
      };
    },
  };
  const workspaceRegistry = {
    list() { return workspaces.map((w) => ({ ...w })); },
    get(id) { return workspaces.find((w) => String(w.id) === String(id)) || undefined; },
  };
  ctx.webServer = webServer;
  ctx.workspaceRegistry = workspaceRegistry;

  // ---- fake agent turn / idle 机制 ----
  function emitSessionEvent(session, event) {
    for (const cb of listeners.get('session/event') || []) {
      try { cb(session, event); } catch (e) { errors.push(e); }
    }
  }

  function finishTurn(agent) {
    if (!agent || agent.status === 'idle') {
      if (agent) agent.status = 'idle';
      return;
    }
    agent.status = 'idle';
    agent.turnSeq = (agent.turnSeq || 0) + 1;
    const waiters = agent.idleWaiters.splice(0);
    for (const r of waiters) { try { r(); } catch (e) { /* noop */ } }
    emitSessionEvent(agent.session, {
      type: 'turn/end',
      data: { turn: agent.turnSeq, reason: { kind: 'completed' } },
    });
    if (typeof agent.ctx._onIdle === 'function') {
      try { agent.ctx._onIdle(agent); } catch (e) { errors.push(e); }
    }
  }

  function buildAgent({ id, meta, options: agentOptions, source }) {
    const sessionEvents = [];
    const tools = new Map();
    const agentCtxListeners = new Map();
    const agent = {
      id,
      status: 'idle',
      options: agentOptions || {},
      meta: meta || {},
      source,
      tools,
      session: {
        id,
        append(type, data) {
          const ev = { type, data, seq: sessionEvents.length + 1 };
          sessionEvents.push(ev);
          return ev;
        },
        snapshotEvents() { return sessionEvents.slice(); },
        events: sessionEvents,
      },
      followups: [],
      cancels: [],
      turnSeq: 0,
      idleWaiters: [],
      disposed: false,
      ctx: null,
    };
    agent.whenIdle = () => (agent.status === 'idle'
      ? Promise.resolve()
      : new Promise((resolve) => agent.idleWaiters.push(resolve)));
    agent.followup = (msg) => {
      agent.followups.push(msg);
      agent.status = 'running';
      const isReview = tools.has('review_verdict');
      // 评审会话的 turn 由 review_verdict / request_input 收尾；执行会话按 autoTurnEnd 自动收尾。
      if (!isReview && host.autoTurnEnd) {
        const delay = host.turnEndDelay || 0;
        setTimeout(() => finishTurn(agent), delay);
      }
    };
    agent.cancel = (cause) => {
      agent.cancels.push(cause);
      agent.status = 'idle';
      const waiters = agent.idleWaiters.splice(0);
      for (const r of waiters) r();
    };
    agent.ctx = {
      tools: {
        register(def) {
          if (def && def.name) tools.set(def.name, def);
          return () => tools.delete(def && def.name);
        },
        restrict(filter) {
          agent.restricted = filter;
          return () => { agent.restricted = null; };
        },
        unregister(name) { tools.delete(name); },
      },
      systemPrompt: {
        section(...args) {
          agent.systemPromptSections = agent.systemPromptSections || [];
          agent.systemPromptSections.push(args);
          return () => {};
        },
      },
      on(event, cb) {
        if (typeof cb !== 'function') return () => {};
        if (!agentCtxListeners.has(event)) agentCtxListeners.set(event, []);
        agentCtxListeners.get(event).push(cb);
        return () => {
          const arr = agentCtxListeners.get(event);
          if (!arr) return;
          const i = arr.indexOf(cb);
          if (i >= 0) arr.splice(i, 1);
        };
      },
      emit(event, ...args) {
        for (const cb of agentCtxListeners.get(event) || []) {
          try { cb(...args); } catch (e) { errors.push(e); }
        }
      },
      listeners: agentCtxListeners,
      get(name) { return ctx.get(name); },
      effect(fn) { try { const d = fn(); return typeof d === 'function' ? d : () => {}; } catch (e) { errors.push(e); return () => {}; } },
    };
    return agent;
  }

  function registerAgent(agent, record) {
    agent._record = record;
    if (!agent.disposed) agentsById.set(agent.id, agent);
    created.push(record);
    if (typeof host.onAgentCreated === 'function') {
      try { host.onAgentCreated(record); } catch (e) { errors.push(e); }
    }
    return agent;
  }

  async function makeAgentRecord({ source, id, meta, agentOptions, setup, signal }) {
    const agent = buildAgent({ id, meta, options: agentOptions, source });
    const record = {
      source, id, meta, agentOptions: agentOptions || {}, agent,
      tools: agent.tools,
      at: Date.now(),
      disposed: false,
      setupRan: false,
    };
    if (typeof setup === 'function') {
      await setup(agent.ctx, agent);
      record.setupRan = true;
    }
    registerAgent(agent, record);
    const dispose = () => {
      agent.disposed = true;
      record.disposed = true;
      record.disposedAt = Date.now();
      agentsById.delete(agent.id);
      agent.status = 'idle';
      const waiters = agent.idleWaiters.splice(0);
      for (const r of waiters) r();
    };
    record.dispose = dispose;
    record.signal = signal;
    return { agent, dispose };
  }

  // ---- ctx.get('agents')：新路径 ----
  const agentsService = {
    async create({ sessionId, meta, agentOptions, setup, signal } = {}) {
      const id = sessionId || ('agent-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
      return makeAgentRecord({ source: 'agents', id, meta, agentOptions, setup, signal });
    },
    get(id) {
      const a = agentsById.get(String(id));
      return a && !a.disposed ? a : undefined;
    },
    list() { return [...agentsById.values()]; },
  };

  // ---- ctx.get('agentLoop')：旧降级路径 ----
  const legacyLoop = {
    created: [],
    async create(sessionId, options2 = {}, meta = {}) {
      const id = sessionId || ('loop-' + Date.now().toString(36));
      const agent = buildAgent({ id, meta, options: options2, source: 'loop' });
      const record = {
        source: 'loop', id, meta, agentOptions: options2, agent,
        tools: agent.tools, at: Date.now(), disposed: false, setupRan: false,
        dispose: () => { agent.disposed = true; record.disposed = true; },
      };
      registerAgent(agent, record);
      return agent;
    },
  };

  // ---- 路由分发 ----
  function routeFor(pathname) {
    for (const r of routes) {
      if (r.kind === 'prefix') {
        if (pathname === r.path || pathname.startsWith(r.path + '/')) return r;
      } else if (r.path === pathname) return r;
    }
    return null;
  }

  host.handleRequest = (req, res) => {
    let pathname;
    try { pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname; }
    catch (e) { pathname = String(req.url || '/').split('?')[0]; }
    const route = routeFor(pathname);
    if (!route) {
      res.statusCode = 404;
      try { res.setHeader('content-type', 'application/json; charset=utf-8'); } catch (e) { }
      res.end(JSON.stringify({ ok: false, error: 'not found (no route)', path: pathname }));
      return;
    }
    return route.handler(req, res);
  };

  async function call(method, subpath, body, opts = {}) {
    const methodU = String(method || 'GET').toUpperCase();
    const url = subpath.startsWith(ROUTE_PREFIX) ? subpath : ROUTE_PREFIX + subpath;
    const pathname = url.split('?')[0];
    const route = routeFor(pathname);
    if (!route) {
      return { status: 404, headers: {}, text: '', json: null, routeMissing: true };
    }
    const payload = body === undefined || body === null
      ? ''
      : (typeof body === 'string' ? body : JSON.stringify(body));
    let ended = false;
    let resRef;
    const endPromise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!ended) { ended = true; resolve({ timeout: true }); }
      }, opts.timeout || 20000);
      resRef = makeRes(() => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        resolve({});
      });
    });
    const res = resRef;
    const req = makeReq(methodU, url, payload);
    let handlerError = null;
    const hop = Promise.resolve()
      .then(() => route.handler(req, res))
      .catch((e) => {
        handlerError = e;
        if (!res.finished) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
        }
      });
    await hop;
    await endPromise;
    await sleep(0);
    const text = Buffer.concat(res.chunks).toString('utf8');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* 保留原文 */ }
    return {
      status: res.statusCode,
      headers: res.headers,
      text,
      json,
      handlerError: handlerError ? String(handlerError.stack || handlerError.message || handlerError) : null,
    };
  }
  host.call = call;

  // ---- 测试辅助 ----
  host.getBoard = async (workspaceId = WS_REPO) => {
    const r = await call('GET', '/board?workspaceId=' + encodeURIComponent(workspaceId));
    return { res: r, board: r.json && r.json.board };
  };
  host.card = async (taskId, workspaceId = WS_REPO) => {
    const { board } = await host.getBoard(workspaceId);
    return board && Array.isArray(board.cards) ? board.cards.find((c) => c.id === taskId) : undefined;
  };
  host.putBoardRaw = (body) => call('PUT', '/board', body);
  host.updateBoard = async (mutator, workspaceId = WS_REPO) => {
    const { board } = await host.getBoard(workspaceId);
    const next = board ? JSON.parse(JSON.stringify(board)) : { version: 3, cards: [] };
    if (!Array.isArray(next.cards)) next.cards = [];
    mutator(next);
    const expectedRevision = board && Number.isFinite(board.revision) ? board.revision : 0;
    return call('PUT', '/board', { workspaceId, expectedRevision, board: next });
  };
  host.start = (taskId, workspaceId = WS_REPO) => call('POST', '/start', { workspaceId, taskId });
  host.action = (taskId, action, payload, workspaceId = WS_REPO) => call('POST', '/action', {
    workspaceId, taskId, action, payload, expectedRevision: undefined,
  });
  host.patch = (taskId, workspaceId = WS_REPO) => call('GET', '/patch?workspaceId=' + encodeURIComponent(workspaceId) + '&taskId=' + encodeURIComponent(taskId));
  host.auditLines = async (workspaceId = WS_REPO) => {
    const file = path.join(HOME, 'task-board', workspaceId + '.audit.jsonl');
    try {
      const raw = await fs.readFile(file, 'utf8');
      return raw.split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch (e) { return { __parseError: line }; }
      });
    } catch (e) { return []; }
  };
  host.worktreeList = async () => {
    const r = await git(['worktree', 'list', '--porcelain'], REPO);
    return r.stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice('worktree '.length).trim());
  };
  host.commitInWorktree = async (wtPath, relFile, content, message = '任务改动') => {
    const abs = path.join(wtPath, relFile);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    const add = await git(['add', '-A'], wtPath);
    const commit = await git(['commit', '-m', message], wtPath);
    return { add, commit };
  };

  host.waitFor = async (predicate, label, timeout = 6000) => {
    const start = Date.now();
    let lastError;
    while (Date.now() - start < timeout) {
      try {
        const v = await predicate();
        if (v) return v;
      } catch (e) { lastError = e; }
      await sleep(15);
    }
    throw new Error('等待超时: ' + label + (lastError ? '（最后错误: ' + (lastError.message || lastError) + '）' : ''));
  };
  host.waitCardStatus = (taskId, statuses, label, timeout = 8000) => {
    const want = Array.isArray(statuses) ? statuses : [statuses];
    return host.waitFor(async () => {
      const c = await host.card(taskId);
      return c && want.includes(c.status) ? c : null;
    }, label || ('卡 ' + taskId + ' 进入状态 ' + want.join('/')), timeout);
  };

  // ---- 假 agent 生命周期控制 ----
  host.turnEnd = (agentOrId) => {
    const agent = typeof agentOrId === 'string'
      ? (agentsById.get(agentOrId) || created.map((r) => r.agent).find((a) => a.id === agentOrId))
      : agentOrId;
    if (!agent) throw new Error('turnEnd: 找不到 agent ' + agentOrId);
    finishTurn(agent);
    return agent;
  };
  host.finishTurn = host.turnEnd;
  host.callTool = async (agent, name, args = {}, opts = {}) => {
    if (!agent) throw new Error('callTool: agent 为空');
    const def = agent.tools instanceof Map ? agent.tools.get(name) : undefined;
    if (!def) {
      throw new Error('callTool: agent ' + agent.id + ' 未注册工具 ' + name +
        '（已注册: ' + [...(agent.tools ? agent.tools.keys() : [])].join(', ') + '）');
    }
    const callId = 'testcall-' + (++toolCallSeq);
    const exec = {
      callId,
      agent,
      signal: new AbortController().signal,
      deferContext: () => {},
      concludeTurn: () => { exec.concluded = true; },
    };
    const result = await def.execute(args, exec);
    toolCalls.push({ agentId: agent.id, name, args, result, exec, at: Date.now() });
    // 模型在调用提交/评审工具后结束本回合。
    if (['submit_for_review', 'review_verdict', 'request_input'].includes(name) && opts.keepTurn !== true) {
      finishTurn(agent);
    }
    return result;
  };
  host.agentsWithTool = (name) => created
    .filter((r) => r.tools && r.tools.has(name))
    .map((r) => r.agent);
  host.executeAgentRecords = () => created.filter((r) => r.tools && r.tools.has('submit_for_review'));
  host.reviewAgentRecords = () => created.filter((r) => r.tools && r.tools.has('review_verdict'));
  host.nextReviewAgent = async (afterCount = 0, label = '新的评审 agent') => {
    await host.waitFor(() => created.filter((r) => r.tools && r.tools.has('review_verdict')).length > afterCount,
      label, 12000);
    const arr = created.filter((r) => r.tools && r.tools.has('review_verdict'));
    return arr[arr.length - 1].agent;
  };

  // ---- 启动真实插件 ----
  const stat = await fs.stat(INDEX_FILE);
  const mod = await import(pathToFileURL(INDEX_FILE).href + '?v=' + stat.mtimeMs + '-' + Math.random().toString(36).slice(2, 6));
  host.module = mod;
  if (typeof mod.apply !== 'function') throw new Error('index.js 未导出 apply(ctx)');
  await mod.apply(ctx);
  await host.waitFor(() => routes.length > 0, 'index.js 注册 /task-board-api 路由', 8000);
  host.indexMtime = stat.mtimeMs;
  host.indexSize = stat.size;
  return host;
}

// ---------------------------------------------------------------- assertions

class AssertionError extends Error {}

function assert(cond, message) {
  if (!cond) throw new AssertionError(message || '断言失败');
}
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionError((message || '值不相等') + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}
function assertMatch(actual, re, message) {
  if (!re.test(String(actual))) {
    throw new AssertionError((message || '正则不匹配') + '：期望匹配 ' + re + '，实际 ' + JSON.stringify(actual));
  }
}
async function assertEventually(predicate, message, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await sleep(15);
  }
  throw new AssertionError(message || '条件最终未满足');
}

const shorten = (v, n = 400) => {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch (e) { s = String(v); }
  if (s == null) return String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

// ---------------------------------------------------------------- 测试用例

async function runTests(host) {
  const WS = WS_REPO;
  const results = [];
  let boardTaskSeq = 0;
  let rootToolCallSeq = 0;

  function makeCard(title, overrides = {}) {
    boardTaskSeq += 1;
    return {
      id: 't-' + boardTaskSeq,
      title: title || ('任务 ' + boardTaskSeq),
      description: '测试任务描述',
      acceptance: '测试通过，行为符合契约',
      labels: [],
      priority: 'normal',
      executor: '',
      reviewer: '',
      base: { mode: 'head', ignoreDirty: false },
      ...overrides,
    };
  }

  async function addCard(card) {
    const r = await host.updateBoard((board) => { board.cards.push(card); });
    return r;
  }

  // ---- create_task_card（根级工具）辅助 ----
  function rootToolRegistrations(name) {
    return host.rootTools.registrations.filter((entry) => entry.def && entry.def.name === name);
  }
  function rootToolDef(name) {
    const hits = rootToolRegistrations(name);
    assertEqual(hits.length, 1, '根级工具 ' + name + ' 应恰好注册一次，实际 ' + hits.length +
      '（已注册: ' + [...host.rootTools.registrations.map((x) => x.def && x.def.name)].join(', ') + '）');
    return hits[0];
  }
  function callCreateCard(args, session = {}) {
    const { def } = rootToolDef('create_task_card');
    const sessionId = session.sessionId || 'sess-ai-1';
    const cwd = session.cwd === undefined ? REPO : session.cwd;
    const exec = {
      callId: 'root-call-' + (++rootToolCallSeq),
      agent: { id: sessionId, session: { id: sessionId, header: cwd ? { cwd } : {} } },
      signal: new AbortController().signal,
      deferContext: () => {},
      concludeTurn: () => { exec.concluded = true; },
    };
    return def.execute(args, exec);
  }
  async function rejectReason(promise) {
    try {
      const value = await promise;
      return { unexpected: value };
    } catch (e) {
      return e || new Error('reject 但错误对象为空');
    }
  }

  async function test(name, fn) {
    const started = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - started });
      console.log('PASS  ' + name + '  (' + (Date.now() - started) + 'ms)');
    } catch (e) {
      const detail = e && e.stack ? e.stack : String(e);
      results.push({ name, ok: false, ms: Date.now() - started, detail });
      console.log('FAIL  ' + name + '  (' + (Date.now() - started) + 'ms)');
      console.log('      ' + String(e && e.message || e).split('\n').join('\n      '));
    }
  }

  // 1. health
  await test('health', async () => {
    const r = await host.call('GET', '/health');
    assertEqual(r.status, 200, 'GET /health 状态码');
    assert(r.json && r.json.ok === true, '健康响应 ok:true，实际 ' + shorten(r.text));
    assert(typeof r.json.pid === 'number', 'pid 应为数字，实际 ' + shorten(r.json.pid));
    assert(typeof r.json.time === 'number', 'time 应为数字，实际 ' + shorten(r.json.time));
  });

  // 2. workspaces
  await test('workspaces', async () => {
    const r = await host.call('GET', '/workspaces');
    assertEqual(r.status, 200, 'GET /workspaces 状态码');
    assert(r.json && r.json.ok === true, 'workspaces ok:true');
    assert(Array.isArray(r.json.workspaces), 'workspaces 应为数组，实际 ' + shorten(r.json));
    const ws = r.json.workspaces.find((w) => String(w.id) === WS);
    assert(ws, '应包含已注册工作区 ' + WS + '，实际 ' + shorten(r.json.workspaces));
    assertEqual(path.resolve(ws.path), path.resolve(REPO), '工作区 path');
    assert(ws.title, '工作区应有 title');
  });

  // 3. git
  await test('git 探测：仓库 / 非仓库 / 越权路径', async () => {
    const r = await host.call('GET', '/git?path=' + encodeURIComponent(REPO));
    assertEqual(r.status, 200, 'GET /git 状态码');
    assert(r.json && r.json.ok === true, 'git ok:true，实际 ' + shorten(r.text));
    assertEqual(r.json.isRepo, true, 'isRepo');
    assertEqual(path.resolve(r.json.root), path.resolve(REPO), 'root');
    assertEqual(r.json.hasHead, true, 'hasHead');
    assertEqual(r.json.dirty, false, 'dirty（fixture 应为干净仓库）');
    assertEqual(r.json.hasRemote, true, 'hasRemote（fixture 配了 origin）');
    assert(r.json.branch === 'main', 'branch 应为 main，实际 ' + shorten(r.json.branch));
    assert(r.json.isLinkedWorktree !== true, '主仓库不应被判定为 linked worktree');

    const plain = await host.call('GET', '/git?path=' + encodeURIComponent(PLAIN));
    assertEqual(plain.status, 200, '非仓库也应 200');
    assert(plain.json && plain.json.ok === true, '非仓库 ok:true');
    assertEqual(plain.json.isRepo, false, '非仓库 isRepo:false');

    const outside = await host.call('GET', '/git?path=' + encodeURIComponent(os.tmpdir()));
    assertEqual(outside.status, 403, '工作区外路径应 403');
    assert(outside.json && outside.json.ok === false, '越权应为 ok:false');
  });

  // 4. board null
  await test('board 不存在返回 null', async () => {
    const r = await host.call('GET', '/board?workspaceId=' + WS);
    assertEqual(r.status, 200, 'GET /board 状态码');
    assert(r.json && r.json.ok === true, 'board ok:true');
    assertEqual(r.json.board, null, '新工作区 board 应为 null，实际 ' + shorten(r.json));
  });

  // 5. PUT 建板 / revision / CAS
  await test('PUT 建板 + revision 递增 + expectedRevision 冲突 409', async () => {
    const cardA = makeCard('板卡 A');
    const first = await host.putBoardRaw({
      workspaceId: WS, expectedRevision: 0,
      board: { version: 3, cards: [cardA] },
    });
    assertEqual(first.status, 200, '首次 PUT 状态码');
    assert(first.json && first.json.ok === true, '首次 PUT ok:true，实际 ' + shorten(first.text));
    assert(first.json.board, '首次 PUT 应返回 board，实际 ' + shorten(first.json));
    assertEqual(first.json.board.revision, 1, '首次 PUT 后 revision 应为 1');
    assertEqual(first.json.board.seq, 1, '首次 PUT 后 seq 应为 1');
    assert(first.json.board.cards.some((c) => c.id === cardA.id), '新板应含 cardA');
    const created2 = first.json.board.cards.find((c) => c.id === cardA.id);
    assertEqual(created2.status || 'todo', 'todo', '新卡默认状态');

    const cardB = makeCard('板卡 B');
    const board2 = JSON.parse(JSON.stringify(first.json.board));
    board2.cards.push(cardB);
    const second = await host.putBoardRaw({ workspaceId: WS, expectedRevision: 1, board: board2 });
    assertEqual(second.status, 200, '第二次 PUT 状态码');
    assert(second.json && second.json.ok === true, '第二次 PUT ok:true，实际 ' + shorten(second.text));
    assertEqual(second.json.board.revision, 2, '第二次 PUT 后 revision 应为 2');
    assertEqual(second.json.board.seq, 2, '第二次 PUT 后 seq 应为 2');

    const stale = await host.putBoardRaw({ workspaceId: WS, expectedRevision: 0, board: board2 });
    assertEqual(stale.status, 409, '过期 expectedRevision 应 HTTP 409，实际 ' + stale.status);
    assert(stale.json && stale.json.ok === false, '冲突应为 ok:false');
    assertEqual(stale.json.code, 'revision_conflict', '冲突 code');
    assert(stale.json.board, '冲突响应应同时返回最新 board');
    assertEqual(stale.json.board.revision, 2, '冲突响应 board.revision 应为最新值');
  });

  // 6. start 缺验收
  await test('start 缺验收返回 missing_acceptance', async () => {
    const card = makeCard('缺验收任务', { acceptance: '' });
    await addCard(card);
    const r = await host.start(card.id);
    assertEqual(r.status, 200, '业务失败应 HTTP 200');
    assert(r.json && r.json.ok === false, '缺验收应 ok:false，实际 ' + shorten(r.text));
    assertEqual(r.json.code, 'missing_acceptance', '错误 code');
    const c = await host.card(card.id);
    assert(c, '卡应仍在板上');
    assertEqual(c.status, 'todo', '缺验收失败后状态应保持 todo');
  });

  // 7. start 成功建 worktree
  let execCard;
  let execAgent;
  let worktreePath;
  await test('start 成功：worktree + Run + 执行 agent + 审计', async () => {
    execCard = makeCard('执行任务', { description: '把 src/app.txt 改成 hello world' });
    await addCard(execCard);
    host.autoTurnEnd = false;
    const before = await host.getBoard();
    const beforeRev = before.board.revision;
    const r = await host.start(execCard.id);
    assertEqual(r.status, 200, 'start 状态码');
    assert(r.json && r.json.ok === true, 'start 应 ok:true，实际 ' + shorten(r.text));
    const card = await host.card(execCard.id);
    assert(card, 'start 后卡应存在');
    assert(['queued', 'worktree_preparing', 'running'].includes(card.status),
      'start 后状态应为 queued/worktree_preparing/running，实际 ' + card.status);
    assert(card.runs && card.runs.length >= 1, '应记录 Run，实际 ' + shorten(card.runs));
    const run = card.runs[card.runs.length - 1];
    assertEqual(run.kind, 'execute', 'Run.kind');
    assertEqual(run.status, 'running', 'Run.status');
    assert(run.sessionId, 'Run 应有 sessionId');
    assert(run.worktree && run.worktree.path, 'Run 应记录 worktree');
    worktreePath = run.worktree.path;
    const st = await fs.stat(worktreePath).catch(() => null);
    assert(st && st.isDirectory(), 'worktree 目录应真实存在: ' + worktreePath);
    const wts = await host.worktreeList();
    assert(wts.some((w) => path.resolve(w) === path.resolve(worktreePath)),
      'git worktree list 应包含 ' + worktreePath + '，实际 ' + shorten(wts));
    assert((await host.getBoard()).board.revision > beforeRev, 'start 应递增 revision');

    const rec = host.created.find((x) => x.agent && x.agent.id === run.sessionId);
    assert(rec, '应通过 agents.create 或 agentLoop.create 建出执行 agent（sessionId=' + run.sessionId + '），实际 created=' +
      shorten(host.created.map((x) => ({ source: x.source, id: x.id }))));
    execAgent = rec.agent;
    assertEqual(path.resolve(rec.meta && rec.meta.cwd || ''), path.resolve(worktreePath), 'agent meta.cwd 应为 worktree');
    assert(execAgent.followups.length >= 1, '执行 agent 应收到 followup 任务 prompt');
    assert(JSON.stringify(execAgent.followups[0]).includes('执行任务'), 'followup 应包含任务标题');
    assert(execAgent.tools.has('submit_for_review'), '执行会话应注册 submit_for_review 工具，实际已注册: ' + [...execAgent.tools.keys()].join(','));
    const execAudit = await host.auditLines();
    assert(execAudit.some((l) => l && l.taskId === execCard.id), '审计应记录 start（taskId=' + execCard.id + '）');
    host._execCard = card;
  });

  // 8. 重复 start 复用
  await test('重复 start 复用 worktree 不失败', async () => {
    const before = await host.worktreeList();
    const r = await host.start(execCard.id);
    assertEqual(r.status, 200, '重复 start 状态码');
    assert(r.json && r.json.ok === true, '重复 start 应 ok:true（复用 worktree），实际 ' + shorten(r.text));
    const after = await host.worktreeList();
    const mineBefore = before.filter((w) => w.includes('t-') || w.includes('task-'));
    assertEqual(after.length, before.length, '不应新增 worktree');
    const card = await host.card(execCard.id);
    assertEqual(card.runs.length, 1, '不应重复记账 Run');
    void mineBefore;
  });

  // 9. turn/end → awaiting_review → 评审 agent
  let reviewAgent;
  await test('执行 turn/end → awaiting_review → 起评审 agent（只读）', async () => {
    const reviewBefore = host.reviewAgentRecords().length;
    host.turnEnd(execAgent);
    const card = await host.waitCardStatus(execCard.id, ['awaiting_review', 'reviewing'], '执行结束后进入等待评审/评审中');
    assert(['awaiting_review', 'reviewing'].includes(card.status), '状态应为 awaiting_review 或 reviewing，实际 ' + card.status);
    reviewAgent = await host.nextReviewAgent(reviewBefore, '起评审 agent');
    assert(reviewAgent, '应创建评审 agent');
    const rec = host.reviewAgentRecords().find((r) => r.agent === reviewAgent);
    assert(rec, '评审 agent 应有创建记录');
    await host.waitFor(() => rec.agent.followups.length > 0, '评审 agent 收到评审 prompt', 8000);
    assert(rec.agent.id !== execAgent.id, '评审会话应是新会话');
    assertEqual(path.resolve(rec.meta && rec.meta.cwd || ''), path.resolve(worktreePath), '评审 agent cwd 应为 worktree');
    assertEqual(JSON.stringify(rec.agent.meta && rec.agent.meta.cwd || ''), JSON.stringify(worktreePath), '评审 agent meta.cwd');
    const appendTypes = rec.agent.session.events.map((e) => e.type + ':' + JSON.stringify(e.data || {}));
    assert(appendTypes.some((t) => /sandbox\/mode/.test(t) && /read-only/.test(t)),
      '评审会话应 append sandbox/mode=read-only，实际 ' + shorten(appendTypes));
    assert(JSON.stringify(appendTypes).includes('approval/policy'), '评审会话应 append approval/policy');
    assert(rec.agent.restricted && Array.isArray(rec.agent.restricted.allow) && rec.agent.restricted.allow.includes('read'),
      '评审应调用 tools.restrict 限制为只读工具，实际 ' + shorten(rec.agent.restricted));
    assert(rec.agent.ctx.listeners.has('tools/pre-execute') && rec.agent.ctx.listeners.get('tools/pre-execute').length > 0,
      '评审应在 agentCtx 上注册 tools/pre-execute 拦截');
    assert(rec.agent.followups.length >= 1, '评审 agent 应收到评审 prompt');
    const promptText = JSON.stringify(rec.agent.followups[0]);
    assert(promptText.includes('执行任务') || promptText.includes('验收'), '评审 prompt 应含任务/验收信息');
    const refreshed = await host.card(execCard.id);
    assertEqual(refreshed.status, 'reviewing', '评审启动后主卡应为 reviewing');
    assertEqual(refreshed.round, 1, '首轮执行 round 应为 1');
  });

  // 10. 评审 pass + 交付物
  await test('评审 pass → awaiting_signoff + 本地交付物 + Run/Review 落账', async () => {
    await host.commitInWorktree(worktreePath, 'src/feature.txt', 'feature from fake agent\n');
    const r = await host.callTool(reviewAgent, 'review_verdict', {
      verdict: 'pass', mustFix: [], nits: [], evidence: ['npm test 通过（假）'],
    });
    void r;
    const card = await host.waitCardStatus(execCard.id, ['awaiting_signoff'], '评审通过后进入待签收');
    assertEqual(card.status, 'awaiting_signoff', '状态');
    assertEqual(card.reviews.length, 1, '应有 1 条 Review，实际 ' + card.reviews.length);
    const review = card.reviews[0];
    assertEqual(review.verdict, 'pass', 'Review.verdict');
    assert(review.reviewerModel != null, 'Review.reviewerModel 应记录');
    assert(review.sessionId, 'Review.sessionId 应记录');
    assertEqual(review.round, 1, 'Review.round');
    assert(card.delivery, '应有 delivery（本地变更集），实际 ' + shorten(card.delivery));
    assertEqual(card.delivery.mode, 'local', 'delivery.mode');
    assertEqual(card.delivery.branch, (card.runs[0].worktree || {}).branch, 'delivery.branch 应与 worktree 分支一致');
    assert(card.delivery.baseCommit, 'delivery.baseCommit 应有值');
    assert(card.delivery.diffStat, 'delivery.diffStat 应非空');
    assertEqual(card.delivery.patchAvailable, true, 'delivery.patchAvailable');
    const execRun = card.runs.find((x) => x.kind === 'execute');
    assertEqual(execRun.status, 'done', '执行 Run 应 done');
    assert(execRun.endedAt != null, '执行 Run 应有 endedAt');
    assert(execRun.summary, '执行 Run 应记录 summary');
    const audit = await host.auditLines();
    assert(audit.some((l) => l && l.taskId === execCard.id && ['review', 'verdict', 'submit_for_review'].some((a) => String(l.action).includes(a))),
      '审计应有评审/提交记录，实际 actions=' + shorten(audit.map((l) => l && l.action)).slice(0, 600));
  });

  // 11. patch
  await test('patch 返回 diff 文本 + diffStat', async () => {
    const r = await host.patch(execCard.id);
    assertEqual(r.status, 200, 'GET /patch 状态码');
    assert(r.json && r.json.ok === true, 'patch ok:true，实际 ' + shorten(r.text));
    assert(typeof r.json.patch === 'string' && r.json.patch.includes('feature.txt'),
      'patch 文本应包含改动文件 feature.txt，实际 ' + shorten(r.json.patch));
    assert(r.json.diffStat, 'patch 应返回 diffStat');
    const missing = await host.patch('t-no-such-task');
    assert(missing.json && missing.json.ok === false, '无交付物任务 patch 应 ok:false');
    assertEqual(missing.json.code, 'not_ready', '无交付物 code 应为 not_ready，实际 ' + shorten(missing.json));
  });

  // 12. signoff → done
  await test('signoff → done + signoff 字段 + 审计行', async () => {
    const r = await host.action(execCard.id, 'signoff', { note: '人工确认通过' });
    assertEqual(r.status, 200, 'signoff 状态码');
    assert(r.json && r.json.ok === true, 'signoff 应 ok:true，实际 ' + shorten(r.text));
    const card = await host.card(execCard.id);
    assertEqual(card.status, 'done', '签字后状态 done');
    assert(card.signoff, '应写 signoff，实际 ' + shorten(card.signoff));
    assert(card.signoff.by != null, 'signoff.by 应有值');
    assert(card.signoff.at != null, 'signoff.at 应有值');
    assertEqual(card.signoff.note, '人工确认通过', 'signoff.note');
    const audit = await host.auditLines();
    const line = audit.find((l) => l && l.taskId === execCard.id && String(l.action).includes('signoff'));
    assert(line, '审计应含 signoff 行，实际 actions=' + shorten(audit.map((l) => l && l.action)));
    assertEqual(String(line.to), 'done', '审计 to 应为 done');
    assert(line.actor, '审计应有 actor');
    assert(line.ts, '审计应有 ts');
  });

  // 13. reject 流
  await test('reject → changes_requested → running（round+1，意见进 followup）', async () => {
    host.autoTurnEnd = true;
    const card = makeCard('签收打回任务');
    await addCard(card);
    const beforeReviews = host.reviewAgentRecords().length;
    const start = await host.start(card.id);
    assert(start.json && start.json.ok === true, 'start 成功，实际 ' + shorten(start.text));
    const agent1 = await host.nextReviewAgent(beforeReviews, '打回用例：评审 agent 1');
    const rejectCardRun = [...(await host.card(card.id)).runs].reverse().find((run) => run.kind === 'execute' && run.worktree && run.worktree.path);
    assert(rejectCardRun, '打回用例应有执行工作树');
    await host.commitInWorktree(rejectCardRun.worktree.path, 'src/reject-case.txt', 'reject case\n');
    await host.callTool(agent1, 'review_verdict', { verdict: 'pass', mustFix: [], nits: [], evidence: ['已运行验证并通过（假）'] });
    await host.waitCardStatus(card.id, ['awaiting_signoff'], '打回用例：进入待签收');
    const before = await host.card(card.id);
    const execRec = host.executeAgentRecords().find((r) => r.agent.id === before.runs[0].sessionId);
    const followupsBefore = execRec ? execRec.agent.followups.length : 0;
    const reject = await host.action(card.id, 'reject', { note: '请补充单元测试' });
    assertEqual(reject.status, 200, 'reject 状态码');
    assert(reject.json && reject.json.ok === true, 'reject 应 ok:true，实际 ' + shorten(reject.text));
    const after = await host.waitCardStatus(card.id, ['changes_requested', 'running'], '打回后回到返工/执行');
    assert(['changes_requested', 'running'].includes(after.status), '打回后状态');
    assertEqual(after.round, before.round + 1, '打回后 round 应 +1（before=' + before.round + '）');
    const followupsAfter = execRec ? execRec.agent.followups.length : 0;
    assert(followupsAfter > followupsBefore, '打回意见应 followup 给执行会话');
    assert(JSON.stringify(execRec.agent.followups.slice(followupsBefore)).includes('请补充单元测试'),
      'followup 应携带打回意见，实际 ' + shorten(execRec.agent.followups.slice(followupsBefore)));
    // 收尾，释放并发槽位
    await host.action(card.id, 'cancel');
    await sleep(30);
  });

  // 14. changes 回环 + round 超限
  await test('评审 changes → running + round+1 + followup；round 超限 → blocked', async () => {
    host.autoTurnEnd = true;
    const card = makeCard('返工轮次任务');
    await addCard(card);
    const reviewBase = host.reviewAgentRecords().length;
    const start = await host.start(card.id);
    assert(start.json && start.json.ok === true, 'start 成功，实际 ' + shorten(start.text));
    let agent = await host.nextReviewAgent(reviewBase, 'changes 用例：评审 agent 1');
    let reviewCount = host.reviewAgentRecords().length;
    let rounds = [];
    let blocked = false;
    let beforeRound = (await host.card(card.id)).round;
    for (let i = 0; i < 8; i++) {
      const mustFix = [{ file: 'src/app.txt', line: 1, severity: 'major', issue: '缺少用例 ' + (i + 1), suggestion: '补测试' }];
      const cur = await host.card(card.id);
      if (cur.status === 'blocked') { blocked = true; break; }
      beforeRound = cur.round;
      await host.callTool(agent, 'review_verdict', { verdict: 'changes', mustFix, nits: [] });
      const after = await host.waitFor(async () => {
        const c = await host.card(card.id);
        if (!c) return null;
        if (c.status === 'blocked') return c;
        return c.round > beforeRound && ['changes_requested', 'running', 'reviewing'].includes(c.status) ? c : null;
      }, 'changes 后 round 递增并进入返工/执行/评审');
      if (after.status === 'blocked') { blocked = true; rounds.push(after.round); break; }
      rounds.push(after.round);
      assertEqual(after.round, beforeRound + 1, '第 ' + (i + 1) + ' 次 changes 后 round 应 +1（before=' + beforeRound + '）');
      const execRec = host.executeAgentRecords().find((r) => r.agent.id === after.runs[0].sessionId);
      assert(execRec && execRec.agent.followups.some((f) => JSON.stringify(f).includes('缺少用例 ' + (i + 1))),
        'changes 的 mustFix 应 followup 给执行会话');
      // 执行会话 auto turn end 后 Host 应自动提交并再起评审
      const nextCount = host.reviewAgentRecords().length;
      if (nextCount > reviewCount) {
        agent = host.nextReviewAgent(0, '第 ' + (i + 2) + ' 个评审 agent');
        reviewCount = nextCount;
      } else {
        agent = await host.nextReviewAgent(reviewCount, '期待第 ' + (i + 2) + ' 个评审 agent');
        reviewCount = host.reviewAgentRecords().length;
      }
    }
    const final = await host.card(card.id);
    if (final.status !== 'blocked') blocked = blocked || false;
    assertEqual(final.status, 'blocked', '超过 maxRounds 后应 blocked，实际 ' + final.status + '（rounds=' + shorten(rounds) + '）');
    assert(final.error, 'blocked 时应写 error，实际 ' + shorten(final.error));
    assert(final.round >= 2, 'round 应推进，实际 ' + final.round);
    const board = await host.getBoard();
    void board;
  });

  // 15. cancel + cleanup
  let cancelledCardId = null;
  await test('cancel → cancelled（保留 worktree）→ cleanup 移除 worktree/分支', async () => {
    host.autoTurnEnd = false;
    const card = makeCard('取消任务');
    await addCard(card);
    const start = await host.start(card.id);
    assert(start.json && start.json.ok === true, 'start 成功，实际 ' + shorten(start.text));
    const running = await host.waitCardStatus(card.id, ['running', 'worktree_preparing', 'queued'], '取消用例：进入执行');
    const run = running.runs[running.runs.length - 1];
    const wtPath = run.worktree.path;
    const agentRec = host.created.find((r) => r.agent && r.agent.id === run.sessionId);
    assert(agentRec, '应有执行 agent');
    const cancel = await host.action(card.id, 'cancel');
    assertEqual(cancel.status, 200, 'cancel 状态码');
    assert(cancel.json && cancel.json.ok === true, 'cancel 应 ok:true，实际 ' + shorten(cancel.text));
    const after = await host.card(card.id);
    assertEqual(after.status, 'cancelled', '取消后状态');
    const run2 = after.runs[after.runs.length - 1];
    assertEqual(run2.status, 'cancelled', 'Run 状态应 cancelled');
    assert(agentRec.agent.cancels.length >= 1, '应调用 agent.cancel');
    assertEqual((agentRec.agent.cancels[0] || {}).kind, 'user', 'cancel cause.kind 应为 user');
    const st = await fs.stat(wtPath).catch(() => null);
    assert(st && st.isDirectory(), '取消应保留 worktree');

    const cleanup = await host.action(card.id, 'cleanup');
    assertEqual(cleanup.status, 200, 'cleanup 状态码');
    assert(cleanup.json && cleanup.json.ok === true, 'cleanup 应 ok:true，实际 ' + shorten(cleanup.text));
    await assertEventually(async () => {
      const st2 = await fs.stat(wtPath).catch(() => null);
      const wts = await host.worktreeList();
      return !st2 && !wts.some((w) => path.resolve(w) === path.resolve(wtPath));
    }, 'cleanup 后 worktree 应被移除', 8000);
    const branch = run.worktree.branch;
    const br = await git(['branch', '--list', branch], REPO);
    assert(!br.stdout.trim(), 'cleanup 后分支应删除，实际仍存在: ' + shorten(br.stdout));
    cancelledCardId = card.id;
  });

  // 16. 非法转移
  await test('非法转移返回 invalid_transition', async () => {
    const todoCard = makeCard('非法转移任务');
    await addCard(todoCard);
    const signoff = await host.action(todoCard.id, 'signoff', { note: 'x' });
    assertEqual(signoff.status, 200, '非法 signoff 应 HTTP 200');
    assert(signoff.json && signoff.json.ok === false, '非法 signoff 应 ok:false，实际 ' + shorten(signoff.text));
    assertEqual(signoff.json.code, 'invalid_transition', '非法 signoff code');
    const cleanup = await host.action(todoCard.id, 'cleanup');
    assert(cleanup.json && cleanup.json.ok === false, '非法 cleanup 应失败');
    assertEqual(cleanup.json.code, 'invalid_transition', '非法 cleanup code');
    const restartDone = await host.start(execCard.id);
    assert(restartDone.json && restartDone.json.ok === false, 'done 任务再 start 应失败，实际 ' + shorten(restartDone.text));
    assertEqual(restartDone.json.code, 'invalid_transition', 'done 再 start code');
    const unknownAction = await host.action(todoCard.id, 'no_such_action');
    assert(unknownAction.json && unknownAction.json.ok === false, '未知 action 应失败');
    assert(unknownAction.json.code === 'invalid_transition' || unknownAction.json.code === 'action_failed' ||
      (unknownAction.status === 400 && /unknown action/i.test(unknownAction.json.error || '')),
      '未知 action 应按协议错误返回（400 unknown action 或 code invalid_transition/action_failed），实际 ' + shorten(unknownAction.json));
  });

  // 17. 未知路径 404
  await test('未知路径 404', async () => {
    const r = await host.call('GET', '/definitely-not-a-route');
    assertEqual(r.status, 404, '未知路径状态码');
    assert(r.json && r.json.ok === false, '未知路径 ok:false，实际 ' + shorten(r.text));
    assert(r.json.path, '404 应返回 path');
  });

  // 18. token 投影：正常与抛错
  await test('sessionProjections：正常记录 token 且抛错时降级不崩', async () => {
    host.autoTurnEnd = false;
    const card = makeCard('Token 记录任务');
    await addCard(card);
    const start = await host.start(card.id);
    assert(start.json && start.json.ok === true, '开始成功，实际 ' + shorten(start.text));
    const running = await host.waitCardStatus(card.id, ['running', 'worktree_preparing', 'queued'], 'token 用例进入执行');
    const run = running.runs[running.runs.length - 1];
    const agentRec = host.created.find((r) => r.agent && r.agent.id === run.sessionId);
    assert(agentRec, '应有执行 agent');
    const reviewBefore = host.reviewAgentRecords().length;
    host.turnEnd(agentRec.agent);
    let reviewAgent2;
    try {
      reviewAgent2 = await host.nextReviewAgent(reviewBefore, 'token 用例评审 agent');
    } catch (e) {
      // Host 可能在 turnEnd 处因缺少 submit 直接 blocked；仍检查不崩溃
      const c = await host.card(card.id);
      assert(c.status === 'blocked', '无 token API 时应降级为 blocked 而非崩溃，实际 ' + c.status);
      return;
    }
    const tokenCardRun = [...(await host.card(card.id)).runs].reverse().find((run) => run.kind === 'execute' && run.worktree && run.worktree.path);
    assert(tokenCardRun, 'token 用例应有执行工作树');
    await host.commitInWorktree(tokenCardRun.worktree.path, 'src/token-case.txt', 'token case\n');
    await host.callTool(reviewAgent2, 'review_verdict', { verdict: 'pass', mustFix: [], nits: [], evidence: ['已运行验证并通过（假）'] });
    const c = await host.waitCardStatus(card.id, ['awaiting_signoff'], 'token 正常：进入待签收');
    const runAfter = c.runs.find((x) => x.kind === 'execute');
    assert(runAfter.tokens != null, 'Run 应记录 tokens（sessionProjections 可用时），实际 ' + shorten(runAfter.tokens));

    // 抛错模式：再起一个任务，不崩、能推进
    host.projections.behavior = 'throw';
    const card2 = makeCard('Token 抛错降级任务');
    await addCard(card2);
    const s2 = await host.start(card2.id);
    assert(s2.json && s2.json.ok === true, 'projections 抛错时 start 仍应成功，实际 ' + shorten(s2.text));
    const running2 = await host.waitCardStatus(card2.id, ['running', 'worktree_preparing', 'queued'], '抛错用例进入执行');
    const run2 = running2.runs[running2.runs.length - 1];
    const rec2 = host.created.find((r) => r.agent && r.agent.id === run2.sessionId);
    const reviewBefore2 = host.reviewAgentRecords().length;
    host.turnEnd(rec2.agent);
    try {
      const ra2 = await host.nextReviewAgent(reviewBefore2, '抛错用例评审 agent');
      const tokenThrowRun = [...(await host.card(card2.id)).runs].reverse().find((run) => run.kind === 'execute' && run.worktree && run.worktree.path);
      assert(tokenThrowRun, '抛错用例应有执行工作树');
      await host.commitInWorktree(tokenThrowRun.worktree.path, 'src/token-throw.txt', 'token throw\n');
      await host.callTool(ra2, 'review_verdict', { verdict: 'pass', mustFix: [], nits: [], evidence: ['已运行验证并通过（假）'] });
      const c2 = await host.waitCardStatus(card2.id, ['awaiting_signoff'], '抛错用例仍能到待签收');
      assertEqual(c2.status, 'awaiting_signoff', '抛错降级后状态');
    } finally {
      host.projections.behavior = 'ok';
    }
    await host.action(card.id, 'cancel').catch(() => {});
    await host.action(card2.id, 'cancel').catch(() => {});
  });

  // 19. needs_input 回环
  await test('needs_input 回环：request_input → needs_input → answer → running + followup', async () => {
    host.autoTurnEnd = false;
    const card = makeCard('需要回答任务');
    await addCard(card);
    const start = await host.start(card.id);
    assert(start.json && start.json.ok === true, 'start 成功，实际 ' + shorten(start.text));
    const running = await host.waitCardStatus(card.id, ['running', 'worktree_preparing', 'queued'], 'needs_input 用例进入执行');
    const run = running.runs[running.runs.length - 1];
    const rec = host.created.find((r) => r.agent && r.agent.id === run.sessionId);
    assert(rec, '应有执行 agent');
    await host.callTool(rec.agent, 'request_input', { question: '请确认先做 A 还是 B？' });
    const pendingCard = await host.waitCardStatus(card.id, ['needs_input'], 'request_input 后进入 needs_input');
    assert(pendingCard.pending, '应写 pending，实际 ' + shorten(pendingCard.pending));
    assert(String(pendingCard.pending.question || '').includes('先做 A 还是 B'),
      'pending.question 应为提问，实际 ' + shorten(pendingCard.pending));
    const before = rec.agent.followups.length;
    const answer = await host.action(card.id, 'answer', { text: '先做 A' });
    assertEqual(answer.status, 200, 'answer 状态码');
    assert(answer.json && answer.json.ok === true, 'answer 应 ok:true，实际 ' + shorten(answer.text));
    const resumed = await host.waitCardStatus(card.id, ['running'], 'answer 后恢复 running');
    assertEqual(resumed.pending, null, 'answer 后 pending 应清空');
    const after = rec.agent.followups.length;
    assert(after > before, 'answer 应 followup 执行会话');
    assert(JSON.stringify(rec.agent.followups.slice(before)).includes('先做 A'),
      'followup 应携带回答，实际 ' + shorten(rec.agent.followups.slice(before)));
    await host.action(card.id, 'cancel');
  });

  // 20. create_pr 无远程
  await test('create_pr 无远程：业务失败或降级 pr_pending，不崩', async () => {
    host.autoTurnEnd = true;
    const card = makeCard('补建 PR 用例');
    await addCard(card);
    const reviewBase = host.reviewAgentRecords().length;
    const start = await host.start(card.id);
    assert(start.json && start.json.ok === true, 'start 成功，实际 ' + shorten(start.text));
    const ra = await host.nextReviewAgent(reviewBase, 'PR 用例评审 agent');
    const prCardRun = [...(await host.card(card.id)).runs].reverse().find((run) => run.kind === 'execute' && run.worktree && run.worktree.path);
    assert(prCardRun, 'PR 用例应有执行工作树');
    await host.commitInWorktree(prCardRun.worktree.path, 'src/pr-case.txt', 'pr case\n');
    await host.callTool(ra, 'review_verdict', { verdict: 'pass', mustFix: [], nits: [], evidence: ['已运行验证并通过（假）'] });
    await host.waitCardStatus(card.id, ['awaiting_signoff'], 'PR 用例进入待签收');
    const remoteProbe = await git(['remote', '-v'], REPO);
    assert(remoteProbe.stdout.includes('origin'), '前置：fixture 应有 origin');
    await git(['remote', 'remove', 'origin'], REPO);
    let pr;
    try {
      pr = await host.action(card.id, 'create_pr');
    } finally {
      const restored = await git(['remote', 'add', 'origin', REMOTE], REPO);
      assertEqual(restored.code, 0, '恢复 fixture origin 失败: ' + shorten(restored.stderr));
    }
    assertEqual(pr.status, 200, '无远程 create_pr 应 HTTP 200');
    const after = await host.card(card.id);
    const okFalse = pr.json && pr.json.ok === false;
    const degraded = pr.json && pr.json.ok === true && after && ['pr_pending', 'finalize_failed'].includes(after.status);
    assert(okFalse || degraded, '无远程 create_pr 应业务失败或降级 pr_pending，实际 ' + shorten(pr.text));
    if (okFalse) {
      assert(['action_failed', 'invalid_transition', 'not_ready'].includes(pr.json.code),
        '无远程 create_pr 的 code，实际 ' + shorten(pr.json));
      assert(after && ['awaiting_signoff', 'pr_pending', 'finalize_failed', 'blocked', 'failed'].includes(after.status),
        '失败后状态应可解释，实际 ' + (after && after.status));
    }
  });

  // 21. merge 非法态
  await test('merge 非法态：todo 任务 → invalid_transition', async () => {
    const card = makeCard('非法 merge 任务');
    await addCard(card);
    const r = await host.action(card.id, 'merge');
    assertEqual(r.status, 200, 'merge 非法态 HTTP 200');
    assert(r.json && r.json.ok === false, 'merge 非法态应 ok:false，实际 ' + shorten(r.text));
    assertEqual(r.json.code, 'invalid_transition', 'merge 非法态 code');
  });

  // 22. cleanup 重复调用
  await test('cleanup 后重复 cleanup：不崩且业务失败/幂等', async () => {
    assert(cancelledCardId, '前置：需要已完成 cleanup 的取消任务');
    const again = await host.action(cancelledCardId, 'cleanup');
    assertEqual(again.status, 200, '重复 cleanup HTTP 200');
    assert(again.json && typeof again.json.ok === 'boolean', '重复 cleanup 应返回 JSON，实际 ' + shorten(again.text));
    if (again.json.ok === false) assert(again.json.code, '失败应带 code，实际 ' + shorten(again.json));
    const c = await host.card(cancelledCardId);
    assertEqual(c.status, 'cancelled', '重复 cleanup 不应改变状态');
  });

  // ================================================================
  // 23-28. create_task_card：会话内 AI 建卡（根级工具）
  // ================================================================

  // 23. 根工具注册
  await test('create_task_card：根级注册（名称/描述/参数/when/presentCall/output）', async () => {
    const hits = rootToolRegistrations('create_task_card');
    assertEqual(hits.length, 1, '根级应恰好注册一个 create_task_card，实际 ' + hits.length +
      '（已注册: ' + [...host.rootTools.registrations.map((x) => x.def && x.def.name)].join(', ') + '）');
    const { def, opts } = hits[0];
    assert(typeof def.description === 'string' && def.description.trim().length > 0, '工具 description 应非空');
    assert(def.parameters && def.parameters.type === 'object', 'parameters 应为 JSON schema object，实际 ' + shorten(def.parameters));
    const required = (def.parameters && def.parameters.required) || [];
    assert(Array.isArray(required) && required.indexOf('title') >= 0, 'parameters.required 应包含 title，实际 ' + shorten(required));
    assert(def.parameters.properties && def.parameters.properties.workspace, '参数应支持 workspace');
    assertEqual(def.parameters.additionalProperties, false, 'parameters.additionalProperties 应为 false');
    assert(opts && typeof opts.when === 'function', 'register 第二参数 when 应为函数，实际 ' + typeof (opts && opts.when));
    assert(def.output && def.output.schema && typeof def.output.render === 'function', '应声明 output.schema/render');
    assert(typeof def.presentCall === 'function', '应提供 presentCall');
    const view = def.presentCall({ title: 'x', workspace: 'ws-repo' });
    assert(view && view.title === '创建任务卡片', 'presentCall title 应为「创建任务卡片」，实际 ' + shorten(view));
    assert(typeof def.execute === 'function', 'def.execute 应为函数');
  });

  // 24. 直接调用建卡：字段 / 置顶 / revision / seq / 审计 / CAS / 不启动
  await test('create_task_card 调用：建 todo 卡（字段/置顶/revision/seq/审计/CAS/不启动）', async () => {
    const beforeWrap = await host.getBoard(WS);
    const before = beforeWrap.board || { version: 3, revision: 0, seq: 0, cards: [] };
    const agentsBefore = host.created.length;
    const execAgentsBefore = host.executeAgentRecords().length;
    const res = await callCreateCard({
      title: 'AI 建卡：验证待办',
      description: '由假宿主测试注入的描述',
      acceptance: '卡片出现在待办列，状态为 todo',
      priority: 'high',
      labels: ['ai', '验证'],
    });
    assert(res && res.ok === true, '工具应返回 ok:true，实际 ' + shorten(res));
    assertEqual(res.status, 'todo', '返回 status');
    assertEqual(res.workspaceId, WS, '返回 workspaceId');
    assertEqual(res.workspaceTitle, 'Fixture Repo', '返回 workspaceTitle');
    assert(res.cardId, '返回应有 cardId');
    assertEqual(res.title, 'AI 建卡：验证待办', '返回 title');
    assert(res.message.indexOf('Fixture Repo') >= 0 && res.message.indexOf('待办') >= 0,
      'message 应含工作区标题与「待办」，实际 ' + shorten(res.message));

    const afterWrap = await host.getBoard(WS);
    const after = afterWrap.board;
    assert(after, '建卡后看板应存在');
    assertEqual(after.revision, (before.revision || 0) + 1, 'revision 应 +1（before=' + before.revision + '）');
    assertEqual(after.seq, (before.seq || 0) + 1, 'seq 应 +1（before=' + before.seq + '）');
    assertEqual(after.cards[0].id, res.cardId, '新卡应在 cards[0]（置顶）');
    const card = after.cards[0];
    assertEqual(card.title, 'AI 建卡：验证待办', '卡 title');
    assertEqual(card.description, '由假宿主测试注入的描述', '卡 description');
    assertEqual(card.acceptance, '卡片出现在待办列，状态为 todo', '卡 acceptance');
    assertEqual(card.priority, 'high', '卡 priority');
    assertEqual(JSON.stringify(card.labels), JSON.stringify(['ai', '验证']), '卡 labels');
    assertEqual(card.status, 'todo', '新卡固定 status=todo');
    assertEqual(card.round, 0, '新卡 round 应为 0');
    assertEqual(card.runs.length, 0, '工具建卡不应有 Run（不自动 /start）');
    assertEqual(host.created.length, agentsBefore, '工具建卡不应创建任何 agent');
    assertEqual(host.executeAgentRecords().length, execAgentsBefore, '工具建卡不应起执行会话');

    const audit = await host.auditLines(WS);
    assert(audit.length > 0, '审计文件应有内容');
    const last = audit[audit.length - 1];
    assertEqual(last.actor, 'agent:sess-ai-1', '审计 actor 应为 agent:<sessionId>');
    assertEqual(last.action, 'create_card', '审计 action');
    assertEqual(last.from, null, '审计 from 应为 null');
    assertEqual(last.to, 'todo', '审计 to 应为 todo');
    assertEqual(last.taskId, res.cardId, '审计 taskId 应对应新卡');
    assert(last.ts, '审计应有 ts');

    // 工具建卡与 PUT CAS 联动：用建卡前的 revision 再 PUT → 409
    const stale = await host.putBoardRaw({ workspaceId: WS, expectedRevision: before.revision || 0, board: after });
    assertEqual(stale.status, 409, '建卡前的 revision 再 PUT 应 HTTP 409，实际 ' + stale.status);
    assertEqual(stale.json && stale.json.code, 'revision_conflict', '冲突 code 应为 revision_conflict，实际 ' + shorten(stale.json));
  });

  // 25. 空标题
  await test('create_task_card：空标题 → 抛错含「标题」，不写盘', async () => {
    const beforeWrap = await host.getBoard(WS);
    const before = beforeWrap.board || { revision: 0, seq: 0 };
    const empty = await rejectReason(callCreateCard({ title: '   ' }));
    assert(empty && typeof empty.message === 'string', '空白 title 应 reject，实际 ' + shorten(empty));
    assertMatch(empty.message, /标题/, '错误信息应含「标题」');
    const missing = await rejectReason(callCreateCard({}));
    assert(missing && typeof missing.message === 'string', '缺 title 应 reject，实际 ' + shorten(missing));
    assertMatch(missing.message, /标题/, '缺 title 错误信息应含「标题」');
    const afterWrap = await host.getBoard(WS);
    const after = afterWrap.board || { revision: 0, seq: 0 };
    assertEqual(after.revision, before.revision, '失败调用不应递增 revision');
    assertEqual(after.seq, before.seq, '失败调用不应递增 seq');
  });

  // 26. 显式 workspace：id / 标题大小写 / 路径 / 未知
  await test('create_task_card 显式 workspace：id、标题忽略大小写、路径、未知报错', async () => {
    const plainBefore = (await host.getBoard(WS_PLAIN)).board;
    const plainRevBefore = plainBefore ? plainBefore.revision : 0;

    const byId = await callCreateCard({ title: '显式 id 建卡', workspace: WS }, { cwd: PLAIN });
    assertEqual(byId.workspaceId, WS, '显式 id 应命中 ws-repo（且优先于 cwd）');
    const idCard = await host.card(byId.cardId, WS);
    assert(idCard && idCard.status === 'todo', 'ws-repo 应出现显式 id 建的卡');

    const byTitle = await callCreateCard({ title: '显式标题建卡', workspace: 'fIxTuRe RePo' }, { cwd: PLAIN });
    assertEqual(byTitle.workspaceId, WS, '标题大小写变体应命中 ws-repo');
    const titleCard = await host.card(byTitle.cardId, WS);
    assert(titleCard && titleCard.status === 'todo', 'ws-repo 应出现标题建的卡');

    const byPath = await callCreateCard({ title: '显式路径建卡', workspace: path.join(REPO, 'src') }, { cwd: PLAIN });
    assertEqual(byPath.workspaceId, WS, '路径（前缀）应命中 ws-repo');
    const pathCard = await host.card(byPath.cardId, WS);
    assert(pathCard && pathCard.status === 'todo', 'ws-repo 应出现路径建的卡');

    const unknown = await rejectReason(callCreateCard({ title: '未知工作区建卡', workspace: 'no-such-board' }));
    assert(unknown && typeof unknown.message === 'string', '未知 workspace 应 reject，实际 ' + shorten(unknown));
    assertMatch(unknown.message, /no-such-board/, '错误信息应指向未知工作区');
    assertMatch(unknown.message, /Fixture Repo/, '错误信息应列出可用工作区 Fixture Repo');
    assertMatch(unknown.message, /Fixture Plain/, '错误信息应列出可用工作区 Fixture Plain');
    const plainAfter = (await host.getBoard(WS_PLAIN)).board;
    assertEqual(plainAfter ? plainAfter.revision : 0, plainRevBefore, '显式/未知 workspace 调用不应写 ws-plain');
  });

  // 27. cwd 归属 + sessionIds 回退
  await test('create_task_card cwd 归属：子目录→ws-repo、PLAIN→ws-plain、工作区外报错、sessionIds 回退', async () => {
    const repoRes = await callCreateCard({ title: 'cwd 子目录建卡' }, { cwd: path.join(REPO, 'src') });
    assertEqual(repoRes.workspaceId, WS, 'REPO 子目录应归属 ws-repo');
    const repoCard = await host.card(repoRes.cardId, WS);
    assert(repoCard && repoCard.status === 'todo', 'ws-repo 应出现 cwd 建的卡');

    const plainBefore = (await host.getBoard(WS_PLAIN)).board;
    const plainRes = await callCreateCard({ title: 'cwd PLAIN 建卡' }, { cwd: PLAIN });
    assertEqual(plainRes.workspaceId, WS_PLAIN, 'PLAIN 应归属 ws-plain');
    const plainAfter = (await host.getBoard(WS_PLAIN)).board;
    assert(plainAfter, 'ws-plain 建卡后看板应存在');
    assertEqual(plainAfter.cards[0].id, plainRes.cardId, 'ws-plain 新卡应在 cards[0]');
    assertEqual(plainAfter.revision, (plainBefore ? plainBefore.revision : 0) + 1, 'ws-plain revision 应 +1');

    const outside = await rejectReason(callCreateCard({ title: '工作区外建卡' }, { cwd: HOME }));
    assert(outside && typeof outside.message === 'string', '工作区外 cwd 应 reject，实际 ' + shorten(outside));
    assertMatch(outside.message, /不属于任何已注册工作区/, '错误信息应提示不属于任何已注册工作区');
    assertMatch(outside.message, /Fixture Repo/, '错误信息应列出可用工作区');

    host.mapSessionToWorkspace(WS_PLAIN, 'sess-mapped');
    const mapped = await callCreateCard({ title: '会话归属建卡' }, { cwd: HOME, sessionId: 'sess-mapped' });
    assertEqual(mapped.workspaceId, WS_PLAIN, 'cwd 不匹配时应按 registry sessionIds 回退到 ws-plain');
    const mappedCard = await host.card(mapped.cardId, WS_PLAIN);
    assert(mappedCard && mappedCard.status === 'todo', 'ws-plain 应出现会话归属建的卡');
  });

  // 28. when：普通会话可见，执行 / 评审会话隐藏
  await test('create_task_card when：普通会话可见，执行/评审会话隐藏', async () => {
    const { opts } = rootToolDef('create_task_card');
    assertEqual(typeof opts.when, 'function', 'when 应为函数');
    const normalCtx = {
      agent: { id: 'sess-ai-1', session: { id: 'sess-ai-1' } },
      signal: new AbortController().signal,
    };
    assertEqual(await opts.when(normalCtx), true, '普通会话应可见 create_task_card');

    host.autoTurnEnd = false;
    const card = makeCard('when 隐藏用任务');
    await addCard(card);
    const reviewBase = host.reviewAgentRecords().length;
    const started = await host.start(card.id);
    assert(started.json && started.json.ok === true, 'start 应成功，实际 ' + shorten(started.text));
    const running = await host.card(card.id);
    assert(running && Array.isArray(running.runs) && running.runs.length > 0, '启动后应有 Run，实际 ' + shorten(running));
    const execRun = running.runs[running.runs.length - 1];
    const execRec = host.created.find((r) => r.agent && r.agent.id === execRun.sessionId);
    assert(execRec, '应有执行 agent（run.sessionId=' + execRun.sessionId + '）');
    const execCtx = {
      agent: { id: execRun.sessionId, session: { id: execRun.sessionId } },
      signal: new AbortController().signal,
    };
    assertEqual(await opts.when(execCtx), false, '执行会话应隐藏 create_task_card');

    host.turnEnd(execRec.agent);
    const reviewAgent = await host.nextReviewAgent(reviewBase, 'when 用例评审 agent');
    const reviewCtx = {
      agent: { id: reviewAgent.id, session: { id: reviewAgent.id } },
      signal: new AbortController().signal,
    };
    assertEqual(await opts.when(reviewCtx), false, '评审会话应隐藏 create_task_card');

    const cancelled = await host.action(card.id, 'cancel');
    assert(cancelled.json && cancelled.json.ok === true, '收尾 cancel 应成功，实际 ' + shorten(cancelled.text));
    host.autoTurnEnd = true;
  });

  // ---- Phase 2：证据门禁与只读 API ----

  async function startToReview(card, label) {
    host.autoTurnEnd = true;
    await addCard(card);
    const before = host.reviewAgentRecords().length;
    const started = await host.start(card.id);
    assert(started.json && started.json.ok === true, label + '：start 应成功，实际 ' + shorten(started.text));
    return host.nextReviewAgent(before, label + '：评审 agent');
  }

  async function executeWorktree(cardId, label) {
    const card = await host.card(cardId);
    const run = [...(card.runs || [])].reverse().find((item) => item.kind === 'execute' && item.worktree && item.worktree.path);
    assert(run, label + '：应有执行工作树');
    return run.worktree.path;
  }

  function boardJsonPath(workspaceId = WS) {
    return path.join(HOME, 'task-board', workspaceId + '.json');
  }

  // 23. /stats
  await test('/stats：返回统计形状（cards/review/tokens/runs/queue/health）与计数', async () => {
    const { board } = await host.getBoard();
    const r = await host.call('GET', '/stats?workspaceId=' + encodeURIComponent(WS));
    assertEqual(r.status, 200, 'GET /stats 状态码');
    assert(r.json && r.json.ok === true, '/stats 应 ok:true，实际 ' + shorten(r.text));
    const stats = r.json.stats;
    assert(stats && typeof stats === 'object', '/stats 应返回 stats 对象');
    for (const key of ['cards', 'review', 'tokens', 'runs', 'queue', 'health']) {
      assert(stats[key] && typeof stats[key] === 'object', 'stats.' + key + ' 应为对象');
    }
    const cards = Array.isArray(board.cards) ? board.cards : [];
    assertEqual(stats.revision, board.revision, 'stats.revision 应等于看板 revision');
    assertEqual(stats.cards.total, cards.length, 'cards.total 应等于看板卡数');
    const byStatusSum = Object.values(stats.cards.byStatus || {}).reduce((sum, n) => sum + n, 0);
    assertEqual(byStatusSum, cards.length, 'cards.byStatus 之和应等于总卡数');
    assert(Number.isFinite(stats.cards.attention), 'cards.attention 应为数字');
    const reviewed = cards.filter((card) => Array.isArray(card.reviews) && card.reviews.length > 0);
    const firstPass = reviewed.filter((card) => card.reviews[0] && card.reviews[0].verdict === 'pass').length;
    const expectedRate = reviewed.length ? Math.round((firstPass / reviewed.length) * 1000) / 1000 : null;
    assertEqual(stats.review.firstPassRate, expectedRate, 'review.firstPassRate 应为 firstPassTasks/reviewedTasks');
    const runTotal = cards.reduce((sum, card) => sum + (Array.isArray(card.runs) ? card.runs.length : 0), 0);
    assertEqual(stats.runs.total, runTotal, 'runs.total 应等于全部 Run 数');
    assert(Number.isFinite(stats.tokens.total) && stats.tokens.total >= 0, 'tokens.total 应为非负数字');
    assert(Number.isFinite(stats.queue.waiting) && stats.queue.waiting >= 0, 'queue.waiting 应为非负数字');
    assert(Number.isFinite(stats.queue.running) && stats.queue.running >= 0, 'queue.running 应为非负数字');
    assert(stats.health && typeof stats.health === 'object', 'health 应为对象');
  });

  // 24. /audit
  await test('/audit：workspaceId 必填 400 / entries 数组 / taskId 过滤 / limit 截断', async () => {
    const missing = await host.call('GET', '/audit');
    assertEqual(missing.status, 400, '缺 workspaceId 应 400');
    assert(missing.json && missing.json.ok === false, '缺 workspaceId 应 ok:false');

    host.autoTurnEnd = false;
    const card = makeCard('/audit 过滤任务');
    const added = await addCard(card);
    assertEqual(added.status, 200, '/audit 用例建卡应 200');
    const started = await host.start(card.id);
    assert(started.json && started.json.ok === true, '/audit 用例 start 应成功，实际 ' + shorten(started.text));
    await host.waitCardStatus(card.id, ['running', 'worktree_preparing', 'queued'], '/audit 用例进入执行');
    const cancelled = await host.action(card.id, 'cancel');
    assert(cancelled.json && cancelled.json.ok === true, '/audit 用例 cancel 应成功，实际 ' + shorten(cancelled.text));
    host.autoTurnEnd = true;

    const auditPath = path.join(HOME, 'task-board', WS + '.audit.jsonl');
    const padLines = [];
    for (let i = 0; i < 110; i += 1) {
      padLines.push(JSON.stringify({ ts: new Date().toISOString(), actor: 'test', action: 'test_pad', taskId: 'audit-pad-' + card.id, from: null, to: null }));
    }
    await fs.appendFile(auditPath, padLines.join('\n') + '\n', 'utf8');

    const explicit = await host.call('GET', '/audit?workspaceId=' + encodeURIComponent(WS) + '&limit=100');
    assertEqual(explicit.status, 200, 'GET /audit 状态码');
    assert(Array.isArray(explicit.json && explicit.json.entries), '/audit entries 应为数组');
    assert(Number.isFinite(explicit.json.count), '/audit count 应为数字');
    assert(explicit.json.count > 100, '前置：审计总数应 >100，实际 ' + explicit.json.count);
    assertEqual(explicit.json.entries.length, Math.min(100, explicit.json.count), 'limit=100 应返回 min(100, count) 条');
    assertEqual(explicit.json.entries.length, 100, 'limit=100 应截断为 100 条');

    const defaults = await host.call('GET', '/audit?workspaceId=' + encodeURIComponent(WS));
    assertEqual(defaults.status, 200, '缺省 limit 的 /audit 状态码');
    assert(Array.isArray(defaults.json && defaults.json.entries), '缺省 limit entries 应为数组');
    assertEqual(defaults.json.entries.length, Math.min(100, defaults.json.count), '缺省 limit 应默认返回最近 min(100, count) 条');
    assertEqual(defaults.json.entries.length, 100, '缺省 limit 应默认返回 100 条（总数 >100 时）');
    assertEqual(defaults.json.count, explicit.json.count, '缺省 limit 与显式 limit=100 的 count 应一致');
    assertEqual(JSON.stringify(defaults.json.entries), JSON.stringify(explicit.json.entries),
      '缺省 limit 应与显式 limit=100 返回相同条目');

    const filtered = await host.call('GET', '/audit?workspaceId=' + encodeURIComponent(WS) + '&taskId=' + encodeURIComponent(card.id) + '&limit=100');
    assertEqual(filtered.status, 200, '/audit taskId 过滤状态码');
    const entries = filtered.json.entries;
    assert(entries.length >= 2, '该任务应有 ≥2 条审计，实际 ' + entries.length);
    assert(entries.every((entry) => entry && String(entry.taskId) === card.id),
      'taskId 过滤应只返回该任务，实际 ' + shorten(entries.map((entry) => entry && entry.taskId)));
    assertEqual(filtered.json.count, entries.length, '未截断时 count 应等于返回条数');

    const limited = await host.call('GET', '/audit?workspaceId=' + encodeURIComponent(WS) + '&taskId=' + encodeURIComponent(card.id) + '&limit=1');
    assertEqual(limited.status, 200, '/audit limit=1 状态码');
    assertEqual(limited.json.entries.length, 1, 'limit=1 应只返回 1 条');
    assertEqual(limited.json.count, entries.length, 'limit 不应改变过滤后总数');
  });

  // 25. /start CAS
  await test('/start CAS：过期 expectedRevision → revision_conflict 且状态不变', async () => {
    const card = makeCard('/start CAS 任务');
    const added = await addCard(card);
    assertEqual(added.status, 200, '/start CAS 用例建卡应 200');
    const { board } = await host.getBoard();
    const stale = Math.max(0, board.revision - 1);
    const r = await host.call('POST', '/start', { workspaceId: WS, taskId: card.id, expectedRevision: stale });
    assertEqual(r.status, 200, '/start CAS HTTP 200');
    assert(r.json && r.json.ok === false, '/start CAS 应 ok:false，实际 ' + shorten(r.text));
    assertEqual(r.json.code, 'revision_conflict', '/start CAS code');
    assert(r.json.board, '/start CAS 应回传当前看板');
    const after = await host.card(card.id);
    assert(after, '/start CAS 后任务应存在');
    assertEqual(after.status, 'todo', '/start CAS 冲突后状态应保持 todo');
    assertEqual((after.runs || []).length, 0, '/start CAS 冲突不应创建 Run');
  });

  // 26. 证据门禁负向
  await test('证据门禁负向：pass 无 evidence → blocked + 评审 Run failed + 审计 review_no_evidence', async () => {
    const card = makeCard('无证据通过任务');
    const reviewAgent = await startToReview(card, '无证据用例');
    await host.callTool(reviewAgent, 'review_verdict', { verdict: 'pass', mustFix: [], nits: [] });
    const blocked = await host.waitCardStatus(card.id, ['blocked'], '无证据 pass 后进入 blocked');
    assert(String(blocked.error || '').includes('证据'), 'error 应含「证据」，实际 ' + shorten(blocked.error));
    const reviewRun = [...blocked.runs].reverse().find((run) => run.kind === 'review');
    assert(reviewRun, '应存在评审 Run');
    assertEqual(reviewRun.status, 'failed', '评审 Run 应 failed');
    const audit = await host.auditLines();
    assert(audit.some((line) => line && line.taskId === card.id && line.action === 'review_no_evidence'),
      '审计应含 review_no_evidence，实际 ' + shorten(audit.filter((line) => line && line.taskId === card.id).map((line) => line.action)));
    assert(!Array.isArray(blocked.reviews) || blocked.reviews.length === 0, '无证据 pass 不应落 Review');
  });

  // 27. run_verification 自动证据
  await test('run_verification 自动证据：exit 0 + pass 无显式 evidence → awaiting_signoff 且 review Run 持久化 verifications', async () => {
    const card = makeCard('自动证据任务');
    const reviewAgent = await startToReview(card, '自动证据用例');
    const worktreePath = await executeWorktree(card.id, '自动证据用例');
    await host.commitInWorktree(worktreePath, 'src/auto-evidence.txt', 'auto evidence\n');
    const verify = await host.callTool(reviewAgent, 'run_verification', { command: 'git status' });
    assertEqual(verify.exitCode, 0, 'git status 应 exit 0，实际 ' + shorten(verify));
    await host.callTool(reviewAgent, 'review_verdict', { verdict: 'pass', mustFix: [], nits: [] });
    const signed = await host.waitCardStatus(card.id, ['awaiting_signoff'], '自动证据后进入待签收');
    const review = signed.reviews[signed.reviews.length - 1];
    assertEqual(review.verdict, 'pass', 'Review.verdict 应为 pass');
    assert(review.verification && review.verification.ran === true, 'verification.ran 应 true，实际 ' + shorten(review.verification));
    assertEqual(review.verification.passed, true, 'verification.passed 应 true');
    assertEqual(review.verification.commands.length, 1, 'verification.commands 应有 1 条');
    assertEqual(review.verification.commands[0].command, 'git status', 'verification.commands[0].command');
    assertEqual(review.verification.commands[0].exitCode, 0, 'verification.commands[0].exitCode');
    assert(review.evidence.some((item) => item && item.type === 'verification' && item.command === 'git status'),
      'evidence 应含 type=verification，实际 ' + shorten(review.evidence));
    const { board } = await host.getBoard();
    const fetched = board.cards.find((entry) => entry.id === card.id);
    const reviewRun = [...fetched.runs].reverse().find((run) => run.kind === 'review');
    assert(reviewRun, '应存在评审 Run');
    assert(Array.isArray(reviewRun.verifications) && reviewRun.verifications.length >= 1,
      'GET /board 后评审 Run 应保留 verifications，实际 ' + shorten(reviewRun.verifications));
    assertEqual(reviewRun.verifications[0].command, 'git status', '持久化 verifications[0].command');
    assertEqual(reviewRun.verifications[0].exitCode, 0, '持久化 verifications[0].exitCode');
  });

  // 28. 验证失败门禁
  await test('验证失败门禁：机器验证 exit 1 + pass → blocked + verification.passed=false + 审计 review_verification_failed', async () => {
    const card = makeCard('验证失败任务');
    const reviewAgent = await startToReview(card, '验证失败用例');
    const verify = await host.callTool(reviewAgent, 'run_verification', { command: 'node --check missing-file.js' });
    assertEqual(verify.exitCode, 1, 'node --check 不存在文件应 exit 1，实际 ' + shorten(verify));
    await host.callTool(reviewAgent, 'review_verdict', { verdict: 'pass', mustFix: [], nits: [] });
    const blocked = await host.waitCardStatus(card.id, ['blocked'], '验证失败后进入 blocked');
    assert(String(blocked.error || '').includes('机器验证'), 'error 应含「机器验证」，实际 ' + shorten(blocked.error));
    const reviewRun = [...blocked.runs].reverse().find((run) => run.kind === 'review');
    assertEqual(reviewRun.status, 'failed', '评审 Run 应 failed');
    const audit = await host.auditLines();
    const hit = audit.find((line) => line && line.taskId === card.id && line.action === 'review_verification_failed');
    assert(hit, '审计应含 review_verification_failed，实际 ' + shorten(audit.filter((line) => line && line.taskId === card.id).map((line) => line.action)));
    assert(hit.verification && hit.verification.passed === false, '审计 verification.passed 应 false，实际 ' + shorten(hit.verification));
    assertEqual(hit.verification.ran, true, '审计 verification.ran 应 true');
  });

  // 29. mustFix 关闭
  await test('mustFix 关闭：第二轮 pass 后首轮 mustFix.status=closed 且 closedByReview=第二轮 review.id', async () => {
    const card = makeCard('mustFix 关闭任务');
    const firstReviewAgent = await startToReview(card, 'mustFix 用例');
    const reviewsBefore = host.reviewAgentRecords().length;
    await host.callTool(firstReviewAgent, 'review_verdict', {
      verdict: 'changes',
      mustFix: [{ file: 'src/app.txt', line: 1, severity: 'major', issue: '补充回归用例', suggestion: '补一条测试' }],
      nits: [],
    });
    const reworking = await host.waitCardStatus(card.id, ['changes_requested', 'running'], 'mustFix 用例进入返工');
    assertEqual(reworking.round, 2, 'changes 后 round 应为 2，实际 ' + reworking.round);
    const secondReviewAgent = await host.nextReviewAgent(reviewsBefore, 'mustFix 用例：第二轮评审 agent');
    const reworkRun = [...reworking.runs].reverse().find((run) => run.kind === 'execute' && run.worktree && run.worktree.path);
    assert(reworkRun, 'mustFix 用例应有执行工作树');
    await host.commitInWorktree(reworkRun.worktree.path, 'src/mustfix-fix.txt', 'fixed\n');
    await host.callTool(secondReviewAgent, 'review_verdict', {
      verdict: 'pass', mustFix: [], nits: [], evidence: ['已补充用例并运行验证'],
    });
    const signed = await host.waitCardStatus(card.id, ['awaiting_signoff'], '第二轮 pass 后进入待签收');
    assertEqual(signed.reviews.length, 2, '应有 2 条 Review，实际 ' + signed.reviews.length);
    const firstReview = signed.reviews[0];
    const secondReview = signed.reviews[1];
    assertEqual(firstReview.verdict, 'changes', '第一轮 verdict 应为 changes');
    assertEqual(firstReview.mustFix.length, 1, '第一轮 mustFix 应有 1 条');
    assertEqual(firstReview.mustFix[0].status, 'closed', '首轮 mustFix 应 closed');
    assertEqual(firstReview.mustFix[0].closedByReview, secondReview.id, 'closedByReview 应等于第二轮 review.id');
  });

  // 30. 空交付
  await test('空交付：无已提交改动即 pass → finalize_failed + error 含「没有可交付」+ 无 signoff', async () => {
    const card = makeCard('空交付任务');
    const reviewAgent = await startToReview(card, '空交付用例');
    await host.callTool(reviewAgent, 'review_verdict', { verdict: 'pass', mustFix: [], nits: [], evidence: ['评审通过（假）'] });
    const failed = await host.waitCardStatus(card.id, ['finalize_failed'], '空交付应进入 finalize_failed');
    assert(String(failed.error || '').includes('没有可交付'), 'error 应含「没有可交付」，实际 ' + shorten(failed.error));
    assert(!failed.signoff, '空交付不应有 signoff');
    const audit = await host.auditLines();
    assert(audit.some((line) => line && line.taskId === card.id && line.action === 'finalize_failed'), '审计应含 finalize_failed');
    assert(!audit.some((line) => line && line.taskId === card.id && line.action === 'finalize'), '不应有成功的 finalize 审计');
  });

  // 31. pushConsent=never
  await test('pushConsent=never：create_pr 返回 action_failed 且错误含「禁止推送」', async () => {
    const card = makeCard('禁止推送任务');
    const reviewAgent = await startToReview(card, '禁止推送用例');
    const worktreePath = await executeWorktree(card.id, '禁止推送用例');
    await host.commitInWorktree(worktreePath, 'src/never-push.txt', 'no push\n');
    await host.callTool(reviewAgent, 'review_verdict', { verdict: 'pass', mustFix: [], nits: [], evidence: ['评审通过（假）'] });
    await host.waitCardStatus(card.id, ['awaiting_signoff'], '禁止推送用例进入待签收');
    const boardPath = boardJsonPath();
    const original = await fs.readFile(boardPath, 'utf8');
    try {
      const parsed = JSON.parse(original);
      parsed.settings.pushConsent = 'never';
      await fs.writeFile(boardPath, JSON.stringify(parsed), 'utf8');
      const pr = await host.action(card.id, 'create_pr');
      assertEqual(pr.status, 200, 'create_pr HTTP 200');
      assert(pr.json && pr.json.ok === false, 'create_pr 应 ok:false，实际 ' + shorten(pr.text));
      assertEqual(pr.json.code, 'action_failed', 'create_pr code 应为 action_failed');
      assert(String(pr.json.error || '').includes('禁止推送'), '错误应含「禁止推送」，实际 ' + shorten(pr.json.error));
      const after = await host.card(card.id);
      assertEqual(after.status, 'awaiting_signoff', '禁止推送后任务状态应不变');
    } finally {
      await fs.writeFile(boardPath, original, 'utf8');
    }
  });

  // 32. 坏板备份
  await test('坏板备份：非法 JSON → GET /board 返回 null 且生成 *.corrupt-*.bak', async () => {
    const boardPath = boardJsonPath();
    const original = await fs.readFile(boardPath, 'utf8');
    const corrupt = '{ 这不是合法 JSON';
    try {
      await fs.writeFile(boardPath, corrupt, 'utf8');
      const r = await host.call('GET', '/board?workspaceId=' + encodeURIComponent(WS));
      assertEqual(r.status, 200, '坏板 GET /board 状态码');
      assert(r.json && r.json.ok === true, '坏板 GET /board 应 ok:true，实际 ' + shorten(r.text));
      assertEqual(r.json.board, null, '坏板 GET /board 应返回 board:null');
      const dir = path.dirname(boardPath);
      const files = await fs.readdir(dir);
      const backups = files.filter((name) => name.startsWith(WS + '.json.corrupt-') && name.endsWith('.bak'));
      assert(backups.length >= 1, '应生成 *.corrupt-*.bak，目录实际 ' + shorten(files));
      const backupRaw = await fs.readFile(path.join(dir, backups[0]), 'utf8');
      assertEqual(backupRaw, corrupt, '备份内容应与损坏原文一致');
    } finally {
      await fs.writeFile(boardPath, original, 'utf8');
    }
  });

  // ---- 汇总 ----
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  if (host.errors.length) {
    console.log('');
    console.log('宿主内部监听/回调抛出的错误（' + host.errors.length + ' 条）:');
    for (const e of host.errors.slice(0, 10)) console.log('  ! ' + String(e && e.stack || e).split('\n')[0]);
  }
  console.log('');
  console.log('==============================================');
  console.log('测试汇总: ' + pass + ' PASS / ' + fail + ' FAIL / ' + results.length + ' 项');
  console.log('index.js: ' + host.indexSize + ' bytes, mtime ' + new Date(host.indexMtime).toISOString());
  if (fail) {
    console.log('失败项:');
    for (const r of results.filter((x) => !x.ok)) console.log('  - ' + r.name + ' :: ' + String(r.detail || '').split('\n')[0]);
  }
  console.log('==============================================');
  return fail === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- 直接运行

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.on('unhandledRejection', (e) => {
    console.error('[fake-host] unhandledRejection:', String(e && e.stack || e));
  });
  const host = await createFakeHost({ verbose: process.argv.includes('--verbose') });
  const code = await runTests(host);
  process.exit(code);
}
