// background.js - Mix01 MV3 完美侦察兵下载引擎
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: "saveOriginalImgMix01", title: "保存原图 (Mix01)", contexts: ["image"] });
    chrome.contextMenus.create({ id: "copyOriginalImgMix01", title: "复制原图到剪贴板 (Mix01)", contexts: ["image"] });

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

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "saveOriginalImgMix01") {
        chrome.tabs.sendMessage(tab.id, { action: "saveHDUrl", clickedUrl: info.srcUrl });
    }
});

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

                // 【侦察兵引擎】: 智能探测 404 与自愈修复
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
                    if (res.status === 404 || res.status === 405) {
                        for (let alt of altUrls) {
                            try {
                                const testRes = await fetch(alt);
                                if (testRes.ok) { res = testRes; finalUrl = alt; break; }
                            } catch(e) {}
                        }
                    }
                }

                if (!res.ok) throw new Error(`服务端拒绝响应 (${res.status})`);

                const urlObj = new URL(finalUrl);
                const fullPath = urlObj.pathname.split('/').pop();
                const filename = fullPath.substring(0, fullPath.lastIndexOf('.')).replace(/[\\/:*?"<>|]/g, "_");
                const ext = fullPath.substring(fullPath.lastIndexOf('.'));
                const finalDownloadName = `IMG_Download/${filename}${ext}`;

                const contentType = res.headers.get('content-type') || '';
                if (!contentType.startsWith('image/') && !contentType.startsWith('video/')) {
                    throw new Error(`拦截到非图片数据 (${contentType})`);
                }

                if (useBase64) {
                    const buffer = await res.arrayBuffer();
                    const bytes = new Uint8Array(buffer);
                    let binary = '';
                    for (let i = 0; i < bytes.length; i += 8192) {
                        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                    }
                    const dataUrl = `data:${contentType};base64,${btoa(binary)}`;
                    chrome.downloads.download({ url: dataUrl, filename: finalDownloadName, saveAs: false }, () => {
                        if (chrome.runtime.lastError) saveToHistory(finalDownloadName, "❌ 失败: " + chrome.runtime.lastError.message);
                        else saveToHistory(finalDownloadName, "✅ 成功 (Base64)");
                    });
                } else {
                    chrome.downloads.download({ url: finalUrl, filename: finalDownloadName, saveAs: false, conflictAction: "uniquify" }, () => {
                        if (chrome.runtime.lastError) saveToHistory(finalDownloadName, "❌ 原生流失败");
                        else saveToHistory(finalDownloadName, "✅ 成功");
                    });
                }

            } catch (err) {
                console.error("Mix01 下载彻底失败:", err);
                const showName = initialUrl.split('/').pop() || "未知文件";
                saveToHistory(showName, "❌ 拦截: " + err.message);
            }
        })();
        sendResponse({ status: "ok" });
        return true; 
    }
});