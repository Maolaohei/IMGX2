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

function saveToHistory(filename, statusMsg) {
    chrome.storage.local.get(['mix01_download_history'], (res) => {
        let history = res.mix01_download_history || [];
        const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
        history.unshift({ time: timeStr, filename: filename, status: statusMsg });
        if (history.length > 50) history = history.slice(0, 50); 
        chrome.storage.local.set({ mix01_download_history: history });
    });
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
            const extMatch = fullPath.match(/\.(jpe?g|png|gif|webp|bmp|svg|mp4|webm)/i);
            if (extMatch) { 
                ext = extMatch[0]; 
                filename = fullPath.replace(ext, ""); 
            } else {
                const paramExtMatch = urlObj.search.match(/(?:format|ext|type)=(jpe?g|png|gif|webp|bmp|svg|mp4|webm)/i);
                if (paramExtMatch) ext = "." + paramExtMatch[1];
                filename = fullPath || "media";
            }
        } catch (e) { filename = "media"; }
        
        filename = filename.replace(/[\\/:*?"<>|]/g, "_");
        const finalDownloadName = `IMG_Download/${filename}_Mix01${ext}`;

        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error("Fetch 被拦截，状态码: " + res.status);
                return res.blob();
            })
            .then(blob => {
                // 【核心内存优化】：使用 ObjectURL 替代 DataURL
                const blobUrl = URL.createObjectURL(blob);
                
                chrome.downloads.download({
                    url: blobUrl,
                    filename: finalDownloadName,
                    saveAs: false,
                    conflictAction: "uniquify"
                }, (downloadId) => {
                    // 下载建立后立即释放指针
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