// rules-engine.js
(function () {
    const LRUCache = {
        set: (mapName, key, value, maxSize = 30) => {
            window[mapName] = window[mapName] || new Map();
            const cache = window[mapName];
            if (cache.has(key)) cache.delete(key); 
            else if (cache.size >= maxSize) cache.delete(cache.keys().next().value); 
            cache.set(key, value);
        },
        get: (mapName, key) => {
            const cache = window[mapName];
            return cache ? cache.get(key) : undefined;
        }
    };

    const TWITTER_DIRECT_FEATURES = {
        'articles_preview_enabled': true,
        'c9s_tweet_anatomy_moderator_badge_enabled': true,
        'communities_web_enable_tweet_community_results_fetch': false,
        'creator_subscriptions_quote_tweet_preview_enabled': false,
        'creator_subscriptions_tweet_preview_api_enabled': false,
        'freedom_of_speech_not_reach_fetch_enabled': true,
        'graphql_is_translatable_rweb_tweet_is_translatable_enabled': true,
        'longform_notetweets_consumption_enabled': false,
        'longform_notetweets_inline_media_enabled': true,
        'longform_notetweets_rich_text_read_enabled': false,
        'premium_content_api_read_enabled': false,
        'profile_label_improvements_pcf_label_in_post_enabled': true,
        'responsive_web_edit_tweet_api_enabled': false,
        'responsive_web_enhance_cards_enabled': false,
        'responsive_web_graphql_exclude_directive_enabled': false,
        'responsive_web_graphql_skip_user_profile_image_extensions_enabled': false,
        'responsive_web_graphql_timeline_navigation_enabled': false,
        'responsive_web_grok_analysis_button_from_backend': false,
        'responsive_web_grok_analyze_button_fetch_trends_enabled': false,
        'responsive_web_grok_analyze_post_followups_enabled': false,
        'responsive_web_grok_image_annotation_enabled': false,
        'responsive_web_grok_share_attachment_enabled': false,
        'responsive_web_grok_show_grok_translated_post': false,
        'responsive_web_jetfuel_frame': false,
        'responsive_web_media_download_video_enabled': false,
        'responsive_web_twitter_article_tweet_consumption_enabled': true,
        'rweb_tipjar_consumption_enabled': true,
        'rweb_video_screen_enabled': false,
        'standardized_nudges_misinfo': true,
        'tweet_awards_web_tipping_enabled': false,
        'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled': true,
        'tweetypie_unmention_optimization_enabled': false,
        'verified_phone_label_enabled': false,
        'view_counts_everywhere_api_enabled': true
    };
    const TWITTER_DIRECT_FEATURES_QS = encodeURIComponent(JSON.stringify(TWITTER_DIRECT_FEATURES));

const tools = {
        getLargestImgSrc: function (container) {
            if (!container || !container.querySelectorAll) return '';
            const imgs = Array.from(container.querySelectorAll('img, [style*="background"]'));
            let maxArea = 0, bestSrc = '';
            for (const el of imgs) {
                const area = el.clientWidth * el.clientHeight;
                if (area <= maxArea) continue;
                let src = el.src || '';
                if (!src) {
                    const match = el.style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
                    if (match) src = match[1];
                }
                if (src && !src.startsWith('data:')) { maxArea = area; bestSrc = src; }
            }
            return bestSrc;
        },
        detectImage: async function (primarySrc, fallbackSrc) {
            const cached = LRUCache.get('__mix01DetectCache', primarySrc);
            if (cached !== undefined) return cached;

            // In-flight dedupe: concurrent probes for same URL share one Image request
            window.__mix01DetectInflight = window.__mix01DetectInflight || new Map();
            if (window.__mix01DetectInflight.has(primarySrc)) {
                return window.__mix01DetectInflight.get(primarySrc);
            }

            const task = new Promise((resolve) => {
                const img = new Image();
                const fallback = fallbackSrc || primarySrc;
                let settled = false;
                const settle = (url) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeoutId);
                    img.onload = null;
                    img.onerror = null;
                    img.src = '';
                    LRUCache.set('__mix01DetectCache', primarySrc, url, 60);
                    window.__mix01DetectInflight.delete(primarySrc);
                    resolve(url);
                };
                // 2.5s is enough for most CDN probes; 8s was over-waiting on dead links
                const timeoutId = setTimeout(() => settle(fallback), 2500);
                img.onload  = () => settle(primarySrc);
                img.onerror = () => settle(fallback);
                img.decoding = 'async';
                img.src = primarySrc;
            });

            window.__mix01DetectInflight.set(primarySrc, task);
            return task;
        }
    };

    const extractVideoUrlFromTweet = (json) => {
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
    };

    const getTwitterVideoUrlDirectly = async (statusId) => {
        const host = window.location.hostname;
        const base_url = `https://${host}/i/api/graphql/2ICDjqPd81tulZcYrtpTuQ/TweetResultByRestId`;
        
        const variables = {
            'tweetId': statusId,
            'with_rux_injections': false,
            'includePromotedContent': true,
            'withCommunity': true,
            'withQuickPromoteEligibilityTweetFields': true,
            'withBirdwatchNotes': true,
            'withVoice': true,
            'withV2Timeline': true
        };
        const url = `${base_url}?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${TWITTER_DIRECT_FEATURES_QS}`;
        
        const cookies = {};
        document.cookie.split(';').forEach(cookie => {
            const parts = cookie.split('=');
            if (parts.length === 2) {
                cookies[parts[0].trim()] = parts[1].trim();
            }
        });
        const csrfToken = cookies['ct0'] || '';

        const headers = {
            'authorization': 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
            'x-twitter-active-user': 'yes',
            'x-csrf-token': csrfToken
        };
        if (csrfToken.length === 32 && cookies['gt']) {
            headers['x-guest-token'] = cookies['gt'];
        }

        const response = await fetch(url, { headers });
        if (!response.ok) throw new Error("HTTP " + response.status);
        
        return extractVideoUrlFromTweet(await response.json());
    };

    const Mix01Configs = {
        '(?:.+\\.)?pixiv\\.net': {
            srcMatching: [
                { srcRegExp: '(.+\\.pximg\\.net/user-profile/.+)_\\d+(@IMG@)', processor: '$1$2' },
                { srcRegExp: '(.+\\.pximg\\.net/.+/.+_thumb/.+)_\\w+(@IMG@)', processor: '$1$2' },
                { srcRegExp: '(.+\\.pximg\\.net)(?=/).+(/uploads/.+/)(?:.+_)?(\\d+@IMG@)', processor: '$1$2$3' },
                { srcRegExp: '(.+\\.pixiv\\.net/images/post/\\d+)/w/\\d+(/.+@IMG@)', processor: '$1$2' },
                {
                    selectors: 'img, [style*="background"], .kTOQSN',
                    srcRegExp: '(//.+\\.pximg\\.net/).+(/img/.+?)(_p\\d+)?(?:_.+)?(@IMG@)',
                    processor: async (trigger, src, srcRegExpObj) => {
                        const finalSrc = src || tools.getLargestImgSrc(trigger.parentElement);
                        const match = finalSrc.match(srcRegExpObj);
                        if (match) {
                            return await tools.detectImage(
                                `${match[1]}img-original${match[2]}${match[3] || '_p0'}${match[4]}`,
                                `${match[1]}img-original${match[2]}${match[3] || '_p0'}.png`
                            );
                        }
                        return '';
                    }
                },
                {
                    selectors: 'canvas, video',
                    processor: async (trigger, src) => {
                        let illustId = null;
                        let pageIndex = 0;
                        const activeSrc = src || trigger.src || '';
                        const m1 = activeSrc.match(/\/(\d+)_/);
                        if (m1) illustId = m1[1];
                        const pm = activeSrc.match(/_p(\d+)/);
                        if (pm) pageIndex = parseInt(pm[1], 10);
                        if (!illustId && trigger) {
                            const parentA = trigger.closest('a');
                            if (parentA && parentA.href) illustId = parentA.href.match(/artworks\/(\d+)/)?.[1];
                        }
                        if (!illustId) illustId = window.location.pathname.match(/artworks\/(\d+)/)?.[1];

                        if (illustId) {
                            try {
                                let pagesData = LRUCache.get('__mix01PixivApiCache', illustId);
                                if (!pagesData) {
                                    const res = await fetch(`/ajax/illust/${illustId}/pages`).then(r => r.json());
                                    pagesData = res?.body;
                                    if (pagesData) LRUCache.set('__mix01PixivApiCache', illustId, pagesData, 30); 
                                }
                                if (pagesData) {
                                    if (pagesData[pageIndex]?.urls?.original) return pagesData[pageIndex].urls.original;
                                    if (pagesData[0]?.urls?.original) return pagesData[0].urls.original;
                                }
                            } catch(e) {}
                        }
                        return src;
                    }
                }
            ]
        },
        '(?:(?:.+\\.)?twitter|x)\\.com': {
            srcMatching: [
                { srcRegExp: '(\\w+\\.twimg\\.com/(?:(?:[^/]+/)?default_)?profile_images/.+)_\\w+(?=@IMG@)(@IMG@)', processor: '$1$2' },
                { srcRegExp: '(\\w+\\.twimg\\.com/media/[^?#:]+)\\?format=([^&]+)&name=[^&]+(.*)', processor: '$1?format=$2&name=orig$3' },
                { srcRegExp: '(\\w+\\.twimg\\.com/media/[^?#:]+)\\?name=[^&]+&format=([^&]+)(.*)', processor: '$1?format=$2&name=orig$3' },
                { srcRegExp: '(\\w+\\.twimg\\.com/media/[^?#:]+)\\?format=([^&]+)(?!.*[&?]name=)(.*)', processor: '$1?format=$2&name=orig$3' },
                { srcRegExp: '(\\w+\\.twimg\\.com/media/[^?#:]+)(@IMG@)(?::(?:large|medium|small|thumb))?$', processor: '$1$2:orig' },
                {
                    selectors: 'video',
                    processor: async (trigger) => {
                        // 🚀 核心改进：优先提取被永久绑定的 _mixStatusId，防止 React 虚拟重卷导致 article 丢失
                        let statusId = trigger._mixStatusId;
                        if (!statusId) {
                            const urlMatch = window.location.pathname.match(/\/status\/(\d+)/);
                            if (urlMatch) {
                                statusId = urlMatch[1];
                            } else {
                                const statusLink = trigger.closest('article')?.querySelector('a[href*="/status/"]');
                                if (statusLink) statusId = statusLink.href.split('/status/').pop().split(/[\/?#]/).shift();
                            }
                        }
                        if (!statusId) return trigger.src || '';

                        const cachedUrl = LRUCache.get('__mix01TwVideoCache', statusId);
                        if (cachedUrl) return cachedUrl;

                        try {
                            const directUrl = await getTwitterVideoUrlDirectly(statusId);
                            if (directUrl) {
                                LRUCache.set('__mix01TwVideoCache', statusId, directUrl, 30);
                                return directUrl;
                            }
                        } catch (directErr) {
                            console.warn("Mix01 同源解析视频失败，准备启动后台代理备份通道:", directErr);
                        }

                        try {
                            const response = await new Promise(resolve => {
                                chrome.runtime.sendMessage({ action: "fetchTwitterGraphQL", statusId: statusId }, resolve);
                            });

                            if (!response || !response.success || !response.data) return trigger.src || '';

                            const finalUrl = extractVideoUrlFromTweet(response.data) || trigger.src || '';
                            if (finalUrl) {
                                LRUCache.set('__mix01TwVideoCache', statusId, finalUrl, 30);
                            }
                            return finalUrl;
                        } catch (e) { return trigger.src || ''; }
                    }
                }
            ]
        },
        '.+\\.bili(?:bili|game)\\.com': {
            srcMatching: [
                {
                    selectors: 'img, [style*="background"], .card-live-module .pic .mask, .cover-ctn .cover, .album-img',
                    srcRegExp: '(.+\\.hdslb\\.com/.+?@IMG@)[^?]*(\\?.*)?',
                    processor: '$1$2'
                },
                {
                    selectors: '.cardBangumibox .modal-box, .song-shadow, .pic-box, .bili-dyn-card-video__cover',
                    srcRegExp: '(//.+\\.hdslb\\.com/.+?@IMG@)[^?]*(\\?.*)?',
                    processor: (trigger, src, srcRegExpObj) => {
                        const largestSrc = tools.getLargestImgSrc(trigger.parentElement) || src;
                        const m = srcRegExpObj.exec(largestSrc);
                        return m ? m[1] + m[2] : '';
                    }
                }
            ]
        },
        '(?:(?:www|magazine)\\.artstation|davidnakayama)\\.com': {
            srcMatching: [
                { srcRegExp: '(cdn\\w?\\.artstation\\.com/p/users/covers/.+/)small(/.+@IMG@.*)', processor: '$1default$2' },
                { srcRegExp: '(cdn\\w?\\.artstation\\.com/p/marketplace/.+/.+_)small(/.+@IMG@.*)', processor: '$1big$2' },
                { srcRegExp: '(cdn\\w?\\.artstation\\.com/.+?/)(?:\\d{14}/)?(?:medium|\\w+_square|thumbnail)(/.+@IMG@.*)', processor: '$1large$2' },
                {
                    selectors: 'img, .overlay>a',
                    srcRegExp: '(//magazine\\.artstation\\.com/.+)(?:-\\d+x\\d+)?(@IMG@.*)',
                    processor: (trigger, src, srcRegExpObj) => {
                        const finalSrc = src || trigger.parentElement?.nextElementSibling?.src || '';
                        const m = srcRegExpObj.exec(finalSrc);
                        return m ? m[1] + m[2] : '';
                    }
                }
            ]
        },
        'www\\.deviantart\\.com': {
            srcMatching: [
                { srcRegExp: '(//a\\.deviantart\\.net/avatars-)(?:\\w+)?(/.+@IMG@).*', processor: '$1big$2' }
            ]
        },
        'konachan\\.(?:com|net)|yande\\.re|e621\\.net': {
            srcMatching: [
                {
                    srcRegExp: '//(?:.+\\.)?(konachan\\.(?:com|net)|yande\\.re)/.+/(\\w+)(?:/.*)?(@IMG@)',
                    processor: async (trigger, src, srcRegExpObj) => {
                        const m = srcRegExpObj.exec(src);
                        if (m) {
                            return await tools.detectImage(
                                `//${m[1]}/image/${m[2]}/${m[1]}${m[3]}`,
                                `//${m[1]}/jpeg/${m[2]}/${m[1]}${m[3]}`
                            );
                        }
                        return '';
                    }
                },
                { srcRegExp: '(//static\\d*\\.e621\\.net/data/)(?:crop|preview|sample)/(.+)(@IMG@)', processor: '$1$2$3' }
            ]
        },
        '(?:.+\\.)?weibo\\.com': {
            srcMatching: [
                { srcRegExp: '(mu\\d+\\.sinaimg\\.cn/)(?:(?:square|crop|frame)\\.[^/]+|original)/(.+@IMG@).*', processor: '$1$2' },
                {
                    selectors: 'img, .woo-picture-main, .wbpv-poster',
                    srcRegExp: '((?:.+\\.sinaimg\\.cn|image\\.storage\\.weibo\\.com)(?:/.+)?/)(?:small|large|thumbnail|\\w?mw\\d+|small|sq\\d+|thumb\\d+|bmiddle|orj\\d+|crop\\.[^/]+|square|wap\\d+)(/\\w+)(?:@IMG@)?.*',
                    processor: (trigger, src, srcRegExpObj) => {
                        const finalSrc = src || trigger.querySelector('img')?.src || '';
                        const m = srcRegExpObj.exec(finalSrc);
                        if (m) {
                            return `${m[1]}large${m[2]}${m[2][22] === 'g' ? '.gif' : '.jpg'}`;
                        }
                        return '';
                    }
                }
            ]
        },
        'www\\.instagram\\.com': {
            srcMatching: [
                {
                    selectors: 'img[alt]',
                    processor: (trigger, src) => {
                        return src.replace(/\/(?:s\d+x\d+\/|p\d+x\d+\/|c\d+\.\d+\.\d+\.\d+\/|vp\/)+/, '/');
                    }
                }
            ]
        },
        '\\w+\\.facebook\\.com': {
            srcMatching: [
                {
                    selectors: 'img, [style*="background-image"], image',
                    processor: (trigger, src) => {
                        return src.replace(/\/(?:s\d+x\d+\/|p\d+x\d+\/|c\d+\.\d+\.\d+\.\d+\/)+/, '/');
                    }
                }
            ]
        },
        'www\\.reddit\\.com': {
            srcMatching: [
                { srcRegExp: '(?:preview|i)(\\.redd\\.it/.+@IMG@).*', processor: 'i$1' },
                { srcRegExp: '(.*\\.(?:redditmedia|redditstatic)\\.com/.+@IMG@).*', processor: '$1' }
            ]
        },
        '.+\\.tumblr\\.com': {
            srcMatching: [
                { srcRegExp: '(.*\\.media\\.tumblr\\.com/avatar_.*)_\\d+(?:sq)?(@IMG@)', processor: '$1_128$2' },
                {
                    selectors: 'img, .post_glass, .photo_post, .post--photo__link',
                    srcRegExp: '(//(?:.*\\.media|static)\\.tumblr\\.com/.*?)_\\d+(?:sq)?((?:_v\\d+)?@IMG@)',
                    processor: (trigger, src, srcRegExpObj) => {
                        const finalSrc = src || trigger.closest('.post__content')?.querySelector('img')?.src || '';
                        const m = srcRegExpObj.exec(finalSrc);
                        return m ? `${m[1]}_1280${m[2]}` : '';
                    }
                }
            ]
        },
        '(?:.+\\.)?(tmall|taobao|etao|fliggy|alitrip|1688|alibaba|aliexpress|liangxinyao|alipay|alicdn|alimama|vvic|wsy)\\.(?:com|[a-z]{2})': {
            srcMatching: [
                { srcRegExp: '(gqrcode\\.alicdn\\.com/img\\?.*?)&w=\\d+(.*?)&h=\\d+(.*)', processor: '$1&w=300$2&h=300$3' },
                { srcRegExp: '(.+\\.(?:alicdn|taobao)\\.com/avatar/get_?Avatar\\.do\\?user(?:Id(?:Str)?|Nick)=[^&]+).*', processor: '$1&width=1280&height=1280' },
                { srcRegExp: '(.+\\.(?:alicdn|china\\.alibaba)\\.com/.+?)\\.(?:\\d+x\\d+[a-z]*|search|summ)(@IMG@).*', processor: '$1$2' },
                { srcRegExp: '(.+\\.(?:alicdn|china\\.alibaba)\\.com/.+?@IMG@).*', processor: '$1' }
            ]
        },
        '(?:.+\\.)?(jd|yhd|tuniu)\\.(?:com|hk)': {
            srcMatching: [
                { srcRegExp: '(.+\\.360buyimg\\.com/).*((?:jfs|g\\d+)/.+@IMG@).*', processor: '$1n1/s800x800_$2' },
                { srcRegExp: '(s\\.tuniu\\.net/.+@IMG@).*', processor: '$1' }
            ]
        },
        'www\\.amazon(?:\\.(?:com|[a-z]{2}))+': {
            srcMatching: [
                {
                    selectors: 'img, [style*="background"], .thumnail',
                    srcRegExp: '(//.*\\.(?:ssl-images|media)-amazon\\.(?:com|[a-z]{2})/images/.*?([-\\w]+))\\._.+(@IMG@)',
                    processor: '$1$3'
                }
            ]
        },
        '(?:.+\\.)?ebay(?:desc)?(?:\\.(?:com|[a-z]{2}))+': {
            srcMatching: [
                { srcRegExp: '(i\\.ebayimg\\.com/.+/s-l)\\d+(?:/p)?(@IMG@)', processor: '$12000$2' },
                { srcRegExp: '(thumbs\\d+\\.ebaystatic\\.com/.+/l)\\d+(/.+@IMG@)', processor: '$12000$2' },
                { srcRegExp: '(i\\.ebayimg\\.com/.+/\\$_)\\d+(@IMG@)', processor: '$110$2' }
            ]
        },
        'www\\.etsy\\.com': {
            srcMatching: [
                { srcRegExp: '(.+\\.etsystatic\\.com/isc/.+?_)\\d+x\\d+(.*@IMG@.*)', processor: '$1190x190$2' },
                { srcRegExp: '(.+\\.etsystatic\\.com/.+?_)\\d+x(?:\\d+|N)(.*@IMG@.*)', processor: '$1fullxfull$2' }
            ]
        },
        'www\\.google(?:\\.(?:com|[a-z]{2}))+|(?:play|store)\\.google\\.com': {
            srcMatching: [
                {
                    selectors: 'img, [style*="background"]',
                    srcRegExp: '(//lh\\d+\\.googleusercontent\\.com/.+[/=])(?:-?[\\w\\d]+)+',
                    processor: (trigger, src, srcRegExpObj) => {
                        const finalSrc = src || trigger.querySelector('img')?.src || '';
                        const m = srcRegExpObj.exec(finalSrc);
                        return m ? `${m[1]}w0` : '';
                    }
                },
                {
                    selectors: 'a img',
                    processor: (trigger) => {
                        const aHref = trigger.closest('a')?.href || '';
                        const match = aHref.match(/imgurl=([^&]+)/);
                        return match ? decodeURIComponent(match[1]) : '';
                    }
                }
            ]
        },
        '.+\\.bing\\.com': {
            srcMatching: [
                {
                    selectors: '.iusc img',
                    srcRegExp: '(//.+\\.bing\\.(?:com|net)/th(?:/id/[^?]+)|\\?id=[^&]+)',
                    processor: async (trigger, src) => {
                        const dataM = trigger.closest('.iusc')?.getAttribute('m');
                        if (dataM) {
                            try {
                                const data = JSON.parse(dataM);
                                return await tools.detectImage(data.murl, data.turl);
                            } catch (e) { }
                        }
                        return '';
                    }
                }
            ]
        },
        '(?:www|image)\\.baidu\\.com|tieba\\.baidu\\.com': {
            srcMatching: [
                { srcRegExp: '(t\\d+\\.baidu\\.com/it/.+&fm=\\d+).*', processor: '$1' },
                { srcRegExp: '((?:.+\\.)?(?:bdstatic|himg\\.(?:baidu|bdimg))\\.com/.+)/portrait/(.+)', processor: '$1/portraith/$2' },
                {
                    selectors: 'a[href] img, .img-box img',
                    processor: (trigger, src) => {
                        const aHref = trigger.closest('a')?.href || '';
                        const objUrlMatch = aHref.match(/objurl=([^&]+)/);
                        return objUrlMatch ? decodeURIComponent(objUrlMatch[1]) : src;
                    }
                }
            ]
        },
        '(?:.+\\.)?pinterest(?:\\.(?:com|[a-z]{2}))+': {
            srcMatching: [
                {
                    selectors: 'a, img',
                    srcRegExp: '(//i\\.pinimg\\.com/)(?:originals|\\d+x(?:\\d+(?:_\\w+)?)?)(/.+@IMG@)',
                    processor: async (trigger, src, srcRegExpObj) => {
                        const finalSrc = src || tools.getLargestImgSrc(trigger);
                        const m = srcRegExpObj.exec(finalSrc);
                        if (m) {
                            return await tools.detectImage(`${m[1]}originals${m[2]}`, `${m[1]}736x${m[2]}`);
                        }
                        return '';
                    }
                }
            ]
        },
        '(?:www\\.)?flickr\\.com': {
            srcMatching: [
                {
                    selectors: 'img, [style*="background"]',
                    srcRegExp: '(//.+\\.static\\.?flickr\\.com/(?:\\d+/)+(\\d+)_.+?)(?:_\\w)?(@IMG@)',
                    processor: (trigger, src, srcRegExpObj) => {
                        const finalSrc = src || tools.getLargestImgSrc(trigger.parentElement);
                        const m = srcRegExpObj.exec(finalSrc);
                        return m ? `${m[1]}_b${m[3]}` : '';
                    }
                },
                { srcRegExp: '(//.+\\.staticflickr\\.com/\\d+/buddyicons/.+?)(?:_\\w)?(@IMG@.*)', processor: '$1_r$2' }
            ]
        },
        'wallhaven\\.cc': {
            srcMatching: [
                {
                    selectors: 'img, a',
                    srcRegExp: '(wallhaven\\.cc/)w/((\\w{2})\\w+)',
                    processor: async (trigger, src, srcRegExpObj) => {
                        const aHref = trigger.closest('a')?.href || '';
                        const m = srcRegExpObj.exec(aHref);
                        if (m) {
                            return await tools.detectImage(
                                `//w.${m[1]}full/${m[3]}/wallhaven-${m[2]}.jpg`,
                                `//w.${m[1]}full/${m[3]}/wallhaven-${m[2]}.png`
                            );
                        }
                        return '';
                    }
                }
            ]
        },
        '(?:.+\\.)?youtube\\.com': {
            srcMatching: [
                {
                    selectors: 'img, [style*="background-image"], .ytp-cued-thumbnail-overlay-image',
                    srcRegExp: '(//i\\d*\\.ytimg\\.com/vi.*?/.+/).+(@IMG@)',
                    processor: async (trigger, src, srcRegExpObj) => {
                        const finalSrc = src || tools.getLargestImgSrc(trigger.closest('a')?.querySelector('img'));
                        const m = srcRegExpObj.exec(finalSrc);
                        if (m) {
                            return await tools.detectImage(`${m[1]}maxresdefault${m[2]}`, `${m[1]}hqdefault${m[2]}`);
                        }
                        return '';
                    }
                }
            ]
        },
        '(?:www|zhuanlan)\\.zhihu\\.com': {
            srcMatching: [
                {
                    srcRegExp: '(//pic\\d+\\.zhimg\\.com/)(?:\\d+/)?(.+)_(?:\\d+x\\d+|[^.]+)(@IMG@)',
                    processor: (trigger, src, srcRegExpObj) => {
                        const m = srcRegExpObj.exec(src);
                        if (m) {
                            const isGif = trigger.classList && trigger.classList.contains('column-gif');
                            return m[1] + m[2] + (isGif ? '.gif' : m[3]);
                        }
                        return '';
                    }
                }
            ]
        },
        '(?:.+\\.)?github\\.(?:com|blog)': {
            srcMatching: [
                { srcRegExp: '//github\\.com/(.+/)(?:blob|raw)/(.+@IMG@).*', processor: '//raw.githubusercontent.com/$1$2' },
                { srcRegExp: '((?:avatars\\d*|marketplace-screenshots)\\.githubusercontent\\.com/[^?]+).*', processor: '$1' }
            ]
        },
        '(?:.+\\.)?douban\\.(?:com|fm)': {
            srcMatching: [
                { srcRegExp: '(img\\d+\\.doubanio\\.com/view/\\w+/).*(/public/.+@IMG@)', processor: '$1l$2' },
                { srcRegExp: '(img\\d+\\.doubanio\\.com/icon/)up?([-\\d]+@IMG@)', processor: '$1ul$2' },
                { srcRegExp: '(img\\d+\\.doubanio\\.com/pview/\\w+_poster/)(?:small|median|large)(/public/.+@IMG@)', processor: '$1raw$2' }
            ]
        },
        'vdownload\\.hembed\\.com': {
            srcMatching: [
                { srcRegExp: '.*', processor: '$&' }
            ]
        },
        'hanime1\\.me': {
            srcMatching: [
                { srcRegExp: '.*', processor: '$&' }
            ]
        },
        '.*': {
            srcMatching: [
                { srcRegExp: '([?&@!])(?:x-oss-process=image|imageMogr2|imageView2).*', processor: '' },
                { srcRegExp: '([_-])(\\d{2,4})x(\\d{2,4})(@IMG@.*)', processor: '$4' },
                { srcRegExp: '(@IMG@)\\?.*', processor: '$1' },
                { srcRegExp: '(\\/(?:thumb(?:nail)?s?|small|mw\\d+)\\/)', processor: '/large/' }
            ]
        }
    };

    const regexCacheSrcMatch = {};
    window.Mix01RegexCacheHost = {};

    window.Mix01RuleEngine = {
        configs: Mix01Configs,

        async getHighResUrl(triggerElement, originalSrc) {
            const src = originalSrc || '';
            // 🚀 核心改进：若 originalSrc 为空但传入了 triggerElement (如 <video>)，允许通过选择器规则向下匹配
            if ((!src && !triggerElement) || (src && src.startsWith('data:'))) {
                return src;
            }

            const host = window.location.hostname;

            if (!this._matchedRulesCache) this._matchedRulesCache = {};
            if (!this._matchedRulesCache[host]) {
                let rules = [];
                for (const pattern in this.configs) {
                    if (pattern === '.*') continue; 
                    if (!window.Mix01RegexCacheHost[pattern]) window.Mix01RegexCacheHost[pattern] = new RegExp(`^${pattern}$`);
                    if (window.Mix01RegexCacheHost[pattern].test(host)) {
                        rules = rules.concat(this.configs[pattern].srcMatching || []);
                    }
                }
                if (this.configs['.*']) {
                    rules = rules.concat(this.configs['.*'].srcMatching || []);
                }
                this._matchedRulesCache[host] = rules;
            }
            const matchedRules = this._matchedRulesCache[host];

            for (const rule of matchedRules) {
                if (rule.selectors && triggerElement && triggerElement.nodeType === 1) {
                    try { if (!triggerElement.matches(rule.selectors)) continue; } catch (e) { }
                }

                let srcRegExpObj = null;
                if (rule.srcRegExp) {
                    if (!regexCacheSrcMatch[rule.srcRegExp]) {
                        const regPattern = rule.srcRegExp.replace(/@IMG@/g, '\\.(?:jpe?g|gifv?|pn[gj]|bmp|webp|svg)');
                        regexCacheSrcMatch[rule.srcRegExp] = new RegExp(regPattern, 'i');
                    }
                    srcRegExpObj = regexCacheSrcMatch[rule.srcRegExp];
                }

                if (srcRegExpObj && !srcRegExpObj.test(src)) continue;

                if (rule.processor !== undefined) {
                    if (typeof rule.processor === 'function') {
                        const result = await rule.processor(triggerElement, src, srcRegExpObj);
                        if (result) return result;
                    } else if (typeof rule.processor === 'string' && srcRegExpObj) {
                        const replaced = src.replace(srcRegExpObj, rule.processor);
                        if (replaced !== src || rule.processor === '') return replaced;
                    }
                } else if (srcRegExpObj) {
                    const m = srcRegExpObj.exec(src);
                    if (m) return m[0];
                }
            }

            return src;
        }
    };
})();