// rules-engine.js
// Mix01 高性能原生规则引擎 (终极完整版 + 正则缓存极限优化架构)

(function () {
    // 模拟原生环境下的 DOM 工具函数
    const tools = {
        getLargestImgSrc: function(container) {
            if (!container || !container.querySelectorAll) return '';
            let maxArea = 0;
            let bestSrc = '';
            const imgs = container.querySelectorAll('img, [style*="background"]');
            imgs.forEach(el => {
                const area = el.clientWidth * el.clientHeight;
                let src = el.src;
                if (!src && el.style.backgroundImage) {
                    const match = el.style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
                    if (match) src = match[1];
                }
                if (area >= maxArea && src) {
                    maxArea = area;
                    bestSrc = src;
                }
            });
            return bestSrc;
        },
        getBackgroundImgSrc: function(el) {
            if (!el) return '';
            const style = window.getComputedStyle(el);
            const match = style.backgroundImage.match(/url\(['"]?(.*?)['"]?\)/);
            return match ? match[1] : '';
        },
        detectImage: async function(primarySrc, fallbackSrc) {
            return new Promise((resolve) => {
                const img = new Image();
                img.onload = () => resolve(primarySrc);
                img.onerror = () => resolve(fallbackSrc || primarySrc);
                img.src = primarySrc;
            });
        }
    };

    const Mix01Configs = {
        // ==========================================
        // 1. 二次元 & 插画社区 (Pixiv, Bilibili, ArtStation, DeviantArt, Yande等)
        // ==========================================
        '(?:.+\\.)?pixiv\\.net': {
            srcMatching: [
                { srcRegExp: '(.+\\.pximg\\.net/user-profile/.+)_\\d+(@IMG@)', processor: '$1$2' },
                { srcRegExp: '(.+\\.pximg\\.net/.+/.+_thumb/.+)_\\w+(@IMG@)', processor: '$1$2' },
                { srcRegExp: '(.+\\.pximg\\.net)(?=/).+(/uploads/.+/)(?:.+_)?(\\d+@IMG@)', processor: '$1$2$3' },
                { srcRegExp: '(.+\\.pixiv\\.net/images/post/\\d+)/w/\\d+(/.+@IMG@)', processor: '$1$2' },
                {
                    selectors: 'img, [style*="background"], .kTOQSN',
                    srcRegExp: '(//.+\\.pximg\\.net/).+(/img/.+?)(_p\\d+)?_.+(@IMG@)',
                    processor: async (trigger, src, srcRegExpObj) => {
                        const finalSrc = src || tools.getLargestImgSrc(trigger.parentElement);
                        if (srcRegExpObj.test(finalSrc)) {
                            return await tools.detectImage(
                                `${RegExp.$1}img-original${RegExp.$2}${RegExp.$3 || '_ugoira0'}${RegExp.$4}`,
                                `${RegExp.$1}img-original${RegExp.$2}${RegExp.$3 || '_ugoira0'}.png`
                            );
                        }
                        return '';
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

        // ==========================================
        // 2. 社交媒体 (Twitter, Weibo, Instagram, Facebook, Reddit, Tumblr)
        // ==========================================
        '(?:(?:.+\\.)?twitter|x)\\.com': {
            srcMatching: [
                { srcRegExp: '(\\w+\\.twimg\\.com/(?:(?:[^/]+/)?default_)?profile_images/.+)_\\w+(?=@IMG@)(@IMG@)', processor: '$1$2' },
                { srcRegExp: '(\\w+\\.twimg\\.com/media/.+?)(?:@IMG@:\\w+)?(.+[?&]name=)[^&]+(.*)', processor: '$1$2orig$3' },
                { srcRegExp: '(\\w+\\.twimg\\.com/.+\\?format=.*&name=).+', processor: '$1orig' }
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

        // ==========================================
        // 3. 电商平台 (Taobao, Tmall, JD, Amazon, AliExpress, Etsy, eBay等)
        // ==========================================
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

        // ==========================================
        // 4. 图库 & 搜索引擎 (Google, Bing, Baidu, Pinterest, Flickr, Wallhaven)
        // ==========================================
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
                            } catch (e) {}
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

        // ==========================================
        // 5. 视频 & 其他综合社区 (YouTube, Zhihu, Github, Douban)
        // ==========================================
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

        // ==========================================
        // 6. 全局通用兜底规则 (CDN 过滤)
        // ==========================================
        '.*': {
            srcMatching: [
                { srcRegExp: '([?&@!])(?:x-oss-process=image|imageMogr2|imageView2).*', processor: '' },
                { srcRegExp: '([_-])(\\d{2,4})x(\\d{2,4})(@IMG@.*)', processor: '$4' },
                { srcRegExp: '(@IMG@)\\?.*', processor: '$1' },
                { srcRegExp: '(\\/(?:thumb(?:nail)?s?|small|mw\\d+)\\/)', processor: '/large/' }
            ]
        }
    };

    // 【核心性能优化】：正则引擎预编译缓存池
    const regexCacheHost = {};
    const regexCacheSrcMatch = {};

    window.Mix01RuleEngine = {
        configs: Mix01Configs,
        
        async getHighResUrl(triggerElement, originalSrc) {
            if (!originalSrc || originalSrc.startsWith('data:')) return originalSrc;

            const host = window.location.hostname;
            let matchedRules = [];
            
            // 管道 1：精确匹配当前域名，缓存编译后的正则对象
            for (const pattern in this.configs) {
                if (!regexCacheHost[pattern]) regexCacheHost[pattern] = new RegExp(`^${pattern}$`);
                
                if (regexCacheHost[pattern].test(host)) {
                    matchedRules = matchedRules.concat(this.configs[pattern].srcMatching || []);
                }
            }
            
            // 管道 2：插入全局兜底规则
            if (this.configs['.*']) {
                matchedRules = matchedRules.concat(this.configs['.*'].srcMatching || []);
            }

            // 执行规则队列
            for (const rule of matchedRules) {
                // DOM 选择器拦截
                if (rule.selectors && triggerElement && triggerElement.nodeType === 1) {
                    try { if (!triggerElement.matches(rule.selectors)) continue; } catch (e) {}
                }

                // 正则预编译与缓存拦截，极致压榨性能
                let srcRegExpObj = null;
                if (rule.srcRegExp) {
                    if (!regexCacheSrcMatch[rule.srcRegExp]) {
                        const regPattern = rule.srcRegExp.replace(/@IMG@/g, '\\.(?:jpe?g|gifv?|pn[gj]|bmp|webp|svg)');
                        regexCacheSrcMatch[rule.srcRegExp] = new RegExp(regPattern, 'i');
                    }
                    srcRegExpObj = regexCacheSrcMatch[rule.srcRegExp];
                }

                if (srcRegExpObj && !srcRegExpObj.test(originalSrc)) continue;

                // 处理器执行
                if (rule.processor !== undefined) {
                    if (typeof rule.processor === 'function') {
                        const result = await rule.processor(triggerElement, originalSrc, srcRegExpObj);
                        if (result) return result;
                    } else if (typeof rule.processor === 'string' && srcRegExpObj) {
                        return originalSrc.replace(srcRegExpObj, rule.processor);
                    }
                } else if (srcRegExpObj) {
                    return RegExp['$&'];
                }
            }
            
            return originalSrc; 
        }
    };
})();