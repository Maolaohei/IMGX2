// rules-engine.js
(function patchKeyboardGuard() {
    const _origAdd = Document.prototype.addEventListener;
    const _origRemove = Document.prototype.removeEventListener;
    const _guardMap = new WeakMap();

    function _isEditableTarget(tgt) {
        if (!tgt) return false;
        const tag = tgt.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tgt.isContentEditable) return true;
        const role = tgt.getAttribute && tgt.getAttribute('role');
        return role === 'textbox' || role === 'combobox' || role === 'searchbox' || role === 'spinbutton';
    }

    Document.prototype.addEventListener = function(type, handler, options) {
        if ((type === 'keydown' || type === 'keyup') && typeof handler === 'function') {
            if (_guardMap.has(handler)) {
                return _origAdd.call(this, type, _guardMap.get(handler), options);
            }
            const guarded = function(e) {
                if (_isEditableTarget(e.target)) return;
                if ((e.ctrlKey || e.metaKey || e.altKey) && !e.shiftKey &&
                    (e.key.length === 1 || e.key === ' ' || e.key === 'Spacebar')) return;
                handler.call(this, e);
            };
            _guardMap.set(handler, guarded);
            return _origAdd.call(this, type, guarded, options);
        }
        return _origAdd.call(this, type, handler, options);
    };

    Document.prototype.removeEventListener = function(type, handler, options) {
        if ((type === 'keydown' || type === 'keyup') && _guardMap.has(handler)) {
            return _origRemove.call(this, type, _guardMap.get(handler), options);
        }
        return _origRemove.call(this, type, handler, options);
    };
})();

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
            return new Promise((resolve) => {
                const img = new Image();
                const fallback = fallbackSrc || primarySrc;
                let settled = false;
                const settle = (url) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeoutId);
                    img.src = ''; 
                    LRUCache.set('__mix01DetectCache', primarySrc, url, 60);
                    resolve(url);
                };
                const timeoutId = setTimeout(() => settle(fallback), 8000);
                img.onload  = () => settle(primarySrc);
                img.onerror = () => settle(fallback);
                img.src = primarySrc;
            });
        }
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
                { srcRegExp: '(\\w+\\.twimg\\.com/media/.+?)(?:@IMG@:\\w+)?(.+[?&]name=)[^&]+(.*)', processor: '$1$2orig$3' },
                { srcRegExp: '(\\w+\\.twimg\\.com/.+\\?format=.*&name=).+', processor: '$1orig' },
                {
                    selectors: 'video',
                    processor: async (trigger) => {
                        let statusId = null;
                        const urlMatch = window.location.pathname.match(/\/status\/(\d+)/);
                        if (urlMatch) {
                            statusId = urlMatch[1];
                        } else {
                            const statusLink = trigger.closest('article')?.querySelector('a[href*="/status/"]');
                            if (statusLink) statusId = statusLink.href.split('/status/').pop().split(/[\/?#]/).shift();
                        }
                        if (!statusId) return trigger.src;

                        const cachedUrl = LRUCache.get('__mix01TwVideoCache', statusId);
                        if (cachedUrl) return cachedUrl;

                        // 🚀 P2: 彻底脱离 Content Script 读取 Cookie 暴露风险，改由 background 代理
                        try {
                            const response = await new Promise(resolve => {
                                chrome.runtime.sendMessage({ action: "fetchTwitterGraphQL", statusId: statusId }, resolve);
                            });

                            if (!response || !response.success || !response.data) return trigger.src;

                            const json = response.data;
                            const tweetResult = json.data?.tweetResult?.result;
                            if (!tweetResult) return trigger.src;
                            const tweet = tweetResult.tweet || tweetResult;
                            
                            let legacy = tweet.legacy;
                            if (!legacy?.extended_entities?.media && tweet.quoted_status_result?.result?.legacy?.extended_entities?.media) {
                                legacy = tweet.quoted_status_result.result.legacy;
                            }
                            
                            const medias = legacy?.extended_entities?.media;
                            if (!medias || !Array.isArray(medias)) return trigger.src;

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
                            
                            const finalUrl = videoUrl || trigger.src;
                            LRUCache.set('__mix01TwVideoCache', statusId, finalUrl, 30);
                            return finalUrl;
                        } catch (e) { return trigger.src; }
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
                        return srcRegExpObj.test(largestSrc) ? RegExp.$1 + RegExp.$2 : '';
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
                        return srcRegExpObj.test(finalSrc) ? RegExp.$1 + RegExp.$2 : '';
                    }
                }
            ]
        },
        '(?:www|shop)\\.deviantart\\.com': {
            srcMatching: [
                { srcRegExp: '(//a\\.deviantart\\.net/avatars-)(?:\\w+)?(/.+@IMG@).*', processor: '$1big$2' }
            ]
        },
        'konachan\\.(?:com|net)|yande\\.re|e621\\.net': {
            srcMatching: [
                {
                    srcRegExp: '//(?:.+\\.)?(konachan\\.(?:com|net)|yande\\.re)/.+/(\\w+)(?:/.*)?(@IMG@)',
                    processor: async (trigger, src, srcRegExpObj) => {
                        if (srcRegExpObj.test(src)) {
                            return await tools.detectImage(
                                `//${RegExp.$1}/image/${RegExp.$2}/${RegExp.$1}${RegExp.$3}`,
                                `//${RegExp.$1}/jpeg/${RegExp.$2}/${RegExp.$1}${RegExp.$3}`
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
                        if (srcRegExpObj.test(finalSrc)) {
                            return `${RegExp.$1}large${RegExp.$2}${RegExp.$2[22] === 'g' ? '.gif' : '.jpg'}`;
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
                        return srcRegExpObj.test(finalSrc) ? `${RegExp.$1}_1280${RegExp.$2}` : '';
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
                        return srcRegExpObj.test(finalSrc) ? `${RegExp.$1}w0` : '';
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
                        if (srcRegExpObj.test(finalSrc)) {
                            return await tools.detectImage(`${RegExp.$1}originals${RegExp.$2}`, `${RegExp.$1}736x${RegExp.$2}`);
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
                        return srcRegExpObj.test(finalSrc) ? `${RegExp.$1}_b${RegExp.$3}` : '';
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
                        if (srcRegExpObj.test(aHref)) {
                            return await tools.detectImage(
                                `//w.${RegExp.$1}full/${RegExp.$3}/wallhaven-${RegExp.$2}.jpg`,
                                `//w.${RegExp.$1}full/${RegExp.$3}/wallhaven-${RegExp.$2}.png`
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
                        if (srcRegExpObj.test(finalSrc)) {
                            return await tools.detectImage(`${RegExp.$1}maxresdefault${RegExp.$2}`, `${RegExp.$1}hqdefault${RegExp.$2}`);
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
                        if (srcRegExpObj.test(src)) {
                            const isGif = trigger.classList && trigger.classList.contains('column-gif');
                            return RegExp.$1 + RegExp.$2 + (isGif ? '.gif' : RegExp.$3);
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

    const regexCacheHost = {};
    const regexCacheSrcMatch = {};

    window.Mix01RuleEngine = {
        configs: Mix01Configs,

        async getHighResUrl(triggerElement, originalSrc) {
            if (!originalSrc || originalSrc.startsWith('data:')) return originalSrc;

            const host = window.location.hostname;

            if (!this._matchedRulesCache) this._matchedRulesCache = {};
            if (!this._matchedRulesCache[host]) {
                let rules = [];
                for (const pattern in this.configs) {
                    if (pattern === '.*') continue; 
                    if (!regexCacheHost[pattern]) regexCacheHost[pattern] = new RegExp(`^${pattern}$`);
                    if (regexCacheHost[pattern].test(host)) {
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

                if (srcRegExpObj && !srcRegExpObj.test(originalSrc)) continue;

                if (rule.processor !== undefined) {
                    if (typeof rule.processor === 'function') {
                        const result = await rule.processor(triggerElement, originalSrc, srcRegExpObj);
                        if (result) return result;
                    } else if (typeof rule.processor === 'string' && srcRegExpObj) {
                        const replaced = originalSrc.replace(srcRegExpObj, rule.processor);
                        if (replaced !== originalSrc || rule.processor === '') return replaced;
                    }
                } else if (srcRegExpObj) {
                    const m = srcRegExpObj.exec(originalSrc);
                    if (m) return m[0];
                }
            }

            return originalSrc;
        }
    };
})();