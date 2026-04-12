// Basic/Utils.js
window.Mix01Utils = {
    getImmersiveAdapter: function() {
        if (window.Mix01ImmersiveEngine && window.Mix01ImmersiveEngine.getAdapter) {
            return window.Mix01ImmersiveEngine.getAdapter(window.location.hostname);
        }
        return null;
    },

    copyImageToClipboard: async function(url, renderer) {
        renderer.showToast("⏳ 正在获取并处理原图...");
        try {
            const response = await fetch(url);
            const blob = await response.blob();
            const img = new Image();
            const blobUrl = URL.createObjectURL(blob);
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width; canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                canvas.toBlob(async (pngBlob) => {
                    try {
                        await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
                        renderer.showToast("✅ 已成功复制原图到剪切板！");
                    } catch (err) { 
                        renderer.showToast("❌ 写入失败，请确保页面保持聚焦"); 
                    }
                    URL.revokeObjectURL(blobUrl);
                }, 'image/png');
            };
            img.onerror = () => { renderer.showToast("❌ 渲染失败"); URL.revokeObjectURL(blobUrl); };
            img.src = blobUrl;
        } catch (err) { 
            renderer.showToast("❌ 获取图片失败，存在跨域限制"); 
        }
    },

    downloadImage: function(url, renderer) {
        renderer.showToast("⏳ 正在打通后台进行安全下载...");
        try {
            chrome.runtime.sendMessage({ action: "downloadImmersiveImg", url: url }, (response) => {
                if (chrome.runtime.lastError) {
                    console.warn(chrome.runtime.lastError);
                    renderer.showToast("❌ 后台离线！请去扩展管理页【刷新本插件】");
                } else {
                    renderer.showToast("✅ 下载指令已送达后台！");
                }
            });
        } catch (e) {
            renderer.showToast("❌ 扩展环境已失效，请刷新当前网页重试！");
        }
    }
};