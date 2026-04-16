// background.js - Mix01 终极自愈下载引擎 (修复版)
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: "saveOriginalImgMix01", title: "保存原图 (Mix01)", contexts: ["image"] });
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

function saveToHistory(filename, statusMsg) {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const newItem = { time: timeStr, filename: filename, status: statusMsg };
    chrome.storage.local.get(['mix01_download_history'], (res) => {
        _historyCache = res.mix01_download_history || [];
        // 优化：使用 pop() 剔除尾部元素，代替耗时的 slice() 数组截取重建
        _historyCache.unshift(newItem);
        if (_historyCache.length > 50) _historyCache.pop(); 
        chrome.storage.local.set({ mix01_download_history: _historyCache });
    });
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
                        // 添加更多备用：不同分辨率
                        altUrls.push(initialUrl.replace('_p0', '_p1'), initialUrl.replace('_p0', '_p2'));
                    } else {
                        // 对于其他情况，尝试添加_p0
                        const base = initialUrl.replace(/\.\w+$/, '');
                        altUrls.push(`${base}_p0.jpg`, `${base}_p0.png`, `${base}.jpg`, `${base}.png`);
                    }
                    
                    if (altUrls.length > 0) {
                        try {
                            // 并发发起 HEAD 请求，谁先返回 200 OK 谁就赢
                            const fetchPromises = altUrls.map(alt => 
                                fetch(alt, { 
                                    method: 'HEAD',
                                    headers: {
                                        'Referer': request.pageUrl || 'https://www.pixiv.net/',
                                        'User-Agent': navigator.userAgent
                                    }
                                }).then(testRes => {
                                    if (testRes.ok) return { res: testRes, url: alt };
                                    throw new Error('Not ok');
                                })
                            );
                            const firstSuccess = await Promise.any(fetchPromises);
                            finalUrl = firstSuccess.url;
                            
                            // 修正原版 Bug：如果使用了 Base64，HEAD 请求是没有 Body 的，必须重新发起 GET
                            if (useBase64) {
                                res = await fetch(finalUrl, {
                                    headers: {
                                        'Referer': request.pageUrl || 'https://www.pixiv.net/',
                                        'User-Agent': navigator.userAgent
                                    }
                                });
                            } else {
                                res = firstSuccess.res; 
                            }
                        } catch(e) {
                            // 所有备用链接都 404，跳出继续走报错逻辑
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
                        // 3. 兜底：从 Content-Type 提取
                        filename = fullPath || "media";
                        const ct = res.headers.get('content-type');
                        if (ct && ct.includes('image/')) ext = "." + ct.split('/')[1].split(';')[0];
                        if (!ext) ext = ".jpg"; 
                    }
                }
                
                filename = filename.replace(/[\\/:*?"<>|]/g, "_");
                const finalDownloadName = `IMG_Download/${filename}${ext}`;
                // --------------------------------

                const contentType = res.headers.get('content-type') || 'image/jpeg';
                
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
                        // 【神级优化】：抛弃 JS 循环拼接，调用浏览器原生 C++ 引擎进行高并发、零阻塞的 Base64 编码
                        const blob = await res.blob();
                        if (blob.size > sizeLimit) {
                            console.warn('Blob too large for Base64, falling back to direct download');
                            chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                                saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败 (大文件直接下载)" : "✅ 成功 (大文件直接下载)");
                            });
                        } else {
                            const reader = new FileReader();
                            
                            reader.onloadend = () => {
                                const dataUrl = reader.result; // 这里直接就是原生生成好的 base64 字符串
                                chrome.downloads.download({ url: dataUrl, filename: finalDownloadName, saveAs: false }, () => {
                                    saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败" : "✅ 成功 (Base64)");
                                });
                            };
                            
                            reader.onerror = () => {
                                saveToHistory(finalDownloadName, "❌ 失败 (Base64 编码异常)");
                            };
                            
                            // 发起底层异步读取
                            reader.readAsDataURL(blob);
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