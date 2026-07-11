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

        if (url.startsWith('blob:') && state?.blobToUrlMap?.[url]) {
            url = state.blobToUrlMap[url];
        }

        if (state?.hdUrlMap?.[url]) {
            return state.hdUrlMap[url];
        }

        if (!url.includes('img-original/') && window.Mix01RuleEngine) {
            try {
                const imgEl = document.querySelector(`img[src="${CSS.escape(url)}"], img[currentsrc="${CSS.escape(url)}"]`);
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
            // Prefer blob path to avoid base64 inflate + canvas re-encode
            const res = await this.sendMessage({
                action: "fetchImageAsBlob",
                url,
                pageUrl: window.location.href
            });

            if (!res?.success) throw new Error("Background fetch failed");

            let blob;
            if (res.base64) {
                // Backward-compatible base64 fallback
                blob = await fetch(res.base64).then(r => r.blob());
            } else if (res.dataUrl) {
                blob = await fetch(res.dataUrl).then(r => r.blob());
            } else {
                throw new Error("Empty image payload");
            }

            window.focus();
            document.body?.focus();

            // Prefer native type when clipboard supports it; convert to PNG only when needed
            let writeBlob = blob;
            const type = (blob.type || 'image/png').split(';')[0];
            if (type !== 'image/png') {
                try {
                    const bitmap = await createImageBitmap(blob);
                    const canvas = document.createElement('canvas');
                    canvas.width = bitmap.width;
                    canvas.height = bitmap.height;
                    const ctx = canvas.getContext('2d', { alpha: false });
                    ctx.drawImage(bitmap, 0, 0);
                    if (bitmap.close) bitmap.close();
                    writeBlob = await new Promise(r => canvas.toBlob(r, 'image/png'));
                } catch (convErr) {
                    // keep original blob; clipboard write may still fail and fall back to text
                    writeBlob = blob;
                }
            }

            try {
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': writeBlob })]);
                renderer.showToast("✅ 已成功复制原图！");
            } catch (writeErr) {
                console.warn("Mix01 剪贴板写入图片失败 (可能是焦点受阻)，降级方案启动...", writeErr);
                try {
                    await navigator.clipboard.writeText(url);
                    renderer.showToast("📋 复制原图失败，已降级复制原图链接");
                } catch (textErr) {
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
            const resolvedUrl = await this._resolveDownloadUrl(url);
            await this.sendMessage({
                action: "downloadImmersiveImg",
                url: resolvedUrl,
                pageUrl: window.location.href
            });
            renderer.showToast("📥 下载任务已提交，结果请查看提取记录");
        } catch (e) {
            console.warn("后台暂不可用，正在自动降级本地兜底通道...", e);
            this._downloadLocallyFallback(url, renderer, isVideo);
        }
    },

    async _downloadLocallyFallback(url, renderer, isVideo) {
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