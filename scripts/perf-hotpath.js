// scripts/perf-hotpath.js
// Mix01 全局热路径基线 / 回归测量（真实 Chrome + 真实源码 + 合成 X 时间线）
//
// 目的：把「性能瓶颈」量化，而不是靠感觉。测量项：
//   P1 引擎冷启动耗时
//   P2 画廊收集冷/热耗时（getGalleryImages）
//   P3 DOM 突变风暴（新增 20 篇文章 / 80 张图）的观察者 + 空闲扫描成本
//   P4 悬停放大镜：120 次 mousemove 的强制布局读取 / 样式写入 / 引擎耗时
//   P5 沉浸模式 HUD：120 次 mousemove 的样式写入 / HUD 重绘 / 引擎耗时
//   P6 泄漏迹象：30 次 打开→关闭 循环后的堆增长与缓存体积
//
// 用法：
//   node scripts/perf-hotpath.js            # 测量 + 预算断言，输出工件
//   node scripts/perf-hotpath.js --no-assert
// 工件：test-artifacts/perf-hotpath-report.json
const fs = require('fs');
const path = require('path');
const {
    ROOT, describeBrowser, launchHarnessBrowser, createHarnessPage, injectMix01Source, bootMix01Engine
} = require('./lib/mix01-harness');

const REPORT_PATH = path.join(ROOT, 'test-artifacts', 'perf-hotpath-report.json');
const NO_ASSERT = process.argv.includes('--no-assert');

const ARTICLE_COUNT = 40;      // 初始文章数（每篇 4 图）
const STORM_ARTICLES = 20;     // 突变风暴新增文章数
const MOVES = 120;             // 每次 mousemove 压测次数

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Mix01 perf harness</title>
<style>
  body { margin: 0; font: 14px system-ui; background: #111; color: #eee; }
  #feed { width: 600px; margin: 0 auto; }
  article { display: block; height: 420px; border-bottom: 1px solid #333; padding: 8px; box-sizing: border-box; }
  .media { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .media img, .media video { width: 285px; height: 195px; object-fit: cover; background: #222; }
</style></head>
<body><div id="feed"></div>
<script>
  // 合成 X 时间线：结构深度贴近线上（article > cell > body > media > a > img）
  (function buildFeed() {
      const feed = document.getElementById('feed');
      const frag = document.createDocumentFragment();
      for (let i = 0; i < ${ARTICLE_COUNT}; i++) {
          const a = document.createElement('article');
          a.dataset.testid = 'tweet';
          a.innerHTML =
              '<div class="cell"><div class="body">' +
              '<div class="text">tweet body ' + i + ' <span>span</span><span>span</span></div>' +
              '<div class="media">' +
              Array.from({ length: 4 }, (_, k) =>
                  '<a href="/user/status/' + (1000000 + i) + '"><img class="photo" ' +
                  'src="https://pbs.twimg.com/media/IMG' + i + '_' + k + '?format=jpg&name=small" ' +
                  'width="285" height="195" alt=""></a>').join('') +
              '</div></div></div>';
          frag.appendChild(a);
      }
      // 少量视频（blob: 假直链，贴近 X MSE 场景）
      for (let v = 0; v < 3; v++) {
          const a = document.createElement('article');
          a.dataset.testid = 'tweet';
          const video = document.createElement('video');
          video.id = 'perf-vid-' + v;
          video.setAttribute('poster', 'https://pbs.twimg.com/tweet_video_thumb/V' + v + '.jpg');
          a.appendChild(video);
          frag.appendChild(a);
          video.src = URL.createObjectURL(new Blob(['perf-video-' + v], { type: 'video/mp4' }));
      }
      feed.appendChild(frag);
      window.__makeHiddenArticle = function () {
          const a = document.createElement('article');
          a.dataset.testid = 'tweet';
          a.innerHTML =
              '<div class="cell"><div class="body"><div class="media">' +
              Array.from({ length: 4 }, (_, k) =>
                  '<a href="/user/status/3000000"><img class="photo" ' +
                  'src="https://pbs.twimg.com/media/HIDDEN' + k + '?format=jpg&name=small" ' +
                  'width="285" height="195" alt=""></a>').join('') +
              '</div></div></div>';
          return a;
      };
      window.__makeStormArticle = function (i) {
          const a = document.createElement('article');
          a.dataset.testid = 'tweet';
          // 贴近线上：深层包裹 + 广告文案 span + 转发/引用共 8 图
          a.innerHTML =
              '<div class="cell"><div class="body"><div class="text">' +
              Array.from({ length: 24 }, (_, s) => '<span class="txt">seg' + s + '</span>').join('') +
              '</div><div class="media">' +
              Array.from({ length: 8 }, (_, k) =>
                  '<a href="/user/status/' + (2000000 + i) + '">' + '<div class="wrap"><img class="photo" ' +
                  'src="https://pbs.twimg.com/media/STORM' + i + '_' + k + '?format=jpg&name=small" ' +
                  'width="285" height="195" alt=""></div></a>').join('') +
              '</div></div></div>';
          return a;
      };
  })();
</script></body></html>`;

const INSTRUMENT = () => {
    const perf = window.__perf = {
        reset() {
            Object.assign(this, {
                rectCalls: 0, rectMs: 0, rectReads: 0,
                qsaElCalls: 0, qsaElMs: 0, qsaDocCalls: 0, qsaDocMs: 0,
                elementsFromPointCalls: 0, elementsFromPointMs: 0,
                elementFromPointCalls: 0, elementFromPointMs: 0,
                styleCalls: 0, styleMs: 0, styleWrites: 0,
                moCalls: 0, moRecords: 0, moMs: 0,
                ricCalls: 0, ricMs: 0,
                engine: {}
            });
        },
        bump(bucket, ms) {
            this[bucket + 'Calls'] = (this[bucket + 'Calls'] || 0) + 1;
            this[bucket + 'Ms'] = (this[bucket + 'Ms'] || 0) + ms;
            if (bucket === 'style') this.styleWrites++;
            if (bucket === 'rect') this.rectReads++;
        },
        engineBump(name, ms) {
            const e = this.engine[name] = this.engine[name] || { calls: 0, ms: 0 };
            e.calls++;
            e.ms += ms;
        },
        snapshot() {
            const out = {};
            for (const k of Object.keys(this)) {
                if (k === 'engine' || typeof this[k] === 'function') continue;
                out[k] = Math.round(this[k] * 1000) / 1000;
            }
            out.engine = {};
            for (const k of Object.keys(this.engine)) {
                out.engine[k] = { calls: this.engine[k].calls, ms: Math.round(this.engine[k].ms * 1000) / 1000 };
            }
            return out;
        }
    };
    perf.reset();

    const timeSync = (bucket, fn) => { const t0 = performance.now(); const r = fn(); perf.bump(bucket, performance.now() - t0); return r; };

    const origElemQSA = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function (...a) { return timeSync('qsaEl', () => origElemQSA.apply(this, a)); };
    const origDocQSA = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function (...a) { return timeSync('qsaDoc', () => origDocQSA.apply(this, a)); };
    const origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (...a) { return timeSync('rect', () => origRect.apply(this, a)); };
    const origEFP = Document.prototype.elementsFromPoint;
    Document.prototype.elementsFromPoint = function (...a) { return timeSync('elementsFromPoint', () => origEFP.apply(this, a)); };
    const origEP = Document.prototype.elementFromPoint;
    Document.prototype.elementFromPoint = function (...a) { return timeSync('elementFromPoint', () => origEP.apply(this, a)); };
    const origSetProp = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function (...a) { return timeSync('style', () => origSetProp.apply(this, a)); };

    const OrigMO = window.MutationObserver;
    window.MutationObserver = class Mix01PerfMO extends OrigMO {
        constructor(cb) {
            super((muts, obs) => {
                const t0 = performance.now();
                try { return cb(muts, obs); }
                finally { perf.bump('mo', performance.now() - t0); perf.moRecords += muts.length; }
            });
        }
    };

    const origRIC = window.requestIdleCallback;
    if (origRIC) {
        window.requestIdleCallback = function (cb, opts) {
            return origRIC.call(window, (...a) => {
                const t0 = performance.now();
                try { return cb(...a); }
                finally { perf.bump('ric', performance.now() - t0); }
            }, opts);
        };
    }

    // 引擎方法埋点（boot 后由调用方 attach）
    window.__perfAttachEngine = function () {
        const { render, controller } = window.__mix01Engine;
        const wrap = (obj, name) => {
            const orig = obj[name];
            obj[name] = function (...a) {
                const t0 = performance.now();
                try { return orig.apply(this, a); }
                finally { perf.engineBump(name, performance.now() - t0); }
            };
        };
        wrap(render, 'handleImmersiveActivity');
        wrap(render, 'setHUDOpacity');
        wrap(render, 'updateLayout');
        wrap(controller, 'updateRender');
        wrap(controller, 'getGalleryImages');
        wrap(controller, 'handleMouseMove');
        wrap(controller, '_findGalleryIndex');
    };
};

// ---------- 页内测量例程 ----------
async function measureGallery(page) {
    return page.evaluate(() => {
        const c = window.__mix01Engine.controller;
        window.__perf.reset();
        const cold = [];
        for (let i = 0; i < 10; i++) {
            c.state._galleryCacheDirty = true;
            const t = performance.now();
            c.getGalleryImages();
            cold.push(performance.now() - t);
        }
        const warm = [];
        for (let i = 0; i < 50; i++) {
            const t = performance.now();
            c.getGalleryImages();
            warm.push(performance.now() - t);
        }
        const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
        return {
            size: c.getGalleryImages().length,
            coldAvgMs: avg(cold), coldMaxMs: Math.max(...cold),
            warmAvgMs: avg(warm), warmMaxMs: Math.max(...warm)
        };
    });
}

async function measureStorm(page) {
    return page.evaluate(async (n) => {
        const feed = document.getElementById('feed');
        const perf = window.__perf;
        perf.reset();
        const frag = document.createDocumentFragment();
        for (let i = 0; i < n; i++) frag.appendChild(window.__makeStormArticle(i));
        const t0 = performance.now();
        feed.appendChild(frag);
        const newImgs = Array.from(document.querySelectorAll('img[src*="STORM"]'));
        // 轮询到空闲扫描真正落地（比固定 sleep 准确）
        while (newImgs.some(el => el._mix01Observed !== true) && performance.now() - t0 < 3000) {
            await new Promise(r => requestAnimationFrame(r));
        }
        return {
            scanLatencyMs: performance.now() - t0,
            newImgCount: newImgs.length,
            observed: newImgs.filter(el => el._mix01Observed === true).length,
            snapshot: perf.snapshot()
        };
    }, STORM_ARTICLES);
}

async function measureHover(page, immersive) {
    return page.evaluate(async ({ moves, immersive }) => {
        const { config, controller } = window.__mix01Engine;
        config.state.hasAgreed = true;
        config.state.isImmersive = immersive;
        config.state.triggerDelay = 0;
        // 选择视口内可见的一张图
        const img = Array.from(document.querySelectorAll('img.photo'))
            .find(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; });
        if (!img) return { error: 'no visible img' };
        controller.triggerZoom(img);
        await new Promise(r => requestAnimationFrame(r));

        const rect = img.getBoundingClientRect();
        const perf = window.__perf;
        perf.reset();
        const t0 = performance.now();
        for (let i = 0; i < moves; i++) {
            const x = rect.left + (rect.width * (i % 100)) / 100;
            const y = rect.top + (rect.height * ((i * 7) % 100)) / 100;
            img.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
            await new Promise(r => requestAnimationFrame(r));
        }
        const wall = performance.now() - t0;
        return { wallMs: wall, snapshot: perf.snapshot() };
    }, { moves: MOVES, immersive });
}

// P7 画廊重建：模拟滚动中 IO 持续失效的最坏情况（每帧重建）
async function measureGalleryStorm(page) {
    return page.evaluate(() => {
        const c = window.__mix01Engine.controller;
        window.__perf.reset();
        const times = [];
        for (let i = 0; i < 30; i++) {
            c.state._galleryCacheDirty = true;
            const t = performance.now();
            c.getGalleryImages();
            times.push(performance.now() - t);
        }
        const avg = times.reduce((s, v) => s + v, 0) / times.length;
        return { avgMs: avg, maxMs: Math.max(...times), snapshot: window.__perf.snapshot() };
    });
}

// P8 页面隐藏/可见：观察器应暂停/恢复（X 这种高动态页面不得在后台持续记录突变）
async function measureHiddenPause(page) {
    return page.evaluate(async () => {
        const feed = document.getElementById('feed');
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));

        const article = window.__makeHiddenArticle();
        feed.appendChild(article);
        await new Promise(r => setTimeout(r, 300));
        await new Promise(r => requestAnimationFrame(r));
        const hiddenImgs = Array.from(document.querySelectorAll('img[src*="HIDDEN"]'));
        const observedWhileHidden = hiddenImgs.filter(el => el._mix01Observed === true).length;

        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
        const t0 = performance.now();
        while (hiddenImgs.some(el => el._mix01Observed !== true) && performance.now() - t0 < 2000) {
            await new Promise(r => requestAnimationFrame(r));
        }
        return {
            hiddenImgCount: hiddenImgs.length,
            observedWhileHidden,
            observedAfterResume: hiddenImgs.filter(el => el._mix01Observed === true).length,
            resumeLatencyMs: performance.now() - t0
        };
    });
}

async function measureLeak(page) {
    return page.evaluate(async () => {
        const { config, controller } = window.__mix01Engine;
        config.state.hasAgreed = true;
        config.state.isImmersive = true;
        const heap = () => (performance.memory ? performance.memory.usedJSHeapSize : 0);
        const gallery = controller.getGalleryImages();
        const startHeap = heap();
        for (let i = 0; i < 30; i++) {
            const el = gallery[i % gallery.length];
            if (!el) continue;
            controller.triggerZoom(el);
            await new Promise(r => setTimeout(r, 30));
            controller.hideViewer();
            await new Promise(r => setTimeout(r, 10));
        }
        await new Promise(r => setTimeout(r, 200));
        const state = window.__mix01State || {};
        const countMap = (m) => (m && typeof m.size === 'number') ? m.size : Object.keys(m || {}).length;
        return {
            domNodes: document.querySelectorAll('*').length,
            heapStartMB: startHeap / 1048576,
            heapEndMB: heap() / 1048576,
            heapDeltaMB: (heap() - startHeap) / 1048576,
            hdUrlMap: Object.keys(state.hdUrlMap || {}).length,
            blobToUrlMap: Object.keys(state.blobToUrlMap || {}).length,
            likeMediaCache: Object.keys(state.likeMediaCache || {}).length,
            followAuthorCache: Object.keys(state.followAuthorCache || {}).length,
            visibleMedia: controller.visibleMediaElements ? controller.visibleMediaElements.size : -1,
            detachProbe: countMap(window.__mix01DetectCache),
            twVideoCache: countMap(window.__mix01TwVideoCache)
        };
    });
}

(async () => {
    const { browser, exe } = await launchHarnessBrowser();
    console.log(`🌐 浏览器: ${describeBrowser(exe)} (headless)`);
    const report = {
        test: 'perf-hotpath',
        generatedAt: new Date().toISOString(),
        browser: describeBrowser(exe),
        articleCount: ARTICLE_COUNT,
        measurements: {},
        budgets: {}
    };

    try {
        const page = await createHarnessPage(browser, { html: PAGE_HTML });
        await page.evaluate(INSTRUMENT);

        // P1 冷启动
        const t0 = Date.now();
        await injectMix01Source(page);
        await bootMix01Engine(page);
        await page.evaluate(() => window.__perfAttachEngine());
        report.measurements.initMs = Date.now() - t0;

        // P2 画廊收集
        report.measurements.gallery = await measureGallery(page);
        console.log('P2 gallery:', JSON.stringify(report.measurements.gallery));

        // P3 DOM 突变风暴
        report.measurements.storm = await measureStorm(page);
        console.log('P3 storm:', JSON.stringify({ ...report.measurements.storm, snapshot: undefined }),
            'qsaEl=' + report.measurements.storm.snapshot.qsaElCalls,
            'qsaElMs=' + report.measurements.storm.snapshot.qsaElMs,
            'moMs=' + report.measurements.storm.snapshot.moMs,
            'ricMs=' + report.measurements.storm.snapshot.ricMs);

        // P4 悬停放大镜
        report.measurements.hover = await measureHover(page, false);
        console.log('P4 hover:', JSON.stringify({ wallMs: report.measurements.hover.wallMs, ...report.measurements.hover.snapshot }));

        // P5 沉浸 HUD
        report.measurements.immersive = await measureHover(page, true);
        console.log('P5 immersive:', JSON.stringify({ wallMs: report.measurements.immersive.wallMs, ...report.measurements.immersive.snapshot }));

        // P6 画廊重建（滚动失效最坏情况）
        report.measurements.galleryStorm = await measureGalleryStorm(page);
        console.log('P6 galleryStorm:', JSON.stringify({
            avgMs: report.measurements.galleryStorm.avgMs,
            maxMs: report.measurements.galleryStorm.maxMs,
            qsaDocCalls: report.measurements.galleryStorm.snapshot.qsaDocCalls,
            rectReads: report.measurements.galleryStorm.snapshot.rectReads
        }));

        // P7 页面隐藏/可见：观察器暂停/恢复
        report.measurements.hiddenPause = await measureHiddenPause(page);
        console.log('P7 hiddenPause:', JSON.stringify(report.measurements.hiddenPause));

        // P8 泄漏迹象
        report.measurements.leak = await measureLeak(page);
        console.log('P8 leak:', JSON.stringify(report.measurements.leak));

        // ---- 预算断言（回归防线） ----
        const m = report.measurements;
        const budgets = report.budgets = {
            'initMs < 2500': m.initMs < 2500,
            'gallery.warmAvgMs < 0.5': m.gallery.warmAvgMs < 0.5,
            'gallery.coldMaxMs < 60': m.gallery.coldMaxMs < 60,
            'galleryStorm.avgMs < 12': m.galleryStorm.avgMs < 12,
            'storm.observed == newImgCount': m.storm.observed === m.storm.newImgCount,
            'storm.scanLatencyMs < 1500': m.storm.scanLatencyMs < 1500,
            'storm.qsaElMs < 30': m.storm.snapshot.qsaElMs < 30,
            'hover.rectReads < 400': m.hover.snapshot.rectReads < 400,
            'hover.styleWrites < 400': m.hover.snapshot.styleWrites < 400,
            'hover.elementFromPointCalls < 30': m.hover.snapshot.elementFromPointCalls < 30,
            'immersive.styleWrites < 60': m.immersive.snapshot.styleWrites < 60,
            'immersive.wallMs < 6000': m.immersive.wallMs < 6000,
            'leak.domNodes < 2200': m.leak.domNodes < 2200,
            'leak.heapDeltaMB < 40': m.leak.heapDeltaMB < 40,
            'hiddenPause.pausedWhileHidden': m.hiddenPause.observedWhileHidden === 0,
            'hiddenPause.resumedAfterVisible': m.hiddenPause.observedAfterResume === m.hiddenPause.hiddenImgCount,
            'hiddenPause.resumeLatencyMs < 800': m.hiddenPause.resumeLatencyMs < 800
        };

        for (const [k, ok] of Object.entries(budgets)) {
            console.log(`${ok ? 'PASS ✅' : 'FAIL ❌'} 预算: ${k}`);
        }
        const failed = Object.values(budgets).filter(v => !v).length;
        report.pass = failed === 0;

        // 与基线对比（若 test-artifacts/perf-hotpath-baseline.json 存在）
        const BASELINE_PATH = path.join(ROOT, 'test-artifacts', 'perf-hotpath-baseline.json');
        if (fs.existsSync(BASELINE_PATH)) {
            try {
                const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')).measurements || {};
                const pick = (obj, p) => p.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
                const metricPaths = [
                    'initMs',
                    'gallery.coldAvgMs', 'gallery.coldMaxMs', 'gallery.warmAvgMs',
                    'storm.snapshot.qsaElCalls', 'storm.snapshot.qsaElMs',
                    'hover.wallMs', 'hover.snapshot.rectReads', 'hover.snapshot.styleWrites', 'hover.snapshot.elementFromPointCalls',
                    'immersive.wallMs', 'immersive.snapshot.styleWrites',
                    'galleryStorm.avgMs',
                    'leak.heapDeltaMB'
                ];
                report.delta = {};
                for (const p of metricPaths) {
                    const b = pick(baseline, p), a = pick(m, p);
                    if (typeof b !== 'number' || typeof a !== 'number') continue;
                    report.delta[p] = {
                        baseline: Math.round(b * 100) / 100,
                        current: Math.round(a * 100) / 100,
                        changePct: b === 0 ? null : Math.round(((a - b) / b) * 1000) / 10
                    };
                }
                console.log('\n📉 与基线对比:');
                for (const [k, v] of Object.entries(report.delta)) {
                    console.log(`   ${k}: ${v.baseline} → ${v.current} (${v.changePct > 0 ? '+' : ''}${v.changePct}%)`);
                }
            } catch (e) { console.warn('基线对比失败:', e.message); }
        }

        console.log(`\n===== 热路径体检: ${Object.keys(budgets).length - failed}/${Object.keys(budgets).length} 预算达标 =====`);

        fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
        fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
        console.log(`🧾 工件: ${path.relative(ROOT, REPORT_PATH)}`);
        if (!NO_ASSERT) process.exitCode = failed ? 4 : 0;
    } finally {
        await browser.close();
    }
})().catch(e => { console.error('❌ perf 脚本异常:', e && e.stack || e); process.exit(9); });
