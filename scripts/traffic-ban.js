/**
 * 🚫 流量超标自动封禁 + AI 分析脚本（GitHub Actions 运行）
 *
 * 工作流程：
 * 1. 从 flow.js 获取封禁阈值 + CF 账号配置
 * 2. 从 glass.js 获取 SaaS/WSaaS/PSaaS 账号
 * 3. 查询 CF GraphQL API 获取 24H 探针路径流量 TOP3
 * 4. 超过阈值的路径提取用户名，调用 glass.js 封禁 API
 * 5. 从 flow.js /api/ai-prompt 获取构建好的 AI messages
 * 6. 调用 AI API 进行分析
 * 7. 发送 TG 通知（AI 分析 + 封禁结果）
 *
 * 环境变量（GitHub Secrets）：
 * - FLOW_URL:    flow.js Worker 地址
 * - FLOW_PWD:    flow.js WEB_PASSWORD
 * - GLASS_URL:   glass.js Worker 地址
 * - GLASS_PWD:   glass.js FRONTEND_PASSWORD
 * - TG_TOKEN:    Telegram Bot Token（可选）
 * - TG_CHATID:   Telegram Chat ID（可选）
 * - AI_API_KEY:  AI API Key（可选，不配则跳过 AI 分析）
 * - AI_API_URL:  AI API 地址（如 https://api.openai.com/v1/chat/completions）
 * - AI_MODEL:    AI 模型名（如 gpt-4o, glm-4-flash 等）
 */

const https = require('https');
const http = require('http');

// ==========================================
// 工具函数
// ==========================================

function fetch(url, options = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: () => Promise.resolve(data), json: () => Promise.resolve(JSON.parse(data)) });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`timeout after ${timeoutMs}ms`)); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

function formatBytes(b) {
  if (b >= 1e12) return (b / 1e12).toFixed(2) + ' TB';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(2) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(2) + ' KB';
  return b + ' B';
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function log(msg) {
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  console.log(`[${ts}] ${msg}`);
}

function extractUsername(path) {
  let rawId;
  try { rawId = decodeURIComponent(path.split('/').filter(Boolean).pop() || path); } catch(e) { rawId = path.split('/').filter(Boolean).pop() || path; }
  const username = rawId.replace(/-[a-f0-9]{16}$/, '') || rawId.split('-')[0] || rawId;
  return username;
}

function extractShortId(path) {
  let rawId;
  try { rawId = decodeURIComponent(path.split('/').filter(Boolean).pop() || path); } catch(e) { rawId = path.split('/').filter(Boolean).pop() || path; }
  return rawId.split('-')[0] || rawId;
}

// ==========================================
// 1. 从 flow.js 获取设置和账号配置
// ==========================================

async function getFlowSettings() {
  const res = await fetch(`${process.env.FLOW_URL}/api/settings`, {}, 10000);
  if (!res.ok) throw new Error(`获取 flow.js 设置失败: ${res.status}`);
  const data = await res.json();
  const threshold = parseFloat(data.alertSettings?.trafficBlockThreshold) || 0;
  const pathPrefix = data.PATH_PREFIX || '/glasspanel/';
  log(`flow.js 设置: PATH_PREFIX=${pathPrefix}, 流量封禁阈值=${threshold}GB`);
  return { threshold, pathPrefix };
}

async function getFlowConfigs() {
  const res = await fetch(`${process.env.FLOW_URL}/api/configs?full=1`, {
    headers: { 'X-Admin-Password': process.env.FLOW_PWD },
  }, 10000);
  if (!res.ok) throw new Error(`获取 flow.js 配置失败: ${res.status}`);
  const configs = await res.json();
  if (!Array.isArray(configs)) return [];
  log(`flow.js 配置: ${configs.length} 个账号配置`);
  return configs;
}

// ==========================================
// 2. 从 glass.js 获取 SaaS/WSaaS/PSaaS 账号
// ==========================================

async function getGlassAccounts() {
  const glassUrl = process.env.GLASS_URL?.replace(/\/$/, '');
  const glassPwd = process.env.GLASS_PWD;
  if (!glassUrl || !glassPwd) return [];

  const headers = { 'X-Admin-Password': glassPwd, 'Content-Type': 'application/json' };
  const accounts = [];

  try {
    const [saasRes, wsaasRes, psaasRes] = await Promise.all([
      fetch(`${glassUrl}/api/saas/profiles`, { headers }, 10000).then(r => r.json()).catch(() => []),
      fetch(`${glassUrl}/api/wsaas/profiles`, { headers }, 10000).then(r => r.json()).catch(() => []),
      fetch(`${glassUrl}/api/psaas/profiles`, { headers }, 10000).then(r => r.json()).catch(() => []),
    ]);

    const saasProfiles = Array.isArray(saasRes) ? saasRes : [];
    const wsaasProfiles = Array.isArray(wsaasRes) ? wsaasRes : [];
    const psaasProfiles = Array.isArray(psaasRes) ? psaasRes : [];

    const tokenMap = new Map();
    for (const p of [...saasProfiles, ...wsaasProfiles, ...psaasProfiles]) {
      if (!p.apiToken) continue;
      const key = p.apiToken;
      if (!tokenMap.has(key)) {
        tokenMap.set(key, { apiToken: p.apiToken, accountId: p.accountId || null, name: p.name || 'glass' });
      } else {
        const existing = tokenMap.get(key);
        if (!existing.accountId && p.accountId) existing.accountId = p.accountId;
      }
    }

    for (const [token, info] of tokenMap) {
      if (!info.accountId) {
        try {
          const idRes = await fetch('https://api.cloudflare.com/client/v4/accounts', {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          }, 10000);
          if (idRes.ok) {
            const idData = await idRes.json();
            if (idData.result && idData.result.length > 0) info.accountId = idData.result[0].id;
          }
        } catch(e) { /* ignore */ }
      }
      if (info.accountId) {
        accounts.push({ id: info.accountId, name: info.name, token: info.apiToken });
      }
    }
    log(`glass.js 账号: ${accounts.length} 个`);
  } catch(e) {
    log(`获取 glass.js 账号失败: ${e.message}`);
  }
  return accounts;
}

// ==========================================
// 3. 合并所有账号
// ==========================================

function buildAuthHeaders(tokenString) {
  if (tokenString.includes('@') && tokenString.includes(':')) {
    const firstColon = tokenString.indexOf(':', tokenString.indexOf('@'));
    const email = tokenString.substring(0, firstColon).trim();
    const key = tokenString.substring(firstColon + 1).trim();
    return { 'X-Auth-Email': email, 'X-Auth-Key': key, 'Content-Type': 'application/json' };
  }
  if (tokenString.includes(',')) {
    const [email, key] = tokenString.split(',');
    return { 'X-Auth-Email': email.trim(), 'X-Auth-Key': key.trim(), 'Content-Type': 'application/json' };
  }
  return { 'Authorization': `Bearer ${tokenString.trim()}`, 'Content-Type': 'application/json' };
}

function mergeAccounts(flowConfigs, glassAccounts) {
  const accountMap = new Map();
  for (const cfg of flowConfigs) {
    const accountId = cfg.ACCOUNT_ID || '';
    const apiKey = cfg.GLOBAL_API_KEY || '';
    if (!accountId || !apiKey) continue;
    if (!accountMap.has(accountId)) {
      const email = cfg.AUTH_EMAIL || '';
      const token = email && email.includes('@') ? `${email}:${apiKey}` : apiKey;
      accountMap.set(accountId, { id: accountId, name: cfg.name || accountId.substring(0, 8), token });
    }
  }
  for (const acc of glassAccounts) {
    if (!accountMap.has(acc.id)) {
      accountMap.set(acc.id, acc);
    }
  }
  const accounts = [...accountMap.values()];
  log(`合并后总账号数: ${accounts.length}`);
  return accounts;
}

// ==========================================
// 4. 查询 CF GraphQL 获取探针 TOP3
// ==========================================

async function fetchTopPaths(accounts, pathPrefix) {
  const now = new Date();
  const start24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const start24hIso = start24h.toISOString();
  const endIso = now.toISOString();
  const likePattern = `%${pathPrefix}%`;
  const aggregated24h = new Map();

  const batchSize = 5;
  for (let i = 0; i < accounts.length; i += batchSize) {
    const batch = accounts.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(async (acc) => {
      const headers = buildAuthHeaders(acc.token);
      const zoneRes = await fetch('https://api.cloudflare.com/client/v4/zones', { headers }, 15000);
      if (!zoneRes.ok) return [];
      const zoneData = await zoneRes.json();
      const zoneIds = (zoneData.result || []).map(z => z.id);
      if (zoneIds.length === 0) return [];

      const zoneFilter = zoneIds.length === 1
        ? `zoneTag: "${zoneIds[0]}"`
        : `zoneTag_in: [${zoneIds.map(id => `"${id}"`).join(', ')}]`;

      const query = `query {
        viewer {
          zones(filter: { ${zoneFilter} }) {
            r24h: httpRequestsAdaptiveGroups(
              limit: 2000
              filter: {
                datetime_geq: "${start24hIso}"
                datetime_leq: "${endIso}"
                clientRequestPath_like: "${likePattern}"
              }
              orderBy: [sum_edgeResponseBytes_DESC]
            ) {
              dimensions { clientRequestPath }
              sum { edgeResponseBytes }
            }
          }
        }
      }`;

      const gqlRes = await fetch('https://api.cloudflare.com/client/v4/graphql', {
        method: 'POST', headers, body: JSON.stringify({ query }),
      }, 15000);

      if (!gqlRes.ok) return [];
      const raw = await gqlRes.json();
      if (raw.errors) return [];

      const zones = raw.data?.viewer?.zones || [];
      const pathMap = new Map();
      for (const zone of zones) {
        for (const g of (zone.r24h || [])) {
          const path = g.dimensions.clientRequestPath;
          if (!path.startsWith(pathPrefix)) continue;
          pathMap.set(path, (pathMap.get(path) || 0) + (g.sum.edgeResponseBytes || 0));
        }
      }
      return [...pathMap.entries()].map(([path, value]) => ({ path, value }));
    }));

    for (const result of results) {
      if (result.status === 'fulfilled') {
        for (const { path, value } of result.value) {
          aggregated24h.set(path, (aggregated24h.get(path) || 0) + value);
        }
      }
    }
  }

  const sorted = [...aggregated24h.entries()]
    .map(([path, value]) => ({ path, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 3);

  log(`探针 24H TOP3: ${sorted.map(p => `${extractShortId(p.path)}=${formatBytes(p.value)}`).join(', ') || '无数据'}`);
  return sorted;
}

// ==========================================
// 5. 调用 glass.js 封禁 API
// ==========================================

async function banUsers(users) {
  const glassUrl = process.env.GLASS_URL?.replace(/\/$/, '');
  const glassPwd = process.env.GLASS_PWD;
  if (!glassUrl || !glassPwd) {
    log('⚠️ 未配置 GLASS_URL/GLASS_PWD，无法封禁');
    return users.map(u => ({ ...u, success: false, msg: '未配置GLASS_URL/PWD' }));
  }

  log(`调用 glass.js 封禁 API，目标 ${users.length} 个用户: ${users.map(u => u.username).join(', ')}`);
  try {
    const res = await fetch(`${glassUrl}/api/admin/auto_block_by_traffic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Password': glassPwd },
      body: JSON.stringify({
        password: glassPwd,
        users: users.map(u => ({
          username: u.username,
          reason: `24H流量超标: ${formatBytes(u.trafficBytes)} > 阈值${u.thresholdGB}GB`,
        })),
      }),
    }, 20000);

    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        log(`✅ 封禁完成: 成功 ${data.blockedCount || 0} 个, 跳过 ${data.skippedCount || 0} 个`);
        return (data.results || []).map(r => ({ username: r.username, success: r.success, msg: r.msg || '' }));
      } else {
        log(`❌ 封禁 API 返回失败: ${data.msg}`);
        return users.map(u => ({ ...u, success: false, msg: data.msg || 'API返回失败' }));
      }
    } else {
      const errText = await res.text().catch(() => '');
      log(`❌ 封禁 API HTTP错误: ${res.status}, ${errText.slice(0, 200)}`);
      return users.map(u => ({ ...u, success: false, msg: `API错误${res.status}` }));
    }
  } catch(e) {
    log(`❌ 封禁 API 调用异常: ${e.message}`);
    return users.map(u => ({ ...u, success: false, msg: `网络异常:${e.message.slice(0, 50)}` }));
  }
}

// ==========================================
// 6. AI 分析（从 flow.js 获取 prompt，调用 AI API）
// ==========================================

async function getAiAnalysis() {
  const aiApiKey = process.env.AI_API_KEY;
  const aiApiUrl = process.env.AI_API_URL;
  const aiModel = process.env.AI_MODEL;

  if (!aiApiKey || !aiApiUrl || !aiModel) {
    log('⚠️ 未配置 AI_API_KEY/AI_API_URL/AI_MODEL，跳过 AI 分析');
    return '';
  }

  // 1. 从 flow.js 获取构建好的 AI messages
  log('从 flow.js 获取 AI prompt...');
  let promptData;
  try {
    const res = await fetch(`${process.env.FLOW_URL}/api/ai-prompt`, {
      headers: { 'X-Admin-Password': process.env.FLOW_PWD },
    }, 15000);

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      log(`⚠️ 获取 AI prompt 失败: ${res.status} ${errText.slice(0, 200)}`);
      return '';
    }
    promptData = await res.json();
    if (!promptData.success || !promptData.messages) {
      log(`⚠️ AI prompt 返回异常: ${promptData.error || '未知'}`);
      return '';
    }
    log(`✅ 获取 AI prompt 成功 (${promptData.messages.length} 条 messages, ${JSON.stringify(promptData.messages).length} 字符)`);
  } catch(e) {
    log(`⚠️ 获取 AI prompt 异常: ${e.message}`);
    return '';
  }

  // 2. 调用 AI API（最多重试 2 次，每次 5 分钟超时，超时放弃）
  const AI_TIMEOUT_MS = 300000; // 5 分钟
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      log(`调用 AI API (第 ${attempt} 次): model=${aiModel}, 超时 ${AI_TIMEOUT_MS / 1000}s`);
      const res = await fetch(aiApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${aiApiKey}`,
        },
        body: JSON.stringify({
          model: aiModel,
          messages: promptData.messages,
          max_tokens: 4096,
          temperature: 0.3,
        }),
      }, AI_TIMEOUT_MS); // 5 分钟超时，GitHub Actions 无限制

      if (res.ok) {
        const data = await res.json();
        // 兼容不同 AI 返回格式
        const content = data.choices?.[0]?.message?.content || '';
        if (content) {
          log(`✅ AI 分析完成 (${content.length} 字符)`);
          return content.trim();
        }
        log(`⚠️ AI 返回无 content: ${JSON.stringify(data).slice(0, 200)}`);
      } else {
        const errText = await res.text().catch(() => '');
        log(`⚠️ AI API 错误: ${res.status} ${errText.slice(0, 300)}`);
      }
    } catch(e) {
      log(`⚠️ AI API 异常 (第 ${attempt} 次): ${e.message}`);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
  }

  return '';
}

// ==========================================
// 7. 发送 TG 通知
// ==========================================

async function sendTgMessage(text) {
  const tgToken = process.env.TG_TOKEN;
  const tgChatId = process.env.TG_CHATID;
  if (!tgToken || !tgChatId) return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChatId, text, parse_mode: 'HTML' }),
    }, 15000);
    if (res.ok) log('✅ TG 通知已发送');
    else log(`❌ TG 发送失败: ${res.status}`);
  } catch(e) {
    log(`❌ TG 发送异常: ${e.message}`);
  }
}

async function sendTgNotification(topPaths, threshold, banResults, aiText) {
  const tgToken = process.env.TG_TOKEN;
  const tgChatId = process.env.TG_CHATID;
  if (!tgToken || !tgChatId) {
    log('未配置 TG_TOKEN/TG_CHATID，跳过通知');
    return;
  }

  let msg = `🚫 <b>流量监控 · 封禁 + AI 分析</b>\n`;
  msg += `〰️〰️〰️〰️〰️〰️〰️〰️〰️〰️\n\n`;

  // TOP3 探针流量
  if (topPaths.length > 0) {
    msg += `🎯 <b>24H 探针流量 TOP 3</b>\n`;
    topPaths.forEach((item) => {
      const shortId = extractShortId(item.path);
      const isOver = item.value > threshold * 1e9;
      msg += ` ${isOver ? '🔴' : '🟢'} <b>${escapeHtml(shortId)}</b>: <b>${formatBytes(item.value)}</b>${isOver ? ' ⚠️超标' : ''}\n`;
    });
    msg += `\n`;
  }

  // 封禁结果
  if (banResults.length > 0) {
    const blocked = banResults.filter(r => r.success);
    const failed = banResults.filter(r => !r.success);
    if (blocked.length > 0) {
      msg += `✅ <b>已封禁</b>（${blocked.length}个）\n`;
      blocked.forEach(r => { msg += ` 🔒 <b>${escapeHtml(r.username)}</b>\n`; });
      msg += `\n`;
    }
    if (failed.length > 0) {
      msg += `⚠️ <b>未封禁</b>（${failed.length}个）\n`;
      failed.forEach(r => { msg += ` ❌ <b>${escapeHtml(r.username)}</b> ${escapeHtml(r.msg)}\n`; });
      msg += `\n`;
    }
  } else if (threshold > 0 && topPaths.length > 0) {
    msg += `✅ 所有探针流量均在阈值范围内，未发现滥用\n\n`;
  } else if (threshold <= 0) {
    msg += `ℹ️ 流量封禁阈值为 0，封禁功能未启用\n\n`;
  }

  // AI 分析结果
  if (aiText) {
    msg += `🤖 <b>分析结果</b>\n${aiText}\n\n`;
  } else {
    const aiApiKey = process.env.AI_API_KEY;
    if (aiApiKey) {
      msg += `🤖 <b>分析结果</b>\n⚠️ AI 分析超时或失败，已放弃\n\n`;
    }
  }

  msg += `🤖 <i>GitHub Actions · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</i>`;

  await sendTgMessage(msg);
}

// ==========================================
// 主流程
// ==========================================

async function main() {
  log('🚀 流量监控脚本启动（封禁 + AI 分析）');

  if (!process.env.FLOW_URL || !process.env.FLOW_PWD) {
    console.error('❌ 缺少 FLOW_URL 或 FLOW_PWD 环境变量');
    process.exit(1);
  }
  if (!process.env.GLASS_URL || !process.env.GLASS_PWD) {
    console.error('❌ 缺少 GLASS_URL 或 GLASS_PWD 环境变量');
    process.exit(1);
  }

  try {
    // 1. 获取设置
    const { threshold, pathPrefix } = await getFlowSettings();

    // 2. 获取账号
    const flowConfigs = await getFlowConfigs();
    const glassAccounts = await getGlassAccounts();
    const accounts = mergeAccounts(flowConfigs, glassAccounts);

    if (accounts.length === 0) {
      log('⚠️ 无可用账号，跳过流量查询');
    } else {
      // 3. 查询 CF 流量 TOP3
      const topPaths = await fetchTopPaths(accounts, pathPrefix);

      // 4. 筛选超标路径并封禁
      let banResults = [];
      if (threshold > 0 && topPaths.length > 0) {
        const thresholdBytes = threshold * 1e9;
        const overLimitPaths = topPaths.filter(p => p.value > thresholdBytes);
        log(`阈值 ${threshold}GB, 超标路径 ${overLimitPaths.length} 条`);

        if (overLimitPaths.length > 0) {
          const blockUsers = overLimitPaths.map(p => ({
            username: extractUsername(p.path),
            trafficBytes: p.value,
            thresholdGB: threshold,
          })).filter(u => u.username && u.username !== 'guest' && u.username !== '-');

          log(`超标用户: ${blockUsers.map(u => `${u.username}(${formatBytes(u.trafficBytes)})`).join(', ')}`);

          if (blockUsers.length > 0) {
            banResults = await banUsers(blockUsers);
          }
        }

        // 7. AI 分析 + TG 通知（并行）
        log('开始 AI 分析...');
        const aiText = await getAiAnalysis();

        // 8. 发送 TG 通知
        await sendTgNotification(topPaths, threshold, banResults, aiText);
      } else {
        // 阈值为 0 也要做 AI 分析和 TG 通知
        log('流量封禁阈值为 0（未启用封禁），仅执行 AI 分析');

        const aiText = await getAiAnalysis();
        await sendTgNotification(topPaths, threshold, [], aiText);
      }
    }

    // 即使没有账号配置，也尝试做 AI 分析（用 flow.js 缓存的数据）
    if (accounts.length === 0) {
      log('无账号配置，仅执行 AI 分析...');
      const aiText = await getAiAnalysis();
      if (aiText) {
        await sendTgMessage(`🤖 <b>AI 分析结果</b>\n${aiText}\n\n🤖 GitHub Actions · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`);
      } else {
        log('AI 分析无结果，不发送通知');
      }
    }

    log('✅ 脚本执行完成');
  } catch(e) {
    console.error('❌ 脚本执行失败:', e.message);
    console.error(e.stack);

    const tgToken = process.env.TG_TOKEN;
    const tgChatId = process.env.TG_CHATID;
    if (tgToken && tgChatId) {
      try {
        await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: tgChatId,
            text: `❌ <b>流量监控脚本执行失败</b>\n\n<code>${escapeHtml(e.message)}</code>\n\n🤖 GitHub Actions`,
            parse_mode: 'HTML',
          }),
        }, 10000);
      } catch(_) { /* ignore */ }
    }
    process.exit(1);
  }
}

main();
