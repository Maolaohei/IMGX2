// 触发下载后立即在扩展 SW 存活窗口内查 chrome.downloads.search
const { chromium } = require('playwright');
const http = require('http');

function getJSON(path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: 9223, path }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

(async () => {
    const b = await chromium.connectOverCDP('http://127.0.0.1:9223');
    const ctx = b.contexts()[0];
    const page = ctx.pages().find(p => p.url().includes('x.com'));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Runtime.enable');
    const mix = new Set();
    cdp.on('Runtime.executionContextCreated', e => { if ((e.context.name || '').includes('Mix01')) mix.add(e.context.id); });
    await page.reload({ waitUntil: 'load', timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 30 && !mix.size; i++) await page.waitForTimeout(500);
    const evalExt = async (expr) => {
        for (const cid of [...mix].reverse()) {
            try {
                const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId: cid, returnByValue: true, awaitPromise: true });
                if (r.result?.value !== undefined && r.result.value !== null) return r.result.value;
            } catch (e) {}
        }
        return undefined;
    };
    for (let i = 0; i < 60; i++) { if (await evalExt('window.__imgZoomProInitialized === true') === true) break; await page.waitForTimeout(500); }
    for (let i = 0; i < 30; i++) {
        const g = await evalExt('(function(){try{return window.__mix01Engine.controller.getGalleryImages().length}catch(e){return 0}})()');
        if (g > 0) break;
        await page.waitForTimeout(1000);
    }

    // 定位图片并触发下载
    const located = await evalExt(`(async function(){
        var c = window.__mix01Engine.controller;
        if (!c.cfg.state.isImmersive) { c.cfg.state.isImmersive = true; }
        var g = c.getGalleryImages();
        var img = null;
        for (var i=0;i<g.length;i++){ if(g[i].tagName==='IMG'){ img=g[i]; break; } }
        if (!img) return 'no-img';
        c.triggerZoom(img);
        await new Promise(function(r){setTimeout(r,1800)});
        c.triggerGlobalDownload();
        return 'triggered';
    })()`);
    console.log(located);

    // SW 刚被消息唤醒，立即从 /json/list 找它
    for (let t = 0; t < 10; t++) {
        await new Promise(r => setTimeout(r, 800));
        const targets = await getJSON('/json/list');
        const sw = targets.find(x => x.type === 'service_worker' && (x.url || '').startsWith('chrome-extension://'));
        if (!sw) continue;
        let WSImpl;
        try { WSImpl = require('playwright-core/lib/utilsBundle').ws; } catch (e) {}
        const ws = new WSImpl(sw.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
        const expr = `new Promise(r => chrome.downloads.search({limit:3, orderBy:['-startTime']}, items => r(items.map(i => ({id:i.id, url:(i.url||'').slice(0,60), state:i.state, err:i.error||null, dir:i.filename||'', bytes:i.bytesReceived})))))`;
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
        const out = await new Promise(resolve => ws.on('message', m => { const msg = JSON.parse(m.toString()); if (msg.id === 1) resolve(msg.result?.result?.value); }));
        console.log(JSON.stringify(out, null, 1));
        process.exit(0);
    }
    console.log('SW 未捕获到');
    process.exit(4);
})().catch(e => { console.error(e.message); process.exit(9); });
