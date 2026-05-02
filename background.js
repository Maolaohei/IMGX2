// background.js - Mix01 终极自愈下载引擎 (修复版)
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

let _historyCache = null;
let _historyDirty = false; // 防止并发写入竞争：标记是否有未刷新的内存变更

function saveToHistory(filename, statusMsg) {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const newItem = { time: timeStr, filename: filename, status: statusMsg };

    if (_historyCache !== null) {
        // 【Bug修复】原版每次都从 storage 读，并发下载时第二个读到的是旧数据，
        // 导致两次写入互相覆盖，丢失历史记录。改为优先使用内存缓存。
        _historyCache.unshift(newItem);
        if (_historyCache.length > 50) _historyCache.pop();
        chrome.storage.local.set({ mix01_download_history: _historyCache });
    } else {
        // 首次：从 storage 初始化内存缓存
        chrome.storage.local.get(['mix01_download_history'], (res) => {
            _historyCache = res.mix01_download_history || [];
            _historyCache.unshift(newItem);
            if (_historyCache.length > 50) _historyCache.pop();
            chrome.storage.local.set({ mix01_download_history: _historyCache });
        });
    }
}

// 缓存全局变量，避免每次下载都重新执行 O(N) 的正则拆分和编译
let _compiledBase64Domains = null;
let _lastBase64DomainsStr = null;

function isBase64Domain(url, userDomainsStr) {
    try {
        if (!userDomainsStr) return false;
        
        // 只有当用户在设置面板修改了配置时，才重新计算
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
    if (request.action === "downloadImmersiveImg") {
        (async () => {
            let initialUrl = request.url;
            if (initialUrl.startsWith('//')) initialUrl = 'https:' + initialUrl;

            try {
                const config = await chrome.storage.local.get(['base64Domains']);
                const useBase64 = isBase64Domain(initialUrl, config.base64Domains);

                let res;
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒超时
                try {
                    res = await fetch(initialUrl, {
                        method: 'GET',
                        mode: 'cors',
                        credentials: 'include',
                        signal: controller.signal,
                        headers: {
                            'Referer': request.pageUrl || new URL(initialUrl).origin,
                            'User-Agent': navigator.userAgent,
                            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                            'Cache-Control': 'no-cache'
                        }
                    });
                    clearTimeout(timeoutId);
                } catch (fetchError) {
                    clearTimeout(timeoutId);
                    if (fetchError.name === 'AbortError') {
                        console.warn('Fetch timeout, trying no-cors');
                    } else {
                        console.warn('CORS fetch failed, trying no-cors:', fetchError);
                    }
                    try {
                        const noCorsController = new AbortController();
                        const noCorsTimeoutId = setTimeout(() => noCorsController.abort(), 30000);
                        res = await fetch(initialUrl, {
                            method: 'GET',
                            mode: 'no-cors',
                            credentials: 'include',
                            signal: noCorsController.signal
                        });
                        clearTimeout(noCorsTimeoutId);
                    } catch (noCorsError) {
                        // 如果都失败，直接使用chrome.downloads下载URL
                        console.warn('All fetch attempts failed, falling back to direct download:', noCorsError);
                        chrome.downloads.download({ url: initialUrl, filename: `IMG_Download/${initialUrl.split('/').pop() || 'media'}`, saveAs: false }, () => {
                            saveToHistory(initialUrl.split('/').pop() || "media", chrome.runtime.lastError ? "❌ 失败 (直接下载)" : "✅ 成功 (直接下载)");
                        });
                        return true;
                    }
                }
                let finalUrl = initialUrl;
                const isOpaque = res && res.type === 'opaque';

                // 优化：Pixiv 404 自愈逻辑 (并发竞速 Promise.any)
                if (res && res.status === 404 && initialUrl.includes('pximg.net')) {
                    const altUrls = [];
                    if (initialUrl.includes('_ugoira0')) {
                        const base = initialUrl.replace('_ugoira0', '_p0');
                        altUrls.push(base, base.replace(/\.\w+$/, '.png'), base.replace(/\.\w+$/, '.jpg'));
                    } else if (initialUrl.includes('_p0')) {
                        const targetExt = initialUrl.endsWith('.png') ? '.jpg' : '.png';
                        altUrls.push(initialUrl.replace(/\.\w+$/, targetExt));
                        altUrls.push(initialUrl.replace('_p0', '_p1'), initialUrl.replace('_p0', '_p2'));
                    } else {
                        const base = initialUrl.replace(/\.\w+$/, '');
                        altUrls.push(`${base}_p0.jpg`, `${base}_p0.png`, `${base}.jpg`, `${base}.png`);
                    }

                    if (altUrls.length > 0) {
                        try {
                            const fetchPromises = altUrls.map(alt =>
                                fetch(alt, {
                                    method: 'HEAD',
                                    headers: {
                                        'Referer': request.pageUrl || 'https://www.pixiv.net/',
                                        'User-Agent': navigator.userAgent
                                    }
                                }).then(testRes => {
                                    if (testRes.ok) return alt; // 只返回 URL，不保留 HEAD response
                                    throw new Error('Not ok');
                                })
                            );
                            finalUrl = await Promise.any(fetchPromises);

                            // 【Bug修复】无论是否 Base64，都必须重新发 GET 请求获取响应体。
                            // 原版在非 Base64 分支直接用 HEAD response 的 res 对象，
                            // 导致后续 res.ok 检查虽然通过，但实际下载的是空响应。
                            res = await fetch(finalUrl, {
                                headers: {
                                    'Referer': request.pageUrl || 'https://www.pixiv.net/',
                                    'User-Agent': navigator.userAgent,
                                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
                                }
                            });
                        } catch(e) {
                            console.warn('All Pixiv alt URLs failed:', altUrls, e);
                        }
                    }
                }

                if (!res || isOpaque || !res.ok) {
                    console.warn('Fetch returned unusable response, falling back to direct download', { status: res?.status, type: res?.type, url: finalUrl });
                    chrome.downloads.download({ url: finalUrl, filename: `IMG_Download/${finalUrl.split('/').pop() || 'media'}`, saveAs: false, conflictAction: 'uniquify' }, () => {
                        saveToHistory(finalUrl.split('/').pop() || "media", chrome.runtime.lastError ? "❌ 失败 (直接下载回退)" : "✅ 成功 (直接下载回退)");
                    });
                    return true;
                }

                // --- 【核心修复：智能后缀提取】 ---
                const urlObj = new URL(finalUrl);
                const fullPath = urlObj.pathname.split('/').pop();
                let filename = "media", ext = "";

                // 预计算 MIME 映射（用于兜底）
                const _mimeToExt = { 'jpeg': 'jpg', 'jpg': 'jpg', 'png': 'png', 'gif': 'gif',
                    'webp': 'webp', 'svg+xml': 'svg', 'bmp': 'bmp', 'mp4': 'mp4',
                    'webm': 'webm', 'avif': 'avif' };
                const _rawCt = (res.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
                const _rawSubtype = _rawCt.split('/')[1] || 'jpeg';
                // 【Bug修复】原 split(';')[0] 对 'image/svg+xml' 给出 'svg+xml'，现在用映射修正
                const _resolvedExt = '.' + (_mimeToExt[_rawSubtype] || _rawSubtype.split('+')[0] || 'jpg');

                // 1. 优先检查 URL 参数 (解决 X.com 问题)
                const paramExt = urlObj.searchParams.get('format') || urlObj.searchParams.get('ext');
                if (paramExt) {
                    ext = "." + paramExt;
                    filename = fullPath || "media";
                } else {
                    // 2. 检查路径是否有后缀
                    const dotIndex = fullPath.lastIndexOf('.');
                    if (dotIndex !== -1) {
                        filename = fullPath.substring(0, dotIndex);
                        ext = fullPath.substring(dotIndex);
                    } else {
                        // 3. 兜底：从 Content-Type 提取（使用修复后的 MIME 映射）
                        filename = fullPath || "media";
                        ext = _resolvedExt;
                    }
                }

                filename = filename.replace(/[\\/:*?"<>|]/g, "_");
                const finalDownloadName = `IMG_Download/${filename}${ext}`;
                // --------------------------------

                const contentType = _rawCt; // 供下方 blob 使用
                
                if (useBase64) {
                    // 优化：检查文件大小，大文件直接下载避免内存溢出
                    const contentLength = res.headers.get('content-length');
                    const sizeLimit = 20 * 1024 * 1024; // 20MB

                    if (contentLength && parseInt(contentLength) > sizeLimit) {
                        console.warn('File too large for Base64, falling back to direct download');
                        chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                            saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败 (大文件直接下载)" : "✅ 成功 (大文件直接下载)");
                        });
                    } else {
                        const blob = await res.blob();
                        if (blob.size > sizeLimit) {
                            console.warn('Blob too large for Base64, falling back to direct download');
                            chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                                saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败 (大文件直接下载)" : "✅ 成功 (大文件直接下载)");
                            });
                        } else {
                            // 【性能优化 & Bug修复】
                            // 原版用 FileReader.readAsDataURL，会把整个文件 Base64 编码后塞进内存字符串，
                            // 实际体积比原文件大 ~33%，service worker 内存会瞬间暴涨。
                            // 改用 URL.createObjectURL：直接引用底层 Blob，零拷贝，用完后即刻释放。
                            const blobUrl = URL.createObjectURL(blob);
                            chrome.downloads.download({ url: blobUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, (downloadId) => {
                                // 延迟释放，确保下载引擎已持有引用
                                setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
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
            }
        })();
        return true; 
    }
});