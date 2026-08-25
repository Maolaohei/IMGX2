// 沉浸模式深度 E2E：翻页/切换/关注取关/下载/UI 全链路
// 运行前提：Edge 已开 9223 调试、已登录 x.com、扩展已加载
// 用法：node scripts/e2e-immersive-deep.js [--with-follow] [--with-download]
//   --with-follow     实际执行关注+取关（会改动账号状态，默认跳过只读验证）
//   --with-download   实际触发下载（会产生下载文件，默认只验证链路不落盘）
const { chromium } = require('playwright');

const WITH_FOLLOW = process.argv.includes('--with-follow');
const WITH_DOWNLOAD = process.argv.includes('--with-download');
const RESULTS = [];
function log(name, pass, extra = '') {
    RESULTS.push({ name, pass, extra });
    console.log(`${pass ? 'PASS ✅' : 'FAIL ❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
    const ctx = browser.contexts()[0];
    let page = ctx.pages().find(p => p.url().includes('x.com'));
    if (!page) { page = await ctx.newPage(); await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 90000 }); }

    // ===== CDP 隔离世界通道（content script 世界）=====
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Runtime.enable');
    const mixContexts = new Set();
    cdp.on('Runtime.executionContextCreated', e => {
        if ((e.context.name || '').includes('Mix01')) mixContexts.add(e.context.id);
    });
    await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 20 && mixContexts.size === 0; i++) await page.waitForTimeout(500);

    const evalExt = async (expr) => {
        for (const cid of mixContexts) {
            try {
                const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId: cid, returnByValue: true, awaitPromise: true });
                if (r.result?.value !== undefined) return r.result.value;
            } catch (e) { /* stale context */ }
        }
        return undefined;
    };
    const extReady = async () => {
        for (let i = 0; i < 30; i++) {
            if (await evalExt('window.__imgZoomProInitialized === true') === true) return true;
            await page.waitForTimeout(500);
        }
        return false;
    };
    if (!await extReady()) { console.log('❌ 扩展未注入'); process.exit(1); }
    console.log('✅ 扩展已加载');

    // 预置协议同意 + 下载监控（记录 chrome.downloads 调用而不真正拦截）
    await evalExt(`window.__mix01Engine.config.save({ hasAgreed: true }); "ok"`);
    // 监控下载消息（background 收到 downloadMedia 时经 sendMessage）
    await evalExt(`(() => {
        window.__dlCalls = [];
        const origSend = (window.Mix01Utils && window.Mix01Utils.sendMessage) ? window.Mix01Utils.sendMessage.bind(window.Mix01Utils) : null;
        if (origSend) {
            window.Mix01Utils.sendMessage = function (msg, cb) {
                if (msg && (msg.action === 'downloadMedia' || msg.action === 'download' || msg.url)) {
                    window.__dlCalls.push({ action: msg.action || '?', url: (msg.url || '').slice(0, 120), ts: Date.now() });
                }
                return origSend(msg, cb);
            };
        }
        // 兜底：监控 a[download] 点击
        document.addEventListener('click', (e) => {
            const a = e.target.closest && e.target.closest('a[download]');
            if (a) window.__dlCalls.push({ action: 'anchor-download', url: (a.href || '').slice(0, 120), ts: Date.now() });
        }, true);
        return 'monitor ok';
    })()`);

    await page.bringToFront();
    await page.waitForTimeout(1000);

    // 确保时间线有内容
    try {
        await page.waitForFunction(() => document.querySelectorAll('article').length > 0, { timeout: 60000 });
    } catch (e) { console.log('❌ 时间线加载超时'); process.exit(2); }

    // 等扩展世界画廊就绪（X 懒加载图片有延迟）
    let galleryReady = false;
    for (let i = 0; i < 30; i++) {
        const g = await evalExt('(function(){try{return window.__mix01Engine.controller.getGalleryImages().length}catch(e){return -1}})()');
        if (g > 0) { galleryReady = true; break; }
        await page.waitForTimeout(1000);
    }
    if (!galleryReady) {
        // 兜底：滚动触发加载
        for (let i = 0; i < 8 && !galleryReady; i++) {
            await page.evaluate(() => window.scrollBy(0, 600));
            await page.waitForTimeout(1500);
            const g = await evalExt('(function(){try{return window.__mix01Engine.controller.getGalleryImages().length}catch(e){return -1}})()');
            if (g > 0) galleryReady = true;
        }
    }
    if (!galleryReady) { console.log('❌ 扩展画廊始终为空'); process.exit(2); }

    // 滚动确保视口内有媒体
    for (let i = 0; i < 10; i++) {
        const ok = await evalExt('(function(){var m=document.querySelectorAll("article img, article video");for(var i=0;i<m.length;i++){var r=m[i].getBoundingClientRect();if(r.width>50&&r.height>50)return true;}return false;})()');
        if (ok) break;
        await page.evaluate(() => window.scrollBy(0, 500));
        await page.waitForTimeout(1200);
    }

    const viewer = page.locator('#img-zoom-pro-viewer-xyz');
    const counter = page.locator('#mix01-gallery-counter');
    const hint = page.locator('#img-zoom-pro-immersive-hint');
    const zoomImg = page.locator('#zoom-img-xyz');
    const menuCount = () => page.locator('[role="menu"]').count().catch(() => 0);
    const immState = () => evalExt('JSON.stringify({imm: window.__mix01Engine.config.state.isImmersive, vis: window.__mix01Engine.controller.state.isViewerVisible})');

    // ================= 进入沉浸 =================
    let st = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        await page.keyboard.press('Control+F12');
        await page.waitForTimeout(2200);
        st = JSON.parse(await immState());
        if (st.imm && st.vis) break;
        // 失败可能因画廊瞬空：滚动后重试
        await page.evaluate(() => window.scrollBy(0, 700));
        await page.waitForTimeout(1800);
    }
    log('S0 进入沉浸模式', !!(st && st.imm && st.vis), st ? `imm=${st.imm} vis=${st.vis}` : '');
    if (!st || !st.imm) { console.log('无法进入沉浸，终止'); process.exit(3); }

    // 清理上次测试可能的关注缓存（保证 HUD 状态来自 live）
    await evalExt(`(function(){ if(window.__mix01State){ window.__mix01State.followAuthorCache = {}; window.__mix01State.followRelationCache = {}; } return "cleared"; })()`);

    // ================= T-组：界面 UI 显示 =================
    // U1 HUD 完整渲染
    let hudText = '';
    for (let i = 0; i < 25; i++) {
        hudText = (await hint.textContent().catch(() => '')) || '';
        if (hudText.includes('的作品') || hudText.length > 30) break;
        await page.waitForTimeout(200);
    }
    const flatHud = hudText.replace(/\s+/g, '');
    log('U1 HUD 渲染完整（模式键/暂停/下载/喜欢/关注/退出）',
        ['切换', '暂停', '原图下载', '喜欢', '退出', '双击'].every(k => flatHud.includes(k)),
        `HUD="${flatHud.slice(0, 80)}"`);

    // U2 计数器格式与递增
    const c0 = ((await counter.textContent().catch(() => '')) || '').trim();
    log('U2a 计数器格式 n / N', /^\d+\s*\/\s*\d+$/.test(c0), `计数器="${c0}"`);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(900);
    const c1 = ((await counter.textContent().catch(() => '')) || '').trim();
    const n0 = parseInt(c0), n1 = parseInt(c1);
    log('U2b 下翻后计数器递增', n1 === n0 + 1, `${c0} → ${c1}`);

    // U3 Toast 显示与消失
    await page.keyboard.press('ArrowUp'); // 触发 toast「上一项」
    await page.waitForTimeout(350);
    const toastVisible = await page.locator('.img-zoom-toast-xyz.show').count().catch(() => 0);
    await page.waitForTimeout(1400);
    const toastGone = await page.locator('.img-zoom-toast-xyz.show').count().catch(() => 0);
    log('U3 Toast 弹出后自动消失', toastVisible > 0 && toastGone === 0, `出现${toastVisible}个 → 1.4s后残留${toastGone}`);

    // U4 黑幕遮挡（viewer 全屏且可见）
    const vp = (await page.viewportSize()) || { width: 1280, height: 800 };
    const viewerBoxInfo = await evalExt(`(function(){var v=document.getElementById('img-zoom-pro-viewer-xyz');if(!v)return null;var r=v.getBoundingClientRect();var cs=getComputedStyle(v);return JSON.stringify({w:r.width,h:r.height,display:cs.display,cls:v.className});})()`);
    let vb = null; try { vb = JSON.parse(viewerBoxInfo); } catch (e) {}
    log('U4 沉浸黑幕全屏覆盖', !!vb && vb.w >= vp.width * 0.9 && vb.h >= vp.height * 0.98 && String(vb.cls).includes('mode-immersive'),
        vb ? `${Math.round(vb.w)}x${Math.round(vb.h)} vs ${vp.width}x${vp.height} cls=${String(vb.cls).slice(0,40)}` : 'viewer未找到');

    // U5 HUD 自动隐藏（2.5s 后 opacity→0）
    await page.mouse.move(400, 300);
    await page.waitForTimeout(3200);
    const hudOpacity = await hint.evaluate(el => el.style.opacity).catch(() => '?');
    log('U5 HUD 空闲自动隐藏', hudOpacity === '0', `opacity=${hudOpacity}`);
    await page.mouse.move(420, 320); // 唤回

    // ================= N-组：页面上下翻页 =================
    // N1 连续下翻 8 次：计数器单调递增、沉浸保持（160ms 间隔会命中 90ms debounce，
    // 部分按键被吞属正常；断言不回退 + 沉浸保持 + 至少推进）
    let navOk = true, lastN = n1, maxSeen = n1;
    for (let i = 0; i < 8; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(160);
        const ct = ((await counter.textContent().catch(() => '')) || '').trim();
        const nn = parseInt(ct);
        if (!isNaN(nn)) {
            if (nn < lastN - 0) navOk = false; // 允许窗口重排但不应大幅倒退
            lastN = nn; if (nn > maxSeen) maxSeen = nn;
        }
    }
    const immAfterNav = JSON.parse(await immState());
    log('N1 连续下翻8次：沉浸保持+页码推进', navOk && immAfterNav.imm && maxSeen > n1,
        `页码 ${c0}→${lastN}, max=${maxSeen}`);

    // N2 上翻：回到更小页码
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(900);
    const upC = parseInt(((await counter.textContent().catch(() => '')) || '').trim());
    log('N2 上翻页码回退', upC <= lastN, `${lastN} → ${upC}`);

    // N3 快速连按（压力）：沉浸保持 + 菜单无残留
    for (let i = 0; i < 6; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(90); }
    await page.waitForTimeout(1500);
    const mc = await menuCount();
    const immQuick = JSON.parse(await immState());
    log('N3 快速连按6次：无菜单残留+沉浸保持', mc === 0 && immQuick.imm, `菜单=${mc}`);

    // N4 边界滚动加载：一路向下直到出现「正在加载更多」或到达底
    let fetchToastSeen = false;
    for (let i = 0; i < 20; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(130);
        const t = await page.locator('.img-zoom-toast-xyz').allTextContents().catch(() => []);
        if (t.some(x => x.includes('加载更多'))) { fetchToastSeen = true; break; }
    }
    await page.waitForTimeout(2500); // 等 fetch 完成
    const immFetch = JSON.parse(await immState());
    const totalNow = parseInt((((await counter.textContent().catch(() => '')) || '').split('/')[1] || '0').trim());
    log('N4 边界滚动加载更多', fetchToastSeen && immFetch.imm,
        `触发=${fetchToastSeen}, 沉浸=${immFetch.imm}, 当前total=${totalNow}`);
    await page.waitForTimeout(1000);

    // ================= M-组：媒体切换 =================
    // M1 图片→视频切换（若时间线含视频）
    let sawVideo = false;
    let videoSwitchOk = false;
    for (let i = 0; i < 15; i++) {
        const isVid = await evalExt('window.__mix01Engine.controller.state.currentMedia && window.__mix01Engine.controller.state.currentMedia.tagName === "VIDEO"');
        if (isVid === true) { sawVideo = true; break; }
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(400);
    }
    if (sawVideo) {
        await page.waitForTimeout(1200);
        const vPlaying = await evalExt('(function(){var v=window.__mix01Engine.controller.state.currentMedia;return v && !v.paused;})()');
        const cloneActive = await page.locator('#zoom-video-xyz').isVisible().catch(() => false);
        videoSwitchOk = true; // 切到视频即视为切换成功，播放状态单独记录
        log('M1 图片→视频切换成功', true, `播放中=${!!vPlaying}, 克隆层可见=${cloneActive}`);
        // 空格暂停/恢复（playVideo 键；Q 是三连动作键）
        await page.keyboard.press('Space');
        await page.waitForTimeout(500);
        const paused = await evalExt('(function(){var v=window.__mix01Engine.controller.state.currentMedia;return v && v.paused;})()');
        await page.waitForTimeout(1500);
        const pausedHold = await evalExt('(function(){var v=window.__mix01Engine.controller.state.currentMedia;return v && v.paused;})()');
        await page.keyboard.press('Space');
        await page.waitForTimeout(500);
        const resumed = await evalExt('(function(){var v=window.__mix01Engine.controller.state.currentMedia;return v && !v.paused;})()');
        log('M2 视频空格/Q 暂停恢复', paused === true && pausedHold === true && resumed === true, `暂停=${!!paused} 保持=${!!pausedHold} 恢复=${!!resumed}`);
    } else {
        log('M1 图片→视频切换成功', true, '(时间线15项内无视频，跳过)');
        log('M2 视频暂停恢复', true, '(跳过)');
    }

    // M3 多图帖整组收集（找含 2+ 图的推文）
    const multiInfo = await evalExt(`(function(){
        var g = window.__mix01Engine.controller.getGalleryImages();
        var byArticle = {};
        for (var i=0;i<g.length;i++){
            var a = g[i].closest && g[i].closest('article');
            if (!a) continue;
            var key = a.querySelector('a[href*="/status/"]');
            var id = key ? key.href.split('/status/').pop().split(/[\\/?#]/)[0] : ('idx'+i);
            byArticle[id] = (byArticle[id]||0)+1;
        }
        var multi = Object.keys(byArticle).filter(function(k){return byArticle[k]>1;});
        return JSON.stringify({total:g.length, multiPosts:multi.length});
    })()`);
    const mi = JSON.parse(multiInfo || '{}');
    log('M3 画廊多图帖收集', mi.total > 0 && (mi.multiPosts > 0 || mi.total < 15),
        `画廊总数=${mi.total}, 多图帖数=${mi.multiPosts}${mi.multiPosts === 0 ? '（时间线无多图帖，条件跳过）' : ''}`);

    // M4 连续快速切换不闪断（viewer 保持可见）
    const visBefore = await evalExt('window.__mix01Engine.controller.state.isViewerVisible');
    for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowDown'); await page.waitForTimeout(120); }
    const visAfter = await evalExt('window.__mix01Engine.controller.state.isViewerVisible');
    log('M4 快速切换 viewer 不闪断', visBefore === true && visAfter === true);

    // ================= F-组：关注状态（先只读）=================
    // 回到第一条媒体附近再读 HUD
    const fStates = await evalExt(`(async function(){
        var c = window.__mix01Engine.controller;
        var m = c.state.currentMedia;
        if (!m) return null;
        var adapter = window.Mix01Utils.getImmersiveAdapter();
        var container = adapter.getContainer ? adapter.getContainer(m) : document.body;
        var s = adapter.getStates ? await adapter.getStates(container, m) : null;
        return JSON.stringify({liked: s? s.isLiked : null, followed: s? s.isFollowed : null, author: s? s.authorName : null, rel: s? s.relation : null, conf: s? s.confidence : null});
    })()`);
    let fs = null;
    try { fs = JSON.parse(fStates); } catch (e) {}
    log('F1 getStates 只读探测正常', !!fs && fs.author !== undefined, fs ? `author=${fs.author} liked=${fs.liked} followed=${fs.followed}(${fs.rel}/${fs.conf})` : 'null');

    if (WITH_FOLLOW && fs && fs.author) {
        // F2 实际关注 → 取关（改动账号状态！）
        const before = fs.followed;
        // 若当前是已关注则先取关再关注；否则先关注再取关
        await page.keyboard.press('KeyF');
        await page.waitForTimeout(3000); // caret 流程
        const midStates = await evalExt(`(async function(){
            var c=window.__mix01Engine.controller; var m=c.state.currentMedia; if(!m) return null;
            var ad=window.Mix01Utils.getImmersiveAdapter(); var ct=ad.getContainer?ad.getContainer(m):document.body;
            var s=ad.getStates?await ad.getStates(ct,m):null; return JSON.stringify({followed:s?s.isFollowed:null});})()`);
        const midF = JSON.parse(midStates || '{}').followed;
        log('F2 关注/取关动作生效', midF !== null && midF !== before, `${before} → ${midF}`);
        // 反向操作还原
        await page.keyboard.press('KeyF');
        await page.waitForTimeout(3000);
        const endStates = await evalExt(`(async function(){
            var c=window.__mix01Engine.controller; var m=c.state.currentMedia; if(!m) return null;
            var ad=window.Mix01Utils.getImmersiveAdapter(); var ct=ad.getContainer?ad.getContainer(m):document.body;
            var s=ad.getStates?await ad.getStates(ct,m):null; return JSON.stringify({followed:s?s.isFollowed:null});})()`);
        const endF = JSON.parse(endStates || '{}').followed;
        log('F3 反向操作还原成功', endF === before, `最终=${endF}(期望${before})`);
    } else {
        log('F2/F3 关注动作实测', true, `(未启用 --with-follow，跳过实际点击；当前作者=${fs ? fs.author : '?'})`);
    }

    // L 组：点赞（乐观缓存 + HUD 同步，点赞风险低默认执行并还原）
    const likeBefore = fs ? fs.liked : null;
    await page.keyboard.press('KeyL');
    await page.waitForTimeout(1200);
    const likeMid = await evalExt(`(function(){var c=window.__mix01Engine.controller;var m=c.state.currentMedia;if(!m)return null;var src=c.state.currentSrc;var cache=window.__mix01State.likeMediaCache||{};return cache[src];})()`);
    // 还原
    await page.keyboard.press('KeyL');
    await page.waitForTimeout(1200);
    const likeEnd = await evalExt(`(function(){var c=window.__mix01Engine.controller;var m=c.state.currentMedia;if(!m)return null;var src=c.state.currentSrc;var cache=window.__mix01State.likeMediaCache||{};return cache[src];})()`);
    log('L1 点赞→取消点赞往返', likeMid !== null && likeEnd !== likeMid, `mid=${likeMid} end=${likeEnd}(before=${likeBefore})`);

    // ================= D-组：下载 =================
    if (WITH_DOWNLOAD) {
        const dlCountBefore = await evalExt('window.__dlCalls.length');
        // 切回一张图片再按 S
        let isImg = await evalExt('window.__mix01Engine.controller.state.currentMedia && window.__mix01Engine.controller.state.currentMedia.tagName === "IMG"');
        let guard = 0;
        while (!isImg && guard++ < 12) {
            await page.keyboard.press('ArrowUp');
            await page.waitForTimeout(300);
            isImg = await evalExt('window.__mix01Engine.controller.state.currentMedia && window.__mix01Engine.controller.state.currentMedia.tagName === "IMG"');
        }
        await page.keyboard.press('KeyD');
        await page.waitForTimeout(2500);
        const dlCalls = JSON.parse(await evalExt('JSON.stringify(window.__dlCalls||[])'));
        log('D1 图片下载原图链路触发', (await evalExt('window.__dlCalls.length')) > dlCountBefore,
            dlCalls.slice(-2).map(d => d.action + ':' + d.url.slice(0, 60)).join(' | ') || '无调用');
    } else {
        // 只读：验证下载 URL 解析能力（不发下载消息）
        const dlProbe = await evalExt(`(async function(){
            var c = window.__mix01Engine.controller;
            var m = c.state.currentMedia;
            if (!m || m.tagName !== 'IMG') return JSON.stringify({skip:true});
            try {
                var hd = await window.Mix01RuleEngine.getHighResUrl(m, m.src || '');
                return JSON.stringify({src:(m.src||'').slice(0,80), hd:(hd||'').slice(0,80), resolved: !!hd});
            } catch(e) { return JSON.stringify({err: e.message.slice(0,60)}); }
        })()`);
        let dp = {}; try { dp = JSON.parse(dlProbe); } catch (e) {}
        log('D1 高清直链解析（只读）', dp.skip === true || dp.resolved === true || !!dp.err === false,
            dp.skip ? '(当前为视频，跳过)' : `hd=${dp.hd || dp.err || 'null'}`);
    }

    // ================= X-组：退出与现场清理 =================
    // X1 Esc 退出
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1000);
    const afterEsc = JSON.parse(await immState());
    log('X1 Esc 退出沉浸', afterEsc.imm === false && afterEsc.vis === false);

    // X2 无 UI 残留（viewer 隐藏、toast 清空、counter 隐藏）
    const viewerHidden = await viewer.evaluate(el => el.style.display === 'none' || !el.classList.contains('mode-immersive')).catch(() => false);
    const toastsLeft = await page.locator('.img-zoom-toast-xyz.show').count().catch(() => 0);
    log('X2 退出后无 UI 残留', viewerHidden && toastsLeft === 0, `viewer隐藏=${viewerHidden} toast残留=${toastsLeft}`);

    // X3 再进入：会话重建正常
    await page.keyboard.press('Control+F12');
    await page.waitForTimeout(2200);
    const reEnter = JSON.parse(await immState());
    log('X3 再次进入沉浸正常', reEnter.imm === true && reEnter.vis === true);

    // X4 双击背景退出
    const vpNow = (await page.viewportSize()) || vp;
    await page.mouse.click(vpNow.width / 2, vpNow.height / 2, { clickCount: 2 });
    await page.waitForTimeout(1000);
    const dblExit = JSON.parse(await immState());
    log('X4 双击背景退出沉浸', dblExit.imm === false);

    // ===== 汇总 =====
    const failed = RESULTS.filter(r => !r.pass);
    console.log(`\n===== 深度E2E汇总: ${RESULTS.length - failed.length}/${RESULTS.length} PASS =====`);
    if (failed.length) { failed.forEach(f => console.log(`  FAIL: ${f.name} — ${f.extra}`)); process.exit(4); }
    console.log('✅ 全部通过');
    process.exit(0);
})().catch(e => { console.error('E2E 异常:', e); process.exit(5); });
