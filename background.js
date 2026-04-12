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

// 核心判断逻辑：是否命中用户配置的 Base64 域名规则
function isBase64Domain(url, domainsStr) {
    if (!domainsStr || typeof domainsStr !== 'string') return false;
    try {
        const host = new URL(url.startsWith('//') ? 'https:' + url : url).hostname;
        const domains = domainsStr.split(',').map(d => d.trim().replace(/\*/g, '.*'));
        return domains.some(d => new RegExp(`^${d}$`, 'i').test(host));
    } catch (e) {
        return false;
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
        let url = request.url;
        
        // 【核心修复 1】协议头嗅探：修复从 DOM 提取出的 //i.pximg.net 导致的 chrome-extension:// 解析错误
        if (url.startsWith('//')) {
            url = 'https:' + url;
        }

        let filename = "media", ext = ".jpg";
        
        try {
            const urlObj = new URL(url);
            const fullPath = urlObj.pathname.split('/').pop();
            const dotIndex = fullPath.lastIndexOf('.');
            if (dotIndex !== -1) {
                filename = fullPath.substring(0, dotIndex);
                ext = fullPath.substring(dotIndex); 
            } else {
                const paramExtMatch = urlObj.search.match(/(?:format|ext|type)=(jpe?g|png|gif|webp|bmp|svg|mp4|webm)/i);
                if (paramExtMatch) ext = "." + paramExtMatch[1];
                filename = fullPath || "media";
            }
        } catch (e) { filename = "media"; }
        
        filename = filename.replace(/[\\/:*?"<>|]/g, "_");
        const finalDownloadName = `IMG_Download/${filename}${ext}`;

        // 并发获取用户 Base64 设置
        chrome.storage.local.get(['base64Domains'], (res) => {
            const useBase64 = isBase64Domain(url, res.base64Domains);

            fetch(url)
                .then(res => {
                    if (!res.ok) throw new Error("Fetch 被拦截，状态码: " + res.status);
                    // 【核心修复 2】避开 MV3 不支持的 FileReader，如果开启了特权，直接读取为二进制缓冲流 ArrayBuffer
                    return useBase64 ? res.arrayBuffer() : res.blob();
                })
                .then(data => {
                    if (useBase64) {
                        // 采用高能效分块转换策略，避免超大图片内存溢出 (Maximum call stack size exceeded)
                        const bytes = new Uint8Array(data);
                        let binary = '';
                        const chunkSize = 8192;
                        for (let i = 0; i < bytes.length; i += chunkSize) {
                            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
                        }
                        const base64data = btoa(binary);

                        // 智能推断 MIME
                        let mimeType = 'image/jpeg';
                        if (ext === '.png') mimeType = 'image/png';
                        else if (ext === '.gif') mimeType = 'image/gif';
                        else if (ext === '.webp') mimeType = 'image/webp';

                        const dataUrl = `data:${mimeType};base64,${base64data}`;

                        chrome.downloads.download({
                            url: dataUrl,
                            filename: finalDownloadName,
                            saveAs: false,
                            conflictAction: "uniquify"
                        }, (downloadId) => {
                            if (chrome.runtime.lastError) {
                                saveToHistory(finalDownloadName, "❌ 失败: " + chrome.runtime.lastError.message);
                            } else {
                                saveToHistory(finalDownloadName, "✅ 成功 (Base64安全通道)");
                            }
                        });
                    } else {
                        // 原生 Blob 下载模式
                        const blobUrl = URL.createObjectURL(data);
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
                    }
                })
                .catch(err => {
                    console.error("Mix01 后台安全下载失败:", err);
                    // 降级使用底层原生通道进行尝试
                    chrome.downloads.download({
                        url: url,
                        filename: finalDownloadName,
                        saveAs: false,
                        conflictAction: "uniquify"
                    }, (downloadId) => {
                        if (chrome.runtime.lastError) {
                            saveToHistory(finalDownloadName, "❌ 失败: 防盗链与网络受限");
                        } else {
                            saveToHistory(finalDownloadName, "✅ 成功 (原生通道降级)");
                        }
                    });
                });
        });
            
        sendResponse({ status: "ok" });
        return true; 
    }
});