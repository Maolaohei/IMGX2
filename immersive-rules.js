// immersive-rules.js
(function () {
    const tools = {
        forceClick: function (el) {
            if (!el) return;
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('mouseover', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
        }
    };

    const Mix01ImmersiveRules = {
        '(?:(?:.+\\.)?twitter|x)\\.com': {
            getContainer: (media) => media.closest('article') || document.body,
            getGalleryImages: () => {
                const allMedia = Array.from(document.querySelectorAll('img, video'));
                const validMedia = [];
                const viewportHeight = window.innerHeight;
                const topBound = -viewportHeight * 1.5;
                const bottomBound = viewportHeight * 2.5;

                for (let i = 0; i < allMedia.length; i++) {
                    const media = allMedia[i];
                    if (media.id === 'zoom-img-xyz' || media.id === 'zoom-video-xyz') continue;

                    const rect = media.getBoundingClientRect();
                    if (rect.top < topBound || rect.bottom > bottomBound) continue;
                    if (rect.width <= 50 || rect.height <= 50) continue;
                    
                    const article = media.closest('article');
                    if (article) {
                        // 🚀 性能飞跃：采用 DOM 专属 Dataset 标志阻断，彻底干掉重卷时的重复文本匹配开销
                        if (article.dataset.mixAdStatus === 'ad') continue;
                        if (article.dataset.mixAdStatus === 'clean') {
                            validMedia.push(media);
                            continue;
                        }
                        
                        const isAd = Array.from(article.querySelectorAll('span')).some(span => 
                            /^(广告|赞助|Ad|Promoted)$/i.test(span.textContent.trim())
                        );
                        
                        if (isAd) { 
                            article.dataset.mixAdStatus = 'ad'; 
                            continue; 
                        } else { 
                            article.dataset.mixAdStatus = 'clean'; 
                            validMedia.push(media);
                        }
                    } else {
                        validMedia.push(media);
                    }
                }
                return validMedia;
            },
            getStates: (container) => {
                const likeBtn = container.querySelector('[data-testid="unlike"]');
                let author = "", userNameEl = container.querySelector('[data-testid="User-Name"]');
                if (userNameEl) { const match = userNameEl.textContent.match(/@[\w_]+/); if (match) author = match[0]; }
                let isFollowed = null, profileScope = document.querySelector('[data-testid="primaryColumn"]');
                if (profileScope) {
                    if (profileScope.querySelector('[data-testid$="-unfollow"]')) isFollowed = true;
                    else if (profileScope.querySelector('[data-testid$="-follow"]')) isFollowed = false;
                }
                if (isFollowed === null && author && window.__mix01FollowCache && window.__mix01FollowCache[author] !== undefined) isFollowed = window.__mix01FollowCache[author];
                return { isLiked: !!likeBtn, isFollowed: isFollowed, authorName: author };
            },
            like: async (container) => {
                const btnLike = container.querySelector('[data-testid="like"]'), btnUnlike = container.querySelector('[data-testid="unlike"]');
                if (btnUnlike) { tools.forceClick(btnUnlike); return false; }
                if (btnLike) { tools.forceClick(btnLike); return true; }
                return null;
            },
            follow: async (container, media) => {
                let author = "";
                const userNameEl = container.querySelector('[data-testid="User-Name"]');
                if (userNameEl) {
                    const match = userNameEl.textContent.match(/@[\w_]+/);
                    if (match) author = match[0];
                }

                // 1. 个人主页场景
                const profileScope = document.querySelector('[data-testid="primaryColumn"]');
                if (profileScope) {
                    const btnUnfollow = profileScope.querySelector('[data-testid$="-unfollow"]');
                    const btnFollow = profileScope.querySelector('[data-testid$="-follow"]');
                    if (btnUnfollow) {
                        tools.forceClick(btnUnfollow);
                        await new Promise(r => setTimeout(r, 150));
                        const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
                        if (confirm) tools.forceClick(confirm);
                        if (author && window.__mix01FollowCache) window.__mix01FollowCache[author] = false;
                        return false;
                    } else if (btnFollow) {
                        tools.forceClick(btnFollow);
                        if (author && window.__mix01FollowCache) window.__mix01FollowCache[author] = true;
                        return true;
                    }
                }

                // 2. 信息流场景：优先寻找推文上直接暴露的“关注”按钮
                const directFollowBtn = container.querySelector('button[data-testid$="-follow"]');
                if (directFollowBtn) {
                    tools.forceClick(directFollowBtn);
                    if (author && window.__mix01FollowCache) window.__mix01FollowCache[author] = true;
                    return true;
                }

                // 3. 弹性容错逻辑：寻找右上角“三个点”下拉按钮
                let caret = container.querySelector('[data-testid="caret"]');
                if (!caret) {
                    // 🚀 核心改进：当原生 ID 失效时，通过 SVG 内部下拉箭头 Path 矢量特征定位按钮
                    const potentialCarets = container.querySelectorAll('button, [role="button"]');
                    for (const btn of potentialCarets) {
                        const svg = btn.querySelector('svg');
                        if (svg && (svg.innerHTML.includes('M3.593 12') || svg.innerHTML.includes('M12 14c'))) {
                            caret = btn;
                            break;
                        }
                    }
                }
                if (!caret) return null;

                tools.forceClick(caret);

                // 轮询等待下拉菜单渲染完成（最多等待 600ms）
                let menu = null;
                for (let i = 0; i < 12; i++) {
                    await new Promise(r => setTimeout(r, 50));
                    const menus = Array.from(document.querySelectorAll('[role="menu"]'));
                    if (menus.length > 0) {
                        menu = menus[menus.length - 1];
                        if (menu.querySelector('[role="menuitem"]')) break;
                    }
                }

                if (!menu) {
                    tools.forceClick(document.body); 
                    return null;
                }

                // 🚀 核心改进：针对多国语言（EN/ZH/JP 等）和无标 TestID 的菜单进行弹性文本匹配
                const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
                let targetBtn = null, willFollow = true;
                for (let item of items) {
                    const text = item.textContent || '';
                    if (/Unfollow|取消关注|フォロー解除/i.test(text)) { 
                        targetBtn = item; 
                        willFollow = false; 
                        break; 
                    } else if (/Follow|关注|フォロー/i.test(text)) { 
                        targetBtn = item; 
                        willFollow = true; 
                        break; 
                    }
                }

                if (!targetBtn) {
                    tools.forceClick(document.body); 
                    return null;
                }

                tools.forceClick(targetBtn);

                // 4. 处理“取消关注”时的二次确认弹窗
                if (!willFollow) {
                    await new Promise(r => setTimeout(r, 200));
                    const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
                    if (confirmBtn) {
                        tools.forceClick(confirmBtn);
                    } else {
                        const dialog = document.querySelector('[role="dialog"], [data-testid="mask"]');
                        if (dialog) {
                            const btns = Array.from(dialog.querySelectorAll('[role="button"]'));
                            const confirmTarget = btns.find(b => /Unfollow|取消关注|确认/i.test(b.textContent));
                            if (confirmTarget) tools.forceClick(confirmTarget);
                        }
                    }
                }

                if (author && window.__mix01FollowCache) window.__mix01FollowCache[author] = willFollow;
                return willFollow;
            },
            downloadVideo: async (container, media) => {
                const customSvgBtn = container.querySelector('svg g.download');
                if (customSvgBtn) { const btn = customSvgBtn.closest('button') || customSvgBtn.closest('div[role="button"]') || customSvgBtn.closest('a'); if (btn) { btn.click(); return 'NATIVE_CLICKED'; } }
                const shareGroup = container.querySelector('[role="group"]');
                if (shareGroup) {
                    const buttons = Array.from(shareGroup.querySelectorAll('[role="button"], a'));
                    const nativeDownloadBtn = buttons.find(b => { const label = (b.getAttribute('aria-label') || '').toLowerCase(); const testId = (b.getAttribute('data-testid') || '').toLowerCase(); return label.includes('download') || label.includes('下载') || testId.includes('download'); });
                    if (nativeDownloadBtn) { nativeDownloadBtn.click(); return 'NATIVE_CLICKED'; }
                }
                if (media && window.Mix01RuleEngine) return await window.Mix01RuleEngine.getHighResUrl(media, media.src || '');
                return null;
            }
        },
        '(?:.+\\.)?pixiv\\.net': {
            getContainer: (media) => document.body,

            // 【性能优化】illustId → userId 的 API 查询结果缓存，避免同一张图触发 getStates+like+follow
            // 三次独立 fetch，改为最多查一次。键：illustId，值：userId
            _userIdCache: Object.create(null),

            _getPixivContext: async (media) => {
                let illustId = null;
                let pageIndex = 0;

                if (media && media.src) {
                    const m = media.src.match(/\/(\d+)_/);
                    if (m) illustId = m[1];

                    const pm = media.src.match(/_p(\d+)/);
                    if (pm) pageIndex = parseInt(pm[1], 10);
                }

                if (!illustId && media) {
                    const parentA = media.closest('a');
                    if (parentA && parentA.href) {
                        const m = parentA.href.match(/artworks\/(\d+)/);
                        if (m) illustId = m[1];
                    }
                }

                if (!illustId) {
                    illustId = window.location.pathname.match(/artworks\/(\d+)/)?.[1];
                }

                let userId = null;
                let authorLink = null;
                if (illustId) {
                    const specificLink = document.querySelector(`a[href*="/artworks/${illustId}"]`);
                    if (specificLink) {
                        const container = specificLink.closest('li') || specificLink.parentElement.parentElement;
                        if (container) authorLink = container.querySelector('a[data-click-label="creator"], a[href*="/users/"]');
                    }
                }
                if (!authorLink) authorLink = document.querySelector('a[data-click-label="creator"], a[href*="/users/"]');

                if (authorLink) {
                    const m = authorLink.getAttribute('href')?.match(/users\/(\d+)/);
                    if (m) userId = m[1];
                }

                let token = document.querySelector('meta[name="csrf-token"]')?.content || window.pixiv?.context?.token || '';
                if (!token) {
                    const meta = document.querySelector('#meta-global-data');
                    if (meta) { try { token = JSON.parse(meta.content).token; } catch (e) { } }
                }

                const self = Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net'];

                if (illustId && !userId) {
                    // 【Bug修复】原版无缓存，getStates/like/follow 各自独立 fetch 同一个 illustId
                    if (self._userIdCache[illustId]) {
                        userId = self._userIdCache[illustId];
                    } else {
                        try {
                            const res = await fetch(`/ajax/illust/${illustId}`).then(r => r.json());
                            userId = res?.body?.userId;
                            if (userId) self._userIdCache[illustId] = userId;
                        } catch (e) { }
                    }
                }

                return { illustId, userId, token, pageIndex };
            },

            _getExactButtons: (illustId) => {
                let likeBtn = null, followBtn = null, authorName = '';
                const isMain = illustId === window.location.pathname.match(/artworks\/(\d+)/)?.[1];

                if (isMain) {
                    likeBtn = document.querySelector('[data-ga4-label="bookmark_button"] button, .gtm-main-bookmark, button svg path[d*="M21,5.5"]')?.closest('button');
                    followBtn = document.querySelector('[data-click-label="follow"], .gtm-main-follow');
                    authorName = document.querySelector('.user-name, [data-click-label="creator"]')?.textContent || '';
                } else if (illustId) {
                    const link = document.querySelector(`a[href*="/artworks/${illustId}"]`);
                    if (link) {
                        const container = link.closest('li') || link.parentElement.parentElement || link.parentElement;
                        if (container) {
                            likeBtn = container.querySelector('button svg path[d*="M21,5.5"], button svg')?.closest('button');
                            followBtn = container.querySelector('[data-click-label="follow"]');
                            authorName = container.querySelector('.user-name, [data-click-label="creator"]')?.textContent || '';
                        }
                    }
                }
                if (!followBtn) followBtn = document.querySelector('[data-click-label="follow"], .gtm-main-follow');
                return { likeBtn, followBtn, authorName };
            },

            getStates: async (container, media) => {
                const ctx = await Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getPixivContext(media);
                const btns = Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getExactButtons(ctx.illustId);

                let isLiked = false;
                if (btns.likeBtn) {
                    isLiked = btns.likeBtn.innerHTML.includes('rgb(255, 64, 96)') ||
                        btns.likeBtn.innerHTML.includes('#FF4060') ||
                        btns.likeBtn.getAttribute('aria-pressed') === 'true';
                }

                let isFollowed = false;
                if (btns.followBtn) {
                    isFollowed = /已关注|Following/i.test(btns.followBtn.textContent) ||
                        btns.followBtn.dataset.clickAction === 'unfollow' ||
                        btns.followBtn.getAttribute('aria-pressed') === 'true' ||
                        btns.followBtn.dataset.variant === 'Secondary';
                }

                return { isLiked, isFollowed, authorName: btns.authorName };
            },

            like: async (container, media) => {
                if (window.__mix01PixivLikeLock) return null;
                window.__mix01PixivLikeLock = true;

                try {
                    const ctx = await Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getPixivContext(media);
                    const btns = Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getExactButtons(ctx.illustId);
                    const btn = btns.likeBtn;

                    let isCurrentlyLiked = false;
                    if (btn) {
                        isCurrentlyLiked = btn.innerHTML.includes('rgb(255, 64, 96)') || btn.innerHTML.includes('#FF4060') || btn.getAttribute('aria-pressed') === 'true';
                    }

                    const src = media ? (media.src || 'video') : '';
                    if (window.__mix01LikeMediaCache && window.__mix01LikeMediaCache[src] !== undefined) {
                        isCurrentlyLiked = window.__mix01LikeMediaCache[src];
                    }

                    if (!isCurrentlyLiked) {
                        if (ctx.illustId && ctx.token) {
                            try {
                                await fetch('/ajax/illusts/bookmarks/add', {
                                    method: 'POST',
                                    headers: { 'x-csrf-token': ctx.token, 'content-type': 'application/json', 'accept': 'application/json' },
                                    body: JSON.stringify({ illust_id: ctx.illustId, restrict: 0, comment: '', tags: [] })
                                });
                                if (btn) {
                                    btn.innerHTML = btn.innerHTML.replace(/currentColor|#\w{3,6}/g, '#FF4060');
                                    btn.setAttribute('aria-pressed', 'true');
                                }
                                return true;
                            } catch (e) { }
                        }
                        if (btn) { tools.forceClick(btn); return true; }
                    } else {
                        if (btn) {
                            tools.forceClick(btn);
                            return false;
                        }
                    }
                    return null;
                } finally {
                    setTimeout(() => { window.__mix01PixivLikeLock = false; }, 400);
                }
            },

            follow: async (container, media) => {
                if (window.__mix01PixivFollowLock) return null;
                window.__mix01PixivFollowLock = true;

                try {
                    const ctx = await Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getPixivContext(media);
                    const btns = Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getExactButtons(ctx.illustId);
                    const btn = btns.followBtn;

                    let isCurrentlyFollowed = false;
                    if (btn) {
                        isCurrentlyFollowed = /已关注|Following/i.test(btn.textContent) || btn.dataset.clickAction === 'unfollow' || btn.getAttribute('aria-pressed') === 'true' || btn.dataset.variant === 'Secondary';
                    }

                    if (btns.authorName && window.__mix01FollowAuthorCache && window.__mix01FollowAuthorCache[btns.authorName] !== undefined) {
                        isCurrentlyFollowed = window.__mix01FollowAuthorCache[btns.authorName];
                    }

                    if (!isCurrentlyFollowed) {
                        if (ctx.userId && ctx.token) {
                            try {
                                const formData = new URLSearchParams(); formData.append('mode', 'add'); formData.append('type', 'user'); formData.append('user_id', ctx.userId); formData.append('tag', ''); formData.append('restrict', '0'); formData.append('format', 'json');
                                await fetch('/bookmark_add.php', { method: 'POST', headers: { 'x-csrf-token': ctx.token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData.toString() });
                                if (btn) {
                                    btn.textContent = '已关注';
                                    btn.dataset.variant = 'Secondary';
                                    btn.setAttribute('aria-pressed', 'true');
                                }
                                return true;
                            } catch (e) { }
                        }
                        if (btn) { tools.forceClick(btn); return true; }
                    } else {
                        if (ctx.userId && ctx.token) {
                            try {
                                const formData = new URLSearchParams(); formData.append('mode', 'delete'); formData.append('type', 'user'); formData.append('user_id', ctx.userId);
                                await fetch('/bookmark_add.php', { method: 'POST', headers: { 'x-csrf-token': ctx.token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData.toString() });
                                if (btn) {
                                    btn.textContent = '关注';
                                    btn.dataset.variant = 'Primary';
                                    btn.setAttribute('aria-pressed', 'false');
                                }
                                return false;
                            } catch (e) { }
                        }
                        if (btn) { tools.forceClick(btn); return false; }
                    }
                    return null;
                } finally {
                    setTimeout(() => { window.__mix01PixivFollowLock = false; }, 400);
                }
            },

            downloadVideo: async (container, media) => {
                const ctx = await Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getPixivContext(media);
                if (!ctx.illustId) return null;
                try {
                    const res = await fetch(`/ajax/illust/${ctx.illustId}/pages`).then(r => r.json());
                    // 修复：使用匹配到的 ctx.pageIndex 获取准确的图片，而不是永远取 [0]
                    if (res && !res.error && res.body && res.body.length > ctx.pageIndex) {
                        return res.body[ctx.pageIndex].urls.original;
                    } else if (res && !res.error && res.body && res.body.length > 0) {
                        return res.body[0].urls.original; // 兜底返回第一张
                    }
                } catch (e) { }
                return null;
            }
        },
        // ==========================================
        // 全局兜底规则：针对未适配页面的沉浸模式
        // ==========================================
        '.*': {
            isFallback: true,
            getContainer: (media) => media.parentElement || document.body,
            getGalleryImages: () => {
                const allMedia = Array.from(document.querySelectorAll('img, video'));
                const validMedia = [];
                const viewportHeight = window.innerHeight;
                const topBound = -viewportHeight * 1.5;
                const bottomBound = viewportHeight * 2.5;

                for (let i = 0; i < allMedia.length; i++) {
                    const media = allMedia[i];
                    if (media.id === 'zoom-img-xyz' || media.id === 'zoom-canvas-xyz' || media.id === 'zoom-video-xyz') continue;

                    const rect = media.getBoundingClientRect();
                    if (rect.top < topBound || rect.bottom > bottomBound) continue;

                    // 【优化 1】：完全剔除 getComputedStyle
                    if (rect.width > 80 && rect.height > 80) {
                        validMedia.push(media);
                    }
                }
                return validMedia;
            },
            getStates: () => ({ isLiked: null, isFollowed: null, authorName: '' }),
            like: async () => null,
            follow: async () => null,
            downloadVideo: async (container, media) => {
                if (media && window.Mix01RuleEngine) return await window.Mix01RuleEngine.getHighResUrl(media, media.src || '');
                return media ? media.src : null;
            }
        }
    };

    const regexCacheHost = {};
    window.Mix01ImmersiveEngine = {
        configs: Mix01ImmersiveRules,
        getAdapter(host) {
            for (const pattern in this.configs) {
                if (!regexCacheHost[pattern]) regexCacheHost[pattern] = new RegExp(`^${pattern}$`);
                if (regexCacheHost[pattern].test(host)) return this.configs[pattern];
            }
            return null;
        }
    };
})();