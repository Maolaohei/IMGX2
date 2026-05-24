// background.js - Mix01 终极自愈下载引擎 (终极性能保活版)
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: "saveOriginalImgMix01", title: "保存原图 (Mix01)", contexts: ["image"] });
    });
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

// 🚀 优化：原子锁状态机与轻量缓冲池，彻底斩断常驻 Promise 闭包链，规避 SW 积压内存泄漏
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

                const baseUrl = `https://x.com/i/api/graphql/2ICDjqPd81tulZcYrtpTuQ/TweetResultByRestId`;
                const variables = { 'tweetId': request.statusId, 'with_rux_injections': false, 'includePromotedContent': true, 'withCommunity': true, 'withQuickPromoteEligibilityTweetFields': true, 'withBirdwatchNotes': true, 'withVoice': true, 'withV2Timeline': true };
                const features = { 'articles_preview_enabled': true, 'c9s_tweet_anatomy_moderator_badge_enabled': true, 'freedom_of_speech_not_reach_fetch_enabled': true, 'graphql_is_translatable_rweb_tweet_is_translatable_enabled': true, 'longform_notetweets_inline_media_enabled': true, 'responsive_web_twitter_article_tweet_consumption_enabled': true, 'rweb_tipjar_consumption_enabled': true, 'standardized_nudges_misinfo': true, 'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled': true, 'view_counts_everywhere_api_enabled': true };
                
                const url = encodeURI(`${baseUrl}?variables=${JSON.stringify(variables)}&features=${JSON.stringify(features)}`);
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

    if (request.action === "fetchImageAsBase64") {
        fetch(request.url, { headers: { 'Referer': request.pageUrl } })
            .then(res => res.blob())
            .then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => sendResponse({ success: true, base64: reader.result });
                reader.readAsDataURL(blob);
            }).catch(e => sendResponse({ success: false }));
        return true;
    }

    if (request.action === "downloadImmersiveImg") {
        handleImmersiveDownload(request, sendResponse);
        return true; 
    }
});

// 🚀 核心改进 5：将大图拦截下载逻辑独立抽离。引入 MV3 流式分块自唤醒保活机制，彻底防挂死 [3]
async function handleImmersiveDownload(request, sendResponse) {
    let initialUrl = request.url;
    if (initialUrl.startsWith('//')) initialUrl = 'https:' + initialUrl;

    try {
        const config = await chrome.storage.local.get(['base64Domains']);
        const useBase64 = isBase64Domain(initialUrl, config.base64Domains);

        let res;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); 
        try {
            res = await fetch(initialUrl, {
                method: 'GET', mode: 'cors', credentials: 'include', signal: controller.signal,
                headers: {
                    'Referer': request.pageUrl || new URL(initialUrl).origin,
                    'User-Agent': navigator.userAgent,
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                    'Cache-Control': 'no-cache'
                }
            });
            clearTimeout(timeoutId);
        } catch (fetchError) {
            clearTimeout(timeoutId);
            try {
                const noCorsController = new AbortController();
                const noCorsTimeoutId = setTimeout(() => noCorsController.abort(), 30000);
                res = await fetch(initialUrl, { method: 'GET', mode: 'no-cors', credentials: 'include', signal: noCorsController.signal });
                clearTimeout(noCorsTimeoutId);
            } catch (noCorsError) {
                chrome.downloads.download({ url: initialUrl, filename: `IMG_Download/${initialUrl.split('/').pop() || 'media'}`, saveAs: false }, () => {
                    saveToHistory(initialUrl.split('/').pop() || "media", chrome.runtime.lastError ? "❌ 失败 (直接下载)" : "✅ 成功 (直接下载)");
                });
                return;
            }
        }
        
        let finalUrl = initialUrl;
        const isOpaque = res && res.type === 'opaque';

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
                    res = await fetch(finalUrl, { headers: { 'Referer': request.pageUrl || 'https://www.pixiv.net/' } });
                } catch(e) {}
            }
        }

        if (!res || isOpaque || !res.ok) {
            chrome.downloads.download({ url: finalUrl, filename: `IMG_Download/${finalUrl.split('/').pop() || 'media'}`, saveAs: false, conflictAction: 'uniquify' }, () => {
                saveToHistory(finalUrl.split('/').pop() || "media", chrome.runtime.lastError ? "❌ 失败 (直接下载回退)" : "✅ 成功 (直接下载回退)");
            });
            return;
        }

        const urlObj = new URL(finalUrl);
        
        // 🚀 强力清洗 CDN 脏参数和小尾巴（剥离 :orig, :large, @2x 等参数）
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
                    ext = cdDot !== -1 ? cdName.substring(cdDot).toLowerCase() : ext;
                } else {
                    filename = cdName;
                }
            }
        }

        filename = filename.replace(/[\\/:*?"<>|]/g, "_");
        const finalDownloadName = `IMG_Download/${filename}${ext}`;
        const contentType = _rawCt; 
        
        if (useBase64) {
            const contentLength = res.headers.get('content-length');
            const sizeLimit = 20 * 1024 * 1024; // 20MB 熔断安全阀门

            if (contentLength && parseInt(contentLength) > sizeLimit) {
                chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                    saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败 (大文件直下)" : "✅ 成功 (大文件直下)");
                });
            } else {
                const reader = res.body.getReader();
                let receivedLength = 0;
                let chunks = [];
                let aborted = false;
                let chunkCount = 0;

                while(true) {
                    const {done, value} = await reader.read();
                    if (done) break;
                    receivedLength += value.length;
                    
                    if (receivedLength > sizeLimit) {
                        reader.cancel('File too large'); 
                        aborted = true;
                        break;
                    }
                    chunks.push(value);
                    chunkCount++;

                    // 🚀 核心保活优化：在 MV3 长连接流式下载大文件时，每拉取 50 块数据，触发一次极轻量 local 
                    // 读取，以此强制刷新 MV3 引擎 Service Worker 的活跃状态计时器，防止后台进程被浏览器强制掐断挂死。
                    if (chunkCount % 50 === 0) {
                        await chrome.storage.local.get('_sw_keep_alive_').catch(() => {});
                    }
                }

                if (aborted) {
                    chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                        saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败 (流超载回退)" : "✅ 成功 (流超载回退)");
                    });
                } else {
                    const blob = new Blob(chunks, { type: contentType });
                    const blobUrl = URL.createObjectURL(blob);
                    chrome.downloads.download({ url: blobUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, (downloadId) => {
                        if (downloadId !== undefined) {
                            const listener = (delta) => {
                                if (delta.id === downloadId && delta.state) {
                                    if (delta.state.current === 'complete' || delta.state.current === 'interrupted') {
                                        URL.revokeObjectURL(blobUrl);
                                        chrome.downloads.onChanged.removeListener(listener);
                                    }
                                }
                            };
                            chrome.downloads.onChanged.addListener(listener);
                        } else {
                            URL.revokeObjectURL(blobUrl);
                        }
                        saveToHistory(finalDownloadName, (chrome.runtime.lastError || downloadId === undefined) ? "❌ 失败" : "✅ 成功 (BlobURL)");
                    });
                }
            }
        } else {
            chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败" : "✅ 成功");
            });
        }
    } catch (err) {
        saveToHistory(initialUrl.split('/').pop() || "media", "❌ 拦截: " + err.message);
    } finally {
        sendResponse({ success: true });
    }
}