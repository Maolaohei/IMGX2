// background.js

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: "saveOriginalImgMix01", title: "保存原图 (Mix01)", contexts: ["image"] });
    chrome.contextMenus.create({ id: "copyOriginalImgMix01", title: "复制原图到剪贴板 (Mix01)", contexts: ["image"] });

    // 【核心黑科技】：使用 DNR 拦截器，强制为所有发往 Pixiv 图片服务器的请求注入 Referer
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
                    resourceTypes: ["xmlhttprequest", "image", "main_frame", "sub_frame"]
                }
            }]
        });
    }
});

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

        // 此时 Fetch 请求会被上面的 DNR 规则自动注入 Referer，Pixiv 会乖乖交出原图
        fetch(url)
            .then(res => {
                if (!res.ok) throw new Error("Fetch 被拦截，状态码: " + res.status);
                return res.blob();
            })
            .then(blob => {
                const reader = new FileReader();
                reader.onloadend = () => {
                    // 转为 Base64 后交给 Chrome 原生下载，100% 成功，无视任何跨域限制
                    chrome.downloads.download({
                        url: reader.result,
                        filename: finalDownloadName,
                        saveAs: false,
                        conflictAction: "uniquify"
                    });
                };
                reader.readAsDataURL(blob);
            })
            .catch(err => {
                console.error("Mix01 后台安全下载失败:", err);
                // 终极兜底方案：交由浏览器自己去下（如果上面的 DNR 规则生效，这里也能成）
                chrome.downloads.download({
                    url: url,
                    filename: finalDownloadName,
                    saveAs: false
                });
            });
            
        sendResponse({ status: "ok" });
        return true; 
    }
});