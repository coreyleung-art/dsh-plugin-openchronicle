// dsh-plugin-openchronicle — 感知记忆层（OpenChronicle 吸收 X3 混合方案）
// 原理：直接 spawn 已编译的 Swift mac-ax-helper 二进制 → 结构化 JSON 捕获
//       → 写入记忆目录（Markdown + 索引）→ 暴露检索/上下文工具
// 配置（环境变量）：
//   OC_HELPER_PATH: mac-ax-helper 二进制路径（默认自动探测）
//   OC_MEM_DIR:     记忆目录（默认 ~/.dsh/openchronicle/）
//   OC_CAPTURE_INTERVAL_MIN: 定时捕获间隔（分钟，默认 10，0=不自动）
//
// 工具：oc_capture / oc_current_context / oc_search / oc_memories / oc_snapshot / oc_timeline / oc_share
//
// 设计：约定式 cordis 插件（export name/inject/apply），spawn 外部二进制。
// v0.1.2 修复：defineTool API 对齐 rc.6（output: makeOutput() + execute(args, exec)），
//              ctx.tools.register 注册（此前旧版 handler API 导致 output.render undefined 崩 server）

import { defineTool } from '@deepseek-ai/dsh-tools';
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const name = 'openchronicle';
export const inject = ['tools'];
export const Config = undefined;

const HOME = homedir();
const MEM_DIR = process.env.OC_MEM_DIR || join(HOME, '.dsh', 'openchronicle');
const HELPER_CANDIDATES = [
  process.env.OC_HELPER_PATH,
  join(HOME, '.openchronicle', 'venv', 'lib', 'python3.12', 'site-packages', 'openchronicle', '_bundled', 'mac-ax-helper'),
  join(HOME, '.openchronicle', 'venv', 'lib', 'python3.13', 'site-packages', 'openchronicle', '_bundled', 'mac-ax-helper'),
];
const CAPTURE_INTERVAL_MIN = parseInt(process.env.OC_CAPTURE_INTERVAL_MIN || '10', 10);
const MAX_MEMORY_FILES = 500;
const MAX_MEMORY_MB = 50;

/** 找到 mac-ax-helper 二进制 */
async function findHelper() {
  for (const c of HELPER_CANDIDATES) {
    if (!c) continue;
    try {
      await fs.access(c);
      return c;
    } catch { /* 不存在，试下一个 */ }
  }
  return null;
}

/** 调用 Swift 二进制捕获 → JSON */
function runCapture(helper, opts = {}) {
  const args = [];
  if (opts.allVisible) args.push('--all-visible');
  if (opts.appName) args.push('--app-name', opts.appName);
  if (opts.depth) args.push('--depth', String(opts.depth));
  args.push('--timeout', String(opts.timeout || 3));
  return new Promise((resolve) => {
    execFile(helper, args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) { resolve({ ok: false, error: err.message }); return; }
      try {
        const data = JSON.parse(stdout);
        resolve({ ok: true, data });
      } catch (e) {
        resolve({ ok: false, error: '解析失败: ' + e.message, raw: String(stdout).slice(0, 300) });
      }
    });
  });
}

/** 捕获 JSON → 精简记忆文本 */
function summarizeCapture(data) {
  if (!data || !data.apps || data.apps.length === 0) return '（无活动应用捕获）';
  const lines = [];
  for (const app of data.apps.slice(0, 3)) {
    const title = app.name || app.bundle_id || '未知应用';
    const windowCount = (app.windows || []).length;
    const texts = [];
    const walk = (els, depth) => {
      if (!els || depth > 4) return;
      for (const el of els) {
        if (el.title && typeof el.title === 'string' && el.title.length > 1 && el.title.length < 200) {
          texts.push(el.title);
        }
        if (el.value && typeof el.value === 'string' && el.value.length > 1 && el.value.length < 200) {
          texts.push(el.value);
        }
        if (texts.length >= 8) return;
        walk(el.children, depth + 1);
      }
    };
    for (const w of (app.windows || []).slice(0, 2)) {
      if (w.title) texts.push(w.title);
      walk(w.elements, 0);
    }
    const uniq = [...new Set(texts)].slice(0, 6);
    lines.push(`- ${title}（${windowCount} 窗口）: ${uniq.join(' | ')}`);
  }
  return lines.join('\n');
}

/** 确保记忆目录 + 文件上限控制 */
async function ensureMemDir() {
  await fs.mkdir(MEM_DIR, { recursive: true });
  try {
    const files = await fs.readdir(MEM_DIR);
    if (files.filter((f) => f.endsWith('.md')).length > MAX_MEMORY_FILES) {
      const mds = files.filter((f) => f.endsWith('.md')).sort();
      const toRemove = mds.slice(0, mds.length - MAX_MEMORY_FILES);
      for (const f of toRemove) await fs.unlink(join(MEM_DIR, f)).catch(() => {});
    }
  } catch { /* 忽略 */ }
}

/** 写一次捕获记忆（按天聚合） */
async function writeCapture(dateStr, summary, rawJson) {
  await ensureMemDir();
  const file = join(MEM_DIR, `capture-${dateStr}.md`);
  const ts = new Date().toISOString();
  let content = '';
  try { content = await fs.readFile(file, 'utf8'); } catch { content = `# 感知记忆 ${dateStr}\n\n`; }
  const entry = `\n## ${ts}\n${summary}\n`;
  content += entry;
  await fs.writeFile(file, content.slice(-200000));
  if (process.env.OC_SAVE_RAW === '1') {
    const rawFile = join(MEM_DIR, `raw-${Date.now()}.json`);
    await fs.writeFile(rawFile, JSON.stringify(rawJson, null, 2)).catch(() => {});
  }
  return { file, ts, summary };
}

export function apply(ctx) {
  const toolsSvc = ctx.get('tools', false);
  if (!toolsSvc) { console.log('[openchronicle] tools 服务不可用'); return; }

  const makeOutput = () => ({
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  });

  // 定时捕获（默认 10min）
  let timer = null;
  if (CAPTURE_INTERVAL_MIN > 0) {
    timer = setInterval(async () => {
      const helper = await findHelper();
      if (!helper) { console.log('[openchronicle] helper 未找到，跳过定时捕获'); return; }
      const r = await runCapture(helper, { timeout: 3 });
      if (r.ok) {
        const summary = summarizeCapture(r.data);
        const dateStr = new Date().toISOString().slice(0, 10);
        await writeCapture(dateStr, summary, r.data);
        console.log('[openchronicle] 定时捕获完成');
      }
    }, CAPTURE_INTERVAL_MIN * 60 * 1000);
    if (timer.unref) timer.unref();
  }

  const tools = [
    defineTool({
      name: 'oc_capture',
      description: '触发一次感知记忆捕获（当前前台 app 的屏幕/应用上下文，调 Swift mac-ax-helper），返回结构化摘要并写入记忆。可选捕获所有可见应用（--all-visible）。',
      parameters: {
        all_visible: { type: 'boolean', description: '捕获所有可见应用（默认只捕获前台应用）' },
        app_name: { type: 'string', description: '指定应用名捕获（默认前台应用）' },
      },
      output: makeOutput(),
      async execute(args) {
        const helper = await findHelper();
        if (!helper) {
          return { ok: false, error: 'mac-ax-helper 二进制未找到（请确认 OpenChronicle 已安装）', candidates: HELPER_CANDIDATES.filter(Boolean) };
        }
        const r = await runCapture(helper, { allVisible: !!args?.all_visible, appName: args?.app_name, timeout: 5 });
        if (!r.ok) return { ok: false, error: r.error };
        const summary = summarizeCapture(r.data);
        const dateStr = new Date().toISOString().slice(0, 10);
        const w = await writeCapture(dateStr, summary, r.data);
        return { ok: true, summary, file: w.file, app_count: (r.data.apps || []).length };
      },
    }),
    defineTool({
      name: 'oc_current_context',
      description: '获取用户「此刻在做什么」的感知记忆（最近一次屏幕/应用上下文捕获摘要）。用于 agent 主动感知用户当前工作，无需询问。',
      parameters: {},
      output: makeOutput(),
      async execute() {
        const helper = await findHelper();
        if (!helper) return { ok: false, error: 'helper 未找到' };
        const r = await runCapture(helper, { timeout: 3 });
        if (!r.ok) return { ok: false, error: r.error };
        const summary = summarizeCapture(r.data);
        return { ok: true, captured_at: new Date().toISOString(), context: summary, apps: (r.data.apps || []).map((a) => a.name).filter(Boolean) };
      },
    }),
    defineTool({
      name: 'oc_search',
      description: '检索感知记忆历史（按关键词在捕获记录中搜索，返回匹配的条目摘要）。用于回顾用户之前的工作上下文。',
      parameters: {
        keyword: { type: 'string', description: '搜索关键词（必填）' },
        days: { type: 'number', description: '搜索最近 N 天（默认 7）' },
        limit: { type: 'number', description: '返回条数上限（默认 10）' },
      },
      output: makeOutput(),
      async execute(args) {
        const kw = String(args?.keyword || '').toLowerCase();
        if (!kw) return { ok: false, error: 'keyword 必填' };
        const days = parseInt(args?.days || '7', 10);
        const limit = parseInt(args?.limit || '10', 10);
        try {
          const files = await fs.readdir(MEM_DIR);
          const hits = [];
          const cutoff = Date.now() - days * 86400000;
          for (const f of files.filter((x) => x.endsWith('.md'))) {
            const full = join(MEM_DIR, f);
            try {
              const stat = await fs.stat(full);
              if (stat.mtimeMs < cutoff) continue;
              const content = await fs.readFile(full, 'utf8');
              const blocks = content.split('\n## ');
              for (const b of blocks) {
                if (b.toLowerCase().includes(kw)) {
                  hits.push({ file: f, excerpt: b.slice(0, 300) });
                  if (hits.length >= limit) break;
                }
              }
            } catch { /* 跳过坏文件 */ }
            if (hits.length >= limit) break;
          }
          return { ok: true, count: hits.length, hits };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
    }),
    defineTool({
      name: 'oc_memories',
      description: '列出感知记忆文件（按天聚合的捕获记录），含大小与最近更新。用于了解记忆规模。',
      parameters: {},
      output: makeOutput(),
      async execute() {
        try {
          const files = await fs.readdir(MEM_DIR);
          const mds = [];
          for (const f of files.filter((x) => x.endsWith('.md'))) {
            const full = join(MEM_DIR, f);
            try {
              const stat = await fs.stat(full);
              mds.push({ file: f, size_kb: Math.round(stat.size / 1024), updated: stat.mtime });
            } catch { /* 跳过 */ }
          }
          mds.sort((a, b) => b.updated - a.updated);
          return { ok: true, count: mds.length, dir: MEM_DIR, files: mds.slice(0, 30) };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
    }),
    defineTool({
      name: 'oc_snapshot',
      description: '把「用户此刻工作上下文」沉淀为一条结构化知识（写入 ~/.dsh/openchronicle/ 的 snapshots/ + 可选追加到 knowledge 库）。用于把高价值的感知记忆固化为长期知识。',
      parameters: {
        note: { type: 'string', description: '补充说明（为什么值得沉淀，如「用户在做 X 决策」）' },
        to_knowledge: { type: 'boolean', description: '是否同时追加到 knowledge 库（默认 false，仅本地落盘）' },
      },
      output: makeOutput(),
      async execute(args) {
        const helper = await findHelper();
        if (!helper) return { ok: false, error: 'helper 未找到' };
        const r = await runCapture(helper, { timeout: 3 });
        if (!r.ok) return { ok: false, error: r.error };
        const summary = summarizeCapture(r.data);
        const snapDir = join(MEM_DIR, 'snapshots');
        await fs.mkdir(snapDir, { recursive: true });
        const ts = new Date().toISOString();
        const file = join(snapDir, `snap-${Date.now()}.md`);
        const content = `# 感知快照 ${ts}\n\n${summary}\n\n${args?.note ? '## 备注\n' + args.note + '\n' : ''}`;
        await fs.writeFile(file, content);
        const result = { ok: true, file, summary, note: args?.note || '' };
        if (args?.to_knowledge) {
          const kb = ctx.get('knowledge', false);
          if (kb && typeof kb.addDocument === 'function') {
            try {
              await kb.addDocument('感知快照 ' + ts, content);
              result.knowledge = '已追加';
            } catch (e) {
              result.knowledge = '追加失败: ' + e.message;
            }
          } else {
            result.knowledge = 'knowledge 服务不可用（跳过）';
          }
        }
        return result;
      },
    }),
    defineTool({
      name: 'oc_timeline',
      description: '查看感知记忆时间线：按状态迁移聚合（同一应用+相同内容合并，标注持续时长），只显示有变化的事件。用于回顾用户工作流而不被重复捕获刷屏。',
      parameters: {
        days: { type: 'number', description: '最近 N 天（默认 1）' },
        limit: { type: 'number', description: '条数上限（默认 20）' },
      },
      output: makeOutput(),
      async execute(args) {
        const days = parseInt(args?.days || '1', 10);
        const limit = parseInt(args?.limit || '20', 10);
        try {
          const files = await fs.readdir(MEM_DIR);
          const entries = [];
          const cutoff = Date.now() - days * 86400000;
          for (const f of files.filter((x) => x.endsWith('.md'))) {
            const full = join(MEM_DIR, f);
            try {
              const stat = await fs.stat(full);
              if (stat.mtimeMs < cutoff) continue;
              const content = await fs.readFile(full, 'utf8');
              const blocks = content.split('\n## ');
              for (const b of blocks.slice(1)) {
                const firstLine = b.split('\n')[0];
                const ts = Date.parse(firstLine);
                if (isNaN(ts)) continue;
                const body = b.split('\n').slice(1).join('\n').trim();
                entries.push({ ts, body, file: f });
              }
            } catch { /* 跳过 */ }
          }
          entries.sort((a, b) => a.ts - b.ts);
          const merged = [];
          for (const e of entries) {
            const last = merged[merged.length - 1];
            if (last && e.body === last.body && e.ts - last.endTs < 30 * 60000) {
              last.endTs = e.ts;
              last.duration_min = Math.round((last.endTs - last.startTs) / 60000);
            } else {
              merged.push({ ...e, startTs: e.ts, endTs: e.ts, duration_min: 0 });
            }
          }
          const result = merged.slice(-limit).map((m) => ({
            time: new Date(m.startTs).toISOString().slice(0, 16).replace('T', ' '),
            duration_min: m.duration_min,
            content: m.body.slice(0, 150),
          }));
          return { ok: true, count: result.length, raw_entries: entries.length, timeline: result };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      },
    }),
    defineTool({
      name: 'oc_share',
      description: '把最新感知记忆同步到黑板 data/perception/ 通道（跨设备共享）。i9/MBP 可经黑板读取 mac 端捕获的用户上下文。',
      parameters: {
        note: { type: 'string', description: '同步备注（可选）' },
      },
      output: makeOutput(),
      async execute(args) {
        const helper = await findHelper();
        if (!helper) return { ok: false, error: 'helper 未找到' };
        const r = await runCapture(helper, { timeout: 3 });
        if (!r.ok) return { ok: false, error: r.error };
        const summary = summarizeCapture(r.data);
        const bb = ctx.get('blackboard', false);
        if (!bb || typeof bb.put !== 'function') {
          return { ok: false, error: '黑板服务不可用（未装 agent-way 或黑板未连接）', summary };
        }
        const ts = Date.now();
        try {
          const key = `data/perception/${new Date().toISOString().slice(0, 10)}/${ts}`;
          const r2 = await bb.put(key, {
            from: 'mac-mini',
            type: 'perception',
            ts,
            summary,
            note: args?.note || '',
          });
          return { ok: true, key, summary, blackboard: r2 };
        } catch (e) {
          return { ok: false, error: '黑板写入失败: ' + e.message, summary };
        }
      },
    }),
  ];

  for (const tool of tools) {
    ctx.effect(() => toolsSvc.register(tool));
  }

  // 清理
  return () => {
    if (timer) clearInterval(timer);
  };
}
