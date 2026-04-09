// immersive-rules.js
// Mix01 沉浸模式专属动作库 (内置原生 GraphQL API + Pixiv 纯后台 AJAX API)

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
        '(?:(?:.+\\.)?twitter|x)\\.com': {
            getContainer: (media) => media.closest('article') || document.body,
            getGalleryImages: () => {
                return Array.from(document.querySelectorAll('img, video')).filter(media => {
                    if (media.id === 'zoom-img-xyz' || media.id === 'zoom-canvas-xyz') return false;
                    const rect = media.getBoundingClientRect();
                    if (rect.width <= 50 || rect.height <= 50 || window.getComputedStyle(media).display === 'none') return false;
                    const article = media.closest('article');
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
            downloadVideo: async (container) => {
                const statusLink = container.querySelector('a[href*="/status/"]');
                if (!statusLink) return null;
                const statusId = statusLink.href.split('/status/').pop().split(/[\/?#]/).shift();

                const cookies = {};
                document.cookie.split(';').filter(n => n.indexOf('=') > 0).forEach(n => {
                    n.replace(/^([^=]+)=(.+)$/, (match, name, value) => { cookies[name.trim()] = value.trim(); });
                });

                if (!cookies.ct0) return null; 

                const baseUrl = `https://${window.location.hostname}/i/api/graphql/2ICDjqPd81tulZcYrtpTuQ/TweetResultByRestId`;
                const variables = { 'tweetId': statusId, 'with_rux_injections': false, 'includePromotedContent': true, 'withCommunity': true, 'withQuickPromoteEligibilityTweetFields': true, 'withBirdwatchNotes': true, 'withVoice': true, 'withV2Timeline': true };
                const features = { 'articles_preview_enabled': true, 'c9s_tweet_anatomy_moderator_badge_enabled': true, 'communities_web_enable_tweet_community_results_fetch': false, 'creator_subscriptions_quote_tweet_preview_enabled': false, 'creator_subscriptions_tweet_preview_api_enabled': false, 'freedom_of_speech_not_reach_fetch_enabled': true, 'graphql_is_translatable_rweb_tweet_is_translatable_enabled': true, 'longform_notetweets_consumption_enabled': false, 'longform_notetweets_inline_media_enabled': true, 'longform_notetweets_rich_text_read_enabled': false, 'premium_content_api_read_enabled': false, 'profile_label_improvements_pcf_label_in_post_enabled': true, 'responsive_web_edit_tweet_api_enabled': false, 'responsive_web_enhance_cards_enabled': false, 'responsive_web_graphql_exclude_directive_enabled': false, 'responsive_web_graphql_skip_user_profile_image_extensions_enabled': false, 'responsive_web_graphql_timeline_navigation_enabled': false, 'responsive_web_grok_analysis_button_from_backend': false, 'responsive_web_grok_analyze_button_fetch_trends_enabled': false, 'responsive_web_grok_analyze_post_followups_enabled': false, 'responsive_web_grok_image_annotation_enabled': false, 'responsive_web_grok_share_attachment_enabled': false, 'responsive_web_grok_show_grok_translated_post': false, 'responsive_web_jetfuel_frame': false, 'responsive_web_media_download_video_enabled': false, 'responsive_web_twitter_article_tweet_consumption_enabled': true, 'rweb_tipjar_consumption_enabled': true, 'rweb_video_screen_enabled': false, 'standardized_nudges_misinfo': true, 'tweet_awards_web_tipping_enabled': false, 'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled': true, 'tweetypie_unmention_optimization_enabled': false, 'verified_phone_label_enabled': false, 'view_counts_everywhere_api_enabled': true };

                const url = encodeURI(`${baseUrl}?variables=${JSON.stringify(variables)}&features=${JSON.stringify(features)}`);
                const headers = {
                    'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
                    'x-twitter-active-user': 'yes',
                    'x-twitter-client-language': cookies.lang || 'en',
                    'x-csrf-token': cookies.ct0
                };
                if (cookies.ct0.length === 32 && cookies.gt) headers['x-guest-token'] = cookies.gt;

                try {
                    const response = await fetch(url, { headers: headers });
                    const json = await response.json();
                    const tweetResult = json.data?.tweetResult?.result;
                    if (!tweetResult) return null;
                    const tweet = tweetResult.tweet || tweetResult;
                    let legacy = tweet.legacy;
                    if (!legacy?.extended_entities?.media && tweet.quoted_status_result?.result?.legacy?.extended_entities?.media) {
                        legacy = tweet.quoted_status_result.result.legacy;
                    }
                    const medias = legacy?.extended_entities?.media;
                    if (!medias || !Array.isArray(medias)) return null;

                    let maxBitrate = -1;
                    let videoUrl = null;
                    medias.forEach(media => {
                        if (media.type === 'video' || media.type === 'animated_gif') {
                            if (media.video_info && media.video_info.variants) {
                                media.video_info.variants.forEach(v => {
                                    if (v.content_type === 'video/mp4' && (v.bitrate || 0) > maxBitrate) {
                                        maxBitrate = v.bitrate || 0;
                                        videoUrl = v.url;
                                    }
                                });
                            }
                        }
                    });
                    return videoUrl;
                } catch (e) {
                    console.warn("Mix01 官方 API 抓取失败:", e);
                    return null;
                }
            }
        },

        // ==========================================
        // 2. Pixiv 沉浸交互规则 (智能 API 脱离 DOM 限制版)
        // ==========================================
        '(?:.+\\.)?pixiv\\.net': {
            getContainer: (media) => document.body,
            
            // 获取画集ID与全局Token
            _getContext: (media) => {
                let illustId = window.location.pathname.match(/artworks\/(\d+)/)?.[1];
                if (!illustId && media && media.src) {
                    const m = media.src.match(/\/(\d+)_p/);
                    if (m) illustId = m[1];
                }
                let token = window.pixiv?.context?.token || '';
                if (!token) {
                    const meta = document.querySelector('#meta-global-data');
                    if (meta) { try { token = JSON.parse(meta.content).token; } catch(e){} }
                }
                return { illustId, token };
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
                const ctx = Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getContext(media);
                if (ctx.illustId && ctx.token) {
                    try {
                        // 无视页面上有没有按钮，直接发包点赞
                        await fetch('/ajax/illusts/bookmarks/add', {
                            method: 'POST',
                            headers: { 'x-csrf-token': ctx.token, 'content-type': 'application/json' },
                            body: JSON.stringify({ illust_id: ctx.illustId, restrict: 0, comment: '', tags: [] })
                        });
                        
                        // 同步按一下UI
                        const btn = container.querySelector('.gtm-main-bookmark, [data-click-action="like"], [data-click-label="like"] button, button svg path[d*="M12"]')?.closest('button');
                        if (btn) tools.forceClick(btn);
                        return true; 
                    } catch(e) { console.warn("Pixiv API 点赞失败", e); }
                }

                // 兜底 DOM
                const btn = container.querySelector('.gtm-main-bookmark, [data-click-action="like"], [data-click-label="like"] button, button svg path[d*="M12"]')?.closest('button');
                if (btn) { tools.forceClick(btn); return true; }
                return null;
            },

            follow: async (container, media) => {
                const ctx = Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getContext(media);
                
                let userId = null;
                const authorLink = container.querySelector('a[data-click-label="creator"]') || document.querySelector('a.user-name') || (media ? media.closest('a')?.previousElementSibling?.querySelector('a') : null);
                if (authorLink) {
                    const m = authorLink.getAttribute('href')?.match(/users\/(\d+)/);
                    if (m) userId = m[1];
                }

                // 如果没找到 User ID，但是有 Illust ID，就去 API 拿 User ID
                if (!userId && ctx.illustId) {
                    try {
                        const res = await fetch(`/ajax/illust/${ctx.illustId}`).then(r => r.json());
                        userId = res?.body?.userId;
                    } catch(e){}
                }

                if (userId && ctx.token) {
                    try {
                        const formData = new URLSearchParams();
                        formData.append('mode', 'add');
                        formData.append('type', 'user');
                        formData.append('user_id', userId);
                        formData.append('tag', '');
                        formData.append('restrict', '0');
                        formData.append('format', 'json');

                        await fetch('/bookmark_add.php', {
                            method: 'POST',
                            headers: { 'x-csrf-token': ctx.token, 'Content-Type': 'application/x-www-form-urlencoded' },
                            body: formData.toString()
                        });

                        const btn = container.querySelector('.gtm-main-follow, [data-click-action="follow"], [data-click-label="follow"]');
                        if (btn) tools.forceClick(btn);
                        return true;
                    } catch(e) { console.warn("Pixiv API 关注失败", e); }
                }
                
                const btn = container.querySelector('.gtm-main-follow, [data-click-action="follow"], [data-click-label="follow"]');
                if (btn) { tools.forceClick(btn); return true; }
                return null;
            },

            downloadVideo: async (container, media) => {
                 const ctx = Mix01ImmersiveRules['(?:.+\\.)?pixiv\\.net']._getContext(media);
                 if (!ctx.illustId) return null;
                 try {
                     const res = await fetch(`/ajax/illust/${ctx.illustId}/pages`).then(r => r.json());
                     if (res && !res.error && res.body && res.body.length > 0) {
                         return res.body[0].urls.original;
                     }
                 } catch(e) { console.warn("Pixiv 原图 API 提取失败", e); }
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