// background.js - Mix01 自愈下载引擎 (原生多级右键菜单 + 性能稳定保活版)
// 🚀 原生右键菜单：图片 / 视频统一提供「下载」入口
// 菜单在 SW 每次冷启动都可能重建，用 storage.session 版本号做幂等保护
const MIX01_MENU_VERSION = 2;
const MIX01_MEDIA_MENU_ID = 'downloadMediaMix01';

function createMix01ContextMenus() {
    chrome.contextMenus.removeAll(() => {
        // 🚀 新增：创建原生右键专属父级菜单（图片 + 视频）
        chrome.contextMenus.create({
            id: "mix01Parent",
            title: "🌅 Mix01 引擎助手",
            contexts: ["image", "video"]
        });

        // 🚀 新增：视频/图片通用下载入口
        // 视频走沉浸引擎同一条解析链路（GraphQL/Fiber → 最高码率 mp4），图片走高清原图链路
        chrome.contextMenus.create({
            id: MIX01_MEDIA_MENU_ID,
            parentId: "mix01Parent",
            title: "📥 下载视频/图片",
            contexts: ["image", "video"]
        });
        chrome.contextMenus.create({
            id: "mix01MenuSepImage",
            parentId: "mix01Parent",
            type: "separator",
            contexts: ["image"]
        });

        // 🚀 新增：创建 4 个对应沉浸模式功能的子级菜单
        chrome.contextMenus.create({
            id: "saveOriginalImgMix01",
            parentId: "mix01Parent",
            title: "💾 保存高清原图",
            contexts: ["image"]
        });
        chrome.contextMenus.create({
            id: "copyOriginalImgMix01",
            parentId: "mix01Parent",
            title: "📋 复制高清原图",
            contexts: ["image"]
        });
        chrome.contextMenus.create({
            id: "openInTabOriginalImgMix01",
            parentId: "mix01Parent",
            title: "↗️ 在新标签页打开原图",
            contexts: ["image"]
        });
        chrome.contextMenus.create({
            id: "copyUrlOriginalImgMix01",
            parentId: "mix01Parent",
            title: "🔗 复制原图链接",
            contexts: ["image"]
        });
    });
}

async function ensureMix01ContextMenus(force = false) {
    try {
        if (!force && chrome.storage?.session) {
            const cached = await chrome.storage.session.get('mix01_menus_version');
            if (cached?.mix01_menus_version === MIX01_MENU_VERSION) return;
        }
    } catch (e) { /* session storage 不可用时直接重建 */ }

    createMix01ContextMenus();
    try { await chrome.storage.session.set({ mix01_menus_version: MIX01_MENU_VERSION }); } catch (e) {}
}

chrome.runtime.onInstalled.addListener(() => {
    ensureMix01ContextMenus(true);

    if (chrome.declarativeNetRequest) {
        chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [1],
            addRules: [{
                id: 1, priority: 1,
                action: { type: "modifyHeaders", requestHeaders: [{ header: "Referer", operation: "set", value: "https://www.pixiv.net/" }] },
                condition: { urlFilter: "||pximg.net/*", resourceTypes: ["xmlhttprequest", "image", "other"] }
            }]
        });
    }
});

// SW 冷启动自愈：菜单持久化于浏览器，只有版本变化或首次安装才重建
chrome.runtime.onStartup.addListener(() => ensureMix01ContextMenus(true));
ensureMix01ContextMenus();

// 🚀 监听原生右键点击，分发任务给网页前台执行
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab || !tab.id) return;

    if (info.menuItemId === MIX01_MEDIA_MENU_ID) {
        handleContextMediaDownload(info, tab);
        return;
    }

    const actionMap = {
        "saveOriginalImgMix01": "saveHDUrl",
        "copyOriginalImgMix01": "copyHDUrl",
        "copyUrlOriginalImgMix01": "copyHDUrlText" // 复制链接
    };

    if (actionMap[info.menuItemId]) {
        chrome.tabs.sendMessage(tab.id, { 
            action: actionMap[info.menuItemId], 
            clickedUrl: info.srcUrl 
        }).catch(err => console.warn("Mix01 Context Menu dispatch failed:", err));
    } 
    else if (info.menuItemId === "openInTabOriginalImgMix01") {
        // 请求前台解析出原图地址后，由后台静默开启新标签页
        chrome.tabs.sendMessage(tab.id, { 
            action: "getHDUrl", 
            clickedUrl: info.srcUrl 
        }, (response) => {
            if (chrome.runtime.lastError) {
                chrome.tabs.create({ url: info.srcUrl }); // 异常兜底
                return;
            }
            if (response && response.url) {
                chrome.tabs.create({ url: response.url });
            } else {
                chrome.tabs.create({ url: info.srcUrl });
            }
        });
    }
});

// 🌊 base64 转存并发闸门：MV3 Service Worker 内存有限，多个 8MB 缓冲 + dataURL 膨胀
// 同时进行会直接推高 SW 堆占用（甚至触发 OOM 重启）。限制并行缓冲数，
// 排队过长时直接走直链下载兜底，保证下载能完成且内存可控。
const MAX_CONCURRENT_BASE64_DOWNLOADS = 2;
const BASE64_QUEUE_LIMIT = 3;
let _activeBase64Downloads = 0;
const _base64Waiters = [];

function acquireBase64Slot() {
    if (_activeBase64Downloads < MAX_CONCURRENT_BASE64_DOWNLOADS) {
        _activeBase64Downloads++;
        return Promise.resolve(true);
    }
    if (_base64Waiters.length >= BASE64_QUEUE_LIMIT) return Promise.resolve(false);
    return new Promise(resolve => _base64Waiters.push(resolve));
}

function releaseBase64Slot() {
    const next = _base64Waiters.shift();
    if (next) next(true);            // 槽位直接移交，计数保持不变
    else _activeBase64Downloads--;
}

// ⚡ 网络瞬时故障重试：下载探测/转存偶发断流时自动重试一次，避免用户看到无意义的失败。
// 仅对网络类错误与 5xx 重试；4xx（404/403 等确定性失败）不重试，避免无意义轮询。
const MIX01_FETCH_RETRIES = 1;
const MIX01_FETCH_RETRY_DELAY_MS = 600;

async function mix01FetchWithRetry(url, init, { retries = MIX01_FETCH_RETRIES, signal } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        if (signal && signal.aborted) throw lastErr || new Error('aborted');
        try {
            const res = await fetch(url, init);
            if (res.status >= 500 && attempt < retries) {
                await new Promise(r => setTimeout(r, MIX01_FETCH_RETRY_DELAY_MS));
                continue;
            }
            return { res, attempts: attempt + 1 };
        } catch (e) {
            lastErr = e;
            if (attempt >= retries) break;
            await new Promise(r => setTimeout(r, MIX01_FETCH_RETRY_DELAY_MS));
        }
    }
    throw lastErr || new Error('fetch failed');
}

// 从 URL 猜一个安全的下载文件名（blob:/data: 一律回退占位名）
function mix01GuessFilename(url, fallback = 'media') {
    try {
        if (!url || url.startsWith('blob:') || url.startsWith('data:')) return fallback;
        const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
        return name.replace(/[\\/:*?"<>|]/g, '_') || fallback;
    } catch (e) { return fallback; }
}

// 🌟 右键「下载视频/图片」：统一交给前台复用沉浸下载链路
// 视频 srcUrl 常为页面内 blob:，后台无法直接取流，必须由 content script 解析真实直链
function handleContextMediaDownload(info, tab) {
    const mediaType = info.mediaType === 'video' ? 'video' : 'image';
    const srcUrl = info.srcUrl || '';

    const directFallback = () => {
        if (!srcUrl || srcUrl.startsWith('blob:') || srcUrl.startsWith('data:')) {
            saveToHistory(mix01GuessFilename(srcUrl), '❌ 失败 (页面脚本未就绪，请刷新后重试)');
            return;
        }
        const filename = `IMG_Download/${mix01GuessFilename(srcUrl)}`;
        chrome.downloads.download({ url: srcUrl, filename, saveAs: false, conflictAction: 'uniquify' }, () => {
            saveToHistory(filename, chrome.runtime.lastError ? '❌ 失败 (直链兜底)' : '✅ 成功 (直链兜底)');
        });
    };

    chrome.tabs.sendMessage(tab.id, {
        action: 'downloadFromContextMenu',
        mediaType,
        clickedUrl: srcUrl,
        pageUrl: info.pageUrl || tab.url || ''
    }, { frameId: typeof info.frameId === 'number' ? info.frameId : 0 })
        .then(resp => {
            const status = resp && resp.status;
            if (!status || status === 'not-found' || status === 'failed' || status === 'error') directFallback();
        })
        .catch(() => directFallback());
}

// 🚀 原子锁状态机与轻量缓冲池，彻底斩断常驻 Promise 闭包链，规避 SW 积压内存泄漏
let _isHistoryWriting = false;
const _historyBuffer = [];

async function processHistoryFlush() {
    if (_isHistoryWriting || _historyBuffer.length === 0) return;
    _isHistoryWriting = true;

    try {
        const batchItems = _historyBuffer.splice(0, _historyBuffer.length);
        const res = await chrome.storage.local.get(['mix01_download_history']);
        let cache = res.mix01_download_history || [];
        
        cache = [...batchItems, ...cache];
        if (cache.length > 50) cache = cache.slice(0, 50);
        
        await chrome.storage.local.set({ mix01_download_history: cache });
    } catch (err) {
        console.error('Mix01 History Save Error:', err);
    } finally {
        _isHistoryWriting = false;
        if (_historyBuffer.length > 0) processHistoryFlush();
    }
}

function saveToHistory(filename, statusMsg) {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const newItem = { time: timeStr, filename: filename, status: statusMsg };
    
    _historyBuffer.unshift(newItem);
    processHistoryFlush();
}

const TWITTER_GQL_BASE = 'https://x.com/i/api/graphql/2ICDjqPd81tulZcYrtpTuQ/TweetResultByRestId';
const TWITTER_GQL_FEATURES = {
    'articles_preview_enabled': true,
    'c9s_tweet_anatomy_moderator_badge_enabled': true,
    'freedom_of_speech_not_reach_fetch_enabled': true,
    'graphql_is_translatable_rweb_tweet_is_translatable_enabled': true,
    'longform_notetweets_inline_media_enabled': true,
    'responsive_web_twitter_article_tweet_consumption_enabled': true,
    'rweb_tipjar_consumption_enabled': true,
    'standardized_nudges_misinfo': true,
    'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled': true,
    'view_counts_everywhere_api_enabled': true
};
const TWITTER_GQL_FEATURES_QS = encodeURIComponent(JSON.stringify(TWITTER_GQL_FEATURES));

let _compiledBase64Domains = null;
let _lastBase64DomainsStr = null;

function isBase64Domain(url, userDomainsStr) {
    try {
        if (!userDomainsStr) return false;
        if (userDomainsStr !== _lastBase64DomainsStr) {
            _lastBase64DomainsStr = userDomainsStr;
            _compiledBase64Domains = userDomainsStr.split(',')
                .filter(d => d.trim())
                .map(d => new RegExp(`^${d.trim().replace(/\*/g, '.*')}$`, 'i'));
        }
        const host = new URL(url.startsWith('//') ? 'https:' + url : url).hostname;
        return _compiledBase64Domains.some(re => re.test(host));
    } catch (e) { return false; }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchTwitterGraphQL") {
        (async () => {
            try {
                const cookies = await chrome.cookies.getAll({ domain: ".twitter.com" });
                const xCookies = await chrome.cookies.getAll({ domain: ".x.com" });
                const allCookies = [...cookies, ...xCookies];
                const ct0 = allCookies.find(c => c.name === 'ct0')?.value;
                const lang = allCookies.find(c => c.name === 'lang')?.value || 'en';
                const gt = allCookies.find(c => c.name === 'gt')?.value;

                if (!ct0) throw new Error("No ct0 cookie found");

                const variables = {
                    'tweetId': request.statusId,
                    'with_rux_injections': false,
                    'includePromotedContent': true,
                    'withCommunity': true,
                    'withQuickPromoteEligibilityTweetFields': true,
                    'withBirdwatchNotes': true,
                    'withVoice': true,
                    'withV2Timeline': true
                };
                const url = `${TWITTER_GQL_BASE}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${TWITTER_GQL_FEATURES_QS}`;
                const headers = {
                    'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
                    'x-twitter-active-user': 'yes',
                    'x-twitter-client-language': lang,
                    'x-csrf-token': ct0
                };
                if (ct0.length === 32 && gt) headers['x-guest-token'] = gt;

                const response = await fetch(url, { headers });
                const json = await response.json();
                sendResponse({ success: true, data: json });
            } catch (e) {
                sendResponse({ success: false, error: e.message });
            }
        })();
        return true;
    }

    if (request.action === "fetchImageAsBase64" || request.action === "fetchImageAsBlob") {
        // fetchImageAsBlob reuses dataURL transport (MV3 content scripts cannot receive Blob directly)
        // but skips double-fetch on content side when possible by returning dataUrl once.
        fetch(request.url, { headers: { 'Referer': request.pageUrl || '' } })
            .then(res => {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.blob();
            })
            .then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({
                    success: true,
                    base64: reader.result,
                    dataUrl: reader.result,
                    contentType: blob.type || 'image/png',
                    size: blob.size || 0
                });
                reader.onerror = () => sendResponse({ success: false });
                reader.readAsDataURL(blob);
            }).catch(e => sendResponse({ success: false, error: String(e && e.message || e) }));
        return true;
    }

    if (request.action === "downloadImmersiveImg") {
        handleImmersiveDownload(request, sendResponse);
        return true; 
    }
});

// 🌟 沉浸式后台下载模块
async function handleImmersiveDownload(request, sendResponse) {
    let initialUrl = request.url;
    if (initialUrl.startsWith('//')) initialUrl = 'https:' + initialUrl;

    try {
        const config = await chrome.storage.local.get(['base64Domains']);
        const useBase64 = isBase64Domain(initialUrl, config.base64Domains);

        let res;
        let probeAttempts = 0;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); 
        try {
            const probe = await mix01FetchWithRetry(initialUrl, {
                method: 'GET', mode: 'cors', credentials: 'include', signal: controller.signal,
                headers: {
                    'Referer': request.pageUrl || new URL(initialUrl).origin,
                    'User-Agent': navigator.userAgent,
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                    'Cache-Control': 'no-cache',
                    // 非 base64 分支只需要响应头（类型/文件名/404 探测）：
                    // Range 只取首字节，避免为了读 header 白下载整份 payload。
                    ...(useBase64 ? {} : { 'Range': 'bytes=0-0' })
                }
            }, { signal: controller.signal });
            res = probe.res;
            probeAttempts = probe.attempts;
            clearTimeout(timeoutId);
        } catch (fetchError) {
            clearTimeout(timeoutId);
            chrome.downloads.download({ url: initialUrl, filename: `IMG_Download/${initialUrl.split('/').pop() || 'media'}`, saveAs: false }, () => {
                saveToHistory(initialUrl.split('/').pop() || "media", chrome.runtime.lastError ? "❌ 失败 (直接下载)" : "✅ 成功 (直接下载)");
            });
            return;
        }
        
        let finalUrl = initialUrl;

        if (res && res.status === 404 && initialUrl.includes('pximg.net')) {
            const altUrls = [];
            if (initialUrl.includes('_ugoira0')) {
                const base = initialUrl.replace('_ugoira0', '_p0');
                altUrls.push(base, base.replace(/\.\w+$/, '.png'), base.replace(/\.\w+$/, '.jpg'));
            } else if (initialUrl.includes('_p0')) {
                const targetExt = initialUrl.endsWith('.png') ? '.jpg' : '.png';
                altUrls.push(initialUrl.replace(/\.\w+$/, targetExt), initialUrl.replace('_p0', '_p1'), initialUrl.replace('_p0', '_p2'));
            } else {
                const base = initialUrl.replace(/\.\w+$/, '');
                altUrls.push(`${base}_p0.jpg`, `${base}_p0.png`, `${base}.jpg`, `${base}.png`);
            }

            if (altUrls.length > 0) {
                try {
                    const fetchPromises = altUrls.map(alt =>
                        fetch(alt, { method: 'HEAD', headers: { 'Referer': request.pageUrl || 'https://www.pixiv.net/' } }).then(testRes => {
                            if (testRes.ok) return alt;
                            throw new Error('Not ok');
                        })
                    );
                    finalUrl = await Promise.any(fetchPromises);
                    res = (await mix01FetchWithRetry(finalUrl, {
                        headers: { 'Referer': request.pageUrl || 'https://www.pixiv.net/', ...(useBase64 ? {} : { 'Range': 'bytes=0-0' }) }
                    })).res;
                } catch(e) {}
            }
        }

        if (!res || !res.ok) {
            chrome.downloads.download({ url: finalUrl, filename: `IMG_Download/${finalUrl.split('/').pop() || 'media'}`, saveAs: false, conflictAction: 'uniquify' }, () => {
                saveToHistory(finalUrl.split('/').pop() || "media", chrome.runtime.lastError ? "❌ 失败 (直接下载回退)" : "✅ 成功 (直接下载回退)");
            });
            return;
        }

        const urlObj = new URL(finalUrl);
        
        let lastSegment = decodeURIComponent(urlObj.pathname.split('/').pop() || '');
        lastSegment = lastSegment.split(':')[0]; 
        lastSegment = lastSegment.split('@')[0]; 
        lastSegment = lastSegment.split('&')[0]; 
        lastSegment = lastSegment.split('?')[0]; 

        let filename = "media", ext = "";
        
        const _mimeToExt = { 'jpeg': 'jpg', 'jpg': 'jpg', 'png': 'png', 'gif': 'gif', 'webp': 'webp', 'svg+xml': 'svg', 'bmp': 'bmp', 'mp4': 'mp4', 'webm': 'webm', 'avif': 'avif', 'quicktime': 'mov', 'x-matroska': 'mkv' };
        const _rawCt = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
        const _rawSubtype = _rawCt.split('/')[1] || 'jpeg';
        const _resolvedExt = '.' + (_mimeToExt[_rawSubtype] || _rawSubtype.split('+')[0] || 'jpg');

        const paramExt = urlObj.searchParams.get('format') || urlObj.searchParams.get('ext');
        
        let dotIndex = lastSegment.lastIndexOf('.');
        if (dotIndex !== -1) {
            filename = lastSegment.substring(0, dotIndex);
            ext = lastSegment.substring(dotIndex).toLowerCase();
        } else {
            filename = lastSegment || "media";
        }

        if (paramExt) ext = "." + paramExt.toLowerCase();

        if (!/^\.(jpg|jpeg|png|gif|webp|svg|bmp|mp4|webm|avif|mov|mkv)$/i.test(ext)) {
            ext = _resolvedExt;
        }
        if (!filename || filename === "") filename = "media";

        let cd = res.headers.get('content-disposition');
        if (cd) {
            let match = cd.match(/filename="?([^"]+)"?/);
            if (match) {
                let cdName = match[1];
                let cdDot = cdName.lastIndexOf('.');
                if (cdDot !== -1) {
                    filename = cdName.substring(0, cdDot);
                    ext = cdName.substring(cdDot).toLowerCase();
                } else {
                    filename = cdName;
                }
            }
        }

        filename = filename.replace(/[\\/:*?"<>|]/g, "_");
        const finalDownloadName = `IMG_Download/${filename}${ext}`;
        const contentType = _rawCt; 
        // 重试事实在所有路径都要可观测（历史记录是用户唯一能看到下载过程的诊断面）
        const retryTag = probeAttempts > 1 ? ' 重试后' : '';
        
        if (useBase64) {
            // base64Domains exist for hotlink-protected hosts: prefer in-SW fetch -> dataURL.
            // Direct remote download is only a fallback when payload is too large / stream fails.
            const contentLength = res.headers.get('content-length');
            const sizeLimit = 8 * 1024 * 1024;
            const knownTooLarge = contentLength && parseInt(contentLength, 10) > sizeLimit;

            const downloadDirect = (reason) => new Promise((resolve) => {
                chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, (downloadId) => {
                    const ok = !chrome.runtime.lastError && downloadId !== undefined;
                    saveToHistory(finalDownloadName, ok ? `✅ 成功 (${reason}${retryTag})` : `❌ 失败 (${reason})`);
                    resolve(ok);
                });
            });

            if (knownTooLarge) {
                // Avoid buffering huge payloads in SW memory
                if (res.body && res.body.cancel) {
                    try { res.body.cancel(); } catch (e) {}
                }
                await downloadDirect('大文件直下');
            } else if (!(await acquireBase64Slot())) {
                // 并发排队过长：不把更多大 buffer 带进 SW 内存
                if (res.body && res.body.cancel) {
                    try { res.body.cancel(); } catch (e) {}
                }
                await downloadDirect('并发限流直下');
            } else {
                try {
                    const reader = res.body.getReader();
                    let receivedLength = 0;
                    let chunks = [];
                    let aborted = false;
                    let chunkCount = 0;

                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        receivedLength += value.length;
                        if (receivedLength > sizeLimit) {
                            reader.cancel('File too large');
                            aborted = true;
                            break;
                        }
                        chunks.push(value);
                        chunkCount++;
                        // Keep SW alive on long streams without hammering storage every few KB.
                        if (chunkCount % 250 === 0) {
                            await chrome.storage.local.get('_sw_keep_alive_').catch(() => {});
                        }
                    }

                    if (aborted) {
                        await downloadDirect('流超载回退');
                    } else {
                        const blob = new Blob(chunks, { type: contentType });
                        chunks = null;
                        const dataUrl = await new Promise((resolve, reject) => {
                            const fileReader = new FileReader();
                            fileReader.onloadend = () => resolve(fileReader.result);
                            fileReader.onerror = () => reject(fileReader.error || new Error('FileReader failed'));
                            fileReader.readAsDataURL(blob);
                        }).catch(() => null);

                        if (!dataUrl) {
                            await downloadDirect('Base64转换异常回退');
                        } else {
                            await new Promise((resolve) => {
                                chrome.downloads.download({ url: dataUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, (downloadId) => {
                                    if (downloadId === undefined || chrome.runtime.lastError) {
                                        chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                                            saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败" : `✅ 成功 (直链回退${retryTag})`);
                                            resolve();
                                        });
                                    } else {
                                        saveToHistory(finalDownloadName, `✅ 成功 (Base64${retryTag})`);
                                        resolve();
                                    }
                                });
                            });
                        }
                    }
                } finally {
                    releaseBase64Slot();
                }
            }
        } else {
            // Non-base64: body already fetched only to inspect headers/type; cancel before direct download
            if (res.body && res.body.cancel) {
                try { res.body.cancel(); } catch (e) {}
            }
            chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败" : `✅ 成功${retryTag}`);
            });
        }
    } catch (err) {
        saveToHistory(initialUrl.split('/').pop() || "media", "❌ 拦截: " + err.message);
    } finally {
        sendResponse({ success: true });
    }
}