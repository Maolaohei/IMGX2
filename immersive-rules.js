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
        },
        // Reading order beats IntersectionObserver insertion order
        sortByDocumentOrder: function (list) {
            if (!list || list.length < 2) return list || [];
            return list
                .filter(el => el && el.isConnected)
                .map((el, idx) => ({ el, idx }))
                .sort((a, b) => {
                    if (a.el === b.el) return 0;
                    const rel = a.el.compareDocumentPosition(b.el);
                    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                    return a.idx - b.idx;
                })
                .map(x => x.el);
        },
        collectCandidateMedia: function () {
            // Prefer a broader DOM sample than only currently-intersecting nodes.
            // Visible-set alone reshuffles when users reverse scroll direction.
            const engineVisible = window.__mix01Engine?.controller?.visibleMediaElements;
            const fromDom = Array.from(document.querySelectorAll('article img, article video, img, video'));
            if (!engineVisible || engineVisible.size === 0) return fromDom;

            const merged = [];
            const seen = new Set();
            for (const el of engineVisible) {
                if (!el || seen.has(el)) continue;
                seen.add(el);
                merged.push(el);
            }
            for (const el of fromDom) {
                if (!el || seen.has(el)) continue;
                seen.add(el);
                merged.push(el);
            }
            return merged;
        },
        isUtilityImage: function (media) {
            if (!media || media.tagName !== 'IMG') return false;
            const src = media.currentSrc || media.src || '';
            if (!src) return true;
            if (src.includes('profile_images') || src.includes('emoji') || src.includes('hashflag')) return true;
            if (src.includes('tweet_video_thumb') || src.includes('ext_tw_video_thumb') ||
                src.includes('amplify_video_thumb') || src.includes('video-thumbnail') ||
                src.includes('video_poster')) return true;
            // Tiny chrome icons / reactions
            if ((media.clientWidth || 0) > 0 && (media.clientWidth || 0) <= 40 &&
                (media.clientHeight || 0) > 0 && (media.clientHeight || 0) <= 40) return true;
            return false;
        },
        collectArticleMedia: function (article) {
            if (!article) return [];
            return Array.from(article.querySelectorAll('img, video')).filter(el => {
                if (!el || !el.isConnected) return false;
                if (el.id === 'zoom-img-xyz' || el.id === 'zoom-img-buffer-xyz' || el.id === 'zoom-video-xyz') return false;
                if (tools.isUtilityImage(el)) return false;
                if (el.tagName === 'VIDEO') return true;
                const src = el.currentSrc || el.src || '';
                // Prefer real media assets; allow large non-twimg fallbacks.
                if (src.includes('/media/') || src.includes('twimg.com/media') || src.includes('pbs.twimg.com/media')) return true;
                const rect = el.getBoundingClientRect();
                return rect.width > 80 && rect.height > 80;
            });
        },
        extractAuthorHandle: function (scope) {
            if (!scope) return '';
            // Only trust the author identity block — never whole-article text (quoted/mentions pollute).
            const userNameEl = scope.querySelector?.('[data-testid="User-Name"]') ||
                scope.querySelector?.('[data-testid="UserName"]');
            if (userNameEl) {
                const m = (userNameEl.textContent || '').match(/@([A-Za-z0-9_]{1,15})/);
                if (m) return '@' + m[1];
                const href = userNameEl.querySelector?.('a[href^="/"]')?.getAttribute('href') || '';
                const hm = href.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
                if (hm && !/^(home|explore|search|i|settings|messages|notifications)$/i.test(hm[1])) {
                    return '@' + hm[1];
                }
            }
            const statusLink = scope.querySelector?.('a[href*="/status/"]');
            if (statusLink) {
                const hm = (statusLink.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})\/status\//);
                if (hm) return '@' + hm[1];
            }
            return '';
        },
        getFollowCache: function () {
            window.__mix01State = window.__mix01State || {};
            window.__mix01State.followAuthorCache = window.__mix01State.followAuthorCache || {};
            window.__mix01FollowCache = window.__mix01State.followAuthorCache;
            return window.__mix01State.followAuthorCache;
        },
        writeFollowCache: function (author, state, meta = null) {
            if (!author || state === undefined || state === null) return;
            const cache = tools.getFollowCache();
            const relation = (state === true) ? 'following'
                : (state === false) ? 'follow'
                : state;
            // meta.confidence: confirmed (menu/button label) | inferred (timeline Following only)
            const confidence = (meta && meta.confidence) ||
                ((relation === 'subscribed' || relation === 'subscribe') ? 'confirmed' : 'inferred');
            const source = (meta && meta.source) || 'unknown';
            cache[author] = {
                relation,
                confidence,
                source,
                ts: Date.now()
            };
            // Keep legacy mirror for any old readers
            window.__mix01FollowCache = cache;
            const keys = Object.keys(cache);
            if (keys.length > 120) {
                for (let i = 0; i < keys.length - 120; i++) delete cache[keys[i]];
            }
        },
        readFollowCacheEntry: function (author) {
            if (!author) return null;
            const cache = tools.getFollowCache();
            const raw = cache[author];
            if (raw == null) return null;
            if (typeof raw === 'string' || typeof raw === 'boolean') {
                const relation = raw === true ? 'following' : raw === false ? 'follow' : raw;
                return {
                    relation,
                    confidence: relation === 'subscribed' ? 'confirmed' : 'inferred',
                    source: 'legacy',
                    ts: 0
                };
            }
            if (typeof raw === 'object') {
                const relation = raw.relation || null;
                if (!relation) return null;
                return {
                    relation,
                    confidence: raw.confidence || (relation === 'subscribed' ? 'confirmed' : 'inferred'),
                    source: raw.source || 'unknown',
                    ts: raw.ts || 0
                };
            }
            return null;
        },
        // following | follow | subscribed | subscribe | null
        classifyRelationControl: function (el) {
            if (!el || el.disabled) return null;
            const testId = (el.getAttribute('data-testid') || '').toLowerCase();
            const aria = (el.getAttribute('aria-label') || '').trim();
            const text = ((el.textContent || '') + ' ' + aria).replace(/\s+/g, ' ').trim();
            const low = text.toLowerCase();

            // Subscription signals first (X often coexists with Following wording)
            if (testId.includes('unsubscribe') || testId.includes('subscribed') || testId.includes('superfollow')) {
                if (testId.includes('unsubscribe') || testId.includes('subscribed') || /ing$/.test(testId)) return 'subscribed';
                return 'subscribe';
            }
            if (/\u5df2\u8ba2\u9605|\u53d6\u6d88\u8ba2\u9605|unsubscribe|subscribed|super\s*subscribed|super.?follow.?ing/i.test(text)) return 'subscribed';
            if ((/\u8ba2\u9605(?!\u4e86)|\bsubscribe\b|super\s*subscribe|super.?follow(?!ing)/i.test(text)) &&
                !/unsubscribe|\u53d6\u6d88\u8ba2\u9605|subscribed/i.test(low)) {
                return 'subscribe';
            }

            // Plain follow / following
            if (testId.endsWith('-unfollow') || testId === 'unfollow') return 'following';
            if (testId.endsWith('-follow') || testId === 'follow') return 'follow';
            if (/\u6b63\u5728\u5173\u6ce8|\u5df2\u5173\u6ce8|\u53d6\u6d88\u5173\u6ce8|\bfollowing\b|unfollow|\u30d5\u30a9\u30ed\u30fc\u4e2d|\u30d5\u30a9\u30ed\u30fc\u89e3\u9664/i.test(text)) return 'following';
            if (/^(\u5173\u6ce8|\u95dc\u8a3b|\u30d5\u30a9\u30ed\u30fc|follow)$/i.test(text) ||
                /\u5173\u6ce8@|\u95dc\u8a3b@|follow @|\u30d5\u30a9\u30ed\u30fc @/i.test(text) ||
                (/\bfollow\b/i.test(low) && !/following|followers|unfollow/i.test(low))) {
                return 'follow';
            }
            return null;
        },
        // Live DOM on timelines often only shows Following even for Super Follow / Subscriptions.
        // Only promote Following -> Subscribed when cache was menu/button confirmed.
        mergeRelation: function (live, cached, cacheMeta = null) {
            const norm = (v) => {
                if (v === true) return 'following';
                if (v === false) return 'follow';
                if (v === 'subscribed' || v === 'following' || v === 'subscribe' || v === 'follow') return v;
                return null;
            };
            live = norm(live);
            cached = norm(cached);
            const confirmed = !!(cacheMeta && cacheMeta.confidence === 'confirmed');

            if (live === 'subscribed') return 'subscribed';
            if (live === 'subscribe') return 'subscribe';
            if (live === 'following') {
                // Timeline rarely exposes Super Follow; sticky only if previously confirmed.
                if (cached === 'subscribed' && confirmed) return 'subscribed';
                return 'following';
            }
            if (live === 'follow') {
                // Explicit Follow CTA clears any prior relation.
                return 'follow';
            }
            // No live control: trust cache only
            return cached || null;
        },
        collectRelationControls: function (scope) {
            if (!scope || !scope.querySelectorAll) return [];
            // Prefer explicit follow/subscribe controls. Avoid scanning every button (false positives).
            const preferred = Array.from(scope.querySelectorAll(
                'button[data-testid$="-follow"], button[data-testid$="-unfollow"], button[data-testid="follow"], button[data-testid="unfollow"], [role="button"][data-testid$="-follow"], [role="button"][data-testid$="-unfollow"], button[data-testid*="subscribe"], button[data-testid*="Subscribe"], button[data-testid*="superFollow"], button[data-testid*="SuperFollow"], [role="button"][data-testid*="subscribe"], [role="button"][data-testid*="SuperFollow"]'
            ));
            let nodes = preferred;
            if (!nodes.length) {
                // Fallback: only short labeled buttons in the author cell / header, not whole tweet body.
                const tightScope = scope.querySelector?.('[data-testid="User-Name"]')?.closest('div') ||
                    scope.querySelector?.('[data-testid="UserCell"]') ||
                    scope;
                nodes = Array.from((tightScope || scope).querySelectorAll('button, [role="button"]'))
                    .filter(el => {
                        if (!el) return false;
                        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                        if (!t || t.length > 28) return false;
                        return /follow|following|unfollow|subscribe|subscribed|unsubscribe|\u5173\u6ce8|\u8ba2\u9605|\u53d6\u6d88/i.test(t + ' ' + (el.getAttribute('aria-label') || ''));
                    });
            }
            const out = [];
            const seen = new Set();
            for (const el of nodes) {
                if (!el || seen.has(el)) continue;
                const kind = tools.classifyRelationControl(el);
                if (!kind) continue;
                seen.add(el);
                out.push({ el, kind });
            }
            return out;
        },
        resolveAuthorRelation: function (container, media) {
            const article = (media && media.closest && media.closest('article')) ||
                (container && container.closest && container.closest('article')) ||
                container || null;
            const author = tools.extractAuthorHandle(article) || tools.extractAuthorHandle(container);
            const scopes = [];
            // Prefer author identity cell first — avoids misreading controls from quoted tweets.
            const userCell = article && (
                article.querySelector('[data-testid="User-Name"]')?.closest('[data-testid="User-Names"], div') ||
                article.querySelector('[data-testid="UserCell"]')
            );
            if (userCell) scopes.push(userCell);
            if (article) scopes.push(article);
            if (container && container !== article) scopes.push(container);

            let live = null;
            let source = null;
            const order = { subscribed: 4, following: 3, subscribe: 2, follow: 1 };
            for (const scope of scopes) {
                const controls = tools.collectRelationControls(scope);
                if (!controls.length) continue;
                controls.sort((a, b) => (order[b.kind] || 0) - (order[a.kind] || 0));
                live = controls[0].kind;
                source = 'tweet';
                break;
            }
            if (!live && author) {
                const pathName = (location.pathname || '').replace(/\/+$/, '');
                const handle = author.slice(1).toLowerCase();
                const onAuthorProfile = new RegExp('^/' + handle + '(?:/|$)', 'i').test(pathName);
                if (onAuthorProfile) {
                    const header = document.querySelector('[data-testid="UserName"]')?.closest('div') ||
                        document.querySelector('[data-testid="primaryColumn"]');
                    if (header) {
                        const controls = tools.collectRelationControls(header);
                        if (controls.length) {
                            controls.sort((a, b) => (order[b.kind] || 0) - (order[a.kind] || 0));
                            live = controls[0].kind;
                            source = 'profile';
                        }
                    }
                }
            }

            const cacheEntry = tools.readFollowCacheEntry(author);
            const cached = cacheEntry ? cacheEntry.relation : null;
            const relation = tools.mergeRelation(live, cached, cacheEntry);
            let isFollowed = null;
            if (relation === 'following' || relation === 'subscribed') isFollowed = true;
            else if (relation === 'follow' || relation === 'subscribe') isFollowed = false;

            // Confidence for HUD: live subscribed/subscribe is confirmed; sticky subscribed needs confirmed cache.
            let confidence = 'unknown';
            if (live === 'subscribed' || live === 'subscribe') confidence = 'confirmed';
            else if (relation === 'subscribed' && cacheEntry && cacheEntry.confidence === 'confirmed') confidence = 'confirmed';
            else if (live === 'following' || live === 'follow') confidence = 'live';
            else if (cached) confidence = cacheEntry.confidence || 'inferred';

            return {
                authorName: author || null,
                relation,
                isFollowed,
                confidence,
                source: live ? source : (cached ? 'cache' : null),
                fromCache: !live && !!cached,
                liveRelation: live || null,
                cachedRelation: cached || null,
                cacheConfidence: cacheEntry ? cacheEntry.confidence : null
            };
        },
        findTweetCaret: function (article) {
            if (!article) return null;
            let caret = article.querySelector('[data-testid="caret"]') ||
                article.querySelector('[aria-label*="\u66f4\u591a"]') ||
                article.querySelector('[aria-label*="More"]');
            if (caret) return caret;
            const potentialCarets = article.querySelectorAll('button, [role="button"]');
            for (const btn of potentialCarets) {
                const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                if (aria.includes('more') || aria.includes('\u66f4\u591a')) return btn;
                const svg = btn.querySelector('svg');
                if (svg && (svg.innerHTML.includes('M3.593 12') || svg.innerHTML.includes('M12 14c') || svg.innerHTML.includes('M12 8c1.1'))) {
                    return btn;
                }
            }
            return null;
        },
        // Open the tweet caret once to read Follow/Subscribe truth, then close. Session-cached per author.
        probeAuthorRelationViaMenu: async function (container, media, force = false) {
            const article = (media && media.closest && media.closest('article')) ||
                (container && container.closest && container.closest('article')) ||
                container || null;
            const author = tools.extractAuthorHandle(article) || tools.extractAuthorHandle(container);
            if (!author || !article) return null;

            window.__mix01State = window.__mix01State || {};
            window.__mix01State.relationProbeAt = window.__mix01State.relationProbeAt || {};
            const last = window.__mix01State.relationProbeAt[author] || 0;
            if (!force && Date.now() - last < 45_000) {
                return tools.resolveAuthorRelation(container, media);
            }
            if (window.__mix01State.relationProbeInFlight === author) {
                return tools.resolveAuthorRelation(container, media);
            }
            window.__mix01State.relationProbeInFlight = author;

            try {
                const caret = tools.findTweetCaret(article);
                if (!caret) return tools.resolveAuthorRelation(container, media);

                tools.forceClick(caret);
                const menu = await tools.waitForMenu(700);
                if (!menu) {
                    tools.dismissMenus();
                    window.__mix01State.relationProbeAt[author] = Date.now();
                    return tools.resolveAuthorRelation(container, media);
                }

                const items = Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="button"], button, div[tabindex]'));
                let found = null; // subscribed | following | subscribe | follow
                for (const item of items) {
                    const tx = (item.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!tx || tx.length > 60) continue;
                    if (/Unsubscribe|\u53d6\u6d88\u8ba2\u9605|\u9000\u8ba2/i.test(tx)) { found = 'subscribed'; break; }
                    if (/Unfollow|\u53d6\u6d88\u5173\u6ce8|\u30d5\u30a9\u30ed\u30fc\u89e3\u9664/i.test(tx)) { found = 'following'; break; }
                    if (/Subscribe|\u8ba2\u9605/i.test(tx) && !/Unsubscribe|\u53d6\u6d88\u8ba2\u9605/i.test(tx)) {
                        // Prefer keep scanning for stronger unfollow/unsubscribe first, but remember.
                        if (!found) found = 'subscribe';
                    }
                    if (/^(Follow|\u5173\u6ce8|\u95dc\u8a3b|\u30d5\u30a9\u30ed\u30fc)\b|Follow @|\u5173\u6ce8 @/i.test(tx) &&
                        !/Unfollow|Following|\u53d6\u6d88/i.test(tx)) {
                        if (!found) found = 'follow';
                    }
                }
                tools.dismissMenus();
                window.__mix01State.relationProbeAt[author] = Date.now();

                if (found) {
                    tools.writeFollowCache(author, found, { confidence: 'confirmed', source: 'menu-probe' });
                }
                return tools.resolveAuthorRelation(container, media);
            } catch (e) {
                tools.dismissMenus();
                return tools.resolveAuthorRelation(container, media);
            } finally {
                if (window.__mix01State.relationProbeInFlight === author) {
                    window.__mix01State.relationProbeInFlight = null;
                }
            }
        },
        waitForMenu: async function (timeoutMs = 700) {
            const t0 = performance.now();
            while (performance.now() - t0 < timeoutMs) {
                const menus = Array.from(document.querySelectorAll('[role="menu"]'));
                if (menus.length) {
                    const menu = menus[menus.length - 1];
                    if (menu.querySelector('[role="menuitem"]')) return menu;
                }
                await new Promise(r => setTimeout(r, 40));
            }
            return null;
        },
        dismissMenus: function () {
            // Escape-only: never click body/viewer (immersive overlay would exit on background click).
            try {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            } catch (e) {}
            try {
                document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
            } catch (e) {}
            // Soft-close any open menus by re-clicking their caret if still open after a beat.
            // Avoid synthetic body clicks under immersive full-screen viewer.
        },

    };

    const Mix01ImmersiveRules = {
        '(?:(?:.+\\.)?twitter|x)\\.com': {
            getContainer: (media) => media.closest('article') || document.body,
            getGalleryImages: () => {
                // Merge visible + DOM candidates, then sort by document order.
                // Pure visible-set order caused mixed up/down deja-vu on X.
                // Multi-image tweets: if any media of an article is near viewport,
                // pull the whole photo set so immersive can step photo1 -> photoN.
                const allMedia = tools.collectCandidateMedia();
                const viewportHeight = window.innerHeight;
                const topBound = -viewportHeight * 2.5;
                const bottomBound = viewportHeight * 3.5;

                const nearArticles = new Set();
                const looseMedia = [];
                const videoRectsByArticle = new WeakMap();

                const markArticle = (article, media, rect) => {
                    if (!article) {
                        looseMedia.push(media);
                        return;
                    }
                    if (article.dataset.mixAdStatus === 'ad') return;
                    if (article.dataset.mixAdStatus !== 'clean') {
                        const isAd = Array.from(article.querySelectorAll('span')).some(span =>
                            /^(?:\u5e7f\u544a|\u8d5e\u52a9|Ad|Promoted)$/i.test((span.textContent || '').trim())
                        );
                        if (isAd) { article.dataset.mixAdStatus = 'ad'; return; }
                        article.dataset.mixAdStatus = 'clean';
                    }
                    nearArticles.add(article);
                    if (media.tagName === 'VIDEO') {
                        if (!videoRectsByArticle.has(article)) videoRectsByArticle.set(article, []);
                        videoRectsByArticle.get(article).push(rect);
                    }
                };

                for (let i = 0; i < allMedia.length; i++) {
                    const media = allMedia[i];
                    if (!media || !media.isConnected) continue;
                    if (media.id === 'zoom-img-xyz' || media.id === 'zoom-img-buffer-xyz' || media.id === 'zoom-video-xyz') continue;
                    if (tools.isUtilityImage(media)) continue;

                    const rect = media.getBoundingClientRect();
                    // Seed with near-viewport media; multi-image expansion happens below.
                    if (rect.top < topBound || rect.bottom > bottomBound) continue;
                    if (rect.width <= 50 || rect.height <= 50) continue;

                    const article = media.closest('article');
                    markArticle(article, media, rect);
                }

                const validMedia = [];
                const seen = new Set();

                const pushMedia = (media, article) => {
                    if (!media || seen.has(media)) return;
                    if (media.id === 'zoom-img-xyz' || media.id === 'zoom-img-buffer-xyz' || media.id === 'zoom-video-xyz') return;
                    if (tools.isUtilityImage(media)) return;

                    const rect = media.getBoundingClientRect();
                    const src = media.currentSrc || media.src || '';
                    const isNamedMediaAsset = media.tagName === 'VIDEO' ||
                        /\/media\//.test(src) || src.includes('twimg.com/media') || src.includes('pbs.twimg.com/media');
                    // Keep multi-image siblings even if slightly outside band, as long as
                    // their article was seeded. Still drop far-away recycled clones.
                    if (!article) {
                        if (rect.top < topBound || rect.bottom > bottomBound) return;
                    } else {
                        if (rect.top < topBound - viewportHeight || rect.bottom > bottomBound + viewportHeight) return;
                    }
                    // Off-screen multi-photo tiles can report 0x0 before paint; keep named assets.
                    if (!isNamedMediaAsset && (rect.width <= 40 || rect.height <= 40)) return;

                    if (media.tagName === 'IMG' && article) {
                        let isVideoCover = false;
                        const videoEls = article.querySelectorAll('video');
                        for (const v of videoEls) {
                            if (v.poster && src && v.poster === src) { isVideoCover = true; break; }
                        }
                        if (!isVideoCover) {
                            const vRects = videoRectsByArticle.get(article);
                            if (vRects) {
                                for (const vr of vRects) {
                                    const overlapX = Math.max(0, Math.min(rect.right, vr.right) - Math.max(rect.left, vr.left));
                                    const overlapY = Math.max(0, Math.min(rect.bottom, vr.bottom) - Math.max(rect.top, vr.top));
                                    const overlapArea = overlapX * overlapY;
                                    const imgArea = rect.width * rect.height;
                                    if (imgArea > 0 && overlapArea / imgArea > 0.5) { isVideoCover = true; break; }
                                }
                            }
                        }
                        if (isVideoCover) return;
                    }

                    // Stamp stable slot inside multi-image posts for identity fallbacks.
                    if (article && (!Number.isInteger(media._mixMediaSlot) || media._mixMediaSlot < 0)) {
                        const siblings = tools.collectArticleMedia(article);
                        const slot = siblings.indexOf(media);
                        if (slot >= 0) media._mixMediaSlot = slot;
                    }

                    seen.add(media);
                    validMedia.push(media);
                };

                // Expand each near article to its full media set (2/3/4 photo grids).
                for (const article of nearArticles) {
                    const mediaList = tools.collectArticleMedia(article);
                    // Refresh video rects for cover detection after expansion
                    for (const m of mediaList) {
                        if (m.tagName === 'VIDEO') {
                            if (!videoRectsByArticle.has(article)) videoRectsByArticle.set(article, []);
                            videoRectsByArticle.get(article).push(m.getBoundingClientRect());
                        }
                    }
                    for (const m of mediaList) pushMedia(m, article);
                }

                for (const media of looseMedia) pushMedia(media, null);

                return tools.sortByDocumentOrder(validMedia);
            },
            getStates: (container, media) => {
                const likeBtn = container.querySelector('[data-testid="unlike"]') ||
                    container.querySelector('[aria-label*="\u5df2\u559c\u6b22"]') ||
                    container.querySelector('[aria-label*="Unlike"]');
                const relation = tools.resolveAuthorRelation(container, media);
                return {
                    isLiked: !!likeBtn,
                    isFollowed: relation.isFollowed,
                    relation: relation.relation,
                    authorName: relation.authorName,
                    relationSource: relation.source,
                    relationFromCache: relation.fromCache,
                    confidence: relation.confidence,
                    liveRelation: relation.liveRelation,
                    cacheConfidence: relation.cacheConfidence
                };
            },
            probeRelation: async (container, media, force = false) => {
                return tools.probeAuthorRelationViaMenu(container, media, force);
            },
            like: async (container) => {
                const btnLike = container.querySelector('[data-testid="like"]') || container.querySelector('[aria-label*="喜欢"]') || container.querySelector('[aria-label*="Like"]');
                const btnUnlike = container.querySelector('[data-testid="unlike"]') || container.querySelector('[aria-label*="已喜欢"]') || container.querySelector('[aria-label*="Unlike"]');
                if (btnUnlike) { tools.forceClick(btnUnlike); return false; }
                if (btnLike) { tools.forceClick(btnLike); return true; }
                return null;
            },
            follow: async (container, media) => {
                const article = (media && media.closest && media.closest('article')) || container;
                const relationInfo = tools.resolveAuthorRelation(container, media);
                const author = relationInfo.authorName || tools.extractAuthorHandle(article) || '';
                const currentlyIn = relationInfo.isFollowed === true;

                const remember = (stateBool, relationHint) => {
                    const rel = stateBool ? (relationHint || 'following') : 'follow';
                    tools.writeFollowCache(author, rel, { confidence: 'confirmed', source: 'action' });
                    window.__mix01State = window.__mix01State || {};
                    window.__mix01State.followRelationCache = window.__mix01State.followRelationCache || {};
                    if (author) window.__mix01State.followRelationCache[author] = rel;
                };

                const clickConfirmIfAny = async () => {
                    await new Promise(r => setTimeout(r, 120));
                    const confirm = document.querySelector('[data-testid="confirmationSheetConfirm"]');
                    if (confirm) { tools.forceClick(confirm); return true; }
                    const dialog = document.querySelector('[role="dialog"]');
                    if (dialog) {
                        const btns = Array.from(dialog.querySelectorAll('[role="button"], button'));
                        const target = btns.find(b => /Unfollow|\u53d6\u6d88\u5173\u6ce8|\u53d6\u6d88\u8ba2\u9605|Unsubscribe|\u786e\u8ba4|Confirm|\u30d5\u30a9\u30ed\u30fc\u89e3\u9664/i.test(b.textContent || ''));
                        if (target) { tools.forceClick(target); return true; }
                    }
                    return false;
                };

                const toggleViaDirectButton = async () => {
                    const scopes = [article, container].filter(Boolean);
                    if (author) {
                        const pathName = (location.pathname || '').replace(/\/+$/, '');
                        const handle = author.slice(1).toLowerCase();
                        if (new RegExp('^/' + handle + '(?:/|$)', 'i').test(pathName)) {
                            const header = document.querySelector('[data-testid="UserName"]')?.closest('div');
                            if (header) scopes.push(header);
                        }
                    }
                    for (const scope of scopes) {
                        const controls = tools.collectRelationControls(scope);
                        if (!controls.length) continue;
                        let pick = null;
                        if (currentlyIn) {
                            pick = controls.find(c => c.kind === 'following' || c.kind === 'subscribed');
                        } else {
                            pick = controls.find(c => c.kind === 'follow') || controls.find(c => c.kind === 'subscribe');
                        }
                        if (!pick) continue;
                        tools.forceClick(pick.el);
                        if (currentlyIn) await clickConfirmIfAny();
                        // Give X a beat to flip the button label before we re-read.
                        await new Promise(r => setTimeout(r, 180));
                        const after = tools.resolveAuthorRelation(container, media);
                        if (after && after.relation) {
                            const inNow = after.isFollowed === true;
                            remember(inNow, after.relation);
                            return inNow;
                        }
                        const nextIn = !currentlyIn;
                        const hint = currentlyIn
                            ? 'follow'
                            : (pick.kind === 'subscribe' || pick.kind === 'subscribed' ? 'subscribed' : 'following');
                        remember(nextIn, nextIn ? hint : 'follow');
                        return nextIn;
                    }
                    return null;
                };

                const toggleViaCaretMenu = async () => {
                    const caret = tools.findTweetCaret(article);
                    if (!caret) return null;
                    tools.forceClick(caret);
                    const menu = await tools.waitForMenu(750);
                    if (!menu) { tools.dismissMenus(); return null; }

                    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
                    let targetBtn = null;
                    let willBeIn = true;
                    let relationHint = 'following';
                    for (const item of items) {
                        const tx = item.textContent || '';
                        if (/Unfollow|\u53d6\u6d88\u5173\u6ce8|\u30d5\u30a9\u30ed\u30fc\u89e3\u9664/i.test(tx)) {
                            targetBtn = item; willBeIn = false; relationHint = 'follow'; break;
                        }
                        if (/Unsubscribe|\u53d6\u6d88\u8ba2\u9605|\u9000\u8ba2/i.test(tx)) {
                            targetBtn = item; willBeIn = false; relationHint = 'follow'; break;
                        }
                        if (/Subscribe|\u8ba2\u9605/i.test(tx) && !/Unsubscribe|\u53d6\u6d88\u8ba2\u9605/i.test(tx)) {
                            targetBtn = item; willBeIn = true; relationHint = 'subscribed';
                        }
                        if (/^(Follow|\u5173\u6ce8|\u95dc\u8a3b|\u30d5\u30a9\u30ed\u30fc)\b|Follow @|\u5173\u6ce8 @|\u95dc\u8a3b @/i.test(tx) && !/Unfollow|Following|\u53d6\u6d88/i.test(tx)) {
                            targetBtn = item; willBeIn = true; relationHint = 'following'; break;
                        }
                    }
                    if (!targetBtn) { tools.dismissMenus(); return null; }
                    tools.forceClick(targetBtn);
                    if (!willBeIn) await clickConfirmIfAny();
                    else tools.dismissMenus();
                    await new Promise(r => setTimeout(r, 180));
                    const after = tools.resolveAuthorRelation(container, media);
                    if (after && after.relation) {
                        const inNow = after.isFollowed === true;
                        // Menu may say Subscribe while live still only exposes Following.
                        const finalRel = (!inNow) ? 'follow'
                            : (relationHint === 'subscribed' || after.relation === 'subscribed') ? 'subscribed'
                            : (after.relation || relationHint || 'following');
                        remember(inNow, finalRel);
                        return inNow;
                    }
                    remember(willBeIn, relationHint);
                    return willBeIn;
                };

                // Prefer in-tweet CTA; never click random primaryColumn buttons from other authors.
                let result = await toggleViaDirectButton();
                if (result === null) result = await toggleViaCaretMenu();
                return result;
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

            // 🚀 性能重构：本地 UserId 查询结果缓存，避免同一作品触发 getStates+like+follow 时的重复异步网络开销
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
                    // 🚀 核心改进：在下载时精准定位 ctx.pageIndex 以获取准确的多图原图，不写死 [0]
                    if (res && !res.error && res.body && res.body.length > ctx.pageIndex) {
                        return res.body[ctx.pageIndex].urls.original;
                    } else if (res && !res.error && res.body && res.body.length > 0) {
                        return res.body[0].urls.original; 
                    }
                } catch (e) { }
                return null;
            }
        },
        '.*': {
            isFallback: true,
            getContainer: (media) => media.parentElement || document.body,
            getGalleryImages: () => {
                const allMedia = tools.collectCandidateMedia();
                const validMedia = [];
                const viewportHeight = window.innerHeight;
                const topBound = -viewportHeight * 2.5;
                const bottomBound = viewportHeight * 3.5;

                for (let i = 0; i < allMedia.length; i++) {
                    const media = allMedia[i];
                    if (media.id === 'zoom-img-xyz' || media.id === 'zoom-canvas-xyz' || media.id === 'zoom-video-xyz' || media.id === 'zoom-img-buffer-xyz') continue;

                    const rect = media.getBoundingClientRect();
                    if (rect.top < topBound || rect.bottom > bottomBound) continue;

                    if (rect.width > 80 && rect.height > 80) {
                        validMedia.push(media);
                    }
                }
                return tools.sortByDocumentOrder(validMedia);
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

    window.Mix01ImmersiveEngine = {
        configs: Mix01ImmersiveRules,
        getAdapter(host) {
            const cache = window.Mix01RegexCacheHost || {};
            for (const pattern in this.configs) {
                if (!cache[pattern]) cache[pattern] = new RegExp(`^${pattern}$`);
                if (cache[pattern].test(host)) return this.configs[pattern];
            }
            return null;
        }
    };
})();