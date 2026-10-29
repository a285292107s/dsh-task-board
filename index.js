/**
 * Host half of the Task Board bundle.
 *
 * Serves a small JSON API over the Harness web server so the Client board can
 * read/write durable per-workspace boards and inspect the workspace's Git
 * state on the Host (the browser cannot run git).
 *
 * Routes (prefix `/task-board-api`):
 *   GET  /task-board-api/health
 *   GET  /task-board-api/workspaces                     -> { workspaces:[{id,title,path}] }
 *   GET  /task-board-api/git?path=<dir>                 -> { isRepo, root, branch, hasHead, dirty, dirtyCount, hasRemote }
 *   GET  /task-board-api/board?workspaceId=<id>         -> { board | null }
 *   PUT  /task-board-api/board  { workspaceId, board }  -> { ok:true }
 *
 * Boards are stored as JSON files under `$DSH_HOME/task-board/<id>.json`.
 * This is the durable store the Client will migrate onto; the current Client
 * still uses localStorage until the rewire lands.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

export const inject = ['webServer', 'workspaceRegistry'];

const ROUTE_PREFIX = '/task-board-api';
const MAX_BODY = 5 * 1024 * 1024; // 5 MiB per board payload

function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'task-board');
}

function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'unknown';
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function run(argv, cwd) {
  return new Promise((resolve) => {
    execFile(argv[0], argv.slice(1), { cwd, timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });
}

async function gitProbe(dir) {
  if (!dir) return { isRepo: false, reason: 'path required' };
  const top = await run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], dir);
  if (top.err) return { isRepo: false, reason: (top.stderr || top.err.message || 'not a git repository').trim() };
  const root = top.stdout.trim();
  const branch = await run(['git', '-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], root);
  const head = await run(['git', '-C', root, 'rev-parse', '--verify', 'HEAD'], root);
  const status = await run(['git', '-C', root, 'status', '--porcelain'], root);
  const remote = await run(['git', '-C', root, 'remote', '-v'], root);
  const dirtyLines = status.stdout.trim() ? status.stdout.trim().split('\n') : [];
  return {
    isRepo: true,
    root,
    branch: branch.stdout.trim() || null,
    hasHead: !head.err,
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    hasRemote: remote.stdout.trim().length > 0,
  };
}

async function readBoard(workspaceId) {
  const file = path.join(dataDir(), safeId(workspaceId) + '.json');
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { return null; }
}

async function writeBoard(workspaceId, board) {
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, safeId(workspaceId) + '.json');
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(board, null, 0), 'utf8');
  await fs.rename(tmp, file);
}

async function createWorktree(root, name, ref) {
  const dir = path.join(root, '.agents', 'worktrees', name);
  const branch = name;
  const rev = await run(['git', '-C', root, 'rev-parse', '--verify', ref], root);
  const baseCommit = rev.err ? null : rev.stdout.trim();
  if (rev.err) return { ok: false, error: (rev.stderr || rev.err.message || 'bad base ref').trim() };
  try { await fs.mkdir(path.join(root, '.agents', 'worktrees'), { recursive: true }); } catch (e) { /* ignore */ }
  const r = await run(['git', '-C', root, 'worktree', 'add', '-b', branch, dir, ref], root);
  if (r.err) return { ok: false, error: (r.stderr || r.err.message || 'git worktree add failed').trim() };
  return { ok: true, path: dir, branch: branch, baseCommit: baseCommit };
}

function buildPrompt(task) {
  const lines = ['你是一个自动化执行代理。请只在当前 Git 工作树中完成任务，只改必要的文件。'];
  lines.push('任务：' + (task.title || '(未命名任务)'));
  if (task.description) lines.push('描述：' + task.description);
  if (task.acceptance) lines.push('验收标准：' + task.acceptance);
  lines.push('完成后请简要汇报：改了哪些文件、如何验证。');
  return lines.join('\n');
}

export function apply(ctx) {
  const roots = () => (ctx.workspaceRegistry.list() || []).map((w) => w.path).filter(Boolean);
  const underWorkspace = (p) => {
    try {
      const n = path.resolve(p);
      return roots().some((root) => { const r = path.resolve(root); return n === r || n.startsWith(r + path.sep); });
    } catch (e) { return false; }
  };
  const knownWorkspace = (id) => (ctx.workspaceRegistry.list() || [])
    .some((w) => String(w.id != null ? w.id : w.workspaceId) === String(id));

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    async handler(req, res) {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/';
        const method = (req.method || 'GET').toUpperCase();

        if (method === 'GET' && sub === '/health') {
          return json(res, 200, { ok: true, pid: process.pid, time: Date.now() });
        }

        if (method === 'GET' && sub === '/workspaces') {
          const raw = ctx.workspaceRegistry.list();
          const workspaces = (raw || []).map((w) => ({
            id: w.id != null ? w.id : w.workspaceId,
            title: w.title || (w.path ? path.basename(w.path) : ''),
            path: w.path || '',
          }));
          return json(res, 200, { ok: true, workspaces });
        }

        if (method === 'GET' && sub === '/git') {
          const dir = url.searchParams.get('path');
          if (!dir) return json(res, 400, { ok: false, error: 'path required' });
          if (!underWorkspace(dir)) return json(res, 403, { ok: false, error: 'path outside registered workspaces' });
          return json(res, 200, { ok: true, ...(await gitProbe(dir)) });
        }

        if (method === 'GET' && sub === '/board') {
          const wid = url.searchParams.get('workspaceId');
          if (!wid) return json(res, 400, { ok: false, error: 'workspaceId required' });
          if (!knownWorkspace(wid)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
          return json(res, 200, { ok: true, board: await readBoard(wid) });
        }

        if (method === 'PUT' && sub === '/board') {
          const body = await readBody(req);
          if (!body || !body.workspaceId) return json(res, 400, { ok: false, error: 'workspaceId required' });
          if (!knownWorkspace(body.workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
          await writeBoard(body.workspaceId, body.board == null ? null : body.board);
          return json(res, 200, { ok: true });
        }

        if (method === 'POST' && sub === '/start') {
          const body = await readBody(req);
          if (!body || !body.workspaceId || !body.taskId) return json(res, 400, { ok: false, error: 'workspaceId and taskId required' });
          if (!knownWorkspace(body.workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
          const ws = (ctx.workspaceRegistry.list() || []).find((w) => String(w.id != null ? w.id : w.workspaceId) === String(body.workspaceId));
          let rootDir = body.workspacePath && underWorkspace(body.workspacePath) ? body.workspacePath : (ws && ws.path);
          if (!rootDir || !underWorkspace(rootDir)) return json(res, 403, { ok: false, error: 'workspace path invalid' });
          const g = await gitProbe(rootDir);
          if (!g.isRepo) return json(res, 200, { ok: false, code: 'not_git', error: '工作区不是 Git 仓库，请先 git init 并提交一次' });
          if (!g.hasHead) return json(res, 200, { ok: false, code: 'no_head', error: '仓库没有任何提交（HEAD 不存在），无法创建工作树' });
          const task = body.task || {};
          const base = task.base || {};
          if (g.dirty && !base.ignoreDirty) return json(res, 200, { ok: false, code: 'dirty', error: '工作区有未提交改动：请先提交，或在任务里勾选「以当前 HEAD 为基线，忽略未提交改动」' });
          const ref = base.mode === 'branch' && base.branch ? base.branch : 'HEAD';
          const name = 'task-' + safeId(body.taskId);
          const wt = await createWorktree(g.root, name, ref);
          if (!wt.ok) return json(res, 200, { ok: false, code: 'worktree_failed', error: wt.error });
          let session = null, sessionError = null;
          if (body.autorun === true) {
            try {
              const loop = (typeof ctx.get === 'function') ? ctx.get('agentLoop') : undefined;
              if (!loop || typeof loop.create !== 'function') throw new Error('agentLoop unavailable');
              const sid = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : ('s-' + Date.now().toString(36) + Math.random().toString(36).slice(2));
              const agent = await loop.create(sid, {}, { cwd: wt.path });
              const mid = (globalThis.crypto && globalThis.crypto.randomUUID) ? globalThis.crypto.randomUUID() : sid;
              agent.followup({ id: mid, role: 'user', content: [{ type: 'text', text: buildPrompt(task) }], source: { kind: 'user' } });
              session = sid;
            } catch (e) { sessionError = String((e && e.message) || e); }
          }
          return json(res, 200, { ok: true, worktree: { path: wt.path, branch: wt.branch, baseCommit: wt.baseCommit }, session: session, sessionError: sessionError });
        }

        return json(res, 404, { ok: false, error: 'not found', path: sub });
      } catch (e) {
        try { json(res, 500, { ok: false, error: String((e && e.message) || e) }); } catch (e2) { /* socket gone */ }
      }
    },
  }), 'dsh-task-board: http api');
}
