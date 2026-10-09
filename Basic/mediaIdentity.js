// Basic/mediaIdentity.js
// 媒体身份判定模块（沉浸画廊导航的唯一真相）
//
// 从 InputController 抽出的纯 DOM 逻辑：这些函数决定「同一个媒体」在多图帖、
// 虚拟列表回收、X 多档预览（?name=small/large/orig）下是否被识别为同一项。
// 独立成模块的原因：身份判定是沉浸导航正确性的核心，应可脱离 2445 行的
// InputController 单独测试与演进。
window.Mix01MediaIdentity = (function () {
    // 稳定资源标识：去 query/hash；blob/mediasource 属临时句柄，不做持久身份
    const normalizeAssetSrc = (src) => {
        if (!src || src === 'video') return '';
        if (src.startsWith('blob:') || src.startsWith('mediasource:')) return '';
        try {
            const u = new URL(src, location.href);
            // X rotates ?name=small/large; pathname (media id) is stable per asset.
            return `${u.origin}${u.pathname}`;
        } catch (e) {
            return src.split('?')[0].split('#')[0];
        }
    };

    // 多图帖内的稳定槽位（photo 1..N）。X 虚拟列表会换节点，槽位身份必须可复用。
    const mediaSlotInArticle = (media) => {
        if (!media || !media.isConnected) return -1;
        if (Number.isInteger(media._mixMediaSlot) && media._mixMediaSlot >= 0) {
            return media._mixMediaSlot;
        }
        const article = media.closest?.('article') || media.closest?.('[data-testid="tweet"]');
        if (!article) return -1;
        const siblings = Array.from(article.querySelectorAll('img, video')).filter(el => {
            if (!el || el === media) return true;
            if (el.id === 'zoom-img-xyz' || el.id === 'zoom-img-buffer-xyz' || el.id === 'zoom-video-xyz') return false;
            if (el.tagName === 'IMG') {
                const s = el.currentSrc || el.src || '';
                if (!s) return false;
                if (s.includes('profile_images') || s.includes('emoji') || s.includes('hashflag')) return false;
                if (s.includes('tweet_video_thumb') || s.includes('ext_tw_video_thumb') ||
                    s.includes('amplify_video_thumb') || s.includes('video_poster') || s.includes('video-thumbnail')) return false;
            }
            return (el.clientWidth || 0) > 40 && (el.clientHeight || 0) > 40;
        });
        // Keep only real media-ish siblings for slot numbering
        const mediaLike = siblings.filter(el => {
            if (el.tagName === 'VIDEO') return true;
            const s = el.currentSrc || el.src || '';
            return !!(s && (s.includes('/media/') || s.includes('twimg.com') || el.naturalWidth > 0 || el.clientWidth > 80));
        });
        const list = mediaLike.length ? mediaLike : siblings;
        const idx = list.indexOf(media);
        if (idx >= 0) media._mixMediaSlot = idx;
        return idx;
    };

    const mediaKey = (media) => {
        if (!media) return '';

        // 1) Durable asset URL wins (critical for multi-image tweets).
        //    Never collapse same-status multi photos into one key.
        const rawSrc = media.currentSrc || media.src || '';
        const asset = normalizeAssetSrc(rawSrc);
        if (asset) {
            // Keep status as soft namespace only when present; asset path is the uniqueness.
            if (media._mixStatusId && /\/media\//.test(asset)) {
                return `asset:${media._mixStatusId}:${asset}`;
            }
            return `src:${asset}`;
        }

        // 2) Blob/MSE video (and rare empty-src nodes): status + slot / role.
        if (media._mixStatusId) {
            if (media.tagName === 'VIDEO') return `vid:${media._mixStatusId}`;
            const slot = mediaSlotInArticle(media);
            if (slot >= 0) return `sid:${media._mixStatusId}#${slot}`;
            return `sid:${media._mixStatusId}#${media.tagName}`;
        }

        // 3) Last resort geometric fingerprint
        const slot = mediaSlotInArticle(media);
        if (slot >= 0) return `slot:${slot}:${media.tagName}:${Math.round(media.clientWidth)}x${Math.round(media.clientHeight)}`;
        return `el:${media.tagName}:${Math.round(media.clientWidth)}x${Math.round(media.clientHeight)}`;
    };

    // documentPosition 是连接节点的稳定阅读顺序（对虚拟列表换序最可靠）
    const sortMediaDocumentOrder = (list) => {
        if (!list || list.length < 2) return list || [];
        return list
            .filter(el => el && el.isConnected)
            .map((el, idx) => ({ el, idx }))
            .sort((a, b) => {
                if (a.el === b.el) return 0;
                const rel = a.el.compareDocumentPosition(b.el);
                if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                // disconnected / uncommon: keep original relative order
                return a.idx - b.idx;
            })
            .map(x => x.el);
    };

    const dedupeMedia = (list) => {
        const seen = new Set();
        const out = [];
        for (const el of list) {
            if (!el || !el.isConnected) continue;
            const key = mediaKey(el);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            out.push(el);
        }
        return out;
    };

    return { normalizeAssetSrc, mediaSlotInArticle, mediaKey, sortMediaDocumentOrder, dedupeMedia };
})();
