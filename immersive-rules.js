// immersive-rules.js
// 纯粹的 UI 交互与 DOM 状态适配器 (API 提取逻辑已剥离至 rules-engine)
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

                return Array.from(document.querySelectorAll('img, video')).filter(media => {
                    if (media.id === 'zoom-img-xyz' || media.id === 'zoom-canvas-xyz' || media.id === 'zoom-video-xyz') return false;
                    const rect = media.getBoundingClientRect();
                    if (rect.width <= 50 || rect.height <= 50 || window.getComputedStyle(media).display === 'none') return false;
                    const article = media.closest('article');
                    if (article) {
                        if (window.__mix01AdCache.has(article)) return false;
                        if (window.__mix01NonAdCache.has(article)) return true;
                        const isAd = Array.from(article.querySelectorAll('span')).some(span =>
                            /^(广告|赞助|Ad|Promoted)$/i.test(span.textContent.trim())
                        );
                        if (isAd) { window.__mix01AdCache.add(article); return false; }
                        else { window.__mix01NonAdCache.add(article); return true; }
                    }
                    return true;
                });
            },
            getStates: (container) => {
                const likeBtn = container.querySelector('[data-testid="unlike"]');
                let author = "";
                const userNameEl = container.querySelector('[data-testid="User-Name"]');
                if (userNameEl) {
                    const match = userNameEl.textContent.match(/@[\w_]+/);
                    if (match) author = match[0];
                }
                let isFollowed = null;
                const profileScope = document.querySelector('[data-testid="primaryColumn"]');
                if (profileScope) {
                    if (profileScope.querySelector('[data-testid$="-unfollow"]')) isFollowed = true;
                    else if (profileScope.querySelector('[data-testid$="-follow"]')) isFollowed = false;
                }
                if (isFollowed === null && author && window.__mix01FollowCache && window.__mix01FollowCache[author] !== undefined) {
                    isFollowed = window.__mix01FollowCache[author];
                }
                return { isLiked: !!likeBtn, isFollowed: isFollowed, authorName: author };
            },
            like: async (container) => {
                const btnLike = container.querySelector('[data-testid="like"]');
                const btnUnlike = container.querySelector('[data-testid="unlike"]');
                if (btnUnlike) { tools.forceClick(btnUnlike); return false; }
                if (btnLike) { tools.forceClick(btnLike); return true; }
                return null;
            },
            follow: async (container) => {
                let author = "";
                const userNameEl = container.querySelector('[data-testid="User-Name"]');
                if (userNameEl) { const match = userNameEl.textContent.match(/@[\w_]+/); if (match) author = match[0]; }
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
                const caret = container.querySelector('[data-testid="caret"]');
                if (!caret) return null;
                tools.forceClick(caret);
                await new Promise(r => setTimeout(r, 150));
                const menus = Array.from(document.querySelectorAll('[role="menu"]'));
                const menu = menus[menus.length - 1];
                if (!menu) return null;
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
                    if (confirmBtn) { tools.forceClick(confirmBtn); }
                    else {
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
                // 仅保留原生 UI 按钮的触发逻辑，这是属于 DOM 交互的范畴
                const customSvgBtn = container.querySelector('svg g.download');
                if (customSvgBtn) {
                    const btn = customSvgBtn.closest('button') || customSvgBtn.closest('div[role="button"]') || customSvgBtn.closest('a');
                    if (btn) { btn.click(); return 'NATIVE_CLICKED'; }
                }

                const shareGroup = container.querySelector('[role="group"]');
                if (shareGroup) {
                    const buttons = Array.from(shareGroup.querySelectorAll('[role="button"], a'));
                    const nativeDownloadBtn = buttons.find(b => {
                        const label = (b.getAttribute('aria-label') || '').toLowerCase();
                        const testId = (b.getAttribute('data-testid') || '').toLowerCase();
                        return label.includes('download') || label.includes('下载') || testId.includes('download');
                    });
                    if (nativeDownloadBtn) { nativeDownloadBtn.click(); return 'NATIVE_CLICKED'; }
                }

                // 核心路由：遇到需要解析直链的，统统交给 Rules Engine
                if (media && window.Mix01RuleEngine) {
                    return await window.Mix01RuleEngine.getHighResUrl(media, media.src || '');
                }
                return null;
            }
        },

        '(?:.+\\.)?pixiv\\.net': {
            getContainer: (media) => document.body,

            _getPixivContext: async (media) => {
                let illustId = window.location.pathname.match(/artworks\/(\d+)/)?.[1];
                if (!illustId && media && media.src) {
                    const m = media.src.match(/\/(\d+)_p/);
                    if (m) illustId = m[1];
                }

                let userId = null;
                const container = media ? (media.closest('li') || media.closest('[role="presentation"]') || document.body) : document.body;
                const authorLink = container.querySelector('a[data-click-label="creator"], a[href*="/users/"]');
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

            getStates: (container) => {
                const likeBtn = container.querySelector('.gtm-main-bookmark, [data-click-action="like"], [data-click-label="like"] button, button svg path[d*="M12"]')?.closest('button');
                let isLiked = false;
                if (likeBtn) isLiked = likeBtn.innerHTML.includes('rgb(255, 64, 96)') || likeBtn.innerHTML.includes('#FF4060') || likeBtn.getAttribute('aria-pressed') === 'true';

                const followBtn = container.querySelector('.gtm-main-follow, [data-click-action="follow"], [data-click-label="follow"]');
                let isFollowed = false;
                if (followBtn) isFollowed = /已关注|Following/i.test(followBtn.textContent) || followBtn.dataset.clickAction === 'unfollow' || followBtn.getAttribute('aria-pressed') === 'true';

                let authorName = container.querySelector('.user-name, [data-click-label="creator"]')?.textContent || '';
                return { isLiked, isFollowed, authorName };
            },

            like: async (container, media) => {
                const ctx = await Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getPixivContext(media);
                const btn = container.querySelector('.gtm-main-bookmark, [data-click-action="like"], button svg path[d*="M12"]')?.closest('button');

                let isCurrentlyLiked = false;
                if (btn) isCurrentlyLiked = btn.innerHTML.includes('rgb(255, 64, 96)') || btn.innerHTML.includes('#FF4060') || btn.getAttribute('aria-pressed') === 'true';

                const src = media ? (media.src || 'video') : '';
                if (window.__mix01LikeMediaCache && window.__mix01LikeMediaCache[src] !== undefined) isCurrentlyLiked = window.__mix01LikeMediaCache[src];

                if (!isCurrentlyLiked) {
                    if (ctx.illustId && ctx.token) {
                        try {
                            await fetch('/ajax/illusts/bookmarks/add', {
                                method: 'POST',
                                headers: { 'x-csrf-token': ctx.token, 'content-type': 'application/json', 'accept': 'application/json' },
                                body: JSON.stringify({ illust_id: ctx.illustId, restrict: 0, comment: '', tags: [] })
                            });
                            if (btn) tools.forceClick(btn);
                            return true;
                        } catch (e) {}
                    }
                    if (btn) { tools.forceClick(btn); return true; }
                } else {
                    if (btn) { tools.forceClick(btn); return false; }
                }
                return null;
            },

            follow: async (container, media) => {
                const ctx = await Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getPixivContext(media);
                const btn = container.querySelector('.gtm-main-follow, [data-click-action="follow"]');

                let isCurrentlyFollowed = false;
                if (btn) isCurrentlyFollowed = /已关注|Following/i.test(btn.textContent) || btn.dataset.clickAction === 'unfollow' || btn.getAttribute('aria-pressed') === 'true';

                const authorName = container.querySelector('.user-name, [data-click-label="creator"]')?.textContent || '';
                if (authorName && window.__mix01FollowAuthorCache && window.__mix01FollowAuthorCache[authorName] !== undefined) {
                    isCurrentlyFollowed = window.__mix01FollowAuthorCache[authorName];
                }

                if (!isCurrentlyFollowed) {
                    if (ctx.userId && ctx.token) {
                        try {
                            const formData = new URLSearchParams();
                            formData.append('mode', 'add'); formData.append('type', 'user'); formData.append('user_id', ctx.userId); formData.append('tag', ''); formData.append('restrict', '0'); formData.append('format', 'json');
                            await fetch('/bookmark_add.php', { method: 'POST', headers: { 'x-csrf-token': ctx.token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData.toString() });
                            if (btn) tools.forceClick(btn);
                            return true;
                        } catch (e) {}
                    }
                    if (btn) { tools.forceClick(btn); return true; }
                } else {
                    if (btn) {
                        tools.forceClick(btn); return false;
                    } else if (ctx.userId && ctx.token) {
                        try {
                            const formData = new URLSearchParams(); formData.append('mode', 'delete'); formData.append('type', 'user'); formData.append('user_id', ctx.userId);
                            await fetch('/bookmark_add.php', { method: 'POST', headers: { 'x-csrf-token': ctx.token, 'Content-Type': 'application/x-www-form-urlencoded' }, body: formData.toString() });
                            return false;
                        } catch (e) {}
                    }
                }
                return null;
            },

            downloadVideo: async (container, media) => {
                // 核心路由：如果是 Pixiv，同样直接丢给 Rules Engine 处理 Ajax 提取
                if (media && window.Mix01RuleEngine) {
                    return await window.Mix01RuleEngine.getHighResUrl(media, media.src || '');
                }
                return null;
            }
        }
    };

    const regexCacheHost = {};

    window.Mix01ImmersiveEngine = {
        configs: Mix01ImmersiveRules,
        getAdapter(host) {
            for (const pattern in this.configs) {
                if (!regexCacheHost[pattern]) regexCacheHost[pattern] = new RegExp(`^${pattern}$`);
                if (regexCacheHost[pattern].test(host)) {
                    return this.configs[pattern];
                }
            }
            return null;
        }
    };
})();