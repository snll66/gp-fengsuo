#!/usr/bin/env node
/**
 * redirect-block.js — GitHub Actions 封禁/解封执行脚本
 * 
 * 流程:
 * 1. 从 glass.js API 拉取任务数据（action + paths + accounts）
 * 2. 串行遍历每个账号 × 每个域名，执行 CF Redirect Rules 操作
 * 3. 将结果回写到 glass.js API
 * 
 * 需要的 GitHub Secrets:
 * - GLASS_API_URL: glass.js Worker 的 URL
 * - REDIRECT_INTERNAL_KEY: 内部通信密钥（与 glass.js Worker 的 REDIRECT_INTERNAL_KEY 一致）
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

// ==================== CF API 客户端 ====================

async function cfFetch(tokenStr, path, init = {}) {
    const headers = { "Content-Type": "application/json" };
    if (tokenStr.includes("|")) {
        const idx = tokenStr.indexOf("|");
        headers["X-Auth-Email"] = tokenStr.slice(0, idx);
        headers["X-Auth-Key"] = tokenStr.slice(idx + 1);
    } else {
        headers["Authorization"] = `Bearer ${tokenStr}`;
    }
    const res = await fetch(CF_API_BASE + path, {
        ...init,
        headers: { ...headers, ...(init.headers || {}) }
    });
    const json = await res.json();
    if (!json.success) {
        const msg = (json.errors && json.errors.length)
            ? json.errors.map(e => `${e.code}: ${e.message}`).join("; ")
            : `HTTP ${res.status}`;
        throw new Error(msg);
    }
    return json;
}

async function cfFetchResult(tokenStr, path, init) {
    return (await cfFetch(tokenStr, path, init)).result;
}

// ==================== 分页拉取域名 ====================

async function listZones(token) {
    const out = [];
    let page = 1;
    for (;;) {
        const r = await cfFetchResult(token, `/zones?per_page=50&page=${page}`);
        if (!r || !r.length) break;
        for (const z of r) out.push({ id: z.id, name: z.name });
        if (r.length < 50) break;
        page++;
        if (page > 50) break;
    }
    return out;
}

// ==================== 工具函数 ====================

const sleep = ms => new Promise(r => setTimeout(r, ms));

const RE_PATH_EXTRACT = /starts_with\(http\.request\.uri\.path,\s*"([^"]+)"\)/g;

function makeBlockRule(paths) {
    return {
        description: "glass-block-aggregated",
        expression: paths.map(p => `starts_with(http.request.uri.path, "${p}")`).join(" or "),
        action: "redirect",
        action_parameters: {
            from_value: {
                target_url: { value: "http://127.0.0.1:1" },
                status_code: 301,
                preserve_query_string: false
            }
        }
    };
}

function buildBlockRules(pathSet) {
    const MAX_EXPR_LEN = 3800;
    const allPaths = Array.from(pathSet).sort();
    const rules = [];
    let currentPaths = [];
    let currentLen = 0;

    for (const p of allPaths) {
        const part = `starts_with(http.request.uri.path, "${p}")`;
        const addition = currentPaths.length === 0 ? part : ` or ${part}`;
        if (currentLen + addition.length > MAX_EXPR_LEN && currentPaths.length > 0) {
            rules.push(makeBlockRule(currentPaths));
            currentPaths = [];
            currentLen = 0;
        }
        currentPaths.push(p);
        currentLen += addition.length;
    }
    if (currentPaths.length > 0) {
        rules.push(makeBlockRule(currentPaths));
    }
    return rules;
}

function cleanNonBlockRule(rule) {
    const clean = {
        description: rule.description || "",
        expression: rule.expression || "",
        action: rule.action,
        enabled: rule.enabled !== false
    };
    if (rule.action_parameters) {
        const ap = {};
        if (rule.action_parameters.from_value) ap.from_value = rule.action_parameters.from_value;
        else if (rule.action_parameters.from_list) ap.from_list = rule.action_parameters.from_list;
        clean.action_parameters = ap;
    }
    return clean;
}

async function getZoneEntrypoint(token, zoneId) {
    try {
        const entry = await cfFetchResult(token, `/zones/${zoneId}/rulesets/phases/http_request_dynamic_redirect/entrypoint`);
        return { id: entry.id, rules: entry.rules || [] };
    } catch (e) {
        return { id: null, rules: [] };
    }
}

async function putZoneRules(token, zoneId, entrypointId, rules) {
    if (entrypointId) {
        await cfFetch(token, `/zones/${zoneId}/rulesets/${entrypointId}`, {
            method: "PUT",
            body: JSON.stringify({ rules })
        });
    } else if (rules.length > 0) {
        await cfFetch(token, `/zones/${zoneId}/rulesets`, {
            method: "POST",
            body: JSON.stringify({
                name: "Redirect Rules",
                kind: "zone",
                phase: "http_request_dynamic_redirect",
                rules
            })
        });
    }
}

// ==================== 封禁逻辑 ====================

async function blockPathsInZone(token, zone, newPaths) {
    const { id: entrypointId, rules: allRules } = await getZoneEntrypoint(token, zone.id);

    const existingPaths = new Set();
    const nonBlockRules = [];

    for (const rule of allRules) {
        if (rule.description === "glass-block-aggregated") {
            let match;
            RE_PATH_EXTRACT.lastIndex = 0;
            while ((match = RE_PATH_EXTRACT.exec(rule.expression || "")) !== null) {
                existingPaths.add(match[1]);
            }
        } else {
            nonBlockRules.push(cleanNonBlockRule(rule));
        }
    }

    const beforeCount = existingPaths.size;
    for (const p of newPaths) existingPaths.add(p);
    const addedCount = existingPaths.size - beforeCount;

    const blockRules = buildBlockRules(existingPaths);
    const mergedRules = blockRules.concat(nonBlockRules);

    await putZoneRules(token, zone.id, entrypointId, mergedRules);
    return { added: addedCount, total: existingPaths.size };
}

// ==================== 解封逻辑 ====================

async function unblockPathsInZone(token, zone, removePaths) {
    const { id: entrypointId, rules: allRules } = await getZoneEntrypoint(token, zone.id);

    const remainingPaths = new Set();
    const nonBlockRules = [];
    let removedCount = 0;

    for (const rule of allRules) {
        if (rule.description === "glass-block-aggregated") {
            let match;
            RE_PATH_EXTRACT.lastIndex = 0;
            while ((match = RE_PATH_EXTRACT.exec(rule.expression || "")) !== null) {
                if (removePaths.has(match[1])) {
                    removedCount++;
                } else {
                    remainingPaths.add(match[1]);
                }
            }
        } else {
            nonBlockRules.push(cleanNonBlockRule(rule));
        }
    }

    const blockRules = remainingPaths.size > 0 ? buildBlockRules(remainingPaths) : [];
    const mergedRules = blockRules.concat(nonBlockRules);

    await putZoneRules(token, zone.id, entrypointId, mergedRules);
    return { removed: removedCount, remaining: remainingPaths.size };
}

// ==================== glass.js API 通信 ====================

async function fetchTaskData(apiUrl, key, taskId) {
    const res = await fetch(`${apiUrl}/api/redirect/internal/task-data`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, key })
    });
    if (!res.ok) {
        throw new Error(`Failed to fetch task data: HTTP ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    if (!data.ok) {
        throw new Error(`Task data error: ${data.error || "Unknown"}`);
    }
    return data;
}

async function reportResult(apiUrl, key, taskId, results, status = "done") {
    try {
        await fetch(`${apiUrl}/api/redirect/internal/result`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ taskId, key, results, status })
        });
    } catch (e) {
        console.error("[Report] Failed to report result:", e.message);
    }
}

// ==================== 主流程 ====================

async function main() {
    const taskId = process.env.TASK_ID;
    const action = process.env.ACTION;
    const apiUrl = process.env.GLASS_API_URL;
    const internalKey = process.env.REDIRECT_INTERNAL_KEY;

    if (!taskId || !action || !apiUrl || !internalKey) {
        console.error("Missing required environment variables");
        console.error("Required: TASK_ID, ACTION, GLASS_API_URL, REDIRECT_INTERNAL_KEY");
        process.exit(1);
    }

    console.log(`[Redirect] Task: ${taskId} | Action: ${action}`);

    // 1. 从 glass.js 拉取任务数据
    const taskData = await fetchTaskData(apiUrl, internalKey, taskId);
    const { paths, accounts } = taskData;

    console.log(`[Redirect] Paths: ${paths.length} | Accounts: ${accounts.length}`);

    if (!accounts.length) {
        console.log("[Redirect] No accounts configured, reporting empty result");
        await reportResult(apiUrl, internalKey, taskId, [], "done");
        return;
    }

    if (!paths.length) {
        console.log("[Redirect] No paths to process");
        await reportResult(apiUrl, internalKey, taskId, [], "done");
        return;
    }

    const results = [];
    const pathSet = new Set(paths);

    // 2. 串行遍历账号 × 域名
    for (const acc of accounts) {
        console.log(`\n[Account] ${acc.name}`);
        let zoneOk = 0, zoneFail = 0;
        const zoneErrors = [];
        let totalAdded = 0, totalRemoved = 0;

        try {
            const zones = await listZones(acc.token);
            console.log(`  Zones: ${zones.length}`);

            for (const zone of zones) {
                try {
                    if (action === "block") {
                        const r = await blockPathsInZone(acc.token, zone, paths);
                        totalAdded += r.added;
                        console.log(`  OK ${zone.name}: +${r.added} (total ${r.total})`);
                    } else {
                        const r = await unblockPathsInZone(acc.token, zone, pathSet);
                        totalRemoved += r.removed;
                        console.log(`  OK ${zone.name}: -${r.removed} (remaining ${r.remaining})`);
                    }
                    zoneOk++;
                } catch (e) {
                    zoneFail++;
                    zoneErrors.push(`${zone.name}: ${e.message}`);
                    console.error(`  FAIL ${zone.name}: ${e.message}`);
                }
                // 速率控制：每个域名间隔 300ms
                await sleep(300);
            }
        } catch (e) {
            zoneErrors.push(`Account error: ${e.message}`);
            console.error(`  Account error: ${e.message}`);
        }

        results.push({
            accountName: acc.name,
            ok: zoneFail === 0,
            zoneOk,
            zoneCount: zoneOk + zoneFail,
            added: totalAdded,
            removed: totalRemoved,
            error: zoneFail === 0 ? null : zoneErrors.join("; ")
        });
        console.log(`  Summary: ${zoneOk}/${zoneOk + zoneFail} zones OK`);
    }

    // 3. 回写结果
    await reportResult(apiUrl, internalKey, taskId, results, "done");
    console.log(`\n[Redirect] Done. Results reported.`);
}

main().catch(async (e) => {
    console.error("[Redirect] Fatal error:", e);
    // 尝试回写失败状态
    const apiUrl = process.env.GLASS_API_URL;
    const internalKey = process.env.REDIRECT_INTERNAL_KEY;
    const taskId = process.env.TASK_ID;
    if (apiUrl && internalKey && taskId) {
        await reportResult(apiUrl, internalKey, taskId, [], "failed");
    }
    process.exit(1);
});
