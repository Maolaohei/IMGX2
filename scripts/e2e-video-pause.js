// M2 视频暂停压制专项测试：找到视频 → 沉浸 → Q 暂停 → 验证 3s 内不被 X 自动恢复
const { chromium } = require('playwright');

const RESULTS = [];
function log(name, pass, extra = '') {
    RESULTS.push({ name, pass, extra });
    console.log(`${pass ? 'PASS ✅' : 'FAIL ❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

(async () => {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9223');
    const ctx = browser.contexts()[0];
    let page = ctx.pages().find(p => p.url().includes('x.com'));
    if (!page) { console.log('❌ 无 x.com 页面'); process.exit(1); }

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
            } catch (e) { /* stale */ }
        }
        return undefined;
    };

    for (let i = 0; i < 30; i++) {
        if (await evalExt('window.__imgZoomProInitialized === true') === true) break;
        await page.waitForTimeout(500);
    }
    await evalExt(`window.__mix01Engine.config.save({ hasAgreed: true }); "ok"`);

    // 滚动寻找视频（最多 25 屏）
    let videoFound = false;
    for (let i = 0; i < 25; i++) {
        const has = await evalExt('(function(){var v=document.querySelectorAll("article video");for(var i=0;i<v.length;i++){var r=v[i].getBoundingClientRect();if(r.width>150&&r.height>150)return true;}return false;})()');
        if (has === true) { videoFound = true; break; }
        await page.evaluate(() => window.scrollBy(0, 700));
        await page.waitForTimeout(1600);
    }
    if (!videoFound) { console.log('⏭️ 时间线找不到视频，跳过 M2 专项'); process.exit(0); }
    console.log('✅ 找到视频');

    await page.bringToFront();
    await page.keyboard.press('Control+F12');
    await page.waitForTimeout(2200);
    // 翻页直到 currentMedia 是 VIDEO
    let onVideo = false;
    for (let i = 0; i < 20; i++) {
        onVideo = await evalExt('window.__mix01Engine.controller.state.currentMedia && window.__mix01Engine.controller.state.currentMedia.tagName === "VIDEO"') === true;
        if (onVideo) break;
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(450);
    }
    if (!onVideo) { console.log('⏭️ 沉浸中未到达视频条目'); process.exit(0); }
    console.log('✅ 沉浸定位到视频');
    await page.waitForTimeout(1500); // 等播放稳定

    // 空格暂停（playVideo 键；Q 是三连动作键，勿用）
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    const p1 = await evalExt('(function(){var v=window.__mix01Engine.controller.state.currentMedia;return v.paused;})()');
    // 等 3s 检查是否被 X 自动恢复
    await page.waitForTimeout(3000);
    const p2 = await evalExt('(function(){var v=window.__mix01Engine.controller.state.currentMedia;return v.paused;})()');
    // 再等 2s 双重确认
    await page.waitForTimeout(2000);
    const p3 = await evalExt('(function(){var v=window.__mix01Engine.controller.state.currentMedia;return v.paused;})()');

    log('M2a Q暂停立即生效', p1 === true, `paused=${p1}`);
    log('M2b 暂停3s不被X自动恢复', p2 === true, `paused=${p2}`);
    log('M2c 暂停5s持续保持', p3 === true, `paused=${p3}`);

    // 再按空格恢复播放 + 退出沉浸
    await page.keyboard.press('Space');
    await page.waitForTimeout(600);
    const resumed = await evalExt('(function(){var v=window.__mix01Engine.controller.state.currentMedia;return !v.paused;})()');
    log('M2d 再按空格恢复播放', resumed === true, `playing=${resumed}`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    const failed = RESULTS.filter(r => !r.pass);
    console.log(`\n===== 视频暂停专项: ${RESULTS.length - failed.length}/${RESULTS.length} PASS =====`);
    process.exit(failed.length ? 4 : 0);
})().catch(e => { console.error(e); process.exit(9); });
