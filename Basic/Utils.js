// Basic/Utils.js
window.Mix01Utils = {
    getImmersiveAdapter() {
        return window.Mix01ImmersiveEngine?.getAdapter(window.location.hostname) || null;
    },

    // ✅ 统一的 Promise 化消息发送器
    // 替代原来的回调写法，让 sendMessage 可以被 await，错误可以被正常 catch
    sendMessage(message) {
        return new Promise((resolve, reject) => {
            try {
                chrome.runtime.sendMessage(message, (response) => {
                    if (chrome.runtime.lastError) {
                        reject(new Error(chrome.runtime.lastError.message));
                    } else {
                        resolve(response);
                    }
                });
            } catch (e) {
                reject(e);
            }
        });
    },

    // ✅ 原猴子补丁的核心逻辑，迁移至此作为内部工具方法
    // 职责：在下载前完成 Blob URL 还原 + 高清 URL 升级 + pageUrl 注入
    async _resolveDownloadUrl(url) {
        const state = window.__mix01State;

        // 1. Blob URL 还原为真实远端 URL
        if (url.startsWith('blob:') && state?.blobToUrlMap?.[url]) {
            url = state.blobToUrlMap[url];
        }

        // 2. 高清 URL 升级（仅在未直接命中原图路径时执行）
        if (!url.includes('img-original/') && window.Mix01RuleEngine) {
            try {
                const imgEl = Array.from(document.querySelectorAll('img')).find(
                    el => el.src === url || el.currentSrc === url
                );
                const hdUrl = await window.Mix01RuleEngine.getHighResUrl(imgEl, url);
                if (hdUrl) url = hdUrl;
            } catch (e) {
                console.warn("Mix01 高清 URL 升级失败，降级使用原链接", e);
            }
        }

        return url;
    },

    async copyImageToClipboard(url, renderer) {
        renderer.showToast("⏳ 正在获取原图...");
        try {
            // ✅ 统一使用 Promise 风格，后台失败或网络异常均可被外层 catch 捕获
            const res = await this.sendMessage({
                action: "fetchImageAsBase64",
                url,
                pageUrl: window.location.href
            });

            if (!res?.success) throw new Error("Background fetch failed");

            const blob = await fetch(res.base64).then(r => r.blob());
            const blobUrl = URL.createObjectURL(blob);

            // 解码图片以便转为标准 PNG
            const img = new Image();
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
            URL.revokeObjectURL(blobUrl);

            // 写入剪贴板前尝试重新聚焦，尽可能挽回异步延时导致的 User Gesture 失效
            window.focus();
            document.body?.focus();

            try {
                // 1. 首选：写入高清 PNG 二进制
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
                renderer.showToast("✅ 已成功复制原图！");
            } catch (writeErr) {
                console.warn("Mix01 剪贴板写入图片失败 (可能是焦点受阻)，降级方案启动...", writeErr);
                try {
                    // 2. 降级：写入图片直链文本
                    await navigator.clipboard.writeText(url);
                    renderer.showToast("📋 复制原图失败，已降级复制原图链接");
                } catch (textErr) {
                    // 3. 兜底：完全受限
                    console.error("Mix01 剪贴板完全受限:", textErr);
                    renderer.showToast("❌ 复制失败，请尝试直接右键保存图片");
                }
            }
        } catch (err) {
            console.error("Mix01 copyImageToClipboard 失败:", err);
            renderer.showToast("❌ 复制失败，请尝试直接保存");
        }
    },

    async downloadMedia(url, renderer, isVideo = false) {
        if (!url) return;
        renderer.showToast(isVideo ? "⏳ 正在提交视频下载任务..." : "⏳ 正在提交图片下载任务...");

        try {
            // ✅ 在发送前完成 Blob 还原与高清升级，不再依赖猴子补丁
            const resolvedUrl = await this._resolveDownloadUrl(url);
            await this.sendMessage({
                action: "downloadImmersiveImg",
                url: resolvedUrl,
                pageUrl: window.location.href
            });
            renderer.showToast("✅ 已保存至 IMG_Download 文件夹内！");
        } catch (e) {
            console.warn("后台暂不可用，正在自动降级本地兜底通道...", e);
            this._downloadLocallyFallback(url, renderer, isVideo);
        }
    },

    // 本地兜底下载通道：仅在后台 Service Worker 不可用时启动
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
        } catch (e) {}

        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
    }
};