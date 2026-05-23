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

        if (renderer._currentBlob && !isVideo) {
            renderer.showToast("✅ 正在本地保存最高清原图...");
            this._saveBlobLocally(renderer._currentBlob, url);
            return;
        }

        renderer.showToast(isVideo ? "⏳ 正在拉取高清视频源..." : "⏳ 正在拉取高清大图...");
        try {
            const response = await fetch(url, { mode: 'cors' });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const blob = await response.blob();
            this._saveBlobLocally(blob, url);
            renderer.showToast("✅ 下载完成！");
        } catch (err) {
            console.warn("网页域 fetch 失败，尝试降级为后台传输下载:", err);
            chrome.runtime.sendMessage({ action: "downloadImmersiveImg", url: url }, () => {
                if (chrome.runtime.lastError) {
                    renderer.showToast("❌ 下载失败，环境已断开，请刷新页面");
                } else {
                    renderer.showToast("✅ 已交付后台加速下载...");
                }
            });
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
