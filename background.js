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
        _historyCache.unshift(newItem);
        if (_historyCache.length > 50) _historyCache = _historyCache.slice(0, 50);
        chrome.storage.local.set({ mix01_download_history: _historyCache });
    });
}

function isBase64Domain(url, userDomainsStr) {
    try {
        const host = new URL(url.startsWith('//') ? 'https:' + url : url).hostname;
        if (!userDomainsStr) return false;
        const domains = userDomainsStr.split(',').filter(d => d.trim()).map(d => new RegExp(`^${d.trim().replace(/\*/g, '.*')}$`, 'i'));
        return domains.some(re => re.test(host));
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

                let res = await fetch(initialUrl);
                let finalUrl = initialUrl;

                // Pixiv 404 自愈逻辑 (保留)
                if (res.status === 404 && initialUrl.includes('pximg.net')) {
                    const altUrls = [];
                    if (initialUrl.includes('_ugoira0')) {
                        const base = initialUrl.replace('_ugoira0', '_p0');
                        altUrls.push(base, base.replace(/\.\w+$/, '.png'), base.replace(/\.\w+$/, '.jpg'));
                    } else if (initialUrl.includes('_p0')) {
                        const targetExt = initialUrl.endsWith('.png') ? '.jpg' : '.png';
                        altUrls.push(initialUrl.replace(/\.\w+$/, targetExt));
                    }
                    for (let alt of altUrls) {
                        try {
                            const testRes = await fetch(alt, { method: 'HEAD' });
                            if (testRes.ok) { res = testRes; finalUrl = alt; break; }
                        } catch(e) {}
                    }
                }

                if (!res.ok) throw new Error(`服务端拒绝 (${res.status})`);

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
                    const buffer = await res.arrayBuffer();
                    const bytes = new Uint8Array(buffer);
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                    const dataUrl = `data:${contentType};base64,${btoa(binary)}`;
                    chrome.downloads.download({ url: dataUrl, filename: finalDownloadName, saveAs: false }, () => {
                        saveToHistory(finalDownloadName, chrome.runtime.lastError ? "❌ 失败" : "✅ 成功 (Base64)");
                    });
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