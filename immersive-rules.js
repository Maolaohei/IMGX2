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
                if (!window.__mix01AdCache) window.__mix01AdCache = new WeakSet();
                if (!window.__mix01NonAdCache) window.__mix01NonAdCache = new WeakSet();
                
                const allMedia = Array.from(document.querySelectorAll('img, video'));
                const validMedia = [];

                // 【核心算法优化：视口深度截断】
                // 提前获取视口高度，避免在循环中反复读取引发重排
                const viewportHeight = window.innerHeight;
                // 设定上下 1.5 屏的缓冲区域（在此区域外的媒体直接忽略，不参与耗时的属性计算）
                const topBound = -viewportHeight * 1.5;
                const bottomBound = viewportHeight * 2.5;

                for (let i = 0; i < allMedia.length; i++) {
                    const media = allMedia[i];
                    if (media.id === 'zoom-img-xyz' || media.id === 'zoom-canvas-xyz' || media.id === 'zoom-video-xyz') continue;

                    // 获取当前元素的位置
                    const rect = media.getBoundingClientRect();

                    // 【性能拦截器】：如果图片距离当前视口太远，直接跳过！极大降低计算量
                    if (rect.top < topBound || rect.bottom > bottomBound) continue;

                    // 只有在视野附近的元素，才去进行昂贵的尺寸判断和 DOM 树回溯
                    if (rect.width <= 50 || rect.height <= 50 || window.getComputedStyle(media).display === 'none') continue;
                    
                    const article = media.closest('article');
                    if (article) {
                        if (window.__mix01AdCache.has(article)) continue;
                        if (window.__mix01NonAdCache.has(article)) {
                            validMedia.push(media);
                            continue;
                        }
                        const isAd = Array.from(article.querySelectorAll('span')).some(span => /^(广告|赞助|Ad|Promoted)$/i.test(span.textContent.trim()));
                        if (isAd) { 
                            window.__mix01AdCache.add(article); 
                            continue; 
                        } else { 
                            window.__mix01NonAdCache.add(article); 
                            validMedia.push(media);
                            continue;
                        }
                    }
                    validMedia.push(media);
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
            follow: async (container) => {
                let author = ""; const userNameEl = container.querySelector('[data-testid="User-Name"]');
                if (userNameEl) { const match = userNameEl.textContent.match(/@[\w_]+/); if (match) author = match[0]; }
                const profileScope = document.querySelector('[data-testid="primaryColumn"]');
                if (profileScope) {
                    const btnUnfollow = profileScope.querySelector('[data-testid$="-unfollow"]'), btnFollow = profileScope.querySelector('[data-testid$="-follow"]');
                    if (btnUnfollow) {
                        tools.forceClick(btnUnfollow); await new Promise(r => setTimeout(r, 150));
                        const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
                        if (confirm) tools.forceClick(confirm);
                        if (author && window.__mix01FollowCache) window.__mix01FollowCache[author] = false; return false;
                    } else if (btnFollow) {
                        tools.forceClick(btnFollow);
                        if (author && window.__mix01FollowCache) window.__mix01FollowCache[author] = true; return true;
                    }
                }
                const caret = container.querySelector('[data-testid="caret"]'); if (!caret) return null;
                tools.forceClick(caret); await new Promise(r => setTimeout(r, 150));
                const menus = Array.from(document.querySelectorAll('[role="menu"]'));
                const menu = menus[menus.length - 1]; if (!menu) return null;
                const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
                let targetBtn = null, willFollow = true;
                for (let item of items) {
                    const text = item.textContent || '';
                    if (/Unfollow|取消关注/i.test(text)) { targetBtn = item; willFollow = false; break; }
                    else if (/Follow|关注/i.test(text)) { targetBtn = item; willFollow = true; break; }
                }
                if (!targetBtn) { tools.forceClick(document.body); return null; }
                tools.forceClick(targetBtn);
                if (!willFollow) {
                    await new Promise(r => setTimeout(r, 200));
                    const confirmBtn = document.querySelector('[data-testid="confirmationSheetConfirm"]');
                    if (confirmBtn) tools.forceClick(confirmBtn);
                    else {
                        const dialog = document.querySelector('[role="dialog"], [data-testid="mask"]');
                        if (dialog) { const btns = Array.from(dialog.querySelectorAll('[role="button"]')); const confirmTarget = btns.find(b => /Unfollow|取消关注|确认/i.test(b.textContent)); if (confirmTarget) tools.forceClick(confirmTarget); }
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

            _getPixivContext: async (media) => {
                let illustId = null;

                // 1. 【最精确】从沉浸模式的媒体 src 中提取 ID
                if (media && media.src) {
                    const m = media.src.match(/\/(\d+)_/);
                    if (m) illustId = m[1];
                }
                // 2. 从父级 a 标签提取
                if (!illustId && media) {
                    const parentA = media.closest('a');
                    if (parentA && parentA.href) {
                        const m = parentA.href.match(/artworks\/(\d+)/);
                        if (m) illustId = m[1];
                    }
                }
                // 3. 兜底：当前网页主图 ID
                if (!illustId) {
                    illustId = window.location.pathname.match(/artworks\/(\d+)/)?.[1];
                }

                let userId = null;
                // 顺藤摸瓜：通过 illustId 找到它对应的画师链接
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

                if (illustId && !userId) {
                    try {
                        const res = await fetch(`/ajax/illust/${illustId}`).then(r => r.json());
                        userId = res?.body?.userId;
                    } catch (e) { }
                }
                return { illustId, userId, token };
            },

            // 【核心新增】精确制导搜寻当前 ID 对应的按钮
            _getExactButtons: (illustId) => {
                let likeBtn = null, followBtn = null, authorName = '';
                const isMain = illustId === window.location.pathname.match(/artworks\/(\d+)/)?.[1];

                if (isMain) {
                    likeBtn = document.querySelector('[data-ga4-label="bookmark_button"] button, .gtm-main-bookmark, button svg path[d*="M21,5.5"]')?.closest('button');
                    followBtn = document.querySelector('[data-click-label="follow"], .gtm-main-follow');
                    authorName = document.querySelector('.user-name, [data-click-label="creator"]')?.textContent || '';
                } else if (illustId) {
                    // 它是瀑布流里的小图，去寻找它真正的主人
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
                // 关注按钮的兜底
                if (!followBtn) followBtn = document.querySelector('[data-click-label="follow"], .gtm-main-follow');
                return { likeBtn, followBtn, authorName };
            },

            getStates: async (container, media) => {
                // 读取状态时，强制等待上下文解析完毕（此方法被我重构为了异步）
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
                // 【并发防封号锁】防止键盘连按导致请求风暴
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
                                // 纯视觉涂红
                                if (btn) {
                                    btn.innerHTML = btn.innerHTML.replace(/currentColor|#\w{3,6}/g, '#FF4060');
                                    btn.setAttribute('aria-pressed', 'true');
                                }
                                return true;
                            } catch (e) {}
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
                    // 请求结束后，延迟 400ms 解锁，保护后端 API
                    setTimeout(() => { window.__mix01PixivLikeLock = false; }, 400);
                }
            },

            follow: async (container, media) => {
                // 【并发防封号锁】
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
                            } catch (e) {}
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
                            } catch (e) {}
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
                    if (res && !res.error && res.body && res.body.length > 0) {
                        return res.body[0].urls.original;
                    }
                } catch (e) {}
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
                    
                    // 全局兜底同样应用视口截断
                    if (rect.top < topBound || rect.bottom > bottomBound) continue;
                    
                    if (rect.width > 80 && rect.height > 80 && window.getComputedStyle(media).display !== 'none') {
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