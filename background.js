// 1. 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "saveOriginalImgMix01",
        title: "保存原图 (Mix01)",
        contexts: ["image"]
    });
    chrome.contextMenus.create({
        id: "copyOriginalImgMix01",
        title: "复制原图到剪贴板 (Mix01)",
        contexts: ["image"]
    });
});

// 2. 监听右键点击
chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "saveOriginalImgMix01") {
        // 委托 content.js 去解析 Base64 绕过防盗链
        chrome.tabs.sendMessage(tab.id, { action: "saveHDUrl", clickedUrl: info.srcUrl });
    } else if (info.menuItemId === "copyOriginalImgMix01") {
        chrome.tabs.sendMessage(tab.id, { action: "copyHDUrl", clickedUrl: info.srcUrl });
    }
});

// 3. 接收 content.js 转化的纯数据流（Base64），强制写入 IMG_Download 文件夹
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "downloadImmersiveImg") {
        const url = request.url;
        const dataUrl = request.dataUrl; 
        
        let filename = "image", ext = ".jpg";
        try {
            const urlObj = new URL(url);
            const fullPath = urlObj.pathname.split('/').pop();
            const extMatch = fullPath.match(/\.(jpe?g|png|gif|webp|bmp|svg)/i);
            if (extMatch) { 
                ext = extMatch[0]; 
                filename = fullPath.replace(ext, ""); 
            } else {
                const paramExtMatch = urlObj.search.match(/(?:format|ext|type)=(jpe?g|png|gif|webp|bmp|svg)/i);
                if (paramExtMatch) ext = "." + paramExtMatch[1];
                filename = fullPath || "image";
            }
        } catch (e) { 
            filename = "image"; 
        }
        
        filename = filename.replace(/[\\/:*?"<>|]/g, "_");
        
        // 【核心魔法】：传入的 dataUrl(Base64) 绕过了一切浏览器的跨域/403报错！
        chrome.downloads.download({
            url: dataUrl || url, 
            filename: `IMG_Download/${filename}_原图${ext}`, 
            saveAs: false, 
            conflictAction: "uniquify"
        });
        
        sendResponse({ status: "ok" });
        return true;
    }
});