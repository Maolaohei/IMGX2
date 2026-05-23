// Basic/Utils.js
window.Mix01Utils = {
    getImmersiveAdapter() {
        return window.Mix01ImmersiveEngine?.getAdapter(window.location.hostname) || null;
    },

    async copyImageToClipboard(url, renderer) {
        renderer.showToast("⏳ 正在获取原图...");
        try {
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
                
                renderer.showToast("✅ 已成功复制原图！");
                URL.revokeObjectURL(blobUrl);
            });
        } catch (err) { 
            renderer.showToast("❌ 复制失败，请尝试直接保存"); 
        }
    },

    async downloadMedia(url, renderer, isVideo = false) {
        if (!url) return;

        renderer.showToast(isVideo ? "⏳ 正在提交视频下载任务..." : "⏳ 正在提交图片下载任务...");
        
        // 🚀 核心改进：由于已部署 rules.json 重写 Referer，优先将任务交还给后台 Service Worker
        // 这样可以确保文件完美地保存到您所期望的 "IMG_Download/" 文件夹内
        try {
            chrome.runtime.sendMessage({ action: "downloadImmersiveImg", url: url }, () => {
                if (chrome.runtime.lastError) {
                    console.warn("后台暂不可用，正在自动降级本地兜底通道...");
                    this._downloadLocallyFallback(url, renderer, isVideo);
                } else {
                    renderer.showToast("✅ 已保存至 IMG_Download 文件夹内！");
                }
            });
        } catch (e) {
            console.warn("扩展上下文已断开，正在自动激活本地兜底通道...");
            this._downloadLocallyFallback(url, renderer, isVideo);
        }
    },

    // 🚀 本地兜底下载通道：仅在后台 Service Worker 被强制休眠或环境失效时启动
    async _downloadLocallyFallback(url, renderer, isVideo) {
        if (renderer._currentBlob && !isVideo) {
            this._saveBlobLocally(renderer._currentBlob, url);
            return;
        }
        try {
            const response = await fetch(url, { mode: 'cors' });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const blob = await response.blob();
            this._saveBlobLocally(blob, url);
        } catch (err) {
            renderer.showToast("❌ 降级下载失败，请尝试刷新当前页面");
        }
    },

    _saveBlobLocally(blob, originalUrl) {
        const a = document.createElement('a');
        const blobUrl = URL.createObjectURL(blob);
        a.href = blobUrl;
        
        let filename = "mix01-media";
        try {
            const u = new URL(originalUrl);
            const pathParts = u.pathname.split('/');
            filename = pathParts[pathParts.length - 1] || "mix01-media";
            if (!filename.includes('.')) {
                const ext = blob.type.split('/')[1] || 'jpg';
                filename += `.${ext}`;
            }
        } catch(e) {}
        
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
    }
};