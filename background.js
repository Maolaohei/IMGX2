// 1. 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "saveOriginalImgMix01",
        title: "保存原图 (Mix01)",
        contexts: ["image"]
    });
    // [新增] 复制到剪贴板菜单
    chrome.contextMenus.create({
        id: "copyOriginalImgMix01",
        title: "复制原图到剪贴板 (Mix01)",
        contexts: ["image"]
    });
});

// 2. 监听右键点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "saveOriginalImgMix01") {
        chrome.tabs.sendMessage(tab.id, { action: "getHDUrl", clickedUrl: info.srcUrl }, (response) => {
            if (chrome.runtime.lastError) return;
            if (response && response.url) {
                const url = response.url;
                let filename = "image", ext = ".jpg";
                try {
                    const urlObj = new URL(url);
                    const fullPath = urlObj.pathname.split('/').pop();
                    const extMatch = fullPath.match(/\.(jpe?g|png|gif|webp|bmp|svg)/i);
                    if (extMatch) { ext = extMatch[0]; filename = fullPath.replace(ext, ""); } 
                    else {
                        const paramExtMatch = urlObj.search.match(/(?:format|ext|type)=(jpe?g|png|gif|webp|bmp|svg)/i);
                        if (paramExtMatch) ext = "." + paramExtMatch[1];
                        filename = fullPath || "image";
                    }
                } catch (e) { filename = "image"; }
                filename = filename.replace(/[\\/:*?"<>|]/g, "_");
                chrome.downloads.download({
                    url: url, filename: `${filename}_原图${ext}`, saveAs: false, conflictAction: "uniquify"
                });
            }
        });
    } else if (info.menuItemId === "copyOriginalImgMix01") {
        // [新增] 发送复制指令给 content.js
        chrome.tabs.sendMessage(tab.id, { action: "copyHDUrl", clickedUrl: info.srcUrl });
    }
});