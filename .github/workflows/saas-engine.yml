const WORKER_URL = process.env.WORKER_URL || process.env.GLASS_URL;
const ADMIN_PWD = process.env.ADMIN_PWD || process.env.GLASS_PWD;
// 🤖 专属 TG 直播播报员
class TgLogger {
    constructor(profile) {
        this.profile = profile;
        this.msgId = null;
        this.text = '';
    }
    
    async log(msg) {
        console.log(msg.replace(/<[^>]*>?/gm, '')); 
        if (!this.profile || !this.profile.tgToken || !this.profile.tgChatId) return;
        
        this.text += (this.text ? '\n' : '') + msg;
        try {
            const headers = { 'X-Admin-Password': ADMIN_PWD, 'Content-Type': 'application/json' };
            const body = JSON.stringify({ tgToken: this.profile.tgToken, tgChatId: this.profile.tgChatId, text: this.text, message_id: this.msgId });
            if (!this.msgId) {
                const res = await fetch(`${WORKER_URL}/api/saas/tg_send`, { method: 'POST', headers, body }).then(r => r.json()).catch(()=>({}));
                if (res.result) this.msgId = res.result.message_id;
            } else {
                await fetch(`${WORKER_URL}/api/saas/tg_edit`, { method: 'POST', headers, body }).catch(()=>{});
            }
        } catch(e) {}
    }
}
// 🛡️ 智能全域打码
const maskDomain = (host, base) => {
    if (!host || !base || !host.endsWith(base)) return host;
    const prefix = host.substring(0, host.length - base.length); 
    if (!prefix) return base;
    const firstChar = prefix.charAt(0);
    const maskedPrefix = firstChar + prefix.substring(1).replace(/[a-zA-Z0-9]/g, '*');
    const baseParts = base.split('.');
    const maskedBase = baseParts.map((p, idx, arr) => {
        if (idx === arr.length - 1) return p; 
        if (p.length <= 2) return '*'.repeat(p.length);
        return p.charAt(0) + '*'.repeat(p.length - 2) + p.charAt(p.length - 1);
    }).join('.');
    return maskedPrefix + maskedBase;
};
// 🚀 域名生成规则
const generateHostPattern = (pattern, baseDomain) => {
    if (!pattern) pattern = "[4].[3].[base]";
    let h = pattern.replace(/\[base\]/g, baseDomain);
    h = h.replace(/\[([^\]]+)\]/g, (_, val) => {
        let len = parseInt(val);
        if (isNaN(len)) len = val.length;
        let res = '';
        while (res.length < len) res += Math.random().toString(36).substring(2);
        return res.substring(0, len);
    });
    return h.replace(/[^a-zA-Z0-9.-]/g, '');
};
// 💥 核心：精准定点销毁 (主机名 + A记录 + TXT记录)
async function exactCleanup(host, apiToken, saasZoneId, dnsZoneId) {
    const cfHeaders = { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' };
    let wiped = false;
    // 1. 删除主机名
    try {
        const chRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${saasZoneId}/custom_hostnames?hostname=${host}`, { headers: cfHeaders }).then(r=>r.json());
        if (chRes.success && chRes.result.length > 0) {
            await fetch(`https://api.cloudflare.com/client/v4/zones/${saasZoneId}/custom_hostnames/${chRes.result[0].id}`, { method: 'DELETE', headers: cfHeaders });
            wiped = true;
        }
    } catch(e) {}
    // 2. 深度清理关联的 A 记录和 TXT 验证记录
    try {
        const dnsHosts = [host, `_acme-challenge.${host}`];
        for (const dHost of dnsHosts) {
            const dnsRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${dnsZoneId}/dns_records?name=${dHost}`, { headers: cfHeaders }).then(r=>r.json());
            if (dnsRes.success && dnsRes.result) {
                for (const record of dnsRes.result) {
                    await fetch(`https://api.cloudflare.com/client/v4/zones/${dnsZoneId}/dns_records/${record.id}`, { method: 'DELETE', headers: cfHeaders });
                    wiped = true;
                }
            }
        }
    } catch(e) {}
    return wiped;
}
async function run() {
    console.log("🚀 开始执行 SaaS 幽灵协议...");
    const headers = { 'X-Admin-Password': ADMIN_PWD, 'Content-Type': 'application/json' };
    const [profilesRes, autoConfigRes] = await Promise.all([
        fetch(`${WORKER_URL}/api/saas/profiles`, { headers }),
        fetch(`${WORKER_URL}/api/saas/auto_config`, { headers })
    ]);
    const profiles = await profilesRes.json();
    const config = await autoConfigRes.json();
    if (!config || !config.batches || config.batches.length === 0) return console.log("💤 无任务。");
    let currentIndex = config.currentIndex || 0;
    if (currentIndex >= config.batches.length) currentIndex = 0;
    const currentBatch = config.batches[currentIndex];
    
    for (const task of currentBatch) {
        const profile = profiles.find(p => p.name === task.profileName);
        if (!profile) continue;
        const tg = new TgLogger(profile);
        await tg.log(`💀 <b>GlassPanel 幽灵协议 [${currentIndex + 1}/${config.batches.length}] 激活</b>`);
        
        // -------------------------------------------------------------
        // 1. 🔍 核心变动：从面板直接拉取当前节点的真实名单
        // -------------------------------------------------------------
        let panelHosts = [];
        try {
            if (profile.domains && Array.isArray(profile.domains)) {
                panelHosts = profile.domains;
            } else {
                const listRes = await fetch(`${WORKER_URL}/api/saas/list_domains`, {
                    method: 'POST', headers, body: JSON.stringify({ profileName: profile.name, baseDomain: profile.baseDomain })
                }).then(r => r.json()).catch(()=>({}));
                if (listRes.success && listRes.domains) panelHosts = listRes.domains;
            }
        } catch(e) {}
        const allOldHosts = [...new Set([...(task.lastHosts || []), ...panelHosts])];
        if (allOldHosts.length > 0) {
            await tg.log(`🗑️ 锁定面板与历史遗留的 ${allOldHosts.length} 个废弃节点，执行精准销毁...`);
            let wipeCount = 0;
            for (const oldHost of allOldHosts) {
                const isWiped = await exactCleanup(oldHost, profile.apiToken, profile.saasZoneId, profile.dnsZoneId);
                if (isWiped) wipeCount++;
            }
            await tg.log(`✅ 成功将 ${wipeCount} 个旧节点的配额与 DNS (A/TXT) 痕迹彻底抹除。`);
        } else {
            await tg.log(`🗑️ 面板记录为空，云端环境干净。`);
        }
        try {
            await fetch(`${WORKER_URL}/api/saas/cleanup`, {
                method: 'POST', headers,
                body: JSON.stringify({ profileName: profile.name, baseDomain: profile.baseDomain, apiToken: profile.apiToken, saasZoneId: profile.saasZoneId, dnsZoneId: profile.dnsZoneId, snippetRule: profile.snippetRule || '' })
            });
        } catch (e) {}
        // -------------------------------------------------------------
        await tg.log(`👁️ <b>目标代号: ${profile.name}</b> (分配 ${task.count} 个动态掩码)`);
        
        // 2. ⚡ 并发创建 (包含写入 A 记录)
        const pendingHosts = [];
        for (let i = 0; i < task.count; i++) {
            const host = generateHostPattern(profile.domainPattern, profile.baseDomain); 
            const mask = maskDomain(host, profile.baseDomain); 
            await tg.log(`▶ [身份伪造 ${i+1}/${task.count}] 幽灵 ${mask} 生成并注入路由...`);
            
            try {
                await fetch(`https://api.cloudflare.com/client/v4/zones/${profile.dnsZoneId}/dns_records`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${profile.apiToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 'A', name: host, content: '192.0.2.1', ttl: 1, proxied: true })
                });
            } catch(e) {}
            const createRes = await fetch(`${WORKER_URL}/api/saas/step_create`, {
                method: 'POST', headers,
                body: JSON.stringify({ profileName: profile.name, apiToken: profile.apiToken, saasZoneId: profile.saasZoneId, dnsZoneId: profile.dnsZoneId, hostname: host })
            }).then(r => r.json()).catch(() => ({}));
            if (createRes.success) pendingHosts.push({ id: createRes.hostId, host: host, mask: mask, index: i+1, retryCount: 0 });
        }
        // 3. 验证与精准补发
        let activeHosts = [];
        for (let w = 0; w < 36; w++) { 
            await new Promise(r => setTimeout(r, 10000)); 
            for (let item of pendingHosts) {
                if (activeHosts.includes(item.host)) continue;
                const statusRes = await fetch(`${WORKER_URL}/api/saas/step_status`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ apiToken: profile.apiToken, saasZoneId: profile.saasZoneId, hostId: item.id })
                }).then(r => r.json()).catch(() => ({ active: false }));
                if (statusRes.active) {
                    activeHosts.push(item.host);
                    await tg.log(` ✅ [${item.index}] 幽灵 ${item.mask} 潜行成功`);
                } else {
                    if (item.retryCount < 2) {
                        item.retryCount++;
                        await tg.log(`🔄 [${item.index}] ${item.mask} 验证缺失，正在重发 TXT 探针 (第 ${item.retryCount} 次)`);
                        await fetch(`${WORKER_URL}/api/saas/step_ssl`, {
                            method: 'POST', headers,
                            body: JSON.stringify({ profileName: profile.name, apiToken: profile.apiToken, saasZoneId: profile.saasZoneId, dnsZoneId: profile.dnsZoneId, hostId: item.id })
                        }).catch(() => {});
                    }
                }
            }
            if (activeHosts.length === pendingHosts.length) break;
        }
        // 4. 同步面板 (批量打包并发防覆盖)
        if (activeHosts.length > 0) {
            await tg.log(`\n🔗 正在将 ${activeHosts.length} 个域名批量同步至主面板...`);
            try {
                const syncRes = await fetch(`${WORKER_URL}/api/saas/sync_domain`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ profileName: profile.name, baseDomain: profile.baseDomain, hostname: activeHosts })
                }).then(r => r.json()).catch(()=>({}));
                if (syncRes.success) {
                    await tg.log(`🎉 <b>成功写入 ${activeHosts.length} 个免杀隐蔽节点</b>`);
                } else {
                    await tg.log(`⚠️ 面板同步失败: ` + syncRes.msg);
                }
            } catch(e) {
                await tg.log(`❌ 同步 API 异常`);
            }
        }
        // 5. 兜底清理：本轮失败的立刻销毁
        const failedHosts = pendingHosts.filter(p => !activeHosts.includes(p.host));
        if (failedHosts.length > 0) {
            await tg.log(`\n💥 发现 ${failedHosts.length} 个废弃掩码，立刻执行深度销毁...`);
            for (const item of failedHosts) {
                await exactCleanup(item.host, profile.apiToken, profile.saasZoneId, profile.dnsZoneId);
            }
        }
        // 6. 记录本轮生成的所有域名
        task.lastHosts = pendingHosts.map(p => p.host);
        await tg.log(`\n🏁 <b>幽灵行动结束，行动记录已归档。</b>`);
    }
    config.currentIndex = (currentIndex + 1) % config.batches.length;
    await fetch(`${WORKER_URL}/api/saas/auto_config`, { method: 'POST', headers, body: JSON.stringify({ password: ADMIN_PWD, config: config }) });
    // ⚡ Workers SaaS 轮询队列处理
    const wsaasConfigRes = await fetch(`${WORKER_URL}/api/wsaas/auto_config`, { headers });
    const wsaasConfig = await wsaasConfigRes.json().catch(() => ({}));
    if (wsaasConfig && wsaasConfig.batches && wsaasConfig.batches.length > 0) {
        let wsaasIdx = wsaasConfig.currentIndex || 0;
        if (wsaasIdx >= wsaasConfig.batches.length) wsaasIdx = 0;
        const wsaasBatch = wsaasConfig.batches[wsaasIdx];
        console.log(`⚡ Workers SaaS 轮询 [${wsaasIdx + 1}/${wsaasConfig.batches.length}]`);
        for (const task of wsaasBatch) {
            try {
                const runRes = await fetch(`${WORKER_URL}/api/wsaas/run`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ profileName: task.profileName, count: task.count })
                }).then(r => r.json()).catch(() => ({}));
                if (runRes.success) {
                    console.log(`  ✅ Workers [${task.profileName}] 执行成功`);
                } else {
                    console.log(`  ❌ Workers [${task.profileName}] 执行失败: ${runRes.msg || '未知'}`);
                }
            } catch(e) {
                console.log(`  ❌ Workers [${task.profileName}] 异常: ${e.message}`);
            }
        }
        wsaasConfig.currentIndex = (wsaasIdx + 1) % wsaasConfig.batches.length;
        await fetch(`${WORKER_URL}/api/wsaas/auto_config`, { method: 'POST', headers, body: JSON.stringify({ password: ADMIN_PWD, config: wsaasConfig }) });
    } else {
        console.log("💤 Workers SaaS 无任务。");
    }
    // 📄 Pages SaaS 轮询队列处理
    const psaasConfigRes = await fetch(`${WORKER_URL}/api/psaas/auto_config`, { headers });
    const psaasConfig = await psaasConfigRes.json().catch(() => ({}));
    if (psaasConfig && psaasConfig.batches && psaasConfig.batches.length > 0) {
        let psaasIdx = psaasConfig.currentIndex || 0;
        if (psaasIdx >= psaasConfig.batches.length) psaasIdx = 0;
        const psaasBatch = psaasConfig.batches[psaasIdx];
        console.log(`📄 Pages SaaS 轮询 [${psaasIdx + 1}/${psaasConfig.batches.length}]`);
        for (const task of psaasBatch) {
            try {
                const runRes = await fetch(`${WORKER_URL}/api/psaas/run`, {
                    method: 'POST', headers,
                    body: JSON.stringify({ profileName: task.profileName, count: task.count })
                }).then(r => r.json()).catch(() => ({}));
                if (runRes.success) {
                    console.log(`  ✅ Pages [${task.profileName}] 执行成功`);
                } else {
                    console.log(`  ❌ Pages [${task.profileName}] 执行失败: ${runRes.msg || '未知'}`);
                }
            } catch(e) {
                console.log(`  ❌ Pages [${task.profileName}] 异常: ${e.message}`);
            }
        }
        psaasConfig.currentIndex = (psaasIdx + 1) % psaasConfig.batches.length;
        await fetch(`${WORKER_URL}/api/psaas/auto_config`, { method: 'POST', headers, body: JSON.stringify({ password: ADMIN_PWD, config: psaasConfig }) });
    } else {
        console.log("💤 Pages SaaS 无任务。");
    }
}
run();
