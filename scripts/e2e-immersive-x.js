// X.com 沉浸模式 E2E 只读验证（node scripts/e2e-immersive-x.js）
// 通过 CDP 连接本机 Chrome（--remote-debugging-port=9223，命令行启动时需
// --load-extension + --enable-unsafe-extension-debugging 才能加载 unpacked 扩展）。
// 只读验证：不执行关注/取消关注，不改动账号状态。需要在新窗口手动登录 X.com。
const { chromium } = require('playwright');

const CDP_ENDPOINT = 'http://127.0.0.1:9223';

const RESULTS = [];
function log(name, pass, extra = '') {
    RESULTS.push({ name, pass, extra });
    console.log(`${pass ? 'PASS ✅' : 'FAIL ❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

(async () => {
    // 连接用户已开启调试的 Chrome
    let browser;
    try {
        browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    } catch (e) {
        console.log('❌ 无法连接 CDP:', e.message);
        console.log('  请确认 Chrome 已开启远程调试（127.0.0.1:9222）');
        process.exit(1);
    }
    console.log('✅ 已连接 Chrome CDP');

    const ctx = browser.contexts()[0];
    const pages = ctx.pages();
    console.log('当前页面:', pages.map(p => p.url().slice(0, 60)).join(' | '));

    // 找 x.com 页面，没有则新开
    let page = pages.find(p => p.url().includes('x.com')) || null;
    if (!page) {
        page = await ctx.newPage();
        await page.goto('https://x.com', { waitUntil: 'domcontentloaded', timeout: 90000 });
    }

    // content script 运行在隔离世界，page.evaluate（主世界）看不到 __mix01Engine。
    // 通过 CDP 在扩展的隔离世界上下文中评估。
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Runtime.enable');
    // content script 世界名固定为扩展名；CDP attach 时已存在的 context 不回放
    // executionContextCreated，因此 reload 页面以捕获 content script 世界。
    const mixContexts = new Set();
    cdp.on('Runtime.executionContextCreated', e => {
        if ((e.context.name || '').includes('Mix01')) mixContexts.add(e.context.id);
    });
    await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const evalExt = async (expr) => {
        for (const cid of mixContexts) {
            try {
                const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId: cid, returnByValue: true });
                if (r.result?.value !== undefined) return r.result.value;
            } catch (e) { /* stale context */ }
        }
        return undefined;
    };

    // 等待 content script 注入（在隔离世界中检查）
    let engineReady = false;
    for (let i = 0; i < 40 && !engineReady; i++) {
        engineReady = await evalExt('!!window.__mix01Engine').catch(() => false);
        if (!engineReady) await page.waitForTimeout(250);
    }
    if (!engineReady) {
        console.log('❌ 扩展 content script 未注入（请确认扩展已加载并刷新页面）');
        process.exit(1);
    }
    console.log('✅ 扩展已加载（content script 注入成功）');

    // 预置协议同意（通过扩展自身 ConfigManager，隔离世界）
    try {
        await evalExt('window.__mix01Engine.config.save({ hasAgreed: true })');
        console.log('✅ 已预置 hasAgreed=true');
    } catch (e) { console.log('⚠️ 预置失败:', e.message); }
    await page.waitForTimeout(500);

    // 等待登录（时间线 article 出现）；已登录则直接继续
    console.log('▶ 等待 X.com 登录状态（已登录则立即继续，最长 10 分钟）...');
    try {
        await page.waitForFunction(() => document.querySelectorAll('article').length > 0, { timeout: 600000 });
    } catch (e) {
        console.log('❌ 等待登录超时'); process.exit(2);
    }
    console.log('✅ 已登录（检测到时间线），开始测试...');
    await page.waitForTimeout(3000);

    const viewer = page.locator('#img-zoom-pro-viewer-xyz');
    const hint = page.locator('#img-zoom-pro-immersive-hint');
    const counter = page.locator('#mix01-gallery-counter');
    const zoomImg = page.locator('#zoom-img-xyz');
    const menuCount = () => page.locator('[role="menu"]').count().catch(() => 0);

    // T1 进入沉浸模式（若首屏无媒体则滚动后重试，最多 3 次）
    let isImmersive = false;
    for (let attempt = 1; attempt <= 3 && !isImmersive; attempt++) {
        await page.keyboard.press('Control+F12');
        await page.waitForTimeout(1500);
        isImmersive = await viewer.evaluate(el => el.classList.contains('mode-immersive')).catch(() => false);
        if (!isImmersive) {
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(2500);
        }
    }
    log('T1 进入沉浸模式 (Ctrl+F12)', isImmersive);
    if (!isImmersive) { console.log('❌ 无法进入沉浸模式（可能时间线无媒体）'); process.exit(3); }

    // T2 探测菜单自动关闭无残留（观察 3s：记录过程出现次数，最终必须为 0）
    let menuSeen = 0;
    const counts = [];
    for (let i = 0; i < 15; i++) {
        const n = await menuCount();
        counts.push(n);
        if (n > 0) menuSeen++;
        await page.waitForTimeout(200);
    }
    const finalMenus = counts[counts.length - 1];
    log('T2 探测菜单自动关闭无残留', finalMenus === 0, `3s窗口菜单出现${menuSeen}次, 最终残留${finalMenus}`);

    // T3 HUD 关注状态：等待自动探测刷新（最长 10s）。
    // 时间线推文无 live 关注控件 + 沉浸零菜单原则（不弹 caret 探测）+ 无缓存时，
    // HUD 诚实降级为「未确认」是预期行为；断言只要求 HUD 完成渲染。
    let hudText = '';
    for (let i = 0; i < 50; i++) {
        hudText = (await hint.textContent().catch(() => '')) || '';
        if (hudText && hudText.includes('的作品')) break;
        await page.waitForTimeout(200);
    }
    const flat = (hudText || '').replace(/\s+/g, '');
    // 关注状态区可能是 关注/已关注/订阅/未确认（诚实降级），任一存在即视为渲染完成
    const hudRendered = flat.includes('喜欢') &&
        (flat.includes('未确认') || flat.includes('关注') || flat.includes('订阅')) &&
        flat.includes('的作品');
    const unconfirmed = hudText.includes('未确认');
    log('T3 HUD 渲染完成', hudRendered,
        `HUD: "${(hudText || '').replace(/\s+/g, ' ').slice(0, 90)}"${unconfirmed ? '（诚实降级：时间线无live控件+零菜单原则+无缓存 → 未确认为预期）' : ''}`);

    // T4 计数器格式（n / N 或 ? / N）
    const counterText = ((await counter.textContent().catch(() => '')) || '').trim();
    log('T4 计数器格式正常', /^(\d+|\?)\s*\/\s*\d+$/.test(counterText), `计数器: "${counterText}"`);

    // T5 翻页：媒体切换 + 菜单无残留
    const srcBefore = await zoomImg.getAttribute('src').catch(() => '');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(700);
    const srcAfter1 = await zoomImg.getAttribute('src').catch(() => '');
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(700);
    const srcAfter2 = await zoomImg.getAttribute('src').catch(() => '');
    const menuResidual = await menuCount();
    log('T5 翻页后媒体切换且菜单无残留', (srcBefore !== srcAfter1 || srcAfter1 !== srcAfter2) && menuResidual === 0,
        `src变化: ${srcBefore !== srcAfter1 ? 'Y' : 'N'}, 菜单残留: ${menuResidual}`);

    // T6 快速连按（模拟探测中按键）：按键不被菜单劫持、菜单无残留
    for (let i = 0; i < 4; i++) {
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1000);
    const menuResidual2 = await menuCount();
    log('T6 快速连按后菜单无残留(按键未被劫持)', menuResidual2 === 0, `菜单残留: ${menuResidual2}`);

    // T7 Esc 退出沉浸
    await page.keyboard.press('Escape');
    await page.waitForTimeout(900);
    const exited = await viewer.evaluate(el => !el.classList.contains('mode-immersive')).catch(() => false);
    log('T7 Esc 退出沉浸', exited);

    const failed = RESULTS.filter(r => !r.pass);
    console.log(`\n===== 汇总: ${RESULTS.length - failed.length}/${RESULTS.length} PASS =====`);
    if (failed.length) {
        failed.forEach(f => console.log(`  FAIL: ${f.name} — ${f.extra}`));
        process.exit(4);
    }
    console.log('✅ 全部通过。浏览器保持打开以便人工复核。');
})().catch(e => { console.error('E2E 异常:', e); process.exit(5); });
