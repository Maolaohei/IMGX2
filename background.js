// background.js - Mix01 终极自愈下载引擎 (终极优化版)
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

// 🚀 P0: 纯无状态化 (Stateless) 与 Promise 队列
let _historyQueue = Promise.resolve();

function saveToHistory(filename, statusMsg) {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const newItem = { time: timeStr, filename: filename, status: statusMsg };

    _historyQueue = _historyQueue.then(async () => {
        const res = await chrome.storage.local.get(['mix01_download_history']);
        const cache = res.mix01_download_history || [];
        cache.unshift(newItem);
        if (cache.length > 50) cache.pop();
        await chrome.storage.local.set({ mix01_download_history: cache });
    }).catch(err => console.error('Mix01 History Save Error:', err));
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
    // 🚀 P2: 后端代发 Twitter API，彻底避开前台 Content Script 读取 Cookie 导致的风控和跨域拦截
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

    // 🚀 P2: 代理请求图片转化为 Base64 回传，完美绕过某些网站对 navigator.clipboard 的严格 CSP 限制
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
        (async () => {
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
                
                // 🔧 FIX: 增强文件名提取逻辑，剥离路径中的脏参数和小尾巴
                let lastSegment = decodeURIComponent(urlObj.pathname.split('/').pop() || '');
                lastSegment = lastSegment.split(':')[0]; // 去除 :orig 或 :large
                lastSegment = lastSegment.split('@')[0]; // 去除 @2x 等缩放标记
                lastSegment = lastSegment.split('&')[0]; // 去除夹带的 &xxx 错误参数
                lastSegment = lastSegment.split('?')[0]; // 防御性去除问号后的字符

                let filename = "media", ext = "";
                
                // 🔧 FIX: 利用 Content-Type 作为格式的终极保底
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

                if (paramExt) {
                    ext = "." + paramExt.toLowerCase();
                }

                // 🔧 FIX: 校验后缀名是否合法。如果不合法（比如是一串哈希），强制使用 Content-Type 推导的格式
                if (!/^\.(jpg|jpeg|png|gif|webp|svg|bmp|mp4|webm|avif|mov|mkv)$/i.test(ext)) {
                    ext = _resolvedExt;
                }
                if (!filename || filename === "") filename = "media";

                // 尝试从 Content-Disposition 请求头获取标准文件名 (最高优先级)
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

                // 最终清洗并组装下载路径
                filename = filename.replace(/[\\/:*?"<>|]/g, "_");
                const finalDownloadName = `IMG_Download/${filename}${ext}`;
                const contentType = _rawCt; 
                
                if (useBase64) {
                    const contentLength = res.headers.get('content-length');
                    const sizeLimit = 20 * 1024 * 1024; // 20MB

                    if (contentLength && parseInt(contentLength) > sizeLimit) {
                        chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                            saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败 (大文件直下)" : "✅ 成功 (大文件直下)");
                        });
                    } else {
                        // 🚀 P0: 引入流式阻断。防止没有 Content-Length 的恶意大文件撑爆内存
                        const reader = res.body.getReader();
                        let receivedLength = 0;
                        let chunks = [];
                        let aborted = false;

                        while(true) {
                            const {done, value} = await reader.read();
                            if (done) break;
                            receivedLength += value.length;
                            
                            if (receivedLength > sizeLimit) {
                                reader.cancel('File too large'); // 立刻掐断流
                                aborted = true;
                                break;
                            }
                            chunks.push(value);
                        }

                        if (aborted) {
                            chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                                saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败 (大流回退)" : "✅ 成功 (大流回退)");
                            });
                        } else {
                            const blob = new Blob(chunks, { type: contentType });
                            const blobUrl = URL.createObjectURL(blob);
                            chrome.downloads.download({ url: blobUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, (downloadId) => {
                                // 🚀 P0: 利用原生下载事件回调，精准释放内存 GC，杜绝 MV3 休眠导致的泄漏
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
        })();
        return true; 
    }
});