import { createHash } from 'node:crypto';

export const inject = ['webServer'];

const ROUTE_PREFIX = '/task-board-api';
const SNAPSHOT_TTL_MS = 10000;
const ARCHIVED_SUMMARY_TTL_MS = 15000;
const LIST_TIMEOUT_MS = 15000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DETAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
const DETAIL_LIMIT = 12;
const DETAIL_TTL_MS = 12000;
const ACTIVITY_TTL_MS = 5000;
const ACTIVITY_TIMEOUT_MS = 1200;
const TITLE_CHANGE_GRACE_MS = 5000;
const DETAIL_CACHE_LIMIT = 32;
const ACTIVITY_CACHE_LIMIT = 64;
const MAX_SNAPSHOT_KEYS = 6;

function asText(value, max) {
  if (value === null || value === undefined) return '';
  return String(value).slice(0, max || 4000);
}

function snippet(value, max) {
  const limit = max || 160;
  const text = asText(value, limit + 1).replace(/\s+/g, ' ').trim();
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

function asInt(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function getService(ctx, name) {
  try {
    const value = ctx.get(name);
    return value === undefined ? undefined : value;
  } catch (e) {
    return undefined;
  }
}

function logWarn(ctx, ...args) {
  try {
    const logger = ctx.logger;
    if (!logger) return;
    const instance = typeof logger === 'function' ? logger.call(ctx, 'dsh-task-board') : logger;
    if (instance && typeof instance.warn === 'function') instance.warn(...args);
  } catch (e) { }
}

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

function trimCache(cache, limit) {
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

function summaryTitle(summary) {
  const value = summary && summary.projections && summary.projections.values;
  return value && typeof value.title === 'string' ? value.title : '';
}

function listFields(summary) {
  return {
    id: String(summary && summary.sessionId ? summary.sessionId : ''),
    cwd: summary && summary.cwd ? String(summary.cwd) : null,
    parentSessionId: summary && summary.parentSessionId ? String(summary.parentSessionId) : null,
    origin: summary && summary.origin === 'subagent' ? 'subagent' : null,
    formatStatus: summary && (summary.formatStatus === 'migration-required' || summary.formatStatus === 'current')
      ? summary.formatStatus
      : null,
    updatedAt: Math.max(0, asInt(summary && summary.updatedAt, 0)),
    running: summary ? summary.running === true : false,
    blank: summary ? summary.blank === true : false,
    agentAvailable: summary ? summary.agentAvailable === true : false,
    title: summaryTitle(summary),
    projections: summary ? summary.projections : undefined,
  };
}

function listProjection(summary, key) {
  const values = summary && summary.projections && summary.projections.values;
  return values ? values[key] : undefined;
}

function readWorkspaceIndex(ctx) {
  const registry = getService(ctx, 'workspaceRegistry');
  const result = {
    workspaces: [],
    bySession: new Map(),
    archived: new Set(),
    pinned: new Set(),
  };
  if (!registry || typeof registry.list !== 'function') return result;
  try {
    const list = registry.list() || [];
    for (const workspace of list) {
      const id = String(workspace && workspace.id !== undefined ? workspace.id : '');
      if (!id) continue;
      const item = {
        id,
        title: asText(workspace.title, 300) || id,
        path: workspace.path ? String(workspace.path) : '',
      };
      result.workspaces.push(item);
      const sessionIds = Array.isArray(workspace.sessionIds) ? workspace.sessionIds : [];
      for (const sessionId of sessionIds) result.bySession.set(String(sessionId), item);
    }
  } catch (e) { }
  try {
    const archived = registry.archivedSessionIds;
    if (Array.isArray(archived)) for (const id of archived) result.archived.add(String(id));
  } catch (e) { }
  try {
    const pinned = registry.pinnedSessionIds;
    if (Array.isArray(pinned)) for (const id of pinned) result.pinned.add(String(id));
  } catch (e) { }
  return result;
}

function workspaceFor(summary, index) {
  const id = String(summary && summary.sessionId ? summary.sessionId : '');
  if (index.bySession.has(id)) return index.bySession.get(id);
  const cwd = summary && summary.cwd ? String(summary.cwd) : '';
  if (!cwd) return null;
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const target = normalize(cwd);
  let best = null;
  for (const workspace of index.workspaces) {
    if (!workspace.path) continue;
    const root = normalize(workspace.path);
    const separator = workspace.path.includes('\\') ? '\\' : '/';
    if (target === root || target.startsWith(root.endsWith(separator) ? root : root + separator)) {
      if (!best || workspace.path.length > best.path.length) best = workspace;
    }
  }
  return best;
}

async function listSummaries(ctx) {
  const controller = getService(ctx, 'sessionController');
  if (controller && typeof controller.list === 'function') {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LIST_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    try {
      const value = await controller.list({}, abort.signal);
      if (value && Array.isArray(value.items)) {
        return { items: value.items.map(listFields), source: 'sessionController' };
      }
    } catch (e) {
      logWarn(ctx, '会话列表读取失败，回退 sessionQuery：' + String((e && e.message) || e));
    } finally {
      clearTimeout(timer);
    }
  }
  const query = getService(ctx, 'sessionQuery');
  if (query && typeof query.listSessions === 'function') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    let records;
    try {
      records = await query.listSessions(controller.signal);
    } catch (e) {
      if (controller.signal.aborted) throw new Error('会话列表读取超时');
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!Array.isArray(records)) throw new Error('会话列表读取超时');
    const items = records.map((record) => {
      const header = record && record.header ? record.header : {};
      return listFields({
        sessionId: header.id,
        updatedAt: header.createdAt,
        running: false,
        blank: false,
        agentAvailable: false,
        cwd: header.cwd,
        parentSessionId: header.parentSession,
        origin: header.origin,
        formatStatus: record && record.formatStatus,
      });
    });
    return { items, source: 'sessionQuery' };
  }
  throw new Error('宿主没有可用的会话列表服务');
}

async function listSummariesCached(ctx, caches, maxAgeMs, force) {
  const cached = caches.summaries;
  const effectiveMaxAge = cached && cached.source === 'sessionQuery' ? Math.min(maxAgeMs, 1500) : maxAgeMs;
  if (!force && effectiveMaxAge > 0 && cached && Date.now() - cached.at <= effectiveMaxAge) {
    return cached;
  }
  if (caches.summaryPending) return caches.summaryPending;
  const task = listSummaries(ctx)
    .then((listed) => {
      caches.summaries = { at: Date.now(), items: listed.items, source: listed.source };
      return caches.summaries;
    })
    .finally(() => {
      if (caches.summaryPending === task) caches.summaryPending = null;
    });
  caches.summaryPending = task;
  return task;
}

function buildChildIndex(items) {
  const map = new Map();
  for (const item of items) {
    if (item.origin !== 'subagent' || !item.parentSessionId) continue;
    const parentId = String(item.parentSessionId);
    const list = map.get(parentId) || [];
    list.push(item);
    map.set(parentId, list);
  }
  return map;
}

function childActivity(children) {
  const labels = [];
  let active = 0;
  for (const child of children) {
    const timing = listProjection(child, 'subagentTiming');
    const identity = listProjection(child, 'subagent');
    const isActive = child.running || (timing && timing.active && Number.isFinite(Number(timing.active.since)));
    if (!isActive) continue;
    active += 1;
    const label = identity && typeof identity.label === 'string' ? identity.label : '';
    if (label) labels.push(label);
  }
  return { count: active, labels: labels.slice(0, 3) };
}

async function activityFor(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return [];
  try {
    const value = await withTimeout(
      ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([])),
      ACTIVITY_TIMEOUT_MS,
      [],
    );
    return Array.isArray(value) ? value : [];
  } catch (e) {
    return [];
  }
}

function normalizeActivity(value) {
  const families = Array.isArray(value) ? value : [];
  let running = false;
  let subagents = 0;
  let jobs = 0;
  let scheduled = 0;
  const labels = [];
  for (const family of families) {
    if (!family || typeof family !== 'object') continue;
    const kind = String(family.kind || '');
    const items = Array.isArray(family.items) ? family.items : [];
    if (kind === 'turn') running = true;
    if (kind === 'subagent') subagents += items.length || 1;
    if (kind === 'job') jobs += items.length || 1;
    if (kind === 'schedule') scheduled += items.length || 1;
    for (const item of items) {
      if (item && typeof item.label === 'string' && item.label.trim()) labels.push(item.label.trim());
    }
  }
  return { running, subagents, jobs, scheduled, labels: labels.slice(0, 4) };
}

function lastTurnInfo(events) {
  const list = Array.isArray(events) ? events : [];
  let openStart = null;
  let openStartSeq = null;
  let lastEnd = null;
  let settledStart = null;
  let lastTool = null;
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'turn/start') {
      openStart = event;
      openStartSeq = Number.isFinite(Number(event.seq)) ? Number(event.seq) : null;
    } else if (event.type === 'turn/end') {
      lastEnd = event;
      settledStart = openStart;
      openStart = null;
      openStartSeq = null;
    } else if (event.type === 'tool/call') {
      lastTool = event;
    }
  }
  const reason = lastEnd && lastEnd.data ? lastEnd.data.reason : null;
  const endedAt = lastEnd && Number.isFinite(Number(lastEnd.time)) ? Number(lastEnd.time) : null;
  const startedAt = settledStart && Number.isFinite(Number(settledStart.time)) ? Number(settledStart.time) : null;
  return {
    openStart: openStart && Number.isFinite(Number(openStart.time)) ? Number(openStart.time) : null,
    openStartSeq,
    settledStart: startedAt,
    endedAt,
    reason,
    durationMs: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
    lastTool,
  };
}

function toolLabel(event) {
  if (!event || !event.data) return '';
  const name = asText(event.data.name, 80);
  let args = null;
  try { args = JSON.parse(event.data.arguments || '{}'); } catch (e) { args = null; }
  const command = args && typeof args.command === 'string' ? args.command : '';
  const file = args && typeof args.path === 'string' ? args.path : '';
  const pattern = args && typeof args.pattern === 'string' ? args.pattern : '';
  const detail = command || file || pattern;
  return detail ? name + '：' + snippet(detail, 60) : name;
}

function todosInfo(value) {
  const list = Array.isArray(value) ? value : [];
  const total = list.length;
  const done = list.filter((item) => item && item.status === 'completed').length;
  const current = list.find((item) => item && item.status === 'in_progress');
  return {
    total,
    done,
    current: current && current.content ? snippet(current.content, 80) : '',
  };
}

function goalInfo(value) {
  if (!value || !value.goal) return null;
  const goal = value.goal;
  return {
    objective: snippet(goal.objective, 200),
    phase: ['active', 'paused', 'blocked', 'complete'].includes(goal.phase) ? goal.phase : 'active',
    roundsStarted: Math.max(0, asInt(value.roundsStarted, 0)),
    maxGoalRounds: Math.max(0, asInt(goal.maxGoalRounds, 0)),
    blockedReason: goal.blockedReason && goal.blockedReason.message
      ? snippet(goal.blockedReason.message, 180)
      : '',
  };
}

function tokenInfo(value) {
  if (!value) return null;
  const total = asInt(value.uncachedInputTokens, 0)
    + asInt(value.outputTokens, 0)
    + asInt(value.cacheReadTokens, 0)
    + asInt(value.cacheWriteTokens, 0);
  return total > 0 ? total : null;
}

function errorText(reason) {
  if (!reason || typeof reason !== 'object') return '';
  if (reason.error && typeof reason.error === 'object') {
    const message = reason.error.message ? String(reason.error.message) : '';
    const code = reason.error.code ? String(reason.error.code) : '';
    if (message) return snippet(message, 180);
    if (code) return code;
  }
  if (reason.kind === 'blocked') return '执行受阻';
  if (reason.kind === 'interrupted') return '宿主重启导致回合中断';
  if (reason.kind === 'max-tokens') return '输出达到上限，回复被截断';
  return '';
}

function reasonState(reason) {
  if (!reason || typeof reason !== 'object') return null;
  if (reason.kind === 'error') return 'failed';
  if (reason.kind === 'blocked') return 'blocked';
  if (reason.kind === 'interrupted') return 'interrupted';
  if (reason.kind === 'max-tokens') return 'max_tokens';
  if (reason.kind === 'aborted') {
    const cause = reason.reason && reason.reason.kind;
    return cause === 'user' ? 'stopped' : 'interrupted';
  }
  return null;
}

function titleSnapshotFromEvents(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'session/title' || !event.data) continue;
    const source = event.data.source;
    if (typeof event.data.title !== 'string' || !source || typeof source.kind !== 'string') continue;
    return {
      title: event.data.title,
      messageSeqs: Array.isArray(event.data.messageSeqs) ? event.data.messageSeqs : [],
      source,
      updatedAt: Number.isFinite(Number(event.time)) ? Number(event.time) : null,
    };
  }
  return null;
}

function titleInfo(summary, snapshot, observation) {
  const outline = observation && observation.projections && observation.projections.values
    ? observation.projections.values.turnOutline
    : null;
  const firstPrompt = Array.isArray(outline) && outline[0] && outline[0].prompt ? outline[0].prompt : '';
  const title = snapshot && snapshot.title
    ? snapshot.title
    : (summary.title || (summary.blank ? '新会话' : firstPrompt ? snippet(firstPrompt, 40) : '未命名会话'));
  const source = snapshot && snapshot.source && snapshot.source.kind ? snapshot.source.kind : (summary.title ? 'unknown' : 'provisional');
  const provider = snapshot && snapshot.source && snapshot.source.kind === 'provider'
    ? String(snapshot.source.provider || '')
    : null;
  const coveredThrough = snapshot && Array.isArray(snapshot.messageSeqs) && snapshot.messageSeqs.length
    ? Math.max(...snapshot.messageSeqs)
    : null;
  const updatedAt = snapshot && Number.isFinite(Number(snapshot.updatedAt)) ? Number(snapshot.updatedAt) : null;
  const lastPromptAt = summary && summary.projections && summary.projections.values
    ? asInt(summary.projections.values.sessionListMetadata && summary.projections.values.sessionListMetadata.lastPromptAt, null)
    : null;
  const stale = source !== 'user'
    && updatedAt !== null
    && lastPromptAt !== null
    && lastPromptAt > updatedAt + TITLE_CHANGE_GRACE_MS;
  return {
    title,
    titleSource: source,
    titleUpdatedAt: updatedAt,
    titleCoveredThrough: coveredThrough,
    titleStale: stale,
    provider,
    provisional: !snapshot,
  };
}

function stateFor(summary, lastTurn, activity, children, goal) {
  if (summary.blank) return 'blank';
  if (lastTurn && lastTurn.openStart) return 'running';
  if (activity.running || summary.running) return 'running';
  const reason = lastTurn && lastTurn.reason;
  const reasonKind = reasonState(reason);
  if (reasonKind === 'failed' || reasonKind === 'blocked' || reasonKind === 'interrupted' || reasonKind === 'max_tokens') return reasonKind;
  if (goal && goal.phase === 'blocked') return 'blocked';
  if (children.count > 0) return 'subagent';
  if (activity.jobs > 0) return 'job';
  if (activity.scheduled > 0) return 'scheduled';
  if (goal && goal.phase === 'active') return 'goal_waiting';
  if (goal && goal.phase === 'paused') return 'goal_paused';
  if (goal && goal.phase === 'complete') return 'goal_complete';
  if (reasonKind === 'stopped') return 'stopped';
  if (reason && reason.kind === 'completed') return 'completed';
  return 'unknown';
}

function sinceFor(state, summary, lastTurn, observation) {
  if (state === 'blank') return observation && observation.header && Number.isFinite(Number(observation.header.createdAt))
    ? Number(observation.header.createdAt)
    : summary.updatedAt;
  if (state === 'running') return lastTurn && lastTurn.openStart ? lastTurn.openStart : summary.updatedAt;
  if (state === 'failed' || state === 'blocked' || state === 'interrupted' || state === 'max_tokens') {
    return lastTurn && lastTurn.endedAt ? lastTurn.endedAt : summary.updatedAt;
  }
  if (state === 'completed' || state === 'stopped' || state === 'goal_complete') {
    return lastTurn && lastTurn.endedAt ? lastTurn.endedAt : summary.updatedAt;
  }
  return summary.updatedAt;
}

function compactCard(summary, title, workspace, pinned, fork, archived) {
  const state = archived ? 'archived' : (summary.blank ? 'blank' : (summary.running ? 'running' : 'unknown'));
  return {
    id: summary.id,
    title: title.title,
    titleSource: title.titleSource,
    titleUpdatedAt: title.titleUpdatedAt,
    titleCoveredThrough: title.titleCoveredThrough,
    titleStale: title.titleStale,
    provisional: title.provisional,
    state,
    since: summary.updatedAt,
    updatedAt: summary.updatedAt,
    lastPromptAt: summary.projections && summary.projections.values && summary.projections.values.sessionListMetadata
      ? asInt(summary.projections.values.sessionListMetadata.lastPromptAt, null)
      : null,
    createdAt: null,
    blank: summary.blank,
    archived,
    pinned,
    cwd: summary.cwd,
    workspace,
    fork,
    activity: {
      running: state === 'running',
      subagents: 0,
      jobs: 0,
      scheduled: 0,
      labels: [],
      currentStep: state === 'running' ? '正在生成回复…' : '',
      todoDone: 0,
      todoTotal: 0,
      runningSince: state === 'running' ? summary.updatedAt : null,
    },
    outcome: null,
    goal: null,
    tokens: null,
    turns: null,
    formatStatus: summary.formatStatus,
    compact: true,
    canOpen: !archived,
  };
}

async function readObservation(query, sessionId, signal) {
  const observation = await query.observeSession(sessionId, { projectionMode: 'all', signal });
  const release = typeof observation[Symbol.dispose] === 'function'
    ? observation[Symbol.dispose].bind(observation)
    : null;
  try {
    return {
      header: observation.header,
      events: Array.isArray(observation.events) ? observation.events : [],
      projections: observation.projections ? { values: observation.projections.values } : undefined,
    };
  } finally {
    try {
      if (release) release();
    } catch (e) { }
  }
}

async function observeWithTimeout(query, sessionId, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  if (timer && typeof timer.unref === 'function') timer.unref();
  try {
    return await readObservation(query, sessionId, controller.signal);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function buildCard(ctx, summary, context) {
  const {
    index,
    children,
    parentTitles,
    includeArchived,
    detailCache,
    activityCache,
    titleFollow,
    now,
  } = context;
  const archived = index.archived.has(summary.id);
  if (includeArchived !== archived) return null;
  const workspace = workspaceFor(summary, index);
  const pinned = index.pinned.has(summary.id);
  const forkParentId = summary.parentSessionId || null;
  let fork = forkParentId && summary.origin !== 'subagent'
    ? { parentId: forkParentId, parentTitle: parentTitles.get(forkParentId) || '' }
    : null;
  const emptyTitle = titleInfo(summary, null, null);

  if (archived) {
    const card = compactCard(summary, emptyTitle, workspace, pinned, fork, true);
    card.canOpen = false;
    return card;
  }

  const shouldReadDetail = context.detail === true;
  let observation = null;
  if (shouldReadDetail) {
    const cached = detailCache.get(summary.id);
    if (cached && cached.updatedAt === summary.updatedAt && now - cached.at < DETAIL_TTL_MS) {
      observation = cached.observation;
    } else {
      const query = getService(ctx, 'sessionQuery');
      if (query && typeof query.observeSession === 'function') {
        observation = await observeWithTimeout(query, summary.id, 1200);
      }
      detailCache.set(summary.id, { at: now, updatedAt: summary.updatedAt, observation });
      trimCache(detailCache, DETAIL_CACHE_LIMIT);
    }
  }
  if (!shouldReadDetail || !observation) {
    const card = compactCard(summary, emptyTitle, workspace, pinned, fork, false);
    card.cwd = summary.cwd;
    card.compact = !summary.running && !summary.blank;
    return card;
  }

  const events = Array.isArray(observation.events) ? observation.events : [];
  if (!fork && summary.origin !== 'subagent' && observation.header && observation.header.isSeeded === true) {
    fork = { parentId: null, parentTitle: '' };
  }
  const title = titleInfo(summary, titleSnapshotFromEvents(events), observation);
  if (title.provider) {
    titleFollow.seen = true;
    if (title.provider.includes('all-prompts')) titleFollow.allPrompts = true;
  }
  let activity = { running: summary.running, subagents: 0, jobs: 0, scheduled: 0, labels: [] };
  if (summary.agentAvailable) {
    const cached = activityCache.get(summary.id);
    if (cached && now - cached.at < ACTIVITY_TTL_MS) {
      activity = cached.value;
    } else {
      const value = normalizeActivity(await activityFor(ctx, summary.id));
      activity = {
        ...value,
        running: value.running || summary.running,
        subagents: Math.max(value.subagents, children.count),
        labels: [...new Set([...value.labels, ...children.labels])].slice(0, 4),
      };
      activityCache.set(summary.id, { at: now, value: activity });
      trimCache(activityCache, ACTIVITY_CACHE_LIMIT);
    }
  } else {
    activity = { ...activity, subagents: children.count, labels: children.labels.slice(0, 3) };
  }

  const lastTurn = lastTurnInfo(events);
  const projections = observation && observation.projections && observation.projections.values
    ? observation.projections.values
    : {};
  const goal = goalInfo(projections.goal || listProjection(summary, 'goal'));
  const state = stateFor(summary, lastTurn, activity, children, goal);
  const todos = todosInfo(projections.todos);
  const outline = Array.isArray(projections.turnOutline) ? projections.turnOutline : [];
  const lastOutline = outline.length ? outline[outline.length - 1] : null;
  const lastResponse = lastOutline && lastOutline.response ? snippet(lastOutline.response, 180) : '';
  const currentTool = lastTurn.lastTool
    && lastTurn.openStartSeq !== null
    && Number(lastTurn.lastTool.seq) >= lastTurn.openStartSeq
    ? toolLabel(lastTurn.lastTool)
    : '';
  const reasonKind = lastTurn.reason && lastTurn.reason.kind ? lastTurn.reason.kind : null;
  const outcome = {
    reason: reasonKind,
    endedAt: lastTurn.endedAt,
    durationMs: lastTurn.durationMs,
    lastResponse,
    error: errorText(lastTurn.reason),
    turns: outline.length,
  };
  const tokens = tokenInfo(projections.tokenUsage || listProjection(summary, 'tokenUsage'));
  const createdAt = observation && observation.header && Number.isFinite(Number(observation.header.createdAt))
    ? Number(observation.header.createdAt)
    : null;

  return {
    id: summary.id,
    title: title.title,
    titleSource: title.titleSource,
    titleUpdatedAt: title.titleUpdatedAt,
    titleCoveredThrough: title.titleCoveredThrough,
    titleStale: title.titleStale,
    provisional: title.provisional,
    state,
    since: sinceFor(state, summary, lastTurn, observation),
    updatedAt: summary.updatedAt,
    lastPromptAt: summary.projections && summary.projections.values && summary.projections.values.sessionListMetadata
      ? asInt(summary.projections.values.sessionListMetadata.lastPromptAt, null)
      : null,
    createdAt,
    blank: summary.blank,
    archived: false,
    pinned,
    cwd: summary.cwd,
    workspace,
    fork,
    activity: {
      running: activity.running,
      subagents: activity.subagents,
      jobs: activity.jobs,
      scheduled: activity.scheduled,
      labels: activity.labels,
      currentStep: todos.current || currentTool || (state === 'running' ? '正在生成回复…' : ''),
      todoDone: todos.done,
      todoTotal: todos.total,
      runningSince: state === 'running' ? sinceFor(state, summary, lastTurn, observation) : null,
    },
    outcome,
    goal,
    tokens,
    turns: outline.length || null,
    formatStatus: summary.formatStatus,
    compact: false,
    canOpen: true,
  };
}

function snapshotRevision(cards, archivedCount) {
  return createHash('sha1')
    .update(JSON.stringify({ cards, archivedCount }))
    .digest('hex');
}

async function buildSnapshot(ctx, includeArchived, caches, days, force) {
  const now = Date.now();
  const listed = await listSummariesCached(
    ctx,
    caches,
    includeArchived ? ARCHIVED_SUMMARY_TTL_MS : SNAPSHOT_TTL_MS,
    force,
  );
  const items = listed.items.filter((item) => item.id);
  const index = readWorkspaceIndex(ctx);
  const nonSubagent = items.filter((item) => item.origin !== 'subagent' && item.blank !== true);
  const windowMs = days > 0 ? days * DAY_MS : 0;
  const selected = nonSubagent.filter((item) => {
    if (includeArchived) return index.archived.has(item.id);
    if (index.archived.has(item.id)) return false;
    if (!windowMs || listed.source === 'sessionQuery') return true;
    return item.updatedAt >= now - windowMs || item.agentAvailable;
  });
  const rich = new Set();
  if (!includeArchived) {
    for (const item of selected) {
      if (item.blank || item.running) rich.add(item.id);
    }
    for (const item of selected.slice().sort((left, right) => right.updatedAt - left.updatedAt)) {
      if (rich.size >= DETAIL_LIMIT) break;
      if (item.updatedAt > now - DETAIL_WINDOW_MS) rich.add(item.id);
    }
  }
  const childrenIndex = buildChildIndex(items);
  const parentTitles = new Map();
  for (const item of items) parentTitles.set(item.id, item.title || '');
  const titleFollow = { seen: false, allPrompts: false };
  const cards = (await mapLimit(selected, 8, (summary) => buildCard(ctx, summary, {
    index,
    children: childChildren(childrenIndex, summary.id),
    parentTitles,
    includeArchived,
    detail: rich.has(summary.id),
    detailCache: caches.detail,
    activityCache: caches.activity,
    titleFollow,
    now,
  }))).filter(Boolean);
  cards.sort((left, right) => {
    if (left.archived !== right.archived) return left.archived ? 1 : -1;
    return (right.updatedAt || 0) - (left.updatedAt || 0);
  });
  const archivedCount = items.filter((item) => (
    item.origin !== 'subagent' && item.blank !== true && index.archived.has(item.id)
  )).length;
  return {
    revision: snapshotRevision(cards, archivedCount),
    generatedAt: Date.now(),
    cards,
    archivedCount,
    titleFollow: titleFollow.seen ? titleFollow.allPrompts : null,
    source: listed.source,
    days: days > 0 ? days : 0,
  };
}

function childChildren(index, parentId) {
  const list = index.get(parentId) || [];
  return childActivity(list);
}

function makeSnapshotCache(ctx) {
  const cache = new Map();
  const failures = new Map();
  const caches = { detail: new Map(), activity: new Map(), summaries: null, summaryPending: null };
  const pending = new Map();

  function startBuild(key, includeArchived, days, force) {
    if (pending.has(key)) return pending.get(key);
    const task = buildSnapshot(ctx, includeArchived, caches, days, force)
      .then((value) => {
        failures.delete(key);
        cache.delete(key);
        cache.set(key, {
          at: Date.now(),
          value,
          degraded: value && value.source === 'sessionQuery',
        });
        if (cache.size > MAX_SNAPSHOT_KEYS) {
          const keys = [...cache.keys()];
          const victim = keys.find((candidate) => candidate !== 'archived' && candidate !== key)
            || keys.find((candidate) => candidate !== 'archived')
            || keys[0];
          cache.delete(victim);
          failures.delete(victim);
        }
        if (!includeArchived && !cache.has('archived') && !pending.has('archived')) {
          startBuild('archived', true, 0, false).catch(() => undefined);
        }
        return value;
      })
      .catch((error) => {
        failures.set(key, { at: Date.now(), message: String((error && error.message) || error) });
        throw error;
      })
      .finally(() => pending.delete(key));
    pending.set(key, task);
    return task;
  }

  return async function getSnapshot(includeArchived, force, days) {
    const key = includeArchived ? 'archived' : 'cards:' + (days > 0 ? days : 0);
    const current = cache.get(key);
    if (!force && current) {
      const ttl = current.degraded ? 1500 : SNAPSHOT_TTL_MS;
      const stale = Date.now() - current.at >= ttl;
      if (stale) startBuild(key, includeArchived, days, false).catch(() => undefined);
      return stale ? { ...current.value, stale: true } : current.value;
    }
    if (force) return startBuild(key, includeArchived, days, true);
    const failed = failures.get(key);
    if (failed && Date.now() - failed.at < 2000) throw new Error(failed.message);
    if (failed) failures.delete(key);
    startBuild(key, includeArchived, days, false).catch(() => undefined);
    return {
      revision: '',
      generatedAt: Date.now(),
      cards: [],
      archivedCount: 0,
      titleFollow: null,
      source: 'warming',
      days: days > 0 ? days : 0,
      warming: true,
    };
  };
}

function writeEvent(res, event, data) {
  if (res.writableEnded) return;
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data) + '\n\n');
}

async function handleEvents(ctx, req, res, getSnapshot, days, streams) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('retry: 3000\n\n');
  streams.add(res);
  let closed = false;
  let lastCards = new Map();
  let lastRevision = '';
  let lastArchivedCount = -1;
  let lastTitleFollow = null;
  let timer = null;
  let heartbeat = null;
  const close = () => {
    if (closed) return;
    closed = true;
    streams.delete(res);
    if (timer) clearInterval(timer);
    if (heartbeat) clearInterval(heartbeat);
  };
  req.on('close', close);
  req.on('close', () => { try { res.end(); } catch (e) { } });
  res.on('close', close);

  const tick = async () => {
    if (closed) return;
    try {
      const snapshot = await getSnapshot(false, false, days);
      if (snapshot.warming) return;
      const metaChanged = snapshot.revision !== lastRevision
        || snapshot.archivedCount !== lastArchivedCount
        || snapshot.titleFollow !== lastTitleFollow;
      if (!metaChanged) return;
      const next = new Map();
      const upserts = [];
      for (const card of snapshot.cards) {
        const serialized = JSON.stringify(card);
        next.set(card.id, serialized);
        if (lastCards.get(card.id) !== serialized) upserts.push(card);
      }
      const removes = [...lastCards.keys()].filter((id) => !next.has(id));
      writeEvent(res, 'cards', {
        full: lastRevision === '',
        revision: snapshot.revision,
        generatedAt: snapshot.generatedAt,
        upserts,
        removes,
        archivedCount: snapshot.archivedCount,
        titleFollow: snapshot.titleFollow,
        days: days > 0 ? days : 0,
      });
      lastCards = next;
      lastRevision = snapshot.revision;
      lastArchivedCount = snapshot.archivedCount;
      lastTitleFollow = snapshot.titleFollow;
    } catch (e) {
      writeEvent(res, 'error', { error: String((e && e.message) || e) });
    }
  };

  await tick();
  timer = setInterval(tick, 1000);
  heartbeat = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': ping\n\n');
  }, 15000);
}

export function apply(ctx) {
  const getSnapshot = makeSnapshotCache(ctx);
  const streams = new Set();

  async function handleRequest(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/';
    const method = (req.method || 'GET').toUpperCase();
    try {
      if (method !== 'GET') {
        res.setHeader('allow', 'GET');
        return json(res, 405, { ok: false, error: 'read only' });
      }
      if (sub === '/health') {
        return json(res, 200, { ok: true, pid: process.pid, time: Date.now(), readOnly: true });
      }
      if (sub === '/cards') {
        const days = Math.max(0, Math.min(3650, asInt(url.searchParams.get('days'), 0)));
        const snapshot = await getSnapshot(false, url.searchParams.get('refresh') === '1', days);
        return json(res, 200, { ok: true, ...snapshot });
      }
      if (sub === '/archived') {
        const force = url.searchParams.get('refresh') === '1';
        let snapshot = await getSnapshot(true, false, 0);
        if (snapshot.warming || force) snapshot = await getSnapshot(true, true, 0);
        return json(res, 200, { ok: true, ...snapshot });
      }
      if (sub === '/events') {
        const days = Math.max(0, Math.min(3650, asInt(url.searchParams.get('days'), 0)));
        return await handleEvents(ctx, req, res, getSnapshot, days, streams);
      }
      return json(res, 404, { ok: false, error: 'not found', path: sub });
    } catch (e) {
      return json(res, 500, { ok: false, error: String((e && e.message) || e) });
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: handleRequest,
  }), 'dsh-task-board: read-only api');

  ctx.effect(() => {
    return () => {
      for (const res of streams) {
        try { res.end(); } catch (e) { }
      }
      streams.clear();
    };
  }, 'dsh-task-board: close event streams');

  ctx.effect(() => {
    let timer = null;
    let attempts = 0;
    const tick = () => {
      const controller = getService(ctx, 'sessionController');
      if (controller && typeof controller.list === 'function') {
        getSnapshot(false, false, 7).catch(() => undefined);
        return;
      }
      attempts += 1;
      if (attempts >= 40) return;
      timer = setTimeout(tick, 500);
      if (timer && typeof timer.unref === 'function') timer.unref();
    };
    timer = setTimeout(tick, 800);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return () => clearTimeout(timer);
  }, 'dsh-task-board: warm snapshot');
}
