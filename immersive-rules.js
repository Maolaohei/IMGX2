// immersive-rules.js
// Mix01 沉浸模式专属动作库 (独立引擎)

(function () {
    const tools = {
        forceClick: function(el) {
            if (!el) return;
            const opts = { bubbles: true, cancelable: true, view: window };
            el.dispatchEvent(new MouseEvent('mouseover', opts));
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
        }
    };

    const Mix01ImmersiveRules = {
        // ==========================================
        // 1. Twitter / X 沉浸交互规则
        // ==========================================
        '(?:(?:.+\\.)?twitter|x)\\.com': {
            getContainer: (img) => img.closest('article') || document.body,
            
            // 智能过滤去广告
            getGalleryImages: () => {
                return Array.from(document.querySelectorAll('img')).filter(img => {
                    if (img.id === 'zoom-img-xyz') return false;
                    const rect = img.getBoundingClientRect();
                    if (rect.width <= 50 || rect.height <= 50 || window.getComputedStyle(img).display === 'none') return false;
                    
                    const article = img.closest('article');
                    if (article) {
                        const isAd = Array.from(article.querySelectorAll('span')).some(span => /^(广告|赞助|Ad|Promoted)$/i.test(span.textContent.trim()));
                        if (isAd) return false;
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
                if (userNameEl) {
                    const match = userNameEl.textContent.match(/@[\w_]+/);
                    if (match) author = match[0];
                }
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
                let targetBtn = null;
                let willFollow = true;
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
            }
        },

        // ==========================================
        // 2. Pixiv 沉浸交互规则
        // ==========================================
        '(?:.+\\.)?pixiv\\.net': {
            getContainer: (img) => document.body,
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
            like: async (container) => {
                const btn = container.querySelector('.gtm-main-bookmark, [data-click-action="like"], [data-click-label="like"] button, button svg path[d*="M12"]')?.closest('button');
                if (btn) {
                    const isCurrentlyLiked = btn.innerHTML.includes('rgb(255, 64, 96)') || btn.innerHTML.includes('#FF4060') || btn.getAttribute('aria-pressed') === 'true';
                    tools.forceClick(btn);
                    return !isCurrentlyLiked;
                }
                return null;
            },
            follow: async (container) => {
                const btn = container.querySelector('.gtm-main-follow, [data-click-action="follow"], [data-click-label="follow"]');
                if (btn) {
                    const isCurrentlyFollowed = /已关注|Following/i.test(btn.textContent) || btn.dataset.clickAction === 'unfollow' || btn.getAttribute('aria-pressed') === 'true';
                    tools.forceClick(btn);
                    return !isCurrentlyFollowed;
                }
                return null;
            }
        }
    };

    // 暴露统一调用接口给 Content.js
    window.Mix01ImmersiveEngine = {
        configs: Mix01ImmersiveRules,
        getAdapter(host) {
            for (const pattern in this.configs) {
                if (new RegExp(`^${pattern}$`).test(host)) {
                    return this.configs[pattern];
                }
            }
            return null;
        }
    };
})();