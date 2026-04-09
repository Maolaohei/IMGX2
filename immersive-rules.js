// immersive-rules.js
// Mix01 沉浸模式专属动作库 (独立适配器 视频与Canvas兼容版)

(function () {
    // 通用 DOM 交互工具库
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
            // 获取当前媒体所属的容器（用于圈定查找点赞/关注按钮的范围）
            getContainer: (media) => media.closest('article') || document.body,
            
            // 核心更新：完美兼容 Canvas 引擎，将 <video> 纳入画廊，并精准过滤推特信息流广告
            getGalleryImages: () => {
                return Array.from(document.querySelectorAll('img, video')).filter(media => {
                    // 【防误伤】绝对忽略扩展自身注入的各类组件
                    if (media.id === 'zoom-img-xyz' || media.id === 'zoom-video-xyz' || media.id === 'zoom-canvas-xyz') return false;
                    
                    const rect = media.getBoundingClientRect();
                    if (rect.width <= 50 || rect.height <= 50 || window.getComputedStyle(media).display === 'none') return false;
                    
                    const article = media.closest('article');
                    if (article) {
                        // 智能识别并剔除时间线上的广告推文，防止沉浸模式播放广告视频
                        const isAd = Array.from(article.querySelectorAll('span')).some(span => /^(广告|赞助|Ad|Promoted)$/i.test(span.textContent.trim()));
                        if (isAd) return false;
                    }
                    return true;
                });
            },
            
            // 状态读取器：无痕读取当前推文的点赞和关注状态
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
            
            // 幽灵点赞动作
            like: async (container) => {
                const btnLike = container.querySelector('[data-testid="like"]');
                const btnUnlike = container.querySelector('[data-testid="unlike"]');
                if (btnUnlike) { tools.forceClick(btnUnlike); return false; } // 取消喜欢
                if (btnLike) { tools.forceClick(btnLike); return true; }     // 喜欢
                return null;
            },
            
            // 幽灵关注动作（绕过推特的复杂菜单结构）
            follow: async (container) => {
                let author = "";
                const userNameEl = container.querySelector('[data-testid="User-Name"]');
                if (userNameEl) {
                    const match = userNameEl.textContent.match(/@[\w_]+/);
                    if (match) author = match[0];
                }
                
                // 场景 A：在个人主页
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
                
                // 场景 B：在信息流页面（通过推文右上角的菜单）
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
                
                if (!targetBtn) { tools.forceClick(document.body); return null; } // 收起菜单
                
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
            getContainer: (media) => document.body,
            getGalleryImages: () => {
                // 针对 Pixiv 的通用画廊提取（剔除扩展自身组件）
                return Array.from(document.querySelectorAll('img, video')).filter(media => {
                    if (media.id === 'zoom-img-xyz' || media.id === 'zoom-video-xyz' || media.id === 'zoom-canvas-xyz') return false;
                    const rect = media.getBoundingClientRect();
                    return rect.width > 50 && rect.height > 50 && window.getComputedStyle(media).display !== 'none';
                });
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
        
        // 此处可以继续优雅地追加 Bilibili, Instagram 等站点的动作规则，完全不干扰主引擎
    };

    // 域名正则缓存池，极限压榨性能
    const regexCacheHost = {};

    window.Mix01ImmersiveEngine = {
        configs: Mix01ImmersiveRules,
        // 根据当前域名分发对应的适配器
        getAdapter(host) {
            for (const pattern in this.configs) {
                if (!regexCacheHost[pattern]) regexCacheHost[pattern] = new RegExp(`^${pattern}$`);
                if (regexCacheHost[pattern].test(host)) {
                    return this.configs[pattern];
                }
            }
            return null; // 若无特定规则，返回 null，由主引擎接管默认逻辑
        }
    };
})();