import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { exec, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

export const inject = ['webServer', 'workspaceRegistry'];

const ROUTE_PREFIX = '/task-board-api';
const MAX_BODY = 5 * 1024 * 1024;
const MAX_PATCH = 2 * 1024 * 1024;
const MAX_DIFF_PROMPT = 40 * 1024;
const QUEUE_CAP = 50;
const GLOBAL_RUN_CAP = 4;
const REVIEW_LIMIT_MINUTES = 15;
const PR_TIMEOUT_MS = 90000;
const VERIFY_TIMEOUT_MS = 120000;
const VERIFY_MAX_OUTPUT = 20000;
const EVIDENCE_MAX = 30;
const EVIDENCE_TEXT_MAX = 500;
const VERIFY_RECORD_MAX = 20;
const AUDIT_DEFAULT_LIMIT = 100;
const AUDIT_MAX_LIMIT = 500;

const DEFAULT_SETTINGS = {
  concurrency: 2,
  reviewConcurrency: 2,
  maxRounds: 3,
  maxMinutesPerRun: 20,
  maxMinutesPerTask: 60,
  maxTokensPerTask: 600000,
  hiddenVerify: [],
  authToken: '',
  prMode: 'auto',
  pushConsent: 'first',
  localSignoffMerge: false,
  patchExport: true,
};

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

function pickNextIndex(queue) {
  let best = 0;
  for (let i = 1; i < queue.length; i += 1) {
    const rank = PRIORITY_RANK[queue[i] && queue[i].priority] ?? 4;
    const bestRank = PRIORITY_RANK[queue[best] && queue[best].priority] ?? 4;
    if (rank < bestRank) best = i;
  }
  return best;
}

const LIVE_STATUS = new Set([
  'queued', 'worktree_preparing', 'running', 'needs_input', 'awaiting_approval',
  'changes_requested', 'awaiting_review', 'reviewing', 'finalizing',
]);

const VALID_STATUS = new Set([
  'todo', 'done', 'blocked', 'failed', 'cancelled', 'awaiting_signoff',
  'pr_pending', 'finalize_failed', ...LIVE_STATUS,
]);

const ATTENTION_STATUS = new Set([
  'needs_input', 'awaiting_approval', 'awaiting_signoff', 'pr_pending',
  'finalize_failed', 'blocked', 'failed',
]);

const TRANSITIONS = {
  start: { todo: 'queued', blocked: 'queued', failed: 'queued', cancelled: 'queued' },
  begin: {
    todo: 'worktree_preparing', blocked: 'worktree_preparing', failed: 'worktree_preparing',
    cancelled: 'worktree_preparing', queued: 'worktree_preparing',
  },
  worktree: { worktree_preparing: 'running' },
  submit: { running: 'awaiting_review' },
  review: { awaiting_review: 'reviewing' },
  changes: { reviewing: 'changes_requested' },
  resume: { changes_requested: 'running' },
  pass: { reviewing: 'finalizing' },
  finalize: { finalizing: 'awaiting_signoff' },
  pr_pending: { finalizing: 'pr_pending' },
  finalize_failed: { finalizing: 'finalize_failed' },
  input: { running: 'needs_input', reviewing: 'needs_input' },
  approval: { running: 'awaiting_approval', reviewing: 'awaiting_approval' },
  approve: { awaiting_approval: 'running' },
  answer: { needs_input: 'running' },
  cancel: {
    queued: 'cancelled', worktree_preparing: 'cancelled', running: 'cancelled',
    needs_input: 'cancelled', awaiting_approval: 'cancelled', changes_requested: 'cancelled',
    awaiting_review: 'cancelled', reviewing: 'cancelled', finalizing: 'cancelled',
  },
  signoff: { awaiting_signoff: 'done', pr_pending: 'done' },
  reject: { awaiting_signoff: 'changes_requested', pr_pending: 'changes_requested' },
  block: {
    queued: 'blocked', worktree_preparing: 'blocked', running: 'blocked', needs_input: 'blocked',
    changes_requested: 'blocked', awaiting_review: 'blocked', reviewing: 'blocked', finalizing: 'blocked',
  },
  fail: {
    queued: 'failed', worktree_preparing: 'failed', running: 'failed', awaiting_review: 'failed',
    reviewing: 'failed', changes_requested: 'failed', finalizing: 'failed',
  },
  retry: { blocked: 'queued', failed: 'queued', cancelled: 'queued' },
};

const CLIENT_FIELDS = ['title', 'description', 'acceptance', 'labels', 'priority', 'due', 'executor', 'reviewer', 'budget', 'base', 'verify', 'blockedBy'];
const HOST_FIELDS = ['status', 'round', 'error', 'runs', 'reviews', 'delivery', 'pr', 'pending', 'signoff', 'updatedAt'];

function newId() {
  try { return randomUUID(); } catch (e) { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
}

function isoNow() {
  return new Date().toISOString();
}

function asText(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max || 4000);
}

function asTextList(value, maxItems, maxLen) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, maxItems || 20)) {
    const text = asText(item, maxLen || 500).trim();
    if (text) out.push(text);
  }
  return out;
}

function hashText(text) {
  try { return createHash('sha1').update(String(text || '')).digest('hex'); }
  catch (e) { return ''; }
}

function normalizeEvidenceItem(item) {
  if (typeof item === 'string') {
    const text = asText(item, EVIDENCE_TEXT_MAX).trim();
    return text ? { type: 'note', text } : null;
  }
  if (!item || typeof item !== 'object') return null;
  const type = item.type === 'verification' ? 'verification' : 'note';
  if (type === 'verification') {
    const command = asText(item.command, EVIDENCE_TEXT_MAX).trim();
    if (!command) return null;
    const normalized = { type, command, exitCode: asInt(item.exitCode, -1) };
    if (item.at) normalized.at = asText(item.at, 64);
    if (item.summary) normalized.summary = asText(item.summary, EVIDENCE_TEXT_MAX).trim();
    return normalized;
  }
  const text = asText(item.text, EVIDENCE_TEXT_MAX).trim();
  return text ? { type: 'note', text } : null;
}

function normalizeEvidence(value, maxItems) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, maxItems || EVIDENCE_MAX)) {
    const normalized = normalizeEvidenceItem(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function evidenceFromVerifications(verifications) {
  if (!Array.isArray(verifications)) return [];
  return verifications.slice(-VERIFY_RECORD_MAX).map((item) => ({
    type: 'verification',
    command: asText(item && item.command, EVIDENCE_TEXT_MAX).trim(),
    exitCode: asInt(item && item.exitCode, -1),
    at: item && item.at ? String(item.at) : isoNow(),
    ...(item && item.summary ? { summary: asText(item.summary, EVIDENCE_TEXT_MAX).trim() } : {}),
  })).filter((item) => item.command);
}

function normalizeVerifications(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-VERIFY_RECORD_MAX).map((item) => ({
    command: asText(item && item.command, EVIDENCE_TEXT_MAX).trim(),
    exitCode: asInt(item && item.exitCode, -1),
    at: item && item.at ? String(item.at) : null,
    summary: item && item.summary ? asText(item.summary, EVIDENCE_TEXT_MAX).trim() : '',
    hash: item && item.hash ? String(item.hash).slice(0, 64) : '',
  })).filter((item) => item.command);
}

function mergeEvidence(value, verifications) {
  const merged = normalizeEvidence(value, EVIDENCE_MAX);
  for (const item of evidenceFromVerifications(verifications)) {
    if (merged.length >= EVIDENCE_MAX) break;
    merged.push(item);
  }
  return merged;
}

function verificationSummary(verifications) {
  const list = Array.isArray(verifications)
    ? verifications.filter((item) => item && item.command)
    : [];
  return {
    ran: list.length > 0,
    passed: list.length > 0 && list.every((item) => asInt(item.exitCode, -1) === 0),
    commands: list.slice(-10).map((item) => ({
      command: asText(item.command, EVIDENCE_TEXT_MAX),
      exitCode: asInt(item.exitCode, -1),
      at: item.at ? String(item.at) : null,
    })),
  };
}

function normalizeVerification(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    ran: source.ran === true,
    passed: source.passed === true,
    commands: Array.isArray(source.commands)
      ? source.commands.slice(0, 10).map((item) => ({
        command: asText(item && item.command, EVIDENCE_TEXT_MAX),
        exitCode: asInt(item && item.exitCode, -1),
        at: item && item.at ? String(item.at) : null,
      })).filter((item) => item.command)
      : [],
  };
}

function closeOpenMustFix(task, review) {
  if (!task || !Array.isArray(task.reviews)) return;
  for (const previous of task.reviews) {
    if (!previous || !Array.isArray(previous.mustFix)) continue;
    for (const item of previous.mustFix) {
      if (item && item.status !== 'closed') {
        item.status = 'closed';
        item.closedAt = isoNow();
        item.closedByReview = review && review.id ? review.id : null;
      }
    }
  }
}

function asInt(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = asInt(value, fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function safeId(id) {
  return String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'unknown';
}

function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'task-board');
}

function boardFile(workspaceId) {
  return path.join(dataDir(), safeId(workspaceId) + '.json');
}

function auditFile(workspaceId) {
  return path.join(dataDir(), safeId(workspaceId) + '.audit.jsonl');
}

function archiveFile(workspaceId) {
  return path.join(dataDir(), safeId(workspaceId) + '.archive.json');
}

async function appendArchive(workspaceId, task) {
  const file = archiveFile(workspaceId);
  let list = [];
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.cards) ? parsed.cards : []);
  } catch (e) { list = []; }
  list.push({ archivedAt: isoNow(), task });
  await fs.mkdir(dataDir(), { recursive: true });
  const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(list), 'utf8');
  await fs.rename(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function execFileAsync(file, args, options) {
  return new Promise((resolve) => {
    execFile(file, args, Object.assign({ windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, options || {}), (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: err ? String(stderr || err.message || 'command failed').trim() : '',
      });
    });
  });
}

function git(args, cwd, timeout) {
  return execFileAsync('git', args, { cwd, timeout: timeout || 30000 });
}

function gitOutput(result) {
  return String(result.stdout || '').trim();
}

async function pathExists(target) {
  try { await fs.stat(target); return true; }
  catch (e) { return false; }
}

async function gitProbe(dir) {
  if (!dir) return { isRepo: false, reason: 'path required' };
  const top = await git(['rev-parse', '--show-toplevel'], dir);
  if (!top.ok) {
    return { isRepo: false, reason: (top.stderr || top.error || 'not a git repository').trim() };
  }
  const root = gitOutput(top);
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root);
  const head = await git(['rev-parse', '--verify', 'HEAD'], root);
  const status = await git(['status', '--porcelain'], root);
  const remote = await git(['remote', '-v'], root);
  const gitDir = await git(['rev-parse', '--git-dir'], root);
  const commonDir = await git(['rev-parse', '--git-common-dir'], root);
  let isLinkedWorktree = false;
  if (gitDir.ok && commonDir.ok) {
    const a = path.resolve(root, gitOutput(gitDir));
    const b = path.resolve(root, gitOutput(commonDir));
    isLinkedWorktree = a !== b;
  }
  const dirtyLines = gitOutput(status) ? gitOutput(status).split('\n') : [];
  return {
    isRepo: true,
    root,
    branch: gitOutput(branch) || null,
    hasHead: head.ok,
    dirty: dirtyLines.length > 0,
    dirtyCount: dirtyLines.length,
    hasRemote: gitOutput(remote).length > 0,
    isLinkedWorktree,
  };
}

async function prepareWorktree(root, taskId, base) {
  const shortId = safeId(taskId);
  const worktreePath = path.join(root, '.agents', 'worktrees', 'task-' + shortId);
  const branch = 'task-' + shortId;
  if (await pathExists(worktreePath)) {
    const probe = await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    if (probe.ok) {
      const currentBranch = gitOutput(probe);
      const head = await git(['rev-parse', '--verify', 'HEAD'], worktreePath);
      return {
        ok: true,
        path: worktreePath,
        branch: currentBranch && currentBranch !== 'HEAD' ? currentBranch : branch,
        baseCommit: head.ok ? gitOutput(head) : null,
        reused: true,
      };
    }
    await git(['worktree', 'prune'], root);
    if (await pathExists(worktreePath)) {
      try { await fs.rm(worktreePath, { recursive: true, force: true }); } catch (e) { }
    }
  }
  const baseMode = base && base.mode === 'branch' && base.branch ? String(base.branch) : 'HEAD';
  const rev = await git(['rev-parse', '--verify', baseMode], root);
  if (!rev.ok) return { ok: false, error: '基线不存在：' + baseMode };
  const baseCommit = gitOutput(rev);
  try { await fs.mkdir(path.dirname(worktreePath), { recursive: true }); } catch (e) { }
  const branchExists = await git(['rev-parse', '--verify', 'refs/heads/' + branch], root);
  const add = branchExists.ok
    ? await git(['worktree', 'add', worktreePath, branch], root, 120000)
    : await git(['worktree', 'add', '-b', branch, worktreePath, baseMode], root, 120000);
  if (!add.ok) return { ok: false, error: (add.stderr || add.error || 'git worktree add 失败').trim() };
  return { ok: true, path: worktreePath, branch, baseCommit, reused: false };
}

async function collectDiff(worktreePath, baseCommit) {
  const base = baseCommit || 'HEAD';
  const stat = await git(['diff', base + '..HEAD', '--stat'], worktreePath, 60000);
  const diff = await git(['diff', base + '..HEAD'], worktreePath, 60000);
  return {
    ok: stat.ok && diff.ok,
    stat: stat.ok ? stat.stdout.trim() : '',
    diff: diff.ok ? diff.stdout : '',
    error: stat.ok && diff.ok ? '' : (stat.error || diff.error || 'git diff 失败'),
  };
}

function buildPrompt(task) {
  const lines = ['你是一个自动化执行代理。请只在当前 Git 工作树中完成任务，只改必要的文件。'];
  lines.push('任务：' + (task.title || '(未命名任务)'));
  if (task.description) lines.push('描述：' + task.description);
  if (task.acceptance) lines.push('验收标准：' + task.acceptance);
  lines.push('完成后请简要汇报：改了哪些文件、如何验证。');
  return lines.join('\n');
}

function buildExecutePrompt(task) {
  return buildPrompt(task) + '\n完成后请把改动提交到当前分支，然后必须调用 submit_for_review 工具提交评审（summary 写明改了什么、如何验证；evidence 可选列出验证命令或结果）。不要自行宣布完成。';
}

function renderEvidenceLines(evidence) {
  return normalizeEvidence(evidence, 10).map((item) => (item.type === 'verification'
    ? '- 验证：' + item.command + '（exit ' + item.exitCode + '）' + (item.summary ? '：' + item.summary : '')
    : '- 记录：' + item.text));
}

function buildReviewHandoff(task, execRun, hostVerifications) {
  const execution = {
    summary: asText(execRun && execRun.summary, 2000),
    evidence: execRun && Array.isArray(execRun.evidence) ? execRun.evidence : [],
  };
  let previous = null;
  if (task && Array.isArray(task.reviews)) {
    for (let i = task.reviews.length - 1; i >= 0; i -= 1) {
      const review = task.reviews[i];
      if (review && review.verdict === 'changes') {
        previous = { round: review.round, mustFix: Array.isArray(review.mustFix) ? review.mustFix : [] };
        break;
      }
    }
  }
  return { execution, previous, verification: Array.isArray(hostVerifications) ? hostVerifications : [] };
}

function buildReviewPrompt(task, diff, handoff) {
  const lines = [
    '你是一名独立评审代理。你只能读取文件、检索代码、运行白名单内的验证命令，不能修改任何文件。',
    '任务：' + (task.title || '(未命名任务)'),
  ];
  if (task.description) lines.push('描述：' + task.description);
  if (task.acceptance) lines.push('验收标准：' + task.acceptance);
  lines.push('变更统计：');
  lines.push(diff.stat || '(无已提交差异)');
  lines.push('变更内容（超过 40KB 已截断）：');
  lines.push(diff.text || '(无已提交差异)');
  const execution = handoff && handoff.execution ? handoff.execution : null;
  if (execution) {
    lines.push('执行方交接（本轮）：' + (execution.summary || '（执行方未提供摘要）'));
    const evidenceLines = renderEvidenceLines(execution.evidence);
    if (evidenceLines.length) {
      lines.push('执行方声明的证据：');
      evidenceLines.forEach((line) => lines.push(line));
    }
  }
  const hostVerification = handoff && Array.isArray(handoff.verification) ? handoff.verification : [];
  if (hostVerification.length) {
    lines.push('Host 机器验证（自动执行，权威结论）：');
    hostVerification.forEach((item) => lines.push('- ' + item.command + ' → exit ' + item.exitCode + (item.summary ? '：' + item.summary : '')));
    if (hostVerification.some((item) => Number(item.exitCode) !== 0)) {
      lines.push('注意：存在非 0 退出码的机器验证，通过前必须处理。');
    }
  }
  const previous = handoff && handoff.previous ? handoff.previous : null;
  if (previous && Array.isArray(previous.mustFix) && previous.mustFix.length) {
    lines.push('上一轮评审（第 ' + (previous.round || '?') + ' 轮）要求修复的项，请逐条确认是否已落实；未落实的重新列为 mustFix：');
    previous.mustFix.slice(0, 20).forEach((item, index) => {
      const where = item.file ? item.file + (item.line ? ':' + item.line : '') : '未指明位置';
      lines.push((index + 1) + '. [' + (item.severity || 'major') + '] ' + where + ' ' + (item.issue || '') + (item.status === 'closed' ? '（已关闭）' : '（未关闭）') + (item.suggestion ? '（建议：' + item.suggestion + '）' : ''));
    });
  }
  lines.push('请对照验收标准检查改动，实际运行可用的验证命令（npm test / npm run build / npm run lint / git diff 等），逐条确认验收项。');
  lines.push('给出结论前必须实际运行验证，并在 evidence 中列出证据（命令与结果）；没有任何证据的 pass 会被拒绝。');
  lines.push('最后必须调用 review_verdict 工具给出结论：通过用 pass；不通过用 changes，并在 mustFix 中按 file/line/severity/issue/suggestion 列出必须修复项。不要只回复文字。');
  return lines.join('\n');
}

function buildChangesPrompt(task, review) {
  const lines = ['评审未通过（当前第 ' + (task.round + 1) + ' 轮）。请逐条修复以下 mustFix 后重新提交评审。'];
  const mustFix = Array.isArray(review.mustFix) ? review.mustFix : [];
  if (!mustFix.length) lines.push('- 评审未给出具体 mustFix，请自行复核验收标准。');
  mustFix.forEach((item, index) => {
    const where = item.file ? item.file + (item.line ? ':' + item.line : '') : '未指明位置';
    lines.push((index + 1) + '. [' + (item.severity || 'major') + '] ' + where + ' ' + (item.issue || '') + (item.suggestion ? '（建议：' + item.suggestion + '）' : ''));
  });
  if (Array.isArray(review.nits) && review.nits.length) {
    lines.push('可选改进：');
    review.nits.forEach((nit) => lines.push('- ' + nit));
  }
  lines.push('修复后请提交改动，并再次调用 submit_for_review。');
  return lines.join('\n');
}

function buildRejectPrompt(note) {
  return '人工签字打回。' + (note ? '意见：' + note : '请按评审记录继续完善。') + '\n请修改后提交，并再次调用 submit_for_review 提交评审。';
}

function buildPrPrompt(task, branch) {
  const lines = [
    '评审已通过，请为该任务创建 Pull Request，不要修改代码内容。',
    '任务：' + (task.title || '(未命名任务)'),
    '当前分支：' + (branch || '(当前分支)'),
    '步骤：确认分支已推送到 origin（git push -u origin ' + (branch || '当前分支') + '），然后运行 gh pr create，标题使用任务标题，正文包含任务描述与验收标准、以及执行阶段的验证说明。',
    '完成后在回复中给出 PR 的完整 URL。',
  ];
  return lines.join('\n');
}

function userMessage(text) {
  return {
    id: newId(),
    role: 'user',
    content: [{ type: 'text', text: String(text || '') }],
    source: { kind: 'user' },
  };
}

const VERIFY_PREFIXES = [
  'node --check', 'npm test', 'npm run build', 'npm run lint', 'pnpm test', 'yarn test',
  'pytest', 'go test', 'cargo test', 'cargo check', 'git status', 'git diff', 'git log',
];

function isVerificationCommand(command) {
  const text = String(command || '').trim();
  if (!text) return false;
  return VERIFY_PREFIXES.some((prefix) => text === prefix || text.startsWith(prefix + ' '));
}

function runVerification(command, cwd) {
  return new Promise((resolve) => {
    const text = String(command || '').trim();
    if (!isVerificationCommand(text)) {
      resolve({ exitCode: 126, stdout: '', stderr: '命令不在白名单内' });
      return;
    }
    if (/[;&|`$<>\n\r]/.test(text)) {
      resolve({ exitCode: 126, stdout: '', stderr: '命令包含不允许的字符' });
      return;
    }
    exec(text, { cwd, timeout: VERIFY_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '').slice(0, VERIFY_MAX_OUTPUT);
      const errOut = String(stderr || '').slice(0, VERIFY_MAX_OUTPUT);
      let code = 0;
      if (err) {
        if (err.killed) code = 124;
        else code = typeof err.code === 'number' ? err.code : 1;
      }
      resolve({ exitCode: code, stdout: out, stderr: errOut });
    });
  });
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    concurrency: clampInt(source.concurrency, 1, 8, DEFAULT_SETTINGS.concurrency),
    reviewConcurrency: clampInt(source.reviewConcurrency, 1, 8, DEFAULT_SETTINGS.reviewConcurrency),
    maxRounds: clampInt(source.maxRounds, 1, 8, DEFAULT_SETTINGS.maxRounds),
    maxMinutesPerRun: clampInt(source.maxMinutesPerRun, 1, 120, DEFAULT_SETTINGS.maxMinutesPerRun),
    maxMinutesPerTask: clampInt(source.maxMinutesPerTask, 1, 480, DEFAULT_SETTINGS.maxMinutesPerTask),
    maxTokensPerTask: clampInt(source.maxTokensPerTask, 1000, 6000000, DEFAULT_SETTINGS.maxTokensPerTask),
    hiddenVerify: Array.isArray(source.hiddenVerify) ? source.hiddenVerify.slice(0, VERIFY_RECORD_MAX).map((cmd) => asText(cmd, 1000).trim()).filter(Boolean) : [],
    authToken: asText(source.authToken, 200).trim(),
    prMode: ['auto', 'local', 'manual'].includes(source.prMode) ? source.prMode : DEFAULT_SETTINGS.prMode,
    pushConsent: ['first', 'always', 'never'].includes(source.pushConsent) ? source.pushConsent : DEFAULT_SETTINGS.pushConsent,
    localSignoffMerge: source.localSignoffMerge === true,
    patchExport: source.patchExport !== false,
  };
}

function normalizeBudget(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const budget = {};
  if (source.maxRounds !== undefined) budget.maxRounds = clampInt(source.maxRounds, 1, 8, DEFAULT_SETTINGS.maxRounds);
  if (source.maxTokens !== undefined) budget.maxTokens = clampInt(source.maxTokens, 1000, 4000000, 200000);
  if (source.maxMinutes !== undefined) budget.maxMinutes = clampInt(source.maxMinutes, 1, 480, DEFAULT_SETTINGS.maxMinutesPerRun);
  return budget;
}

function normalizeBase(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    mode: source.mode === 'branch' ? 'branch' : 'head',
    branch: source.branch ? String(source.branch) : null,
    commit: source.commit ? String(source.commit) : null,
    ignoreDirty: source.ignoreDirty === true,
  };
}

function normalizeVerify(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, VERIFY_RECORD_MAX)
    .map((item) => asText(typeof item === 'string' ? item : (item && item.command), 1000).trim())
    .filter(Boolean);
}

function normalizeRun(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const worktree = source.worktree && typeof source.worktree === 'object'
    ? {
      path: source.worktree.path ? String(source.worktree.path) : null,
      branch: source.worktree.branch ? String(source.worktree.branch) : null,
      baseCommit: source.worktree.baseCommit ? String(source.worktree.baseCommit) : null,
    }
    : null;
  return {
    id: source.id ? String(source.id) : newId(),
    kind: source.kind === 'review' ? 'review' : 'execute',
    attempt: Math.max(1, asInt(source.attempt, 1)),
    sessionId: source.sessionId ? String(source.sessionId) : null,
    model: source.model ? String(source.model) : '',
    worktree,
    status: ['running', 'done', 'failed', 'cancelled'].includes(source.status) ? source.status : 'done',
    startedAt: source.startedAt ? String(source.startedAt) : null,
    endedAt: source.endedAt ? String(source.endedAt) : null,
    summary: source.summary ? String(source.summary) : '',
    evidence: normalizeEvidence(source.evidence, EVIDENCE_MAX),
    verifications: normalizeVerifications(source.verifications),
    tokens: Math.max(0, asInt(source.tokens, 0)),
    error: source.error ? String(source.error) : null,
  };
}

function normalizeReview(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: source.id ? String(source.id) : newId(),
    round: Math.max(0, asInt(source.round, 0)),
    sessionId: source.sessionId ? String(source.sessionId) : null,
    reviewerModel: source.reviewerModel ? String(source.reviewerModel) : '',
    verdict: ['pass', 'changes', 'none'].includes(source.verdict) ? source.verdict : 'none',
    mustFix: Array.isArray(source.mustFix)
      ? source.mustFix.slice(0, 50).map((item) => ({
        file: item && item.file ? String(item.file) : '',
        line: item && item.line !== undefined && item.line !== null ? asInt(item.line, 0) : 0,
        severity: item && item.severity ? String(item.severity) : 'major',
        issue: item && item.issue ? String(item.issue) : '',
        suggestion: item && item.suggestion ? String(item.suggestion) : '',
        status: item && item.status === 'closed' ? 'closed' : 'open',
        closedAt: item && item.closedAt ? String(item.closedAt) : null,
        closedByReview: item && item.closedByReview ? String(item.closedByReview) : null,
      }))
      : [],
    nits: asTextList(source.nits, 30, 500),
    evidence: normalizeEvidence(source.evidence, EVIDENCE_MAX),
    verification: normalizeVerification(source.verification),
    startedAt: source.startedAt ? String(source.startedAt) : null,
    endedAt: source.endedAt ? String(source.endedAt) : null,
    note: source.note ? String(source.note) : null,
  };
}

function normalizeTask(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    id: source.id !== undefined && source.id !== null ? String(source.id) : newId(),
    title: asText(source.title, 400),
    description: asText(source.description, 20000),
    acceptance: asText(source.acceptance, 20000),
    labels: Array.isArray(source.labels) ? source.labels.slice(0, 30).map((label) => String(label).slice(0, 60)) : [],
    priority: ['none', 'low', 'medium', 'high', 'urgent'].includes(source.priority) ? source.priority : 'none',
    due: source.due === undefined ? null : source.due,
    executor: asText(source.executor, 120),
    reviewer: asText(source.reviewer, 120),
    budget: normalizeBudget(source.budget),
    base: normalizeBase(source.base),
    verify: normalizeVerify(source.verify),
    blockedBy: Array.isArray(source.blockedBy) ? source.blockedBy.slice(0, 50).map((id) => String(id)).filter(Boolean) : [],
    status: VALID_STATUS.has(source.status) ? source.status : 'todo',
    round: Math.max(0, asInt(source.round, 0)),
    error: source.error ? String(source.error) : null,
    runs: Array.isArray(source.runs) ? source.runs.map(normalizeRun) : [],
    reviews: Array.isArray(source.reviews) ? source.reviews.map(normalizeReview) : [],
    delivery: source.delivery && typeof source.delivery === 'object' ? Object.assign({}, source.delivery) : null,
    pr: source.pr && typeof source.pr === 'object' ? Object.assign({}, source.pr) : null,
    pending: source.pending && typeof source.pending === 'object'
      ? {
        kind: source.pending.kind === 'awaiting_approval' ? 'awaiting_approval' : 'needs_input',
        runId: source.pending.runId ? String(source.pending.runId) : null,
        question: source.pending.question ? String(source.pending.question) : '',
      }
      : null,
    signoff: source.signoff && typeof source.signoff === 'object'
      ? {
        by: source.signoff.by ? String(source.signoff.by) : 'user',
        at: source.signoff.at ? String(source.signoff.at) : null,
        note: source.signoff.note ? String(source.signoff.note) : '',
        reviewId: source.signoff.reviewId ? String(source.signoff.reviewId) : null,
        verification: source.signoff.verification ? normalizeVerification(source.signoff.verification) : null,
      }
      : null,
    updatedAt: source.updatedAt ? String(source.updatedAt) : isoNow(),
  };
}

function emptyBoard() {
  return { version: 3, revision: 0, seq: 0, settings: normalizeSettings(null), cards: [] };
}

function normalizeBoard(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 3,
    revision: Math.max(0, asInt(source.revision, 0)),
    seq: Math.max(0, asInt(source.seq, 0)),
    settings: normalizeSettings(source.settings),
    cards: Array.isArray(source.cards) ? source.cards.map(normalizeTask) : [],
  };
}

async function readBoard(workspaceId) {
  const file = boardFile(workspaceId);
  let raw;
  try { raw = await fs.readFile(file, 'utf8'); }
  catch (e) { return null; }
  try { return normalizeBoard(JSON.parse(raw)); }
  catch (e) {
    const backup = file + '.corrupt-' + Date.now() + '.bak';
    try {
      await fs.copyFile(file, backup);
      console.warn('[dsh-task-board] 看板 JSON 损坏，已备份到 ' + backup);
    } catch (copyError) {
      console.warn('[dsh-task-board] 看板 JSON 损坏且备份失败: ' + String((copyError && copyError.message) || copyError));
    }
    return null;
  }
}

async function readAudit(workspaceId, options) {
  const limit = clampInt(options && options.limit, 1, AUDIT_MAX_LIMIT, AUDIT_DEFAULT_LIMIT);
  const taskId = options && options.taskId ? String(options.taskId) : null;
  let raw;
  try { raw = await fs.readFile(auditFile(workspaceId), 'utf8'); }
  catch (e) { return { entries: [], count: 0 }; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== 'object') continue;
      if (taskId && String(entry.taskId || '') !== taskId) continue;
      entries.push(entry);
    } catch (e) { }
  }
  return { entries: entries.slice(-limit), count: entries.length };
}

function ratio(part, total) {
  return total > 0 ? Math.round((part / total) * 1000) / 1000 : null;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function computeStats(board, auditEntries, runtime) {
  const cards = Array.isArray(board.cards) ? board.cards : [];
  const byStatus = {};
  for (const status of VALID_STATUS) byStatus[status] = 0;
  for (const card of cards) byStatus[card.status] = (byStatus[card.status] || 0) + 1;
  const reviewed = cards.filter((card) => Array.isArray(card.reviews) && card.reviews.length > 0);
  const firstPassTasks = reviewed.filter((card) => card.reviews[0] && card.reviews[0].verdict === 'pass').length;
  const reworkTasks = reviewed.filter((card) => card.reviews.some((review) => review && review.verdict === 'changes') || card.reviews.length > 1).length;
  const verifiedTasks = reviewed.filter((card) => card.reviews.some((review) => review && review.verification && review.verification.ran)).length;
  const signedOff = cards.filter((card) => card.signoff && card.signoff.at);
  const mergedTasks = cards.filter((card) => (card.delivery && card.delivery.mergedAt) || (card.pr && card.pr.state === 'merged')).length;
  const roundCounts = signedOff.map((card) => (Array.isArray(card.reviews) ? card.reviews.length : 0));
  const avgRounds = roundCounts.length
    ? Math.round((roundCounts.reduce((sum, value) => sum + value, 0) / roundCounts.length) * 100) / 100
    : null;
  const cycles = [];
  for (const card of cards) {
    if (card.status !== 'done' || !card.signoff || !card.signoff.at) continue;
    const firstRun = (Array.isArray(card.runs) ? card.runs : []).find((run) => run && run.kind === 'execute' && run.startedAt);
    const start = firstRun ? Date.parse(firstRun.startedAt) : NaN;
    const end = Date.parse(card.signoff.at);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) cycles.push(end - start);
  }
  const tokensByModel = new Map();
  let tokensTotal = 0;
  let runTotal = 0;
  let runExecute = 0;
  let runReview = 0;
  let runFailed = 0;
  let runCancelled = 0;
  let tasksWithTokens = 0;
  for (const card of cards) {
    let taskTokens = 0;
    for (const run of Array.isArray(card.runs) ? card.runs : []) {
      if (!run) continue;
      runTotal += 1;
      if (run.kind === 'review') runReview += 1; else runExecute += 1;
      if (run.status === 'failed') runFailed += 1;
      if (run.status === 'cancelled') runCancelled += 1;
      const tokens = Math.max(0, asInt(run.tokens, 0));
      if (tokens > 0) {
        taskTokens += tokens;
        tokensTotal += tokens;
        const model = run.model || '（宿主默认）';
        tokensByModel.set(model, (tokensByModel.get(model) || 0) + tokens);
      }
    }
    if (taskTokens > 0) tasksWithTokens += 1;
  }
  const auditList = Array.isArray(auditEntries) ? auditEntries : [];
  const countAction = (action) => auditList.filter((entry) => entry && entry.action === action).length;
  const answers = countAction('answer');
  const signoffs = countAction('signoff');
  const rejects = countAction('reject');
  const retries = countAction('retry');
  const health = {
    needsInput: cards.filter((card) => card.status === 'needs_input').length,
    awaitingApproval: cards.filter((card) => card.status === 'awaiting_approval').length,
    prPending: cards.filter((card) => card.status === 'pr_pending').length,
    finalizeFailed: cards.filter((card) => card.status === 'finalize_failed').length,
    blocked: cards.filter((card) => card.status === 'blocked').length,
    failed: cards.filter((card) => card.status === 'failed').length,
  };
  return {
    generatedAt: isoNow(),
    revision: board.revision,
    cards: {
      total: cards.length,
      byStatus,
      attention: cards.filter((card) => ATTENTION_STATUS.has(card.status)).length,
      live: cards.filter((card) => LIVE_STATUS.has(card.status)).length,
      done: byStatus.done || 0,
    },
    review: {
      reviewedTasks: reviewed.length,
      firstPassTasks,
      reworkTasks,
      firstPassRate: ratio(firstPassTasks, reviewed.length),
      reworkRate: ratio(reworkTasks, reviewed.length),
      verifiedTasks,
      verificationCoverage: ratio(verifiedTasks, reviewed.length),
    },
    delivery: { signoffTasks: signedOff.length, mergedTasks, avgRoundsToSignoff: avgRounds },
    cycle: {
      sampledTasks: cycles.length,
      avgMs: cycles.length ? Math.round(cycles.reduce((sum, value) => sum + value, 0) / cycles.length) : null,
      p50Ms: percentile(cycles, 50),
      p90Ms: percentile(cycles, 90),
    },
    tokens: {
      total: tokensTotal,
      byModel: [...tokensByModel.entries()]
        .map(([model, tokens]) => ({ model, tokens }))
        .sort((a, b) => b.tokens - a.tokens)
        .slice(0, 12),
      avgPerTask: tasksWithTokens ? Math.round(tokensTotal / tasksWithTokens) : null,
      tasksWithTokens,
    },
    runs: {
      total: runTotal,
      execute: runExecute,
      review: runReview,
      failed: runFailed,
      cancelled: runCancelled,
    },
    human: {
      answers,
      signoffs,
      rejects,
      retries,
      interventions: answers + signoffs + rejects + retries,
    },
    queue: {
      waiting: runtime && Number.isFinite(Number(runtime.waiting)) ? Number(runtime.waiting) : 0,
      running: runtime && Number.isFinite(Number(runtime.running)) ? Number(runtime.running) : 0,
    },
    health,
  };
}

async function writeBoard(workspaceId, board) {
  const dir = dataDir();
  await fs.mkdir(dir, { recursive: true });
  const target = boardFile(workspaceId);
  const tmp = target + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(board), 'utf8');
  await fs.rename(tmp, target);
}

async function appendAudit(workspaceId, entry) {
  try {
    await fs.mkdir(dataDir(), { recursive: true });
    await fs.appendFile(auditFile(workspaceId), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) { }
}

async function ensureBoard(workspaceId) {
  const board = await readBoard(workspaceId);
  return board || emptyBoard();
}

async function saveBoard(workspaceId, board, audit) {
  board.version = 3;
  board.settings = normalizeSettings(board.settings);
  board.revision = Math.max(0, asInt(board.revision, 0)) + 1;
  board.seq = Math.max(0, asInt(board.seq, 0)) + 1;
  await writeBoard(workspaceId, board);
  if (audit) await appendAudit(workspaceId, audit);
  return board;
}

function auditEntry(actor, action, task, from, to, extra) {
  return {
    ts: isoNow(),
    actor: actor || 'host',
    action,
    taskId: task ? task.id : null,
    from: from || null,
    to: to || null,
    ...(extra && extra.reason ? { reason: String(extra.reason).slice(0, 2000) } : {}),
    ...(extra && extra.runId ? { runId: extra.runId } : {}),
    ...(extra && extra.reviewId ? { reviewId: String(extra.reviewId).slice(0, 80) } : {}),
    ...(extra && extra.model ? { model: String(extra.model).slice(0, 120) } : {}),
    ...(extra && extra.commit ? { commit: String(extra.commit).slice(0, 64) } : {}),
    ...(extra && extra.verification && typeof extra.verification === 'object'
      ? {
        verification: {
          ran: extra.verification.ran === true,
          passed: extra.verification.passed === true,
          commands: Array.isArray(extra.verification.commands) ? extra.verification.commands.length : 0,
        },
      }
      : {}),
  };
}

function confirmTransition(action, from) {
  const row = TRANSITIONS[action];
  if (!row || !from) return null;
  return Object.prototype.hasOwnProperty.call(row, from) ? row[from] : null;
}

function findTask(board, taskId) {
  if (!board || !Array.isArray(board.cards)) return null;
  return board.cards.find((card) => card && card.id === taskId) || null;
}

function latestExecuteWorktree(task) {
  if (!task || !Array.isArray(task.runs)) return null;
  for (let i = task.runs.length - 1; i >= 0; i -= 1) {
    const run = task.runs[i];
    if (run.kind === 'execute' && run.worktree && run.worktree.path) return run.worktree;
  }
  return null;
}

function countExecuteRuns(task) {
  return Array.isArray(task.runs) ? task.runs.filter((run) => run.kind === 'execute').length : 0;
}

function makeRun(spec) {
  return {
    id: spec.id || newId(), kind: spec.kind, attempt: spec.attempt || 1, sessionId: spec.sessionId || null,
    model: spec.model || '', worktree: spec.worktree || null, status: spec.status || 'running',
    startedAt: spec.startedAt || isoNow(), endedAt: spec.endedAt || null, summary: spec.summary || '',
    evidence: spec.evidence || [], tokens: spec.tokens || 0, error: spec.error || null,
  };
}

function makeReview(spec) {
  return {
    id: spec.id || newId(), round: spec.round || 0, sessionId: spec.sessionId || null,
    reviewerModel: spec.reviewerModel || '', verdict: spec.verdict || 'none',
    mustFix: spec.mustFix || [], nits: spec.nits || [], evidence: spec.evidence || [],
    startedAt: spec.startedAt || null, endedAt: spec.endedAt || isoNow(), note: spec.note || null,
  };
}

function mergeIncomingBoard(oldBoard, incoming) {
  const base = oldBoard || emptyBoard();
  const next = emptyBoard();
  next.revision = base.revision;
  next.seq = base.seq;
  next.settings = base.settings;
  const oldById = new Map();
  base.cards.forEach((card) => oldById.set(card.id, card));
  const incomingCards = Array.isArray(incoming.cards) ? incoming.cards : [];
  const warnings = [];
  const seen = new Set();
  for (const raw of incomingCards) {
    if (!raw || typeof raw !== 'object') continue;
    const id = raw.id !== undefined && raw.id !== null ? String(raw.id) : newId();
    if (seen.has(id)) continue;
    seen.add(id);
    const previous = oldById.get(id);
    const merged = { id };
    CLIENT_FIELDS.forEach((field) => { merged[field] = raw[field]; });
    if (raw.verify === undefined && previous) merged.verify = previous.verify;
    if (raw.blockedBy === undefined && previous) merged.blockedBy = previous.blockedBy;
    if (previous) {
      HOST_FIELDS.forEach((field) => { merged[field] = previous[field]; });
    } else {
      merged.status = 'todo';
      merged.round = 0;
      merged.error = null;
      merged.runs = [];
      merged.reviews = [];
      merged.delivery = null;
      merged.pr = null;
      merged.pending = null;
      merged.signoff = null;
      merged.updatedAt = isoNow();
    }
    next.cards.push(normalizeTask(merged));
  }
  for (const [id, previous] of oldById) {
    if (seen.has(id)) continue;
    if (LIVE_STATUS.has(previous.status)) {
      warnings.push('任务「' + (previous.title || id) + '」处于执行中，不能删除，已保留。');
      next.cards.push(normalizeTask(previous));
    }
  }
  return { board: next, warnings };
}

function extractPrUrl(text) {
  const match = /(?:https?:\/\/)?github\.com\/[^\s"'<>()]+\/pull\/\d+/.exec(String(text || ''));
  if (!match) return null;
  const raw = match[0];
  return raw.startsWith('http') ? raw : 'https://' + raw;
}

function prNumber(url) {
  const match = /\/(\d+)(?:$|[?#])/.exec(String(url || ''));
  return match ? Number(match[1]) : null;
}

export function apply(ctx) {
  const getService = (name) => {
    try {
      const service = ctx.get(name);
      return service === undefined ? undefined : service;
    } catch (e) {
      return undefined;
    }
  };
  const logAt = (level, args) => {
    try {
      const service = ctx.logger;
      if (!service) return;
      const instance = typeof service === 'function' ? service.call(ctx, 'dsh-task-board') : service;
      if (instance && typeof instance[level] === 'function') instance[level](...args);
    } catch (e) { }
  };
  const logWarn = (...args) => logAt('warn', args);
  const logError = (...args) => logAt('error', args);
  const agentsService = () => getService('agents');
  const runEntries = new Map();
  const sessionIndex = new Map();
  const queues = new Map();
  const startingKeys = new Set();
  const pumping = new Set();
  const reviewQueues = new Map();
  const startingReviews = new Set();
  const pumpingReviews = new Set();
  const boardLocks = new Map();
  const bootAt = Date.now();

  const keyOf = (workspaceId, taskId) => workspaceId + '::' + taskId;

  function workspaceList() {
    const registry = getService('workspaceRegistry');
    if (!registry || typeof registry.list !== 'function') return [];
    try {
      const list = registry.list() || [];
      return list.map((item) => ({
        id: String(item.id !== undefined && item.id !== null ? item.id : (item.workspaceId || '')),
        title: item.title || (item.path ? path.basename(item.path) : ''),
        path: item.path || '',
        sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.map((sessionId) => String(sessionId)) : [],
      }));
    } catch (e) {
      return [];
    }
  }

  function findWorkspace(workspaceId) {
    return workspaceList().find((item) => item.id === String(workspaceId)) || null;
  }

  function underWorkspace(target) {
    try {
      const resolved = path.resolve(String(target || ''));
      return workspaceList().some((workspace) => {
        if (!workspace.path) return false;
        const root = path.resolve(workspace.path);
        return resolved === root || resolved.startsWith(root + path.sep);
      });
    } catch (e) {
      return false;
    }
  }

  function workspaceLabels(list) {
    const labels = list.map((workspace) => workspace.title || workspace.id).filter(Boolean);
    return labels.slice(0, 10).join('、') || '（宿主未登记任何工作区）';
  }

  function withinPath(root, target) {
    try {
      const base = path.resolve(String(root || ''));
      const value = path.resolve(String(target || ''));
      if (!base || !value) return false;
      const sameCase = (text) => (process.platform === 'win32' ? text.toLowerCase() : text);
      const left = sameCase(base);
      const right = sameCase(value);
      return right === left || right.startsWith(left + path.sep);
    } catch (e) {
      return false;
    }
  }

  function resolveCardWorkspace(wanted, cwd, sessionId) {
    const list = workspaceList();
    const key = asText(wanted, 300).trim();
    if (key) {
      let hit = list.find((workspace) => workspace.id === key);
      if (!hit) hit = list.find((workspace) => String(workspace.title || '').toLowerCase() === key.toLowerCase());
      if (!hit) hit = list.find((workspace) => workspace.path && withinPath(workspace.path, key));
      if (!hit) throw new Error('找不到工作区「' + key + '」。可用工作区：' + workspaceLabels(list));
      return hit;
    }
    if (cwd) {
      const matched = list
        .filter((workspace) => workspace.path && withinPath(workspace.path, cwd))
        .sort((a, b) => String(b.path).length - String(a.path).length);
      if (matched.length) return matched[0];
    }
    if (sessionId) {
      const bySession = list.find((workspace) => workspace.sessionIds.indexOf(String(sessionId)) >= 0);
      if (bySession) return bySession;
    }
    if (!list.length) throw new Error('宿主还没有登记任何工作区，无法创建任务卡片。');
    throw new Error('当前会话所在目录不属于任何已注册工作区，无法创建任务卡片。可用工作区：' + workspaceLabels(list));
  }

  async function createCardFromSession(args, exec) {
    const session = exec && exec.agent && exec.agent.session;
    if (!session) throw new Error('create_task_card 只能由会话中的 AI 调用');
    const sessionId = String(session.id || (session.header && session.header.id) || '');
    const cwd = session.header && session.header.cwd ? String(session.header.cwd) : '';
    const title = asText(args && args.title, 400).trim();
    if (!title) throw new Error('任务标题不能为空，请提供 title。');
    const workspace = resolveCardWorkspace(args && args.workspace, cwd, sessionId);
    if (!findWorkspace(workspace.id)) throw new Error('工作区「' + (workspace.title || workspace.id) + '」已不可用，请刷新后重试。');
    const priority = ['none', 'low', 'medium', 'high', 'urgent'].indexOf(args && args.priority) >= 0 ? args.priority : 'none';
    const card = normalizeTask({
      id: newId(),
      title,
      description: asText(args && args.description, 20000),
      acceptance: asText(args && args.acceptance, 20000),
      labels: asTextList(args && args.labels, 30, 60),
      priority,
      status: 'todo',
      updatedAt: isoNow(),
    });
    await lockedBoard(workspace.id, async (board) => {
      board.cards.unshift(card);
      await saveBoard(workspace.id, board, auditEntry('agent:' + sessionId, 'create_card', card, null, 'todo', {}));
    });
    const workspaceTitle = workspace.title || workspace.id;
    return {
      ok: true,
      cardId: card.id,
      title: card.title,
      workspaceId: workspace.id,
      workspaceTitle,
      status: 'todo',
      message: '已在「' + workspaceTitle + '」看板创建任务卡片「' + card.title + '」（状态：待办）。',
    };
  }

  function installCreateCardTool(tools) {
    if (!tools || typeof tools.register !== 'function') return false;
    tools.register({
      name: 'create_task_card',
      description: '把一条讨论结论或待办记录成当前工作区看板的「待办」任务卡片。当用户要求“创建任务卡片 / 记成看板任务 / 加到待办”时调用；新卡片固定进入「待办」列，不会自动开始执行。标题写清要做什么；讨论中若已形成验收标准，一并填入 acceptance，方便之后直接启动 AI 执行。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '任务标题（必填，一句话说明要做什么）' },
          description: { type: 'string', description: '背景、约束与上下文（可选）' },
          acceptance: { type: 'string', description: '验收标准（可选，建议从讨论中提取）' },
          priority: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'urgent'], description: '优先级，默认 none' },
          labels: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
          workspace: { type: 'string', description: '目标看板：工作区 id 或标题；省略时使用当前会话所在工作区' },
        },
        required: ['title'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            cardId: { type: 'string' },
            title: { type: 'string' },
            workspaceId: { type: 'string' },
            workspaceTitle: { type: 'string' },
            status: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['ok', 'cardId', 'title', 'workspaceId', 'workspaceTitle', 'status', 'message'],
        },
        render: (args, value) => [{ type: 'text', text: value && value.message ? value.message : '已创建任务卡片' }],
      },
      presentCall: (args) => {
        const raw = { title: args && args.title };
        if (args && args.workspace) raw.workspace = args.workspace;
        return { card: 'generic', title: '创建任务卡片', kind: 'other', rawInput: raw };
      },
      async execute(args, exec) {
        return await createCardFromSession(args, exec);
      },
    }, {
      when: (context) => {
        try {
          const id = context && context.agent && context.agent.session && context.agent.session.id;
          return !(id && sessionIndex.has(String(id)));
        } catch (e) {
          return true;
        }
      },
    });
    return true;
  }

  function registerCreateCardTool() {
    if (installCreateCardTool(getService('tools'))) return;
    if (ctx && typeof ctx.inject === 'function') {
      try {
        ctx.inject(['tools'], (toolCtx) => {
          if (!installCreateCardTool(toolCtx && toolCtx.tools)) logWarn('tools 服务不可用，create_task_card 工具未注册');
        });
      } catch (error) {
        logWarn('create_task_card 延迟注册失败', String((error && error.message) || error));
      }
      return;
    }
    logWarn('tools 服务不可用，create_task_card 工具未注册');
  }

  function lockedBoard(workspaceId, mutate) {
    const prior = boardLocks.get(workspaceId) || Promise.resolve();
    const current = prior.then(async () => mutate(await ensureBoard(workspaceId)));
    boardLocks.set(workspaceId, current.then(() => undefined, () => undefined));
    return current;
  }

  function activeEntries(workspaceId, kind) {
    const out = [];
    runEntries.forEach((entry) => {
      if (workspaceId && entry.workspaceId !== workspaceId) return;
      if (kind && entry.kind !== kind) return;
      out.push(entry);
    });
    return out;
  }

  function activeExecutionCount(workspaceId) {
    return activeEntries(workspaceId, 'execute').filter((entry) => entry.phase === 'executing').length;
  }

  function globalActiveCount() {
    let count = startingKeys.size;
    runEntries.forEach((entry) => {
      if (['executing', 'reviewing', 'input', 'pr'].includes(entry.phase)) count += 1;
    });
    return count;
  }

  function canStartExecution(workspaceId, settings, excludeKey) {
    const limit = settings && settings.concurrency ? settings.concurrency : DEFAULT_SETTINGS.concurrency;
    const startingHere = [...startingKeys].filter((key) => key.startsWith(workspaceId + '::') && key !== excludeKey).length;
    return activeExecutionCount(workspaceId) + startingHere < limit && globalActiveCount() < GLOBAL_RUN_CAP;
  }

  function activeReviewCount(workspaceId) {
    return activeEntries(workspaceId, 'review').filter((entry) => entry.phase === 'reviewing' || entry.phase === 'input').length;
  }

  function taskTotalTokens(task) {
    return (task && Array.isArray(task.runs) ? task.runs : [])
      .reduce((sum, run) => sum + Math.max(0, asInt(run && run.tokens, 0)), 0);
  }

  function taskElapsedMs(task) {
    const first = (task && Array.isArray(task.runs) ? task.runs : [])
      .find((run) => run && run.kind === 'execute' && run.startedAt);
    if (!first) return 0;
    const start = Date.parse(first.startedAt);
    return Number.isFinite(start) ? Math.max(0, Date.now() - start) : 0;
  }

  function budgetBreach(task, settings) {
    const maxTokens = settings && settings.maxTokensPerTask ? settings.maxTokensPerTask : DEFAULT_SETTINGS.maxTokensPerTask;
    if (maxTokens && taskTotalTokens(task) >= maxTokens) return '任务累计 token 超过上限（' + maxTokens + '），已中止';
    const maxMinutes = settings && settings.maxMinutesPerTask ? settings.maxMinutesPerTask : DEFAULT_SETTINGS.maxMinutesPerTask;
    if (maxMinutes && taskElapsedMs(task) >= maxMinutes * 60000) return '任务总耗时超过上限（' + maxMinutes + ' 分钟），已中止';
    return null;
  }

  function canStartReview(workspaceId, settings) {
    const limit = settings && settings.reviewConcurrency ? settings.reviewConcurrency : DEFAULT_SETTINGS.reviewConcurrency;
    const startingHere = [...startingReviews].filter((key) => key.startsWith(workspaceId + '::')).length;
    return activeReviewCount(workspaceId) + startingHere < limit && globalActiveCount() < GLOBAL_RUN_CAP;
  }

  function findEntry(workspaceId, taskId, kind) {
    return runEntries.get(keyOf(workspaceId, taskId) + '::' + kind) || null;
  }

  function entryKeysForTask(workspaceId, taskId) {
    return [...runEntries.keys()].filter((key) => key.startsWith(keyOf(workspaceId, taskId) + '::'));
  }

  function adoptEntry(entry) {
    runEntries.set(entry.key, entry);
    if (entry.sessionId) sessionIndex.set(entry.sessionId, entry);
  }

  function clearEntryTimer(entry) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  function releaseEntry(entry, dispose) {
    if (!entry) return;
    clearEntryTimer(entry);
    runEntries.delete(entry.key);
    if (entry.sessionId && sessionIndex.get(entry.sessionId) === entry) sessionIndex.delete(entry.sessionId);
    if (dispose && typeof entry.dispose === 'function') {
      try { Promise.resolve(entry.dispose()).catch(() => undefined); }
      catch (e) { }
    }
  }

  function releaseTask(workspaceId, taskId, options) {
    entryKeysForTask(workspaceId, taskId).forEach((key) => {
      const entry = runEntries.get(key);
      if (!entry) return;
      if (options && options.cancel && entry.agent) {
        try { entry.agent.cancel({ kind: 'user' }); } catch (e) { }
      }
      releaseEntry(entry, entry.kind === 'review');
    });
  }

  function armTimer(entry, minutes) {
    clearEntryTimer(entry);
    const limit = Math.max(1, asInt(minutes, DEFAULT_SETTINGS.maxMinutesPerRun));
    entry.limitMinutes = limit;
    const timer = setTimeout(() => {
      onRunTimeout(entry).catch((error) => logError('run timeout handling failed', String((error && error.message) || error)));
    }, limit * 60000);
    if (timer && typeof timer.unref === 'function') timer.unref();
    entry.timer = timer;
  }

  function pumpQueue(workspaceId) {
    if (pumping.has(workspaceId)) return Promise.resolve();
    pumping.add(workspaceId);
    return (async () => {
      try {
        const queue = queues.get(workspaceId);
        if (!queue || !queue.length) return;
        for (;;) {
          const pending = queues.get(workspaceId);
          if (!pending || !pending.length) return;
          const board = await ensureBoard(workspaceId);
          const settings = board.settings;
          const limit = settings.concurrency;
          const startingHere = [...startingKeys].filter((key) => key.startsWith(workspaceId + '::')).length;
          if (activeExecutionCount(workspaceId) + startingHere >= limit) return;
          if (globalActiveCount() >= GLOBAL_RUN_CAP) return;
          const next = pending.splice(pickNextIndex(pending), 1)[0];
          if (!next) return;
          const key = keyOf(workspaceId, next.taskId) + '::execute';
          startingKeys.add(key);
          startTask(workspaceId, next.taskId)
            .catch((error) => logError('queued start failed', String((error && error.message) || error)))
            .finally(() => {
              startingKeys.delete(key);
              pumpQueue(workspaceId).catch(() => undefined);
            });
        }
      } finally {
        pumping.delete(workspaceId);
      }
    })();
  }

  function pumpReviewQueue(workspaceId) {
    if (pumpingReviews.has(workspaceId)) return Promise.resolve();
    pumpingReviews.add(workspaceId);
    return (async () => {
      try {
        for (;;) {
          const queue = reviewQueues.get(workspaceId);
          if (!queue || !queue.length) return;
          const board = await ensureBoard(workspaceId);
          if (!canStartReview(workspaceId, board.settings)) return;
          const next = queue.splice(pickNextIndex(queue), 1)[0];
          if (!next) return;
          const key = keyOf(workspaceId, next.taskId) + '::review';
          startingReviews.add(key);
          startReview(workspaceId, next.taskId, null)
            .catch((error) => logError('queued review failed', String((error && error.message) || error)))
            .finally(() => {
              startingReviews.delete(key);
              pumpReviewQueue(workspaceId).catch(() => undefined);
            });
        }
      } finally {
        pumpingReviews.delete(workspaceId);
      }
    })();
  }

  async function scheduleReview(workspaceId, taskId) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return;
    if (canStartReview(workspaceId, board.settings)) {
      const key = keyOf(workspaceId, taskId) + '::review';
      startingReviews.add(key);
      startReview(workspaceId, taskId, null)
        .catch((error) => logError('start review failed', String((error && error.message) || error)))
        .finally(() => {
          startingReviews.delete(key);
          pumpReviewQueue(workspaceId).catch(() => undefined);
        });
      return;
    }
    const queue = reviewQueues.get(workspaceId) || [];
    if (queue.some((item) => item.taskId === taskId)) return;
    queue.push({ taskId, priority: task.priority || 'none' });
    reviewQueues.set(workspaceId, queue);
  }

  function requestToken(req, url) {
    try {
      const headers = (req && req.headers) || {};
      const header = headers['x-task-board-token'] || headers['X-Task-Board-Token'];
      if (header) return String(header);
    } catch (e) { }
    return url && typeof url.searchParams.get === 'function' ? (url.searchParams.get('token') || '') : '';
  }

  async function authGuard(workspaceId, req, url) {
    const board = await ensureBoard(workspaceId);
    const need = board && board.settings && board.settings.authToken ? String(board.settings.authToken) : '';
    if (!need) return true;
    return requestToken(req, url) === need;
  }

  function modelRoute(task, kind) {    const raw = kind === 'review' ? (task.reviewer || task.executor) : task.executor;
    const text = String(raw || '').trim();
    if (!text) return {};
    const slash = text.indexOf('/');
    if (slash > 0) return { provider: text.slice(0, slash), model: text.slice(slash + 1) };
    return { model: text };
  }

  async function createSession(task, kind, cwd, setup) {
    const route = modelRoute(task, kind);
    const agentOptions = {};
    if (route.provider) agentOptions.provider = route.provider;
    if (route.model) agentOptions.model = route.model;
    if (task.budget && task.budget.maxTokens) agentOptions.maxTokens = task.budget.maxTokens;
    const sessionId = newId();
    const agents = agentsService();
    if (agents && typeof agents.create === 'function') {
      try {
        const handle = await agents.create({ sessionId, meta: { cwd }, agentOptions, setup });
        return {
          ok: true,
          sessionId,
          agent: handle.agent,
          dispose: handle && typeof handle.dispose === 'function' ? handle.dispose : null,
        };
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) };
      }
    }
    const loop = getService('agentLoop');
    if (!loop || typeof loop.create !== 'function') {
      return { ok: false, error: '执行服务不可用（agents 与 agentLoop 均缺失）' };
    }
    try {
      const agent = await loop.create(sessionId, agentOptions, { cwd });
      if (typeof setup === 'function') await setup(agent.ctx, agent);
      return { ok: true, sessionId, agent, dispose: null };
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) };
    }
  }

  function conclude(exec) {
    try { if (exec && typeof exec.concludeTurn === 'function') exec.concludeTurn(); }
    catch (e) { }
  }

  function registerExecuteTools(agentCtx, agent, holder) {
    try {
      const tools = agentCtx && agentCtx.tools;
      if (!tools || typeof tools.register !== 'function') throw new Error('tools service unavailable');
      tools.register({
        name: 'submit_for_review',
        description: '把本次执行结果提交给评审。完成改动后必须调用，summary 写明改了什么、如何验证。',
        parameters: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: '改动摘要与验证方式' },
            evidence: { type: 'array', items: { type: 'string' }, description: '验证命令或结果' },
          },
          required: ['summary'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok'] },
          render: (args, value) => [{ type: 'text', text: value && value.message ? value.message : '已提交评审' }],
        },
        async execute(args, exec) {
          const entry = holder.entry;
          try {
            if (entry && entry.phase === 'executing') {
              entry.phase = 'submitted';
              clearEntryTimer(entry);
              await submitForReview(entry, asText(args && args.summary, 4000) || '执行结束', asTextList(args && args.evidence, 20, 500));
            }
          } catch (error) {
            logWarn('submit_for_review 处理失败', String((error && error.message) || error));
          }
          conclude(exec);
          return { ok: true, message: '已提交评审' };
        },
      });
      tools.register({
        name: 'request_input',
        description: '遇到必须由人确认的问题时调用，会暂停任务并等待人工答复。',
        parameters: {
          type: 'object',
          properties: { question: { type: 'string', description: '要向人提出的问题' } },
          required: ['question'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok'] },
          render: (args, value) => [{ type: 'text', text: value && value.message ? value.message : '已请求人工输入' }],
        },
        async execute(args, exec) {
          const entry = holder.entry;
          try { if (entry) await requestInput(entry, asText(args && args.question, 2000) || '需要人工输入'); }
          catch (error) { logWarn('request_input 处理失败', String((error && error.message) || error)); }
          conclude(exec);
          return { ok: true, message: '已请求人工输入' };
        },
      });
      tools.register({
        name: 'request_approval',
        description: '遇到需要人批准才能继续的高风险动作时调用，会暂停任务等待人工批准。',
        parameters: {
          type: 'object',
          properties: { question: { type: 'string', description: '要向人说明并请求批准的事项' } },
          required: ['question'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok'] },
          render: (args, value) => [{ type: 'text', text: value && value.message ? value.message : '已请求批准' }],
        },
        async execute(args, exec) {
          const entry = holder.entry;
          try { if (entry) await requestApproval(entry, asText(args && args.question, 2000) || '请求人工批准'); }
          catch (error) { logWarn('request_approval 处理失败', String((error && error.message) || error)); }
          conclude(exec);
          return { ok: true, message: '已请求人工批准' };
        },
      });
      holder.toolsReady = true;
    } catch (error) {
      holder.toolsReady = false;
      logWarn('执行工具注册失败，降级为 turn 结束即提交', String((error && error.message) || error));
    }
  }

  function registerReviewTools(agentCtx, agent, holder) {
    try {
      const tools = agentCtx && agentCtx.tools;
      if (!tools || typeof tools.register !== 'function') throw new Error('tools service unavailable');
      tools.register({
        name: 'review_verdict',
        description: '给出评审结论。通过用 pass（必须带 evidence，可先用 run_verification 实际跑验证）；需要返工用 changes 并列出 mustFix。必须调用。',
        parameters: {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['pass', 'changes'] },
            mustFix: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  file: { type: 'string' },
                  line: { type: 'integer' },
                  severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
                  issue: { type: 'string' },
                  suggestion: { type: 'string' },
                },
                required: ['file', 'issue'],
              },
            },
            nits: { type: 'array', items: { type: 'string' } },
            evidence: { type: 'array', items: { type: 'string' } },
          },
          required: ['verdict'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok'] },
          render: (args, value) => [{ type: 'text', text: value && value.message ? value.message : '评审结论已提交' }],
        },
        async execute(args, exec) {
          const entry = holder.entry;
          const verdict = (args && args.verdict) === 'pass' ? 'pass' : 'changes';
          const mustFix = normalizeMustFix(args && args.mustFix);
          if (entry && entry.phase === 'reviewing' && verdict === 'pass' && mustFix.length > 0) {
            return { ok: false, message: 'pass 不能同时列出 mustFix；请改为 changes 或移除 mustFix 后重试。' };
          }
          try {
            if (entry && entry.phase === 'reviewing') {
              entry.phase = 'decided';
              clearEntryTimer(entry);
              await handleVerdict(entry, verdict, mustFix, asTextList(args && args.nits, 30, 500), asTextList(args && args.evidence, 30, 500));
            }
          } catch (error) {
            logWarn('review_verdict 处理失败', String((error && error.message) || error));
          }
          conclude(exec);
          return { ok: true, message: '评审结论已提交' };
        },
      });
      tools.register({
        name: 'request_input',
        description: '评审遇到无法判断的问题时调用，会暂停评审并等待人工答复。',
        parameters: {
          type: 'object',
          properties: { question: { type: 'string', description: '要向人提出的问题' } },
          required: ['question'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok'] },
          render: (args, value) => [{ type: 'text', text: value && value.message ? value.message : '已请求人工输入' }],
        },
        async execute(args, exec) {
          const entry = holder.entry;
          try { if (entry) await requestInput(entry, asText(args && args.question, 2000) || '需要人工输入'); }
          catch (error) { logWarn('request_input 处理失败', String((error && error.message) || error)); }
          conclude(exec);
          return { ok: true, message: '已请求人工输入' };
        },
      });
      tools.register({
        name: 'run_verification',
        description: '在工作树中运行一条白名单验证命令（测试/构建/lint/git 查看）。返回 exitCode、stdout、stderr。',
        parameters: {
          type: 'object',
          properties: { command: { type: 'string', description: '要执行的命令，必须以白名单前缀开头' } },
          required: ['command'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: { exitCode: { type: 'integer' }, stdout: { type: 'string' }, stderr: { type: 'string' } },
            required: ['exitCode', 'stdout', 'stderr'],
          },
          render: (args, value) => [{
            type: 'text',
            text: 'exit ' + (value ? value.exitCode : '?') + '\n' + (value ? value.stdout : '') + (value && value.stderr ? '\n' + value.stderr : ''),
          }],
        },
        async execute(args) {
          const entry = holder.entry;
          if (!entry || !entry.worktreePath) throw new Error('评审工作树不可用');
          const command = asText(args && args.command, 1000);
          const result = await runVerification(command, entry.worktreePath);
          try {
            if (!Array.isArray(entry.verifications)) entry.verifications = [];
            entry.verifications.push({
              command,
              exitCode: result.exitCode,
              at: isoNow(),
              summary: asText(String(result.stdout || '') + (result.stderr ? '\n' + result.stderr : ''), EVIDENCE_TEXT_MAX).trim(),
              hash: hashText(String(result.stdout || '') + '\n' + String(result.stderr || '')),
            });
            if (entry.verifications.length > VERIFY_RECORD_MAX) entry.verifications = entry.verifications.slice(-VERIFY_RECORD_MAX);
            await lockedBoard(entry.workspaceId, async (board) => {
              const task = findTask(board, entry.taskId);
              const run = task && task.runs.find((item) => item.id === entry.runId);
              if (!run) return;
              run.verifications = entry.verifications.slice();
              await saveBoard(entry.workspaceId, board, null);
            });
          } catch (e) { }
          return result;
        },
      });
      tools.register({
        name: 'request_approval',
        description: '遇到需要人批准才能继续的高风险动作时调用，会暂停评审等待人工批准。',
        parameters: {
          type: 'object',
          properties: { question: { type: 'string', description: '要向人说明并请求批准的事项' } },
          required: ['question'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok'] },
          render: (args, value) => [{ type: 'text', text: value && value.message ? value.message : '已请求批准' }],
        },
        async execute(args, exec) {
          const entry = holder.entry;
          try { if (entry) await requestApproval(entry, asText(args && args.question, 2000) || '请求人工批准'); }
          catch (error) { logWarn('request_approval 处理失败', String((error && error.message) || error)); }
          conclude(exec);
          return { ok: true, message: '已请求人工批准' };
        },
      });
      try { tools.restrict({ allow: ['read', 'glob', 'grep', 'bash'] }); }
      catch (error) { logWarn('评审工具限制失败，已降级', String((error && error.message) || error)); }
      try {
        agentCtx.on('tools/pre-execute', async (execution, next) => {
          try {
            const name = String((execution && execution.name) || '');
            if (['bash', 'pwsh', 'shell', 'terminal'].includes(name)) {
              const args = (execution && execution.arguments) || {};
              const command = args.command || args.cmd || args.text || '';
              if (!isVerificationCommand(command)) return { kind: 'deny', reason: '评审会话只允许运行白名单验证命令' };
            }
          } catch (e) { }
          return next();
        });
      } catch (error) {
        logWarn('评审 bash 白名单守卫安装失败', String((error && error.message) || error));
      }
      try { agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' }); }
      catch (error) { logWarn('评审会话设置只读沙箱失败', String((error && error.message) || error)); }
      try { agent.session.append('approval/policy', { policy: 'never', source: 'delegation' }); }
      catch (error) { logWarn('评审会话设置 approval 策略失败', String((error && error.message) || error)); }
      holder.toolsReady = true;
    } catch (error) {
      holder.toolsReady = false;
      logWarn('评审工具注册失败，降级为 verdict 缺失即 blocked', String((error && error.message) || error));
    }
  }

  function normalizeMustFix(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 50).map((item) => ({
      file: asText(item && item.file, 400),
      line: Math.max(0, asInt(item && item.line, 0)),
      severity: ['blocker', 'major', 'minor'].includes(item && item.severity) ? item.severity : 'major',
      issue: asText(item && item.issue, 2000),
      suggestion: asText(item && item.suggestion, 2000),
      status: 'open',
    })).filter((item) => item.issue || item.file);
  }

  function readTokens(entry) {
    try {
      const projections = getService('sessionProjections');
      if (!entry || !entry.agent || !entry.agent.session || !projections || typeof projections.snapshot !== 'function') return 0;
      const snapshot = projections.snapshot(entry.agent.session, ['tokenUsage']);
      const usage = snapshot && snapshot.values ? snapshot.values.tokenUsage : null;
      if (!usage) return 0;
      if (usage.totals && Number.isFinite(Number(usage.totals.totalTokens))) return Number(usage.totals.totalTokens);
      if (Number.isFinite(Number(usage.totalTokens))) return Number(usage.totalTokens);
      const sum = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
        .reduce((total, key) => total + (Number.isFinite(Number(usage[key])) ? Number(usage[key]) : 0), 0);
      return sum;
    } catch (e) {
      return 0;
    }
  }

  async function submitForReview(entry, summary, evidence) {
    entry.phase = 'submitted';
    entry.settled = true;
    clearEntryTimer(entry);
    const workspaceId = entry.workspaceId;
    const result = await lockedBoard(workspaceId, async (board) => {
      const task = findTask(board, entry.taskId);
      if (!task || task.status !== 'running') return { ok: false };
      const run = task.runs.find((item) => item.id === entry.runId);
      if (run) {
        run.status = 'done';
        run.endedAt = isoNow();
        run.summary = summary;
        run.evidence = mergeEvidence(evidence, entry.verifications);
        run.tokens = readTokens(entry) || run.tokens;
      }
      const breach = budgetBreach(task, board.settings);
      if (breach) {
        task.status = 'blocked';
        task.error = breach;
        task.updatedAt = isoNow();
        await saveBoard(workspaceId, board, auditEntry('host', 'budget_blocked', task, 'running', 'blocked', { runId: entry.runId, reason: breach }));
        return { ok: false, breach: true };
      }
      const from = task.status;
      const to = confirmTransition('submit', from);
      if (!to) return { ok: false };
      task.status = to;
      task.pending = null;
      task.updatedAt = isoNow();
      await saveBoard(workspaceId, board, auditEntry('agent:' + entry.sessionId, 'submit', task, from, to, { runId: entry.runId }));
      return { ok: true };
    });
    if (!result.ok) { if (result.breach) releaseEntry(entry, false); return; }
    pumpQueue(workspaceId);
    scheduleReview(workspaceId, entry.taskId).catch((error) => logError('schedule review failed', String((error && error.message) || error)));
  }

  async function runHostVerifications(task, settings, cwd) {
    const taskCommands = Array.isArray(task && task.verify) ? task.verify : [];
    const hiddenCommands = settings && Array.isArray(settings.hiddenVerify) ? settings.hiddenVerify : [];
    const commands = taskCommands.concat(hiddenCommands).slice(0, VERIFY_RECORD_MAX);
    const out = [];
    for (const command of commands) {
      const result = await runVerification(command, cwd);
      out.push({
        command,
        exitCode: result.exitCode,
        at: isoNow(),
        summary: asText(String(result.stdout || '') + (result.stderr ? '\n' + result.stderr : ''), EVIDENCE_TEXT_MAX).trim(),
        hash: hashText(String(result.stdout || '') + '\n' + String(result.stderr || '')),
      });
    }
    return out;
  }

  async function startReview(workspaceId, taskId, executeEntry) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task || task.status !== 'awaiting_review') return;
    const worktree = (executeEntry && executeEntry.worktree) || latestExecuteWorktree(task);
    if (!worktree || !worktree.path) {
      await blockTask(workspaceId, taskId, '缺少执行工作树，无法评审', null);
      return;
    }
    const runId = newId();
    let started = false;
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target || target.status !== 'awaiting_review') return;
      const from = target.status;
      const to = confirmTransition('review', from);
      if (!to) return;
      target.status = to;
      target.updatedAt = isoNow();
      target.runs.push(makeRun({
        id: runId,
        kind: 'review',
        attempt: Math.max(1, target.round),
        model: target.reviewer || target.executor || '',
        worktree: { path: worktree.path, branch: worktree.branch || null, baseCommit: worktree.baseCommit || null },
      }));
      await saveBoard(workspaceId, current, auditEntry('host', 'review_start', target, from, to, { runId }));
      started = true;
    });
    if (!started) return;
    const diff = await collectDiff(worktree.path, worktree.baseCommit);
    const promptDiff = {
      stat: diff.stat,
      text: diff.diff.length > MAX_DIFF_PROMPT ? diff.diff.slice(0, MAX_DIFF_PROMPT) + '\n…（已截断）' : diff.diff,
    };
    const execRun = (task.runs || []).find((run) => run.id === (executeEntry && executeEntry.runId))
      || [...(task.runs || [])].reverse().find((run) => run.kind === 'execute');
    const hostVerifications = await runHostVerifications(task, board.settings, worktree.path);
    const handoff = buildReviewHandoff(task, execRun, hostVerifications);
    const holder = { entry: null, toolsReady: false };
    const created = await createSession(task, 'review', worktree.path, (agentCtx, reviewAgent) => registerReviewTools(agentCtx, reviewAgent, holder));
    if (!created.ok) {
      await failReviewStart(workspaceId, taskId, runId, created.error);
      return;
    }
    const entry = {
      key: keyOf(workspaceId, taskId) + '::review', workspaceId, taskId, kind: 'review', runId,
      sessionId: created.sessionId, agent: created.agent, dispose: created.dispose, phase: 'reviewing',
      timer: null, startedAt: Date.now(), worktree, worktreePath: worktree.path,
      model: task.reviewer || task.executor || '', settled: false, toolsReady: holder.toolsReady,
      prCapture: null, limitMinutes: REVIEW_LIMIT_MINUTES,
      verifications: hostVerifications.slice(),
    };
    holder.entry = entry;
    adoptEntry(entry);
    let aborted = false;
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      const run = target && target.runs.find((item) => item.id === runId);
      if (!target || target.status !== 'reviewing' || !run) { aborted = true; return; }
      run.sessionId = created.sessionId;
      run.model = entry.model;
      if (hostVerifications.length) run.verifications = hostVerifications.slice();
      target.updatedAt = isoNow();
      await saveBoard(workspaceId, current, null);
    });
    if (aborted) { releaseEntry(entry, true); return; }
    armTimer(entry, REVIEW_LIMIT_MINUTES);
    driveTurn(entry, userMessage(buildReviewPrompt(task, promptDiff, handoff)));
  }

  async function failReviewStart(workspaceId, taskId, runId, message) {
    await lockedBoard(workspaceId, async (board) => {
      const task = findTask(board, taskId);
      if (!task) return;
      const run = task.runs.find((item) => item.id === runId);
      if (run) {
        run.status = 'failed';
        run.endedAt = isoNow();
        run.error = message;
      }
      const from = task.status;
      const to = confirmTransition('block', from) || 'blocked';
      task.status = to;
      task.error = '评审会话启动失败：' + message;
      task.updatedAt = isoNow();
      await saveBoard(workspaceId, board, auditEntry('host', 'review_start_failed', task, from, to, { runId, reason: message }));
    });
    releaseTask(workspaceId, taskId, null);
    pumpQueue(workspaceId);
    pumpReviewQueue(workspaceId).catch(() => undefined);
  }

  async function handleVerdict(entry, verdict, mustFix, nits, rawEvidence) {
    const workspaceId = entry.workspaceId;
    const taskId = entry.taskId;
    try {
      if (!Array.isArray(entry.verifications)) entry.verifications = [];
      if (!entry.verifications.length) {
        const stored = findTask(await ensureBoard(workspaceId), taskId);
        const storedRun = stored && stored.runs.find((item) => item.id === entry.runId);
        if (storedRun && Array.isArray(storedRun.verifications)) entry.verifications = storedRun.verifications;
      }
    } catch (e) { }
    const evidence = mergeEvidence(rawEvidence, entry.verifications);
    const verification = verificationSummary(entry.verifications);
    let decision = 'blocked';
    let review = null;
    await lockedBoard(workspaceId, async (board) => {
      const task = findTask(board, taskId);
      if (!task || task.status !== 'reviewing') return;
      const run = task.runs.find((item) => item.id === entry.runId);
      if (run) {
        run.status = 'done';
        run.endedAt = isoNow();
        run.tokens = readTokens(entry) || run.tokens;
      }
      const breach = budgetBreach(task, board.settings);
      if (breach) {
        if (run) { run.status = 'failed'; run.error = breach; }
        task.status = 'blocked';
        task.error = breach;
        task.updatedAt = isoNow();
        await saveBoard(workspaceId, board, auditEntry('host', 'budget_blocked', task, 'reviewing', 'blocked', { runId: entry.runId, reason: breach }));
        decision = 'blocked';
        return;
      }
      const passProblem = verdict === 'pass'
        ? (evidence.length === 0
          ? { action: 'review_no_evidence', message: '评审没有提供任何证据，不能通过；请实际运行验证或列出证据后重试' }
          : (verification.ran && !verification.passed
            ? { action: 'review_verification_failed', message: '机器验证未全部通过，不能通过评审；请修复后重试' }
            : null))
        : null;
      if (passProblem) {
        if (run) {
          run.status = 'failed';
          run.error = passProblem.message;
        }
        const from = task.status;
        const to = confirmTransition('block', from) || 'blocked';
        task.status = to;
        task.error = passProblem.message;
        task.updatedAt = isoNow();
        await saveBoard(workspaceId, board, auditEntry('agent:' + entry.sessionId, passProblem.action, task, from, to, { runId: entry.runId, reason: task.error, model: entry.model, verification }));
        decision = 'blocked';
        return;
      }
      review = {
        id: newId(),
        round: task.round,
        sessionId: entry.sessionId,
        reviewerModel: entry.model || '',
        verdict,
        mustFix,
        nits,
        evidence,
        verification,
        startedAt: run ? run.startedAt : entry.startedAt ? new Date(entry.startedAt).toISOString() : isoNow(),
        endedAt: isoNow(),
        note: null,
      };
      closeOpenMustFix(task, review);
      task.reviews.push(review);
      task.updatedAt = isoNow();
      if (verdict === 'pass') {
        const from = task.status;
        const to = confirmTransition('pass', from);
        if (!to) return;
        task.status = to;
        task.error = null;
        await saveBoard(workspaceId, board, auditEntry('agent:' + entry.sessionId, 'review_pass', task, from, to, { runId: entry.runId, reviewId: review.id, model: entry.model, verification }));
        decision = 'finalize';
        return;
      }
      const maxRounds = (task.budget && task.budget.maxRounds) || board.settings.maxRounds;
      if (task.round >= maxRounds) {
        const from = task.status;
        const to = confirmTransition('block', from) || 'blocked';
        task.status = to;
        task.error = '评审未通过，已达到轮数上限（' + maxRounds + ' 轮），需人工处理';
        await saveBoard(workspaceId, board, auditEntry('agent:' + entry.sessionId, 'review_changes_blocked', task, from, to, { runId: entry.runId, reviewId: review.id, reason: task.error, model: entry.model, verification }));
        decision = 'blocked';
        return;
      }
      const from = task.status;
      const to = confirmTransition('changes', from);
      if (!to) return;
      task.round += 1;
      task.status = to;
      await saveBoard(workspaceId, board, auditEntry('agent:' + entry.sessionId, 'review_changes', task, from, to, { runId: entry.runId, reviewId: review.id, model: entry.model, verification }));
      decision = 'changes';
    });
    releaseEntry(entry, true);
    pumpQueue(workspaceId);
    pumpReviewQueue(workspaceId).catch(() => undefined);
    if (decision === 'finalize') {
      await finalizeTask(workspaceId, taskId);
      return;
    }
    if (decision === 'changes') {
      const task = findTask(await ensureBoard(workspaceId), taskId);
      if (task) await resumeExecution(workspaceId, taskId, buildChangesPrompt(task, review)).catch((error) => logError('resume after review failed', String((error && error.message) || error)));
    }
  }

  async function finalizeTask(workspaceId, taskId) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task || task.status !== 'finalizing') return;
    const workspace = findWorkspace(workspaceId);
    const worktree = latestExecuteWorktree(task);
    let delivery = null;
    let failure = null;
    if (!workspace || !workspace.path) failure = '工作区路径缺失，无法记录交付物';
    else if (!worktree) failure = '缺少执行工作树，无法记录交付物';
    else {
      const diff = await collectDiff(worktree.path, worktree.baseCommit);
      if (!diff.ok) failure = '无法读取交付物差异：' + diff.error;
      else if (!String(diff.diff || '').trim()) failure = '没有可交付的已提交改动（请确认改动已提交）';
      else {
        const head = await git(['rev-parse', 'HEAD'], worktree.path, 30000);
        delivery = {
          mode: 'local',
          branch: worktree.branch || null,
          baseCommit: worktree.baseCommit || null,
          commit: head.ok ? gitOutput(head) : null,
          diffStat: diff.stat,
          patchAvailable: true,
          createdAt: isoNow(),
        };
      }
    }
    if (failure) {
      await lockedBoard(workspaceId, async (current) => {
        const target = findTask(current, taskId);
        if (!target || target.status !== 'finalizing') return;
        const from = target.status;
        const to = confirmTransition('finalize_failed', from) || 'finalize_failed';
        target.status = to;
        target.error = failure;
        target.updatedAt = isoNow();
        await saveBoard(workspaceId, current, auditEntry('host', 'finalize_failed', target, from, to, { reason: failure }));
      });
      return;
    }
    const settings = board.settings;
    const autoPr = settings.prMode === 'auto' && settings.pushConsent === 'always' && workspace && workspace.path
      ? (await gitProbe(workspace.path)).hasRemote
      : false;
    if (autoPr) {
      await lockedBoard(workspaceId, async (current) => {
        const target = findTask(current, taskId);
        if (!target) return;
        target.delivery = delivery;
        target.updatedAt = isoNow();
        await saveBoard(workspaceId, current, null);
      });
      const prResult = await createPr(workspaceId, taskId, { internal: true });
      if (!prResult.ok && prResult.code === 'action_failed') return;
      return;
    }
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target || target.status !== 'finalizing') return;
      const from = target.status;
      const to = confirmTransition('finalize', from);
      if (!to) return;
      target.delivery = delivery;
      target.status = to;
      target.error = null;
      target.updatedAt = isoNow();
      await saveBoard(workspaceId, current, auditEntry('host', 'finalize', target, from, to, { commit: delivery.commit }));
    });
    pumpQueue(workspaceId);
  }

  async function resumeExecution(workspaceId, taskId, prompt) {
    const entry = findEntry(workspaceId, taskId, 'execute');
    if (!entry) {
      await blockTask(workspaceId, taskId, '执行会话已丢失，请重试', null);
      return { ok: false, code: 'not_ready', error: '执行会话已丢失，请重试' };
    }
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在' };
    const runId = newId();
    const startedAt = isoNow();
    const model = task.executor || '';
    let ok = false;
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target) return;
      const to = confirmTransition('resume', target.status) || 'running';
      const from = target.status;
      target.status = to;
      target.error = null;
      target.pending = null;
      target.updatedAt = isoNow();
      target.runs.push({
        id: runId,
        kind: 'execute',
        attempt: countExecuteRuns(target) + 1,
        sessionId: entry.sessionId,
        model,
        worktree: entry.worktree ? Object.assign({}, entry.worktree) : null,
        status: 'running',
        startedAt,
        endedAt: null,
        summary: '',
        evidence: [],
        tokens: 0,
        error: null,
      });
      await saveBoard(workspaceId, current, auditEntry('host', 'resume', target, from, to, { runId }));
      ok = true;
    });
    if (!ok) return { ok: false, code: 'not_ready', error: '任务状态已变化' };
    entry.runId = runId;
    entry.phase = 'executing';
    entry.settled = false;
    armTimer(entry, (task.budget && task.budget.maxMinutes) || (await ensureBoard(workspaceId)).settings.maxMinutesPerRun);
    driveTurn(entry, userMessage(prompt));
    return { ok: true };
  }

  function driveTurn(entry, message) {
    if (!entry || !entry.agent) return;
    try { entry.agent.followup(message); }
    catch (error) { logWarn('followup 发送失败', String((error && error.message) || error)); }
    let idle;
    try { idle = entry.agent.whenIdle(); }
    catch (e) { idle = Promise.resolve(); }
    Promise.resolve(idle)
      .catch(() => undefined)
      .then(() => settleEntry(entry))
      .catch((error) => logError('settle after turn failed', String((error && error.message) || error)));
  }

  async function settleEntry(entry) {
    if (!entry || entry.settled) return;
    if (!runEntries.has(entry.key)) return;
    if (entry.phase !== 'executing' && entry.phase !== 'reviewing') return;
    entry.settled = true;
    const board = await ensureBoard(entry.workspaceId);
    const task = findTask(board, entry.taskId);
    if (!task) return;
    if (entry.kind === 'execute') {
      if (task.status !== 'running') return;
      await submitForReview(entry, '执行结束（未显式调用 submit_for_review）', []);
      return;
    }
    if (task.status !== 'reviewing') {
      entry.settled = false;
      return;
    }
    await failReview(entry, '评审未给出结论（会话结束），已转人工');
  }

  async function failReview(entry, message) {
    const workspaceId = entry.workspaceId;
    await lockedBoard(workspaceId, async (board) => {
      const task = findTask(board, entry.taskId);
      if (!task || task.status !== 'reviewing') return;
      const run = task.runs.find((item) => item.id === entry.runId);
      if (run) {
        run.status = 'failed';
        run.endedAt = isoNow();
        run.error = message;
        run.tokens = readTokens(entry) || run.tokens;
      }
      task.reviews.push({
        id: newId(),
        round: task.round,
        sessionId: entry.sessionId,
        reviewerModel: entry.model || '',
        verdict: 'none',
        mustFix: [],
        nits: [],
        evidence: [],
        startedAt: run ? run.startedAt : null,
        endedAt: isoNow(),
        note: message,
      });
      const from = task.status;
      const to = confirmTransition('block', from) || 'blocked';
      task.status = to;
      task.error = '评审未通过或未给出结论：' + message;
      task.updatedAt = isoNow();
      await saveBoard(workspaceId, board, auditEntry('host', 'review_blocked', task, from, to, { runId: entry.runId, reason: message }));
    });
    releaseEntry(entry, true);
    pumpQueue(workspaceId);
    pumpReviewQueue(workspaceId).catch(() => undefined);
  }

  async function blockTask(workspaceId, taskId, message, runId) {
    await lockedBoard(workspaceId, async (board) => {
      const task = findTask(board, taskId);
      if (!task) return;
      const from = task.status;
      const to = confirmTransition('block', from) || 'blocked';
      task.status = to;
      task.error = message;
      task.updatedAt = isoNow();
      if (runId) {
        const run = task.runs.find((item) => item.id === runId);
        if (run && run.status === 'running') {
          run.status = 'failed';
          run.endedAt = isoNow();
          run.error = message;
        }
      }
      await saveBoard(workspaceId, board, auditEntry('host', 'blocked', task, from, to, { reason: message, runId }));
    });
    releaseTask(workspaceId, taskId, null);
    pumpQueue(workspaceId);
    pumpReviewQueue(workspaceId).catch(() => undefined);
  }

  async function markStartFailure(workspaceId, taskId, status, code, message, runId) {
    await lockedBoard(workspaceId, async (board) => {
      const task = findTask(board, taskId);
      if (!task) return;
      const from = task.status;
      task.status = status;
      task.error = message;
      task.updatedAt = isoNow();
      if (runId) {
        const run = task.runs.find((item) => item.id === runId);
        if (run) {
          run.status = 'failed';
          run.endedAt = isoNow();
          run.error = message;
        }
      }
      await saveBoard(workspaceId, board, auditEntry('host', 'start_failed', task, from, status, { reason: message, runId }));
    });
    releaseTask(workspaceId, taskId, null);
    pumpQueue(workspaceId);
    pumpReviewQueue(workspaceId).catch(() => undefined);
    const board = await ensureBoard(workspaceId);
    return { ok: false, code, error: message, board };
  }

  async function startTask(workspaceId, taskId) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'invalid_transition', error: '任务不存在', board };
    const isQueued = task.status === 'queued';
    if (LIVE_STATUS.has(task.status) && !isQueued) {
      return { ok: true, board, result: { reused: true } };
    }
    if (isQueued && !startingKeys.has(keyOf(workspaceId, taskId) + '::execute')) {
      return { ok: true, board, result: { queued: true, reused: true } };
    }
    const queuedTarget = isQueued ? 'queued' : confirmTransition('start', task.status);
    if (!queuedTarget) {
      return { ok: false, code: 'invalid_transition', error: '当前状态「' + task.status + '」不能开始执行', board };
    }
    if (!String(task.acceptance || '').trim()) {
      return { ok: false, code: 'missing_acceptance', error: '请先填写验收标准再开始执行', board };
    }
    const blockers = Array.isArray(task.blockedBy) ? task.blockedBy : [];
    if (blockers.length) {
      const unmet = blockers.filter((id) => {
        const dep = findTask(board, id);
        return !dep || dep.status !== 'done';
      });
      if (unmet.length) {
        return { ok: false, code: 'blocked_by_dependency', error: '存在未完成的依赖任务：' + unmet.join('、'), board };
      }
    }
    const workspace = findWorkspace(workspaceId);
    if (!workspace || !workspace.path) {
      return markStartFailure(workspaceId, taskId, 'failed', 'worktree_failed', '工作区未注册或路径缺失');
    }
    if (!underWorkspace(workspace.path)) {
      return markStartFailure(workspaceId, taskId, 'failed', 'worktree_failed', '工作区路径不在已注册白名单内');
    }
    const probe = await gitProbe(workspace.path);
    if (!probe.isRepo) {
      return markStartFailure(workspaceId, taskId, 'failed', 'not_git', '工作区不是 Git 仓库，请先 git init 并提交一次');
    }
    if (!probe.hasHead) {
      return markStartFailure(workspaceId, taskId, 'failed', 'no_head', '仓库没有任何提交（HEAD 不存在），无法创建工作树');
    }
    if (probe.isLinkedWorktree) {
      return markStartFailure(workspaceId, taskId, 'failed', 'worktree_failed', '当前工作区本身是 linked worktree，无法再用它创建任务工作树');
    }
    if (probe.dirty && !(task.base && task.base.ignoreDirty)) {
      return markStartFailure(workspaceId, taskId, 'failed', 'dirty', '工作区有未提交改动：请先提交，或在任务里勾选「以当前 HEAD 为基线，忽略未提交改动」');
    }
    if (!canStartExecution(workspaceId, board.settings, keyOf(workspaceId, taskId) + '::execute')) {
      if (isQueued) {
        const waiting = queues.get(workspaceId) || [];
        waiting.unshift({ taskId, priority: task.priority || 'none' });
        queues.set(workspaceId, waiting);
        return { ok: true, board, result: { queued: true, position: 1 } };
      }
      const queue = queues.get(workspaceId) || [];
      if (queue.some((item) => item.taskId === taskId)) {
        return { ok: true, board, result: { queued: true } };
      }
      if (queue.length >= QUEUE_CAP) {
        return { ok: false, code: 'queue_full', error: '执行队列已满，请稍后再试', board };
      }
      queue.push({ taskId, priority: task.priority || 'none' });
      queues.set(workspaceId, queue);
      let queuedBoard = board;
      await lockedBoard(workspaceId, async (current) => {
        const target = findTask(current, taskId);
        if (!target || LIVE_STATUS.has(target.status)) return;
        const from = target.status;
        const to = confirmTransition('start', from);
        if (!to) return;
        target.status = to;
        target.error = null;
        target.updatedAt = isoNow();
        await saveBoard(workspaceId, current, auditEntry('user', 'queue', target, from, to, { reason: '等待执行槽位' }));
        queuedBoard = current;
      });
      return { ok: true, board: queuedBoard, result: { queued: true, position: queue.length } };
    }
    const startKey = keyOf(workspaceId, taskId) + '::execute';
    const ownsKey = !startingKeys.has(startKey);
    if (ownsKey) startingKeys.add(startKey);
    try {
      return await launchTask(workspaceId, taskId, task.base || {});
    } finally {
      if (ownsKey) startingKeys.delete(startKey);
      pumpQueue(workspaceId).catch(() => undefined);
    }
  }

  async function launchTask(workspaceId, taskId, base) {
    const workspace = findWorkspace(workspaceId);
    if (!workspace || !workspace.path) {
      return markStartFailure(workspaceId, taskId, 'failed', 'worktree_failed', '工作区未注册或路径缺失');
    }
    const prepared = await prepareWorktree(workspace.path, taskId, base);
    if (!prepared.ok) {
      return markStartFailure(workspaceId, taskId, 'failed', 'worktree_failed', prepared.error);
    }
    const runId = newId();
    const startedAt = isoNow();
    let startedTask = null;
    await lockedBoard(workspaceId, async (board) => {
      const task = findTask(board, taskId);
      if (!task) return;
      const from = task.status;
      const to = confirmTransition('begin', from);
      if (!to) return;
      task.status = to;
      task.error = null;
      task.pending = null;
      task.round = 1;
      task.updatedAt = isoNow();
      task.runs.push({
        id: runId,
        kind: 'execute',
        attempt: countExecuteRuns(task) + 1,
        sessionId: null,
        model: task.executor || '',
        worktree: { path: prepared.path, branch: prepared.branch, baseCommit: prepared.baseCommit },
        status: 'running',
        startedAt,
        endedAt: null,
        summary: '',
        evidence: [],
        tokens: 0,
        error: null,
      });
      startedTask = task;
      await saveBoard(workspaceId, board, auditEntry('user', 'start', task, from, to, { runId }));
    });
    if (!startedTask) return { ok: false, code: 'invalid_transition', error: '任务状态已变化，无法开始', board: await ensureBoard(workspaceId) };
    const holder = { entry: null, toolsReady: false };
    const created = await createSession(startedTask, 'execute', prepared.path, (agentCtx, agent) => registerExecuteTools(agentCtx, agent, holder));
    if (!created.ok) {
      return markStartFailure(workspaceId, taskId, 'failed', 'agent_unavailable', '执行会话创建失败：' + created.error, runId);
    }
    const entry = {
      key: keyOf(workspaceId, taskId) + '::execute',
      workspaceId,
      taskId,
      kind: 'execute',
      runId,
      sessionId: created.sessionId,
      agent: created.agent,
      dispose: created.dispose,
      phase: 'executing',
      timer: null,
      startedAt: Date.now(),
      worktree: { path: prepared.path, branch: prepared.branch, baseCommit: prepared.baseCommit },
      worktreePath: prepared.path,
      model: startedTask.executor || '',
      settled: false,
      toolsReady: holder.toolsReady,
      prCapture: null,
      limitMinutes: 0,
    };
    holder.entry = entry;
    adoptEntry(entry);
    let runningTask = null;
    let aborted = false;
    await lockedBoard(workspaceId, async (board) => {
      const task = findTask(board, taskId);
      const run = task && task.runs.find((item) => item.id === runId);
      const from = task ? task.status : null;
      const to = from ? confirmTransition('worktree', from) : null;
      if (!task || !run || !to) { aborted = true; return; }
      run.sessionId = created.sessionId;
      run.model = task.executor || '';
      task.status = to;
      task.error = null;
      task.updatedAt = isoNow();
      runningTask = task;
      await saveBoard(workspaceId, board, auditEntry('host', 'running', task, from, to, { runId }));
    });
    if (aborted) {
      releaseEntry(entry, true);
      return { ok: false, code: 'invalid_transition', error: '任务状态已变化，已取消启动', board: await ensureBoard(workspaceId) };
    }
    const minutes = (runningTask.budget && runningTask.budget.maxMinutes) || (await ensureBoard(workspaceId)).settings.maxMinutesPerRun;
    armTimer(entry, minutes);
    driveTurn(entry, userMessage(buildExecutePrompt(runningTask)));
    return {
      ok: true,
      board: await ensureBoard(workspaceId),
      result: { runId, sessionId: entry.sessionId, worktree: entry.worktree },
    };
  }

  async function requestInput(entry, question) {
    const workspaceId = entry.workspaceId;
    let accepted = false;
    await lockedBoard(workspaceId, async (board) => {
      const task = findTask(board, entry.taskId);
      if (!task) return;
      const from = task.status;
      const to = confirmTransition('input', from);
      if (!to) return;
      task.status = to;
      task.pending = { kind: 'needs_input', runId: entry.runId, question };
      task.updatedAt = isoNow();
      await saveBoard(workspaceId, board, auditEntry('agent:' + entry.sessionId, 'request_input', task, from, to, { runId: entry.runId, reason: question }));
      accepted = true;
    });
    if (!accepted) return;
    entry.phase = 'input';
    clearEntryTimer(entry);
    pumpQueue(workspaceId);
  }

  async function requestApproval(entry, question) {
    const workspaceId = entry.workspaceId;
    let accepted = false;
    await lockedBoard(workspaceId, async (board) => {
      const task = findTask(board, entry.taskId);
      if (!task) return;
      const from = task.status;
      const to = confirmTransition('approval', from);
      if (!to) return;
      task.status = to;
      task.pending = { kind: 'awaiting_approval', runId: entry.runId, question };
      task.updatedAt = isoNow();
      await saveBoard(workspaceId, board, auditEntry('agent:' + entry.sessionId, 'request_approval', task, from, to, { runId: entry.runId, reason: question }));
      accepted = true;
    });
    if (!accepted) return;
    entry.phase = 'input';
    clearEntryTimer(entry);
    pumpQueue(workspaceId);
  }

  async function onRunTimeout(entry) {
    if (!entry || !runEntries.has(entry.key)) return;
    if (!['executing', 'reviewing', 'input', 'pr'].includes(entry.phase)) return;
    const workspaceId = entry.workspaceId;
    const minutes = entry.limitMinutes || DEFAULT_SETTINGS.maxMinutesPerRun;
    if (entry.agent) {
      try { entry.agent.cancel({ kind: 'user' }); } catch (e) { }
    }
    if (entry.kind === 'execute') {
      await lockedBoard(workspaceId, async (board) => {
        const task = findTask(board, entry.taskId);
        if (!task) return;
        const run = task.runs.find((item) => item.id === entry.runId);
        if (run && run.status === 'running') {
          run.status = 'failed';
          run.endedAt = isoNow();
          run.error = '执行超时';
        }
        const from = task.status;
        const to = confirmTransition('block', from) || 'blocked';
        task.status = to;
        task.error = '执行超时（' + minutes + ' 分钟），已取消，可重试';
        task.updatedAt = isoNow();
        await saveBoard(workspaceId, board, auditEntry('host', 'run_timeout', task, from, to, { runId: entry.runId, reason: task.error }));
      });
    } else {
      await lockedBoard(workspaceId, async (board) => {
        const task = findTask(board, entry.taskId);
        if (!task) return;
        const run = task.runs.find((item) => item.id === entry.runId);
        if (run && run.status === 'running') {
          run.status = 'failed';
          run.endedAt = isoNow();
          run.error = '评审超时';
        }
        task.reviews.push({
          id: newId(),
          round: task.round,
          sessionId: entry.sessionId,
          reviewerModel: entry.model || '',
          verdict: 'none',
          mustFix: [],
          nits: [],
          evidence: [],
          startedAt: run ? run.startedAt : null,
          endedAt: isoNow(),
          note: '评审超时',
        });
        const from = task.status;
        const to = confirmTransition('block', from) || 'blocked';
        task.status = to;
        task.error = '评审超时（' + minutes + ' 分钟），已转人工';
        task.updatedAt = isoNow();
        await saveBoard(workspaceId, board, auditEntry('host', 'review_timeout', task, from, to, { runId: entry.runId, reason: task.error }));
      });
      releaseEntry(entry, true);
      pumpQueue(workspaceId);
      pumpReviewQueue(workspaceId).catch(() => undefined);
      return;
    }
    releaseEntry(entry, false);
    pumpQueue(workspaceId);
    pumpReviewQueue(workspaceId).catch(() => undefined);
  }

  function firstPrFromForge(entry) {
    try {
      if (!entry || !entry.agent || !entry.agent.session) return null;
      const forge = getService('forgeSession');
      if (!forge || typeof forge.changeRequests !== 'function') return null;
      const list = forge.changeRequests(entry.agent.session) || [];
      if (!list.length) return null;
      const last = list[list.length - 1];
      if (!last || !last.url) return null;
      const update = last.update || {};
      return {
        url: String(last.url),
        state: update.state || update.status || 'open',
        checks: update.checksRollup !== undefined ? update.checksRollup : (update.checks !== undefined ? update.checks : null),
      };
    } catch (e) {
      return null;
    }
  }

  function capturePrUrl(entry, text) {
    if (!entry || !entry.prCapture || entry.prCapture.url) return;
    const url = extractPrUrl(text);
    if (url) entry.prCapture.url = url;
  }

  function onSessionEvent(session, event) {
    try {
      if (!session || !session.id) return;
      const entry = sessionIndex.get(session.id);
      if (!entry) return;
      const type = event && event.type;
      const data = event && event.data;
      if (entry.prCapture && (type === 'tool/result' || type === 'tool/call')) {
        capturePrUrl(entry, JSON.stringify(data || {}));
      }
      if (type === 'turn/end') {
        if (entry.phase === 'executing' || entry.phase === 'reviewing') {
          Promise.resolve().then(() => settleEntry(entry)).catch(() => undefined);
        }
      }
    } catch (error) {
      logWarn('session/event 处理失败', String((error && error.message) || error));
    }
  }

  async function createPr(workspaceId, taskId, options) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在', board };
    const allowed = ['awaiting_signoff', 'pr_pending', 'finalize_failed'].includes(task.status)
      || (options && options.internal && task.status === 'finalizing');
    if (!allowed) return { ok: false, code: 'invalid_transition', error: '当前状态不能补建 PR', board };
    if (board.settings && board.settings.pushConsent === 'never') {
      return { ok: false, code: 'action_failed', error: '看板设置禁止推送（pushConsent=never），无法创建 PR', board };
    }
    const workspace = findWorkspace(workspaceId);
    if (!workspace || !workspace.path) return { ok: false, code: 'action_failed', error: '工作区路径缺失', board };
    const probe = await gitProbe(workspace.path);
    if (!probe.isRepo) return { ok: false, code: 'action_failed', error: '工作区不是 Git 仓库', board };
    if (!probe.hasRemote) return { ok: false, code: 'action_failed', error: '仓库没有远程地址，无法推送分支', board };
    const worktree = latestExecuteWorktree(task);
    const branch = (task.delivery && task.delivery.branch) || (worktree && worktree.branch);
    if (!branch) return { ok: false, code: 'action_failed', error: '找不到任务分支，无法创建 PR', board };
    const push = await git(['-C', workspace.path, 'push', '-u', 'origin', branch], workspace.path, 120000);
    if (!push.ok) {
      return { ok: false, code: 'action_failed', error: '推送分支失败：' + (push.stderr || push.error), board };
    }
    let entry = findEntry(workspaceId, taskId, 'execute');
    let looseEntry = false;
    if (!entry) {
      const latestRun = [...task.runs].reverse().find((run) => run.kind === 'execute' && run.sessionId);
      const agents = agentsService();
      const agent = latestRun && agents && typeof agents.get === 'function' ? agents.get(latestRun.sessionId) : undefined;
      if (!agent) {
        await lockedBoard(workspaceId, async (current) => {
          const target = findTask(current, taskId);
          if (!target) return;
          const from = target.status;
          const to = confirmTransition('pr_pending', from) || 'pr_pending';
          target.status = to;
          target.error = '已推送分支，但执行会话不可用，请手动创建 PR 后补建';
          target.updatedAt = isoNow();
          await saveBoard(workspaceId, current, auditEntry('host', 'create_pr_pending', target, from, to, { reason: target.error }));
        });
        return { ok: false, code: 'action_failed', error: '已推送分支，但执行会话不可用，请手动创建 PR 后补建', board: await ensureBoard(workspaceId) };
      }
      looseEntry = true;
      entry = {
        key: keyOf(workspaceId, taskId) + '::execute-loose',
        workspaceId,
        taskId,
        kind: 'execute',
        runId: latestRun ? latestRun.id : null,
        sessionId: latestRun ? latestRun.sessionId : null,
        agent,
        dispose: null,
        phase: 'pr',
        timer: null,
        startedAt: Date.now(),
        worktree: worktree,
        worktreePath: worktree ? worktree.path : null,
        model: task.executor || '',
        settled: true,
        toolsReady: false,
        prCapture: null,
      };
      sessionIndex.set(entry.sessionId, entry);
    }
    entry.prCapture = { url: null };
    entry.phase = 'pr';
    entry.prTurnDone = false;
    const prompt = buildPrPrompt(task, branch);
    try { entry.agent.followup(userMessage(prompt)); }
    catch (error) { entry.prTurnDone = true; logWarn('PR followup 发送失败', String((error && error.message) || error)); }
    try {
      Promise.resolve(entry.agent.whenIdle())
        .catch(() => undefined)
        .then(() => { entry.prTurnDone = true; })
        .catch(() => { entry.prTurnDone = true; });
    } catch (e) {
      entry.prTurnDone = true;
    }
    const startedWaiting = Date.now();
    const deadline = startedWaiting + PR_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (entry.prCapture && entry.prCapture.url) break;
      if (entry.prTurnDone && Date.now() - startedWaiting > 1500) {
        const forged = firstPrFromForge(entry);
        if (forged) { entry.prCapture.url = forged.url; break; }
        break;
      }
      await sleep(500);
    }
    let bound = null;
    if (entry.prCapture && entry.prCapture.url) {
      bound = { url: entry.prCapture.url, state: 'open', checks: null };
    } else {
      const forged = firstPrFromForge(entry);
      if (forged) bound = forged;
    }
    entry.phase = 'waiting';
    entry.prCapture = null;
    entry.prTurnDone = false;
    if (looseEntry) {
      if (entry.sessionId && sessionIndex.get(entry.sessionId) === entry) sessionIndex.delete(entry.sessionId);
      runEntries.delete(entry.key);
    }
    if (!bound) {
      await lockedBoard(workspaceId, async (current) => {
        const target = findTask(current, taskId);
        if (!target) return;
        const from = target.status;
        const to = confirmTransition('pr_pending', from) || 'pr_pending';
        target.status = to;
        target.error = '已推送分支，但 90 秒内未获取 PR 链接，请手动创建后补建';
        target.updatedAt = isoNow();
        await saveBoard(workspaceId, current, auditEntry('host', 'create_pr_pending', target, from, to, { reason: target.error }));
      });
      return { ok: false, code: 'action_failed', error: '已推送分支，但 90 秒内未获取 PR 链接，请手动创建后补建', board: await ensureBoard(workspaceId) };
    }
    let pr = null;
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target) return;
      const from = target.status;
      const to = confirmTransition('finalize', from) || confirmTransition('pr_pending', from) || 'awaiting_signoff';
      target.pr = {
        url: bound.url,
        number: prNumber(bound.url),
        state: bound.state || 'open',
        checks: bound.checks === undefined ? null : bound.checks,
        bound: true,
      };
      target.status = to;
      target.error = null;
      target.updatedAt = isoNow();
      pr = target.pr;
      await saveBoard(workspaceId, current, auditEntry('host', 'create_pr', target, from, to, { reason: bound.url }));
    });
    pumpQueue(workspaceId);
    return { ok: true, board: await ensureBoard(workspaceId), result: { url: pr ? pr.url : bound.url } };
  }

  async function mergeTask(workspaceId, task) {
    const workspace = findWorkspace(workspaceId);
    if (!workspace || !workspace.path) return { ok: false, error: '工作区路径缺失' };
    const probe = await gitProbe(workspace.path);
    if (!probe.isRepo) return { ok: false, error: '工作区不是 Git 仓库' };
    if (probe.dirty) return { ok: false, error: '根仓库有未提交改动，请先提交或清理后再合并' };
    const worktree = latestExecuteWorktree(task);
    const branch = (task.delivery && task.delivery.branch) || (worktree && worktree.branch);
    if (!branch) return { ok: false, error: '找不到任务分支，无法合并' };
    const merged = await git(['-C', workspace.path, 'merge', '--squash', branch], workspace.path, 120000);
    if (!merged.ok) {
      await git(['-C', workspace.path, 'merge', '--abort'], workspace.path, 30000);
      return { ok: false, error: '合并失败（可能有冲突）：' + (merged.stderr || merged.error) };
    }
    const committed = await git(['-C', workspace.path, 'commit', '-m', 'task: ' + (task.title || task.id) + ' (' + task.id + ')'], workspace.path, 120000);
    if (!committed.ok) return { ok: false, error: '提交合并结果失败：' + (committed.stderr || committed.error) };
    return { ok: true };
  }

  async function cleanupWorktree(workspaceId, task) {
    const workspace = findWorkspace(workspaceId);
    if (!workspace || !workspace.path) return { ok: false, error: '工作区路径缺失' };
    const worktree = latestExecuteWorktree(task);
    const worktreePath = (worktree && worktree.path) || path.join(workspace.path, '.agents', 'worktrees', 'task-' + safeId(task.id));
    const branch = (task.delivery && task.delivery.branch) || (worktree && worktree.branch) || 'task-' + safeId(task.id);
    const errors = [];
    const removed = await git(['-C', workspace.path, 'worktree', 'remove', '--force', worktreePath], workspace.path, 120000);
    if (!removed.ok && (await pathExists(worktreePath))) errors.push('移除工作树失败：' + (removed.stderr || removed.error));
    if (!removed.ok) await git(['-C', workspace.path, 'worktree', 'prune'], workspace.path, 30000);
    const branchExists = await git(['-C', workspace.path, 'rev-parse', '--verify', 'refs/heads/' + branch], workspace.path, 30000);
    if (branchExists.ok) {
      const deleted = await git(['-C', workspace.path, 'branch', '-D', branch], workspace.path, 30000);
      if (!deleted.ok) errors.push('删除分支失败：' + (deleted.stderr || deleted.error));
    }
    if (errors.length) return { ok: false, error: errors.join('；') };
    return { ok: true };
  }

  async function cancelTask(workspaceId, taskId) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在', board };
    const to = confirmTransition('cancel', task.status);
    if (!to) return { ok: false, code: 'invalid_transition', error: '当前状态不能取消', board };
    const queue = queues.get(workspaceId);
    if (queue) {
      const index = queue.findIndex((item) => item.taskId === taskId);
      if (index >= 0) queue.splice(index, 1);
    }
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target) return;
      const from = target.status;
      const toStatus = confirmTransition('cancel', from);
      if (!toStatus) return;
      target.status = toStatus;
      target.pending = null;
      target.updatedAt = isoNow();
      target.runs.forEach((run) => {
        if (run.status === 'running') {
          run.status = 'cancelled';
          run.endedAt = isoNow();
        }
      });
      await saveBoard(workspaceId, current, auditEntry('user', 'cancel', target, from, toStatus, {}));
    });
    entryKeysForTask(workspaceId, taskId).forEach((key) => {
      const entry = runEntries.get(key);
      if (!entry) return;
      if (entry.agent) {
        try { entry.agent.cancel({ kind: 'user' }); } catch (e) { }
      }
      clearEntryTimer(entry);
      releaseEntry(entry, entry.kind === 'review');
    });
    pumpQueue(workspaceId);
    pumpReviewQueue(workspaceId).catch(() => undefined);
    return { ok: true, board: await ensureBoard(workspaceId) };
  }

  async function retryTask(workspaceId, taskId) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在', board };
    if (!confirmTransition('retry', task.status)) {
      return { ok: false, code: 'invalid_transition', error: '只有 blocked / failed / cancelled 状态可以重试', board };
    }
    releaseTask(workspaceId, taskId, null);
    return startTask(workspaceId, taskId);
  }

  async function answerTask(workspaceId, taskId, payload) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在', board };
    if (task.status !== 'needs_input') return { ok: false, code: 'invalid_transition', error: '任务当前不需要人工回答', board };
    const text = asText(payload && payload.text, 8000);
    if (!text.trim()) return { ok: false, code: 'action_failed', error: '答复内容不能为空', board };
    const pending = task.pending || {};
    const run = task.runs.find((item) => item.id === pending.runId);
    const kind = run && run.kind === 'review' ? 'review' : 'execute';
    const entry = findEntry(workspaceId, taskId, kind);
    if (!entry) {
      await blockTask(workspaceId, taskId, '执行会话已丢失，无法继续任务，请重试', pending.runId);
      return { ok: false, code: 'not_ready', error: '执行会话已丢失，无法继续任务，请重试', board: await ensureBoard(workspaceId) };
    }
    const from = task.status;
    const to = kind === 'review' ? 'reviewing' : 'running';
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target) return;
      target.status = to;
      target.pending = null;
      target.updatedAt = isoNow();
      await saveBoard(workspaceId, current, auditEntry('user', 'answer', target, from, to, { runId: pending.runId }));
    });
    entry.phase = kind === 'review' ? 'reviewing' : 'executing';
    entry.settled = false;
    armTimer(entry, kind === 'review' ? REVIEW_LIMIT_MINUTES : ((task.budget && task.budget.maxMinutes) || board.settings.maxMinutesPerRun));
    driveTurn(entry, userMessage('人工答复：' + text));
    return { ok: true, board: await ensureBoard(workspaceId) };
  }

  async function approveTask(workspaceId, taskId, payload) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在', board };
    if (task.status !== 'awaiting_approval') return { ok: false, code: 'invalid_transition', error: '任务当前不需要批准', board };
    const pending = task.pending || {};
    const run = task.runs.find((item) => item.id === pending.runId);
    const kind = run && run.kind === 'review' ? 'review' : 'execute';
    const entry = findEntry(workspaceId, taskId, kind);
    if (!entry) {
      await blockTask(workspaceId, taskId, '执行会话已丢失，无法继续任务，请重试', pending.runId);
      return { ok: false, code: 'not_ready', error: '执行会话已丢失，无法继续任务，请重试', board: await ensureBoard(workspaceId) };
    }
    const from = task.status;
    const to = kind === 'review' ? 'reviewing' : 'running';
    const note = asText(payload && payload.note, 4000);
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target) return;
      target.status = to;
      target.pending = null;
      target.updatedAt = isoNow();
      await saveBoard(workspaceId, current, auditEntry('user', 'approve', target, from, to, { runId: pending.runId, reason: note }));
    });
    entry.phase = kind === 'review' ? 'reviewing' : 'executing';
    entry.settled = false;
    armTimer(entry, kind === 'review' ? REVIEW_LIMIT_MINUTES : ((task.budget && task.budget.maxMinutes) || board.settings.maxMinutesPerRun));
    driveTurn(entry, userMessage('人工已批准' + (note ? '（意见：' + note + '）' : '') + '，请继续。'));
    return { ok: true, board: await ensureBoard(workspaceId) };
  }

  async function signoffTask(workspaceId, taskId, payload) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在', board };
    const to = confirmTransition('signoff', task.status);
    if (!to) return { ok: false, code: 'invalid_transition', error: '只有待签收 / 可补建 PR 的任务可以签字', board };
    if (!task.delivery) return { ok: false, code: 'not_ready', error: '没有可签收的交付物，请先完成交付', board };
    const latestReview = Array.isArray(task.reviews) && task.reviews.length ? task.reviews[task.reviews.length - 1] : null;
    const openMustFix = latestReview && Array.isArray(latestReview.mustFix)
      ? latestReview.mustFix.filter((item) => item && item.status !== 'closed')
      : [];
    if (openMustFix.length) {
      return { ok: false, code: 'action_failed', error: '仍有未关闭的评审 mustFix，不能签字', board };
    }
    const merge = payload && payload.merge === true;
    if (merge) {
      const merged = await mergeTask(workspaceId, task);
      if (!merged.ok) return { ok: false, code: 'action_failed', error: merged.error, board };
    }
    const note = asText(payload && payload.note, 4000);
    let signed = null;
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target) return;
      const from = target.status;
      const toStatus = confirmTransition('signoff', from);
      if (!toStatus) return;
      const passReview = [...target.reviews].reverse().find((review) => review && review.verdict === 'pass') || null;
      target.signoff = {
        by: 'user',
        at: isoNow(),
        note,
        reviewId: passReview ? passReview.id : null,
        verification: passReview && passReview.verification ? passReview.verification : null,
      };
      target.status = toStatus;
      target.error = null;
      target.pending = null;
      if (merge && target.pr) target.pr = Object.assign({}, target.pr, { state: 'merged' });
      if (merge && target.delivery) target.delivery = Object.assign({}, target.delivery, { mergedAt: isoNow() });
      target.updatedAt = isoNow();
      signed = target;
      await saveBoard(workspaceId, current, auditEntry('user', 'signoff', target, from, toStatus, {
        reason: note,
        reviewId: target.signoff.reviewId,
        verification: target.signoff.verification,
      }));
    });
    releaseTask(workspaceId, taskId, null);
    pumpQueue(workspaceId);
    return { ok: true, board: await ensureBoard(workspaceId), result: signed ? { signoff: signed.signoff } : {} };
  }

  async function rejectTask(workspaceId, taskId, payload) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在', board };
    const to = confirmTransition('reject', task.status);
    if (!to) return { ok: false, code: 'invalid_transition', error: '只有待签收 / 可补建 PR 的任务可以打回', board };
    const note = asText(payload && payload.note, 4000);
    const maxRounds = (task.budget && task.budget.maxRounds) || board.settings.maxRounds;
    if (task.round >= maxRounds) {
      await blockTask(workspaceId, taskId, '打回返工次数已达到轮数上限（' + maxRounds + ' 轮），需人工处理', null);
      return { ok: false, code: 'action_failed', error: '打回返工次数已达到轮数上限（' + maxRounds + ' 轮），需人工处理', board: await ensureBoard(workspaceId) };
    }
    if (!findEntry(workspaceId, taskId, 'execute')) {
      await blockTask(workspaceId, taskId, '执行会话已丢失，无法打回返工，请重试', null);
      return { ok: false, code: 'not_ready', error: '执行会话已丢失，无法打回返工，请重试', board: await ensureBoard(workspaceId) };
    }
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target) return;
      const from = target.status;
      const toStatus = confirmTransition('reject', from);
      if (!toStatus) return;
      target.round += 1;
      target.status = toStatus;
      target.error = null;
      target.updatedAt = isoNow();
      await saveBoard(workspaceId, current, auditEntry('user', 'reject', target, from, toStatus, { reason: note }));
    });
    return resumeExecution(workspaceId, taskId, buildRejectPrompt(note));
  }

  async function mergeTaskAction(workspaceId, taskId) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在', board };
    if (task.status !== 'done') return { ok: false, code: 'invalid_transition', error: '只有已完成的任务可以合并', board };
    const merged = await mergeTask(workspaceId, task);
    if (!merged.ok) return { ok: false, code: 'action_failed', error: merged.error, board };
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target) return;
      target.pr = target.pr ? Object.assign({}, target.pr, { state: 'merged' }) : target.pr;
      target.delivery = target.delivery ? Object.assign({}, target.delivery, { mergedAt: isoNow() }) : target.delivery;
      target.updatedAt = isoNow();
      await saveBoard(workspaceId, current, auditEntry('user', 'merge', target, target.status, target.status, {}));
    });
    return { ok: true, board: await ensureBoard(workspaceId) };
  }

  async function archiveTaskAction(workspaceId, taskId) {
    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在', board };
    if (!['done', 'cancelled'].includes(task.status)) {
      return { ok: false, code: 'invalid_transition', error: '只有已完成或已取消的任务可以归档', board };
    }
    await appendArchive(workspaceId, task);
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target) return;
      current.cards = current.cards.filter((card) => card.id !== taskId);
      await saveBoard(workspaceId, current, auditEntry('user', 'archive', target, target.status, target.status, {}));
    });
    return { ok: true, board: await ensureBoard(workspaceId), result: { archived: true } };
  }

  async function cleanupTaskAction(workspaceId, taskId) {    const board = await ensureBoard(workspaceId);
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在', board };
    if (!['done', 'cancelled'].includes(task.status)) {
      return { ok: false, code: 'invalid_transition', error: '只有已完成或已取消的任务可以清理工作树', board };
    }
    const cleaned = await cleanupWorktree(workspaceId, task);
    if (!cleaned.ok) return { ok: false, code: 'action_failed', error: cleaned.error, board };
    await lockedBoard(workspaceId, async (current) => {
      const target = findTask(current, taskId);
      if (!target) return;
      target.delivery = target.delivery ? Object.assign({}, target.delivery, { cleanedAt: isoNow() }) : target.delivery;
      target.updatedAt = isoNow();
      await saveBoard(workspaceId, current, auditEntry('user', 'cleanup', target, target.status, target.status, {}));
    });
    return { ok: true, board: await ensureBoard(workspaceId) };
  }

  async function runAction(workspaceId, taskId, action, payload) {
    switch (action) {
      case 'cancel': return cancelTask(workspaceId, taskId);
      case 'retry': return retryTask(workspaceId, taskId);
      case 'answer': return answerTask(workspaceId, taskId, payload);
      case 'approve': return approveTask(workspaceId, taskId, payload);
      case 'signoff': return signoffTask(workspaceId, taskId, payload);
      case 'reject': return rejectTask(workspaceId, taskId, payload);
      case 'create_pr': return createPr(workspaceId, taskId, null);
      case 'merge': return mergeTaskAction(workspaceId, taskId);
      case 'archive': return archiveTaskAction(workspaceId, taskId);
      case 'cleanup': return cleanupTaskAction(workspaceId, taskId);
      default: return null;
    }
  }

  async function patchTask(workspaceId, taskId) {
    const board = await readBoard(workspaceId);
    if (!board) return { ok: false, code: 'not_ready', error: '看板不存在，无法导出补丁' };
    const task = findTask(board, taskId);
    if (!task) return { ok: false, code: 'not_ready', error: '任务不存在，无法导出补丁' };
    const workspace = findWorkspace(workspaceId);
    if (!workspace || !workspace.path) return { ok: false, code: 'action_failed', error: '工作区路径缺失' };
    const worktree = latestExecuteWorktree(task);
    const branch = (task.delivery && task.delivery.branch) || (worktree && worktree.branch);
    const baseCommit = (task.delivery && task.delivery.baseCommit) || (worktree && worktree.baseCommit);
    if (!branch || !baseCommit) return { ok: false, code: 'not_ready', error: '没有可导出的交付物，请先执行任务' };
    const stat = await git(['-C', workspace.path, 'diff', baseCommit + '..' + branch, '--stat'], workspace.path, 120000);
    const patch = await git(['-C', workspace.path, 'diff', baseCommit + '..' + branch], workspace.path, 120000);
    if (!stat.ok || !patch.ok) {
      return { ok: false, code: 'action_failed', error: 'git diff 失败：' + (stat.error || patch.error) };
    }
    if (patch.stdout.length > MAX_PATCH) {
      return { ok: false, code: 'action_failed', error: '补丁超过 2MB，请改用本地查看' };
    }
    return { ok: true, patch: patch.stdout, diffStat: stat.stdout.trim() };
  }

  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    const method = (req.method || 'GET').toUpperCase();
    try {
      if (method === 'GET' && sub === '/health') {
        return json(res, 200, { ok: true, pid: process.pid, time: Date.now() });
      }
      if (method === 'GET' && sub === '/workspaces') {
        return json(res, 200, { ok: true, workspaces: workspaceList() });
      }
      if (method === 'GET' && sub === '/git') {
        const target = url.searchParams.get('path');
        if (!target) return json(res, 400, { ok: false, error: 'path required' });
        if (!underWorkspace(target)) return json(res, 403, { ok: false, error: 'path outside registered workspaces' });
        const probe = await gitProbe(target);
        return json(res, 200, Object.assign({ ok: true }, probe));
      }
      if (method === 'GET' && sub === '/board') {
        const workspaceId = url.searchParams.get('workspaceId');
        if (!workspaceId) return json(res, 400, { ok: false, error: 'workspaceId required' });
        if (!findWorkspace(workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
        return json(res, 200, { ok: true, board: await readBoard(workspaceId) });
      }
      if (method === 'PUT' && sub === '/board') {
        const body = await readBody(req);
        if (!body || !body.workspaceId) return json(res, 400, { ok: false, error: 'workspaceId required' });
        if (!findWorkspace(body.workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
        if (!body.board || typeof body.board !== 'object') return json(res, 400, { ok: false, error: 'board required' });
        const workspaceId = String(body.workspaceId);
        if (!(await authGuard(workspaceId, req, url))) return json(res, 401, { ok: false, code: 'unauthorized', error: '需要鉴权 token（x-task-board-token 或 ?token=）' });
        const expected = body.expectedRevision === undefined || body.expectedRevision === null ? 0 : asInt(body.expectedRevision, -1);
        const result = await lockedBoard(workspaceId, async () => {
          const oldBoard = await readBoard(workspaceId);
          const oldRevision = oldBoard ? oldBoard.revision : 0;
          if (expected !== oldRevision) {
            return { conflict: true, board: oldBoard };
          }
          const merged = mergeIncomingBoard(oldBoard, body.board);
          await saveBoard(workspaceId, merged.board, auditEntry('user', 'save_board', null, null, null, {}));
          return { conflict: false, board: merged.board, warnings: merged.warnings };
        });
        if (result.conflict) {
          return json(res, 409, { ok: false, code: 'revision_conflict', error: '看板已在别处更新，请先刷新', board: result.board });
        }
        return json(res, 200, { ok: true, board: result.board, ...(result.warnings.length ? { result: { warnings: result.warnings } } : {}) });
      }
      if (method === 'POST' && sub === '/start') {
        const body = await readBody(req);
        if (!body || !body.workspaceId || !body.taskId) return json(res, 400, { ok: false, error: 'workspaceId and taskId required' });
        if (!findWorkspace(body.workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
        const workspaceId = String(body.workspaceId);
        if (!(await authGuard(workspaceId, req, url))) return json(res, 401, { ok: false, code: 'unauthorized', error: '需要鉴权 token（x-task-board-token 或 ?token=）' });
        if (body.expectedRevision !== undefined && body.expectedRevision !== null) {
          const board = await readBoard(workspaceId);
          const revision = board ? board.revision : 0;
          if (asInt(body.expectedRevision, -1) !== revision) {
            return json(res, 200, { ok: false, code: 'revision_conflict', error: '看板已在别处更新，请先刷新', board });
          }
        }
        const result = await startTask(workspaceId, String(body.taskId));
        return json(res, 200, result);
      }
      if (method === 'POST' && sub === '/action') {
        const body = await readBody(req);
        if (!body || !body.workspaceId || !body.taskId || !body.action) {
          return json(res, 400, { ok: false, error: 'workspaceId, taskId and action required' });
        }
        if (!findWorkspace(body.workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
        const workspaceId = String(body.workspaceId);
        if (!(await authGuard(workspaceId, req, url))) return json(res, 401, { ok: false, code: 'unauthorized', error: '需要鉴权 token（x-task-board-token 或 ?token=）' });
        const taskId = String(body.taskId);
        if (body.expectedRevision !== undefined && body.expectedRevision !== null) {
          const board = await readBoard(workspaceId);
          const revision = board ? board.revision : 0;
          if (asInt(body.expectedRevision, -1) !== revision) {
            return json(res, 200, { ok: false, code: 'revision_conflict', error: '看板已在别处更新，请先刷新', board });
          }
        }
        const result = await runAction(workspaceId, taskId, String(body.action), body.payload || {});
        if (!result) return json(res, 200, { ok: false, code: 'invalid_transition', error: '未知动作：' + body.action, board: await ensureBoard(workspaceId) });
        return json(res, 200, result);
      }
      if (method === 'POST' && sub === '/reconcile') {
        const body = await readBody(req);
        if (!body || !body.workspaceId) return json(res, 400, { ok: false, error: 'workspaceId required' });
        if (!findWorkspace(body.workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
        if (!(await authGuard(String(body.workspaceId), req, url))) return json(res, 401, { ok: false, code: 'unauthorized', error: '需要鉴权 token（x-task-board-token 或 ?token=）' });
        await reconcileAll();
        return json(res, 200, { ok: true, board: await ensureBoard(String(body.workspaceId)) });
      }
      if (method === 'POST' && sub === '/settings') {
        const body = await readBody(req);
        if (!body || !body.workspaceId || !body.settings || typeof body.settings !== 'object') {
          return json(res, 400, { ok: false, error: 'workspaceId and settings required' });
        }
        if (!findWorkspace(body.workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
        const workspaceId = String(body.workspaceId);
        if (!(await authGuard(workspaceId, req, url))) return json(res, 401, { ok: false, code: 'unauthorized', error: '需要鉴权 token（x-task-board-token 或 ?token=）' });
        let conflict = false;
        let saved = null;
        await lockedBoard(workspaceId, async (board) => {
          if (body.expectedRevision !== undefined && body.expectedRevision !== null && asInt(body.expectedRevision, -1) !== board.revision) {
            conflict = true;
            saved = board;
            return;
          }
          board.settings = normalizeSettings(Object.assign({}, board.settings, body.settings));
          await saveBoard(workspaceId, board, auditEntry('user', 'settings', null, null, null, { reason: Object.keys(body.settings).join(',') }));
          saved = board;
        });
        if (conflict) return json(res, 200, { ok: false, code: 'revision_conflict', error: '看板已在别处更新，请先刷新', board: saved });
        return json(res, 200, { ok: true, board: saved });
      }
      if (method === 'GET' && sub === '/events') {
        const workspaceId = url.searchParams.get('workspaceId');
        if (!workspaceId) return json(res, 400, { ok: false, error: 'workspaceId required' });
        if (!findWorkspace(workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
        const once = url.searchParams.get('once') === '1';
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        let last = -1;
        let closed = false;
        const send = async () => {
          if (closed) return;
          const b = await ensureBoard(workspaceId);
          if (b.revision !== last) {
            last = b.revision;
            res.write('event: board\ndata: ' + JSON.stringify({ workspaceId, revision: b.revision }) + '\n\n');
          }
        };
        send().catch(() => undefined);
        if (once) {
          setTimeout(() => { closed = true; try { res.end(); } catch (e) { } }, 60);
          return;
        }
        const iv = setInterval(() => { send().catch(() => undefined); }, 1500);
        const ka = setInterval(() => { if (!closed) { try { res.write(': ping\n\n'); } catch (e) { } } }, 15000);
        if (iv && typeof iv.unref === 'function') iv.unref();
        if (ka && typeof ka.unref === 'function') ka.unref();
        req.on('close', () => { closed = true; clearInterval(iv); clearInterval(ka); });
        return;
      }
      if (method === 'GET' && sub === '/patch') {
        const workspaceId = url.searchParams.get('workspaceId');
        const taskId = url.searchParams.get('taskId');
        if (!workspaceId || !taskId) return json(res, 400, { ok: false, error: 'workspaceId and taskId required' });
        if (!findWorkspace(workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
        return json(res, 200, await patchTask(workspaceId, taskId));
      }
      if (method === 'GET' && sub === '/audit') {
        const workspaceId = url.searchParams.get('workspaceId');
        if (!workspaceId) return json(res, 400, { ok: false, error: 'workspaceId required' });
        if (!findWorkspace(workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
        const rawLimit = url.searchParams.get('limit');
        const limit = rawLimit === null ? AUDIT_DEFAULT_LIMIT : clampInt(rawLimit, 1, AUDIT_MAX_LIMIT, AUDIT_DEFAULT_LIMIT);
        const taskId = url.searchParams.get('taskId') || null;
        const audit = await readAudit(workspaceId, { limit, taskId });
        return json(res, 200, { ok: true, entries: audit.entries, count: audit.count });
      }
      if (method === 'GET' && sub === '/stats') {
        const workspaceId = url.searchParams.get('workspaceId');
        if (!workspaceId) return json(res, 400, { ok: false, error: 'workspaceId required' });
        if (!findWorkspace(workspaceId)) return json(res, 400, { ok: false, error: 'unknown workspaceId' });
        const board = await ensureBoard(workspaceId);
        const audit = await readAudit(workspaceId, { limit: AUDIT_MAX_LIMIT });
        const runtime = {
          waiting: (queues.get(workspaceId) || []).length,
          running: activeExecutionCount(workspaceId),
        };
        return json(res, 200, { ok: true, stats: computeStats(board, audit.entries, runtime) });
      }
      return json(res, 404, { ok: false, error: 'not found', path: sub });
    } catch (error) {
      logError('task-board request failed', String((error && error.message) || error));
      try { json(res, 500, { ok: false, error: String((error && error.message) || error) }); }
      catch (e) { }
    }
  }

  async function reconcileBoard(workspaceId, board) {
    const changes = [];
    const enqueueExec = [];
    const scheduleReviewTasks = [];
    for (const task of board.cards) {
      if (!LIVE_STATUS.has(task.status)) continue;
      const updatedAt = Date.parse(task.updatedAt || '');
      if (Number.isFinite(updatedAt) && updatedAt >= bootAt) continue;
      const lastRun = [...task.runs].reverse().find((run) => run.status === 'running' || run.sessionId);
      const agents = agentsService();
      const agent = lastRun && lastRun.sessionId && agents && typeof agents.get === 'function'
        ? agents.get(lastRun.sessionId)
        : undefined;
      if (agent) {
        if (!lastRun) continue;
        const kind = lastRun.kind === 'review' ? 'review' : 'execute';
        const phase = task.status === 'reviewing'
          ? 'reviewing'
          : (task.status === 'needs_input' ? 'input' : (task.status === 'running' ? 'executing' : 'submitted'));
        const entry = {
          key: keyOf(workspaceId, task.id) + '::' + kind,
          workspaceId,
          taskId: task.id,
          kind,
          runId: lastRun.id,
          sessionId: lastRun.sessionId,
          agent,
          dispose: null,
          phase,
          timer: null,
          startedAt: Date.now(),
          worktree: lastRun.worktree,
          worktreePath: lastRun.worktree ? lastRun.worktree.path : null,
          model: lastRun.model || '',
          settled: phase !== 'executing' && phase !== 'reviewing',
          toolsReady: false,
          prCapture: null,
          limitMinutes: kind === 'review' ? REVIEW_LIMIT_MINUTES : 20,
        };
        adoptEntry(entry);
        if (phase === 'executing' || phase === 'reviewing') armTimer(entry, entry.limitMinutes);
        continue;
      }
      const from = task.status;
      if (from === 'awaiting_review') {
        scheduleReviewTasks.push(task.id);
        continue;
      }
      if (from === 'reviewing') {
        if (lastRun && lastRun.status === 'running') {
          lastRun.status = 'failed';
          lastRun.endedAt = isoNow();
          lastRun.error = 'Host 重启，评审会话重建';
        }
        task.status = 'awaiting_review';
        task.updatedAt = isoNow();
        changes.push(auditEntry('host', 'reconcile_review_restart', task, from, 'awaiting_review', { runId: lastRun ? lastRun.id : null }));
        scheduleReviewTasks.push(task.id);
        continue;
      }
      if (from === 'queued' || from === 'worktree_preparing' || from === 'running' || from === 'changes_requested') {
        if (lastRun && lastRun.status === 'running' && lastRun.kind !== 'review') {
          lastRun.status = 'failed';
          lastRun.endedAt = isoNow();
          lastRun.error = 'Host 重启，执行会话重建';
        }
        task.status = 'queued';
        task.error = null;
        task.updatedAt = isoNow();
        changes.push(auditEntry('host', 'reconcile_requeue', task, from, 'queued', { runId: lastRun ? lastRun.id : null }));
        enqueueExec.push(task.id);
        continue;
      }
      task.status = 'blocked';
      task.error = 'Host 重启，需人工继续（' + from + '）';
      task.pending = null;
      task.updatedAt = isoNow();
      changes.push(auditEntry('host', 'reconcile', task, from, 'blocked', { reason: task.error, runId: lastRun ? lastRun.id : null }));
    }
    return { changes, enqueueExec, scheduleReviewTasks };
  }

  async function reconcileAll() {
    let names = [];
    try { names = await fs.readdir(dataDir()); }
    catch (e) { return; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const base = name.slice(0, -5);
      const workspace = workspaceList().find((item) => safeId(item.id) === base);
      if (!workspace) continue;
      let result = null;
      let snapshot = null;
      await lockedBoard(workspace.id, async (current) => {
        result = await reconcileBoard(workspace.id, current);
        if (result.changes.length) {
          await saveBoard(workspace.id, current, null);
          for (const change of result.changes) await appendAudit(workspace.id, change);
        }
        snapshot = current;
      });
      if (!result) continue;
      for (const taskId of result.enqueueExec) {
        const task = findTask(snapshot, taskId);
        const queue = queues.get(workspace.id) || [];
        if (!queue.some((item) => item.taskId === taskId)) queue.push({ taskId, priority: task ? task.priority : 'none' });
        queues.set(workspace.id, queue);
      }
      if (result.enqueueExec.length) pumpQueue(workspace.id).catch(() => undefined);
      for (const taskId of result.scheduleReviewTasks) {
        scheduleReview(workspace.id, taskId).catch(() => undefined);
      }
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: handleRequest,
  }), 'dsh-task-board: http api');

  ctx.effect(() => ctx.on('session/event', onSessionEvent), 'dsh-task-board: session events');

  ctx.effect(() => {
    const timer = setTimeout(() => {
      reconcileAll().catch((error) => logWarn('重启对账失败', String((error && error.message) || error)));
    }, 800);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return () => clearTimeout(timer);
  }, 'dsh-task-board: reconcile');

  registerCreateCardTool();
}
