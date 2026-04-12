// background.js - Mix01 零负担后台下载引擎
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: "saveOriginalImgMix01", title: "保存原图 (Mix01)", contexts: ["image"] });
    chrome.contextMenus.create({ id: "copyOriginalImgMix01", title: "复制原图到剪贴板 (Mix01)", contexts: ["image"] });

    // DNR 规则注入：强制注入 Referer
    if (chrome.declarativeNetRequest) {
        chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [1],
            addRules: [{
                id: 1,
                priority: 1,
                action: {
                    type: "modifyHeaders",
                    requestHeaders: [
                        { header: "Referer", operation: "set", value: "https://www.pixiv.net/" }
                    ]
                },
                condition: {
                    urlFilter: "||pximg.net/*",
                    resourceTypes: ["xmlhttprequest", "image", "main_frame", "sub_frame", "other"]
                }
            }]
        });
    }
});

let _historyCache = null; // 内存缓存，避免频繁 IO

function saveToHistory(filename, statusMsg) {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const newItem = { time: timeStr, filename: filename, status: statusMsg };

    if (_historyCache !== null) {
        // 缓存命中，直接操作内存，跳过 get 请求
        _historyCache.unshift(newItem);
        if (_historyCache.length > 50) _historyCache = _historyCache.slice(0, 50);
        chrome.storage.local.set({ mix01_download_history: _historyCache });
    } else {
        chrome.storage.local.get(['mix01_download_history'], (res) => {
            _historyCache = res.mix01_download_history || [];
            _historyCache.unshift(newItem);
            if (_historyCache.length > 50) _historyCache = _historyCache.slice(0, 50);
            chrome.storage.local.set({ mix01_download_history: _historyCache });
        });
    }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "saveOriginalImgMix01") {
        chrome.tabs.sendMessage(tab.id, { action: "saveHDUrl", clickedUrl: info.srcUrl });
    } else if (info.menuItemId === "copyOriginalImgMix01") {
        chrome.tabs.sendMessage(tab.id, { action: "copyHDUrl", clickedUrl: info.srcUrl });
    }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "downloadImmersiveImg") {
        const url = request.url;
        let filename = "media", ext = ".jpg";
        
        try {
            const urlObj = new URL(url);
            const fullPath = urlObj.pathname.split('/').pop();
            // 分离文件名和扩展名
            const dotIndex = fullPath.lastIndexOf('.');
            if (dotIndex !== -1) {
                filename = fullPath.substring(0, dotIndex);
                ext = fullPath.substring(dotIndex); // 含点，如 ".jpg"
            } else {
                // 路径里没扩展名，尝试从 query 参数里找
                const paramExtMatch = urlObj.search.match(/(?:format|ext|type)=(jpe?g|png|gif|webp|bmp|svg|mp4|webm)/i);
                if (paramExtMatch) ext = "." + paramExtMatch[1];
                filename = fullPath || "media";
            }
        } catch (e) { filename = "media"; }
        
        filename = filename.replace(/[\\/:*?"<>|]/g, "_");
        const finalDownloadName = `IMG_Download/${filename}${ext}`;

        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error("Fetch 被拦截，状态码: " + res.status);
                return res.blob();
            })
            .then(blob => {
                const blobUrl = URL.createObjectURL(blob);
                chrome.downloads.download({
                    url: blobUrl,
                    filename: finalDownloadName,
                    saveAs: false,
                    conflictAction: "uniquify"
                }, (downloadId) => {
                    URL.revokeObjectURL(blobUrl);
                    if (chrome.runtime.lastError) {
                        saveToHistory(finalDownloadName, "❌ 失败: " + chrome.runtime.lastError.message);
                    } else {
                        saveToHistory(finalDownloadName, "✅ 成功");
                    }
                });
            })
            .catch(err => {
                console.error("Mix01 后台安全下载失败:", err);
                chrome.downloads.download({
                    url: url,
                    filename: finalDownloadName,
                    saveAs: false,
                    conflictAction: "uniquify"
                }, (downloadId) => {
                    if (chrome.runtime.lastError) {
                        saveToHistory(finalDownloadName, "❌ 失败: 防盗链拦截");
                    } else {
                        saveToHistory(finalDownloadName, "✅ 成功 (原生通道)");
                    }
                });
            });
            
        sendResponse({ status: "ok" });
        return true; 
    }
});