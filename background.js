// background.js
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({ id: "saveOriginalImgMix01", title: "保存原图 (Mix01)", contexts: ["image"] });
    chrome.contextMenus.create({ id: "copyOriginalImgMix01", title: "复制原图到剪贴板 (Mix01)", contexts: ["image"] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "saveOriginalImgMix01") { chrome.tabs.sendMessage(tab.id, { action: "saveHDUrl", clickedUrl: info.srcUrl }); } 
    else if (info.menuItemId === "copyOriginalImgMix01") { chrome.tabs.sendMessage(tab.id, { action: "copyHDUrl", clickedUrl: info.srcUrl }); }
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "downloadImmersiveImg") {
        const url = request.url;
        const dataUrl = request.dataUrl; 
        
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
        
        chrome.downloads.download({
            url: dataUrl || url, 
            filename: `IMG_Download/${filename}_Mix01${ext}`, 
            saveAs: false, 
            conflictAction: "uniquify"
        });
        
        sendResponse({ status: "ok" });
        return true;
    }
});