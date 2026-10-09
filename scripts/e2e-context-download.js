// scripts/e2e-context-download.js
// X.com 原生右键菜单「📥 下载视频/图片」端到端验证
//
// 与其它 e2e 脚本不同，这个脚本不依赖用户手动启动的 Chrome：
//   * 用 playwright 启动本机 Chrome（可用 MIX01_CHROME_PATH 覆盖）
//   * 用 route 拦截把 https://x.com/... 伪造成同源 X 页面（location.hostname === 'x.com'）
//   * 注入真实源码：rules-engine / immersive-rules / Basic/* / background.js
//   * 只用一份内存版 chrome.* Mock 连接 content 侧与 background 侧
//
// 覆盖链路（真实源码，非手写模拟）：
//   chrome.contextMenus.onClicked
//     → chrome.tabs.sendMessage
//       → MediaRenderer.setupMessageListener
//         → 站点适配器 downloadVideo → Mix01RuleEngine.getHighResUrl (GraphQL 最高码率)
//           → Mix01Utils.sendMessage('downloadImmersiveImg')
//             → background.handleImmersiveDownload → chrome.downloads.download
//
// 产物：test-artifacts/e2e-context-download-report.json
// 运行：node scripts/e2e-context-download.js
const fs = require('fs')
const path = require('path');
const {
    ROOT, describeBrowser, launchHarnessBrowser, createHarnessPage, injectMix01Source, bootMix01Engine
} = require('./lib/mix01-harness');

const REPORT_PATH = path.join(ROOT, 'test-artifacts', 'e2e-context-download-report.json');
const PAGE_URL = 'https://x.com/harness/status/999111222';

const RESULTS = [];
function log(name, pass, extra = '') {
    RESULTS.push({ name, pass, extra });
    console.log(`${pass ? 'PASS ✅' : 'FAIL ❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

const PAGE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Mix01 harness tweet</title></head>
<body>
  <article id="tweet">
    <a href="/harness/status/999111222">status link</a>
    <video id="vid" poster="https://pbs.twimg.com/tweet_video_thumb/THUMB.jpg" muted playsinline></video>
    <img id="pic" src="https://pbs.twimg.com/media/ABC123?format=jpg&amp;name=small" alt="">
  </article>
</body></html>`;

// 与线上结构一致的 GraphQL 返回：含低码率 mp4、m3u8 与最高码率 mp4
const TWEET_JSON = {
    data: {
        tweetResult: {
            result: {
                legacy: {
                    extended_entities: {
                        media: [{
                            type: 'video',
                            video_info: {
                                variants: [
                                    { content_type: 'video/mp4', bitrate: 832000, url: 'https://video.twimg.com/low.mp4' },
                                    { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/playlist.m3u8' },
                                    { content_type: 'video/mp4', bitrate: 2176000, url: 'https://video.twimg.com/high.mp4' }
                                ]
                            }
                        }]
                    }
                }
            }
        }
    }
};

async function waitFor(fn, timeout = 6000, interval = 100) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
        const v = await fn();
        if (v) return v;
        await new Promise(r => setTimeout(r, interval));
    }
    return null;
}

(async () => {
    const { browser, exe } = await launchHarnessBrowser();
    console.log(`🌐 浏览器: ${describeBrowser(exe)} (headless)`);

    try {
        const page = await createHarnessPage(browser, { html: PAGE_HTML, url: PAGE_URL });

        // 伪造 X 视频元素（真实 blob: 源，与线上一致）+ 记录真实 URL
        await page.evaluate(() => {
            const blobUrl = URL.createObjectURL(new Blob(['harness-video'], { type: 'video/mp4' }));
            const video = document.getElementById('vid');
            video.src = blobUrl;
            window.__harnessTargets = {
                blobUrl,
                videoSrc: video.src,
                imgSrc: document.getElementById('pic').src
            };
        });

        // ---------- 2) 注入真实源码 ----------
        await injectMix01Source(page, { withBackground: true });
        await bootMix01Engine(page);
        await waitFor(() => page.evaluate(() => window.__harness.createdMenus.length > 0), 4000);

        // 拦截 GraphQL / 媒体直链：只允许内存响应，禁止联网
        await page.evaluate((tweetJson) => {
            const origFetch = window.fetch.bind(window);
            window.__origFetch = origFetch;
            window.__harness.probeLog = [];
            window.fetch = async (input, init) => {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                if (url.includes('/i/api/graphql/')) {
                    return new Response(JSON.stringify(tweetJson), {
                        status: 200,
                        headers: { 'content-type': 'application/json' }
                    });
                }
                if (url.startsWith('https://video.twimg.com/') || url.startsWith('https://pbs.twimg.com/media/')) {
                    const h = (init && init.headers) || {};
                    window.__harness.probeLog.push({ url: url.slice(0, 64), range: h.Range || h.range || null });
                }
                if (url.startsWith('https://video.twimg.com/')) {
                    return new Response('FAKEMP4', { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': '7' } });
                }
                if (url.startsWith('https://pbs.twimg.com/media/')) {
                    return new Response('FAKEJPG', { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '7' } });
                }
                return origFetch(input, init);
            };
        }, TWEET_JSON);

        const targets = await page.evaluate(() => window.__harnessTargets);

        // ---------- 3) 菜单树断言 ----------
        let menus = await page.evaluate(() => window.__harness.createdMenus.map(m => ({
            id: m.id, parentId: m.parentId || null, contexts: m.contexts || null, title: m.title || null, type: m.type || null
        })));

        const parent = menus.find(m => m.id === 'mix01Parent');
        log('菜单: 父级同时覆盖 image + video',
            !!parent && (parent.contexts || []).includes('image') && (parent.contexts || []).includes('video'),
            JSON.stringify(parent && parent.contexts));

        const downloadItem = menus.find(m => m.id === 'downloadMediaMix01');
        log('菜单: 新增「下载」项挂在父级并覆盖 image + video',
            !!downloadItem && downloadItem.parentId === 'mix01Parent' &&
            (downloadItem.contexts || []).includes('video') && (downloadItem.contexts || []).includes('image') &&
            /下载/.test(downloadItem.title || ''),
            JSON.stringify(downloadItem));

        const legacyIds = ['saveOriginalImgMix01', 'copyOriginalImgMix01', 'openInTabOriginalImgMix01', 'copyUrlOriginalImgMix01'];
        log('菜单: 原有 4 个图片项保留（无回归）',
            legacyIds.every(id => menus.some(m => m.id === id && (m.contexts || []).includes('image'))),
            menus.map(m => m.id).join(','));

        // ---------- 4) 视频右键 → 最高码率 mp4 ----------
        await page.evaluate((videoSrc) => {
            const info = {
                menuItemId: 'downloadMediaMix01', mediaType: 'video',
                srcUrl: videoSrc, pageUrl: location.href, frameId: 0
            };
            window.__harness.menuClickListeners.forEach(fn => fn(info, { id: 77, url: location.href }));
        }, targets.videoSrc);

        const videoDownload = await waitFor(async () => {
            const list = await page.evaluate(() => window.__harness.downloaded.slice());
            return list.find(d => /\.mp4(\?|$)/.test(d.url || '')) || null;
        }, 8000);

        log('视频右键: 解析出最高码率 mp4（跳过 m3u8/低码率）',
            !!videoDownload && videoDownload.url === 'https://video.twimg.com/high.mp4',
            videoDownload && videoDownload.url);
        log('视频右键: 后台转存文件名正确',
            !!videoDownload && videoDownload.filename === 'IMG_Download/high.mp4',
            videoDownload && videoDownload.filename);

        // ---------- 5) 图片右键 → name=orig ----------
        await page.evaluate((imgSrc) => {
            const info = {
                menuItemId: 'downloadMediaMix01', mediaType: 'image',
                srcUrl: imgSrc, pageUrl: location.href, frameId: 0
            };
            window.__harness.menuClickListeners.forEach(fn => fn(info, { id: 77, url: location.href }));
        }, targets.imgSrc);

        const imgDownload = await waitFor(async () => {
            const list = await page.evaluate(() => window.__harness.downloaded.slice());
            return list.find(d => (d.url || '').includes('pbs.twimg.com/media/')) || null;
        }, 8000);

        log('图片右键: 升级到高清 name=orig',
            !!imgDownload && imgDownload.url.includes('name=orig') && !imgDownload.url.includes('name=small'),
            imgDownload && imgDownload.url);
        log('图片右键: 后台转存文件名正确',
            !!imgDownload && imgDownload.filename === 'IMG_Download/ABC123.jpg',
            imgDownload && imgDownload.filename);

        // ---------- 6) 视频 blob 假直链 + 内容脚本缺失 → 只记录失败，不产生错误下载 ----------
        const beforeFail = await page.evaluate(() => window.__harness.downloaded.length);
        await page.evaluate((videoSrc) => {
            window.__harness.failNextTabMessage = true;
            const info = {
                menuItemId: 'downloadMediaMix01', mediaType: 'video',
                srcUrl: videoSrc, pageUrl: location.href, frameId: 0
            };
            window.__harness.menuClickListeners.forEach(fn => fn(info, { id: 77, url: location.href }));
        }, targets.videoSrc);

        const failHistory = await waitFor(async () => {
            const h = await page.evaluate(() => window.__harness.storageLocal.mix01_download_history || []);
            return h.find(x => /页面脚本未就绪/.test(x.status || '')) || null;
        }, 4000);
        const afterFail = await page.evaluate(() => window.__harness.downloaded.length);
        log('视频 blob 兜底: 不产生注定失败的下载，且写入失败记录',
            !!failHistory && afterFail === beforeFail,
            `downloads ${beforeFail}→${afterFail}; history=${failHistory && failHistory.status}`);

        // ---------- 7) 内容脚本缺失 + 普通图片 URL → 后台直链兜底 ----------
        const beforeDirect = await page.evaluate(() => window.__harness.downloaded.length);
        await page.evaluate((imgSrc) => {
            window.__harness.failNextTabMessage = true;
            const info = {
                menuItemId: 'downloadMediaMix01', mediaType: 'image',
                srcUrl: imgSrc, pageUrl: location.href, frameId: 0
            };
            window.__harness.menuClickListeners.forEach(fn => fn(info, { id: 77, url: location.href }));
        }, targets.imgSrc);

        const directFallback = await waitFor(async () => {
            const list = await page.evaluate(() => window.__harness.downloaded.slice());
            return list.length > beforeDirect ? list[list.length - 1] : null;
        }, 4000);
        log('图片直链兜底: 内容脚本不可用时后台仍能下载',
            !!directFallback && directFallback.url === targets.imgSrc,
            directFallback && directFallback.url);

        // ---------- 8) 沉浸查看器右键菜单：标签 + 保存动作 ----------
        const labelState = await page.evaluate(() => {
            const render = window.__mix01Engine.render;
            render.showContextMenu(10, 10, {}, { isVideo: true });
            const videoLabel = document.querySelector('#mix01-ctx-menu [data-action="save"]').textContent.trim();
            render.showContextMenu(10, 10, {}, {});
            const imgLabel = document.querySelector('#mix01-ctx-menu [data-action="save"]').textContent.trim();
            render.hideContextMenu();
            return { videoLabel, imgLabel };
        });
        log('查看器菜单: 视频显示「保存视频」/ 图片显示「保存图片」',
            labelState.videoLabel === '💾 保存视频' && labelState.imgLabel === '💾 保存图片',
            JSON.stringify(labelState));

        const beforeViewer = await page.evaluate(() => window.__harness.downloaded.length);
        await page.evaluate(() => {
            const { config, render, controller } = window.__mix01Engine;
            const video = document.getElementById('vid');
            config.state.hasAgreed = true;
            controller.state.isViewerVisible = true;
            controller.state.currentMedia = video;
            controller.state.currentSrc = video.src;
            controller.state.currentHdUrl = null;
            // 触发真实 contextmenu 监听器（InputController.bindEvents），再点击「保存视频」
            render.elements.viewer.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
            document.querySelector('#mix01-ctx-menu [data-action="save"]').click();
        });
        const viewerDownload = await waitFor(async () => {
            const list = await page.evaluate(() => window.__harness.downloaded.slice());
            return list.length > beforeViewer ? list[list.length - 1] : null;
        }, 8000);
        log('查看器菜单: 视频「保存」复用同一下载链路',
            !!viewerDownload && viewerDownload.url === 'https://video.twimg.com/high.mp4',
            viewerDownload && viewerDownload.url);

        // ---------- 10) 非 base64 下载探测：只取首字节（Range） ----------
        const probeInfo = await page.evaluate(() => (window.__harness.probeLog || []));
        const imgProbe = probeInfo.find(p => p.url.includes('pbs.twimg.com/media'));
        log('下载探测: 非 base64 域仅取首字节（Range: bytes=0-0）',
            !!imgProbe && imgProbe.range === 'bytes=0-0', JSON.stringify(imgProbe));

        // ---------- 11) base64 域下载并发限流（SW 内存保护） ----------
        // 模拟 7 个并发下载：2 个占用缓冲槽，3 个排队，超出的走直链兜底；
        // 断言全部下载仍然完成，且确实触发了限流分支。
        await page.evaluate(() => {
            window.__harness.storageLocal.base64Domains = 'video.twimg.com';
            window.__harness.mediaFetchCount = 0;
            window.__harness.probeLog = []; // 只观察本轮 base64 探测
            const baseFetch = window.fetch;
            window.fetch = async (input, init) => {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                if (url.startsWith('https://video.twimg.com/')) {
                    window.__harness.mediaFetchCount++;
                    await new Promise(r => setTimeout(r, 300)); // 拉长窗口，制造真实并发
                }
                return baseFetch(input, init);
            };
        });

        const beforeBase64 = await page.evaluate(() => window.__harness.downloaded.length);
        await page.evaluate((videoSrc) => {
            for (let i = 0; i < 7; i++) {
                const info = {
                    menuItemId: 'downloadMediaMix01', mediaType: 'video',
                    srcUrl: videoSrc, pageUrl: location.href, frameId: 0
                };
                window.__harness.menuClickListeners.forEach(fn => fn(info, { id: 77, url: location.href }));
            }
        }, targets.videoSrc);

        const base64Done = await waitFor(async () => {
            const n = await page.evaluate(() => window.__harness.downloaded.length);
            return n >= beforeBase64 + 7 ? n : null;
        }, 12000);
        const base64State = await page.evaluate(() => ({
            mediaFetchCount: window.__harness.mediaFetchCount,
            history: (window.__harness.storageLocal.mix01_download_history || []).slice(0, 12),
            lastDownloads: window.__harness.downloaded.slice(-7).map(d => ({ url: (d.url || '').slice(0, 24), filename: d.filename }))
        }));
        const throttled = base64State.history.some(h => /并发限流直下/.test(h.status || ''));
        log('base64 并发: 7 个并发下载全部完成且触发限流兜底',
            !!(base64Done && base64State.mediaFetchCount >= 7 && throttled),
            `downloads=${base64State.lastDownloads.length}, mediaFetches=${base64State.mediaFetchCount}, throttled=${throttled}`);

        const base64Probes = await page.evaluate(() => (window.__harness.probeLog || []).filter(p => p.url.includes('video.twimg.com')));
        log('下载探测: base64 域不使用 Range（需要完整 payload 转存）',
            base64Probes.length >= 7 && base64Probes.every(p => !p.range),
            `probes=${base64Probes.length}, withRange=${base64Probes.filter(p => p.range).length}`);

        // ---------- 11) 自愈：destroy 后旧渲染器不得再响应消息（防重复下载） ----------
        const destroyResult = await page.evaluate(async () => {
            const before = window.__harness.downloaded.length;
            const listenersBefore = window.__harness.onMessageListeners.length;
            window.__mix01Engine.render.destroy();
            window.__mix01Engine.controller.destroy();
            const resp = await new Promise((resolve) => {
                let done = false;
                window.__deliverRuntimeMessage(
                    { action: 'downloadFromContextMenu', mediaType: 'video', clickedUrl: 'blob:https://x.com/stale' },
                    { id: 'background' },
                    (v) => { done = true; resolve(v); }
                );
                setTimeout(() => { if (!done) resolve('no-response'); }, 400);
            });
            await new Promise(r => setTimeout(r, 200));
            return {
                listenersBefore,
                listenersAfter: window.__harness.onMessageListeners.length,
                downloadsBefore: before,
                downloadsAfter: window.__harness.downloaded.length,
                resp: typeof resp === 'string' ? resp : (resp === undefined ? 'undefined' : JSON.stringify(resp))
            };
        });
        log('自愈: destroy 后旧渲染器不再响应消息（防重复下载）',
            destroyResult.listenersAfter < destroyResult.listenersBefore &&
            destroyResult.downloadsAfter === destroyResult.downloadsBefore && destroyResult.resp === 'no-response',
            JSON.stringify(destroyResult));

        // ---------- 12) 网络瞬时故障重试：首次 fetch 失败仍能完成下载 ----------
        const retryResult = await page.evaluate(async () => {
            let firstAttempt = true;
            const origFetch = window.fetch;
            window.fetch = async (input, init) => {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                if (url.startsWith('https://video.twimg.com/') && firstAttempt) {
                    firstAttempt = false;
                    throw new TypeError('Failed to fetch'); // 模拟瞬时断流
                }
                return origFetch(input, init);
            };
            const before = window.__harness.downloaded.length;
            const historyBefore = (window.__harness.storageLocal.mix01_download_history || []).length;
            // 直接调用后台下载链路（绕过已 destroy 的渲染器）
            await new Promise((resolve) => {
                let settled = false;
                window.__deliverRuntimeMessage(
                    { action: 'downloadImmersiveImg', url: 'https://video.twimg.com/high.mp4', pageUrl: location.href },
                    { id: 'content' },
                    (v) => { if (!settled) { settled = true; resolve(v); } }
                );
                setTimeout(() => { if (!settled) { settled = true; resolve('timeout'); } }, 6000);
            });
            window.fetch = origFetch;
            return {
                attempted: !firstAttempt,
                downloadsAdded: window.__harness.downloaded.length - before,
                lastUrl: (window.__harness.downloaded.slice(-1)[0] || {}).url || '',
                newHistory: (window.__harness.storageLocal.mix01_download_history || []).slice(0, historyBefore + 2)
            };
        });
        const retryTagged = retryResult.newHistory.some(h => /重试后/.test(h.status || ''));
        // base64 域走的是 dataURL 下载，因此不断言 lastUrl；只断言「重试后仍成功」
        log('网络重试: 首次 fetch 断流后自动重试并完成下载',
            retryResult.attempted && retryResult.downloadsAdded === 1 && retryTagged,
            JSON.stringify({ attempted: retryResult.attempted, added: retryResult.downloadsAdded, retryTagged, history: retryResult.newHistory[0] }));

        // ---------- 13) 确定性失败不重试：404 不应触发重试延时 ----------
        const noRetryResult = await page.evaluate(async () => {
            let attempts = 0;
            const origFetch = window.fetch;
            window.fetch = async (input, init) => {
                const url = typeof input === 'string' ? input : (input && input.url) || '';
                if (url.startsWith('https://pbs.twimg.com/missing')) {
                    attempts++;
                    return new Response('', { status: 404 });
                }
                return origFetch(input, init);
            };
            const t0 = performance.now();
            await new Promise((resolve) => {
                let settled = false;
                window.__deliverRuntimeMessage(
                    { action: 'downloadImmersiveImg', url: 'https://pbs.twimg.com/missing/IMG404?format=jpg', pageUrl: location.href },
                    { id: 'content' },
                    (v) => { if (!settled) { settled = true; resolve(v); } }
                );
                setTimeout(() => { if (!settled) { settled = true; resolve('timeout'); } }, 6000);
            });
            const elapsed = performance.now() - t0;
            window.fetch = origFetch;
            return { attempts, elapsedMs: elapsed };
        });
        log('确定性失败: 404 只请求一次（不引入重试延时）',
            noRetryResult.attempts <= 1 && noRetryResult.elapsedMs < 600,
            JSON.stringify(noRetryResult));

        // ---------- 14) 产出工件 ----------
        const snapshot = await page.evaluate(() => ({
            createdMenus: window.__harness.createdMenus,
            downloaded: window.__harness.downloaded,
            history: window.__harness.storageLocal.mix01_download_history || [],
            tabMessageLog: window.__harness.tabMessageLog,
            errors: window.__harness.errors
        }));

        const failed = RESULTS.filter(r => !r.pass);
        const report = {
            test: 'e2e-context-download',
            generatedAt: new Date().toISOString(),
            pageUrl: PAGE_URL,
            browser: exe || 'channel:chrome',
            pass: failed.length === 0,
            results: RESULTS,
            downloads: snapshot.downloaded,
            createdMenus: snapshot.createdMenus,
            contextMenuPayloads: snapshot.tabMessageLog.map(x => ({ tabId: x.tabId, frameId: x.opts && x.opts.frameId, action: x.msg && x.msg.action, mediaType: x.msg && x.msg.mediaType })),
            history: snapshot.history,
            pageErrors: snapshot.errors
        };
        fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
        fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

        console.log(`\n===== X 右键下载 E2E: ${RESULTS.length - failed.length}/${RESULTS.length} PASS =====`);
        console.log(`🧾 工件: ${path.relative(ROOT, REPORT_PATH)}`);
        process.exitCode = failed.length ? 4 : 0;
    } finally {
        await browser.close();
    }
})().catch(e => {
    console.error('❌ E2E 脚本异常:', e && e.stack || e);
    process.exit(9);
});
