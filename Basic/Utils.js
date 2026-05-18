// Basic/Utils.js
window.Mix01Utils = {
    getImmersiveAdapter() {
        return window.Mix01ImmersiveEngine?.getAdapter(window.location.hostname) || null;
    },

    async copyImageToClipboard(url, renderer) {
        renderer.showToast("⏳ 正在安全获取并处理原图...");
        try {
            // 🚀 P2: 绕过前端 CSP 跨域限制，让具有最高特权的后台发送请求并传回 Base64 数据
            chrome.runtime.sendMessage({ action: "fetchImageAsBase64", url: url, pageUrl: window.location.href }, async (res) => {
                if (!res || !res.success) throw new Error("Background fetch failed");
                
                const fetchRes = await fetch(res.base64); 
                const blob = await fetchRes.blob();
                const img = new Image();
                const blobUrl = URL.createObjectURL(blob);
                
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = blobUrl;
                });

                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth; 
                canvas.height = img.naturalHeight;
                canvas.getContext('2d', { alpha: false }).drawImage(img, 0, 0);
                
                const pngBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
                
                renderer.showToast("✅ 已成功复制原图到剪切板！");
                URL.revokeObjectURL(blobUrl);
            });
        } catch (err) { 
            renderer.showToast("❌ 获取图片失败，剪贴板 API 被拒绝"); 
            console.error("Clipboard Copy Failed:", err);
        }
    },

    downloadImage(url, renderer) {
        renderer.showToast("⏳ 正在打通后台进行安全下载...");
        try {
            chrome.runtime.sendMessage({ action: "downloadImmersiveImg", url: url }, () => {
                if (chrome.runtime.lastError) {
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