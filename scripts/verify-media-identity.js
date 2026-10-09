// scripts/verify-media-identity.js
// 媒体身份判定模块（Basic/mediaIdentity.js）回归验证
//
// 身份判定是沉浸画廊导航的正确性核心：多图帖必须逐张区分、同一资源的不同
// 预览档（?name=small/large/orig）必须视为同一项、blob/MSE 视频必须靠
// statusId+槽位而不是临时句柄做身份。
//
// 覆盖：
//   I1 同一资源不同 query（name=small vs name=orig）→ 同一 key
//   I2 同一 statusId 的多张图（_p0/_p1）→ 不同 key，且槽位正确（1./2.）
//   I3 blob 视频 vs blob 图（同 statusId）→ 不同 key（vid: vs sid:#slot）
//   I4 跨 statusId 的同名资源不互相串台
//   I5 dedupe 保留文档顺序首项、剔除断连节点与重复 key
//   I6 sortMediaDocumentOrder 按文档顺序（非插入顺序）排序
//   I7 InputController 已委托到该模块（callsite 迁移无残留）
(function () {
    'use strict';
    let failed = 0;
    const check = (name, cond, extra = '') => {
        console.log((cond ? 'PASS ✅ ' : 'FAIL ❌ ') + name + (cond ? '' : '  ' + extra));
        if (!cond) failed++;
    };

    // ---- DOM 桩：只实现 mediaIdentity 用到的能力 ----
    class Node {
        constructor(tag, src = '', id = '') {
            this.tagName = tag;
            this.currentSrc = src;
            this.src = src;
            this.id = id;
            this.isConnected = true;
            this.naturalWidth = tag === 'IMG' ? 1200 : 0;
            this.naturalHeight = tag === 'IMG' ? 800 : 0;
            this.clientWidth = 300;
            this.clientHeight = 200;
            this._mixMediaSlot = undefined;
            this._mixStatusId = undefined;
            this.parent = null;
            this.children = [];
            this._docIndex = Node._seq++;
        }
        querySelectorAll(sel) {
            const want = sel.split(',').map(s => s.trim().toUpperCase());
            const out = [];
            const walk = (n) => {
                for (const c of n.children) {
                    if (want.includes(c.tagName)) out.push(c);
                    walk(c);
                }
            };
            walk(this);
            return out;
        }
        closest(sel) {
            let n = this;
            while (n) {
                if (sel === 'article' && n.tagName === 'ARTICLE') return n;
                if (sel === '[data-testid="tweet"]' && n.datasetTestid === 'tweet') return n;
                n = n.parent;
            }
            return null;
        }
        // 只需要「谁在文档中更靠前」的语义（真实实现用于稳定阅读顺序）
        compareDocumentPosition(other) {
            if (this === other) return 0;
            const a = this._docIndex, b = other._docIndex;
            return a < b ? Node.DOCUMENT_POSITION_FOLLOWING : Node.DOCUMENT_POSITION_PRECEDING;
        }
    }
    Node._seq = 0;
    Node.DOCUMENT_POSITION_FOLLOWING = 4;
    Node.DOCUMENT_POSITION_PRECEDING = 2;

    const article = new Node('ARTICLE');
    article.datasetTestid = 'tweet';
    const addChild = (parent, node) => { node.parent = parent; parent.children.push(node); return node; };

    // 多图帖 A（status 111）：两张图 + 一个视频封面缩略图（应被过滤）
    const imgA0 = addChild(article, new Node('IMG', 'https://pbs.twimg.com/media/AAA_p0?format=jpg&name=small'));
    imgA0._mixStatusId = '111';
    const imgA1 = addChild(article, new Node('IMG', 'https://pbs.twimg.com/media/AAA_p1?format=jpg&name=large'));
    imgA1._mixStatusId = '111';
    const thumb = addChild(article, new Node('IMG', 'https://pbs.twimg.com/tweet_video_thumb/VID.jpg'));
    thumb._mixStatusId = '111';
    const vidBlob = addChild(article, new Node('VIDEO', 'blob:https://x.com/abc-123'));
    vidBlob._mixStatusId = '111';

    // 另一帖（status 222）：同一作者头像等干扰项
    const article2 = new Node('ARTICLE');
    article2.datasetTestid = 'tweet';
    const avatar = addChild(article2, new Node('IMG', 'https://pbs.twimg.com/profile_images/9/me_normal.jpg'));
    avatar._mixStatusId = '222';
    const imgB0 = addChild(article2, new Node('IMG', 'https://pbs.twimg.com/media/AAA_p0?format=jpg&name=orig'));
    imgB0._mixStatusId = '222';

    // 加载模块
    const fs = require('fs');
    const path = require('path');
    global.window = {};
    global.Node = Node;
    global.location = { href: 'https://x.com/user/status/111' };
    global.URL = URL;
    const code = fs.readFileSync(path.join(__dirname, '..', 'Basic', 'mediaIdentity.js'), 'utf8');
    eval(code);
    const MI = global.window.Mix01MediaIdentity;
    check('模块导出完整 API', !!(MI && MI.mediaKey && MI.dedupeMedia && MI.sortMediaDocumentOrder && MI.normalizeAssetSrc));

    // I1 同资源不同预览档 → 同 key
    const keyA0Small = MI.mediaKey(imgA0);
    const keyB0Orig = MI.mediaKey(imgB0);
    check('I1 同资源不同 query 归一为同一 key（去 query）',
        keyA0Small.includes('AAA_p0') && MI.normalizeAssetSrc('https://pbs.twimg.com/media/AAA_p0?format=jpg&name=small')
            === MI.normalizeAssetSrc('https://pbs.twimg.com/media/AAA_p0?format=jpg&name=orig'),
        `${keyA0Small} vs ${keyB0Orig}`);

    // I2 同帖多图不同 key + 槽位（缩略图被过滤，不影响 1./2.）
    const keyA1 = MI.mediaKey(imgA1);
    check('I2a 同帖多图 key 不互相坍缩', keyA0Small !== keyA1, `${keyA0Small} vs ${keyA1}`);
    // 槽位为惰性落地：显式调用时按「有效媒体」编号，tweet_video_thumb 缩略图必须被过滤
    const slotA0 = MI.mediaSlotInArticle(imgA0);
    const slotA1 = MI.mediaSlotInArticle(imgA1);
    const slotVid = MI.mediaSlotInArticle(vidBlob);
    const slotThumb = MI.mediaSlotInArticle(thumb);
    // 关键不变量：视频封面缩略图不能占用有效编号（所以视频才是 2 号而不是 3 号）；
    // 被查询元素自身总会被保留，故 thumb 自己的槽位存在但不影响其它媒体的编号。
    check('I2b 多图槽位按有效媒体编号（视频封面缩略图被过滤）',
        slotA0 === 0 && slotA1 === 1 && slotVid === 2 && slotThumb >= 0,
        `slots=${slotA0},${slotA1},${slotVid},thumb=${slotThumb}`);

    // I3 blob 视频 vs blob 图：绝不能共享身份
    const vidKey = MI.mediaKey(vidBlob);
    check('I3a blob 视频 key 使用 vid:<statusId>', vidKey === 'vid:111', vidKey);
    const blobImg = addChild(article, new Node('IMG', 'blob:https://x.com/img-blob'));
    blobImg._mixStatusId = '111';
    const blobImgKey = MI.mediaKey(blobImg);
    check('I3b blob 图 key 使用 sid:<statusId>#<slot>', blobImgKey.startsWith('sid:111#'), blobImgKey);
    check('I3c blob 视频与 blob 图身份不同', vidKey !== blobImgKey, `${vidKey} vs ${blobImgKey}`);
    MI.mediaSlotInArticle(blobImg); // 触发槽位落地
    check('I3d blob 图与多图帖图片槽位不冲突', MI.mediaSlotInArticle(blobImg) !== imgA0._mixMediaSlot,
        `${MI.mediaSlotInArticle(blobImg)} vs ${imgA0._mixMediaSlot}`);

    // I4 跨帖同资源不串台（statusId 作为命名空间）
    const keyA0Ns = MI.mediaKey(imgA0);           // status 111
    const keyB0Ns = MI.mediaKey(imgB0);           // status 222（同 p0 但不同帖）
    check('I4 跨帖同资源因 statusId 命名空间区分',
        keyA0Ns.includes(':111:') && keyB0Ns.includes(':222:') && keyA0Ns !== keyB0Ns,
        `${keyA0Ns} vs ${keyB0Ns}`);

    // I5 dedupe
    const dup = addChild(article, new Node('IMG', 'https://pbs.twimg.com/media/AAA_p0?format=jpg&name=orig'));
    dup._mixStatusId = '111';
    const disconnected = new Node('IMG', 'https://pbs.twimg.com/media/DEAD_p0?format=jpg');
    disconnected.isConnected = false;
    const kept = MI.dedupeMedia([imgA0, dup, disconnected, imgA1, avatar]);
    check('I5 dedupe 保留首项、剔除重复 key 与断连节点',
        kept.length === 3 && kept[0] === imgA0 && kept.includes(imgA1),
        `len=${kept.length} keys=${kept.map(m => MI.mediaKey(m)).join('|')}`);

    // I6 文档顺序排序（故意以插入顺序倒序传入）
    const sorted = MI.sortMediaDocumentOrder([imgA1, imgA0, vidBlob]);
    check('I6 sortMediaDocumentOrder 按文档顺序而非插入顺序',
        sorted.length === 3 && sorted[0] === imgA0 && sorted[1] === imgA1 && sorted[2] === vidBlob,
        sorted.map(m => m.tagName + ':' + (m.currentSrc || '').slice(-12)).join(','));

    // I7 InputController 委托（无重复实现残留）
    const ic = fs.readFileSync(path.join(__dirname, '..', 'Basic', 'InputController.js'), 'utf8');
    const delegates = (name) =>
        new RegExp(`_${name}\\([\\s\\S]{0,120}?Mix01MediaIdentity\\.${name}`).test(ic);
    check('I7a InputController 五个身份方法均委托给模块',
        delegates('normalizeAssetSrc') && delegates('mediaSlotInArticle') && delegates('mediaKey') &&
        delegates('sortMediaDocumentOrder') && delegates('dedupeMedia'),
        [delegates('normalizeAssetSrc'), delegates('mediaSlotInArticle'), delegates('mediaKey'),
         delegates('sortMediaDocumentOrder'), delegates('dedupeMedia')].join(','));
    // 重复实现回归：如果谁把实现重新内联回 InputController，这些特征字符串会出现
    const inlineTraces = ['mediasource:', 'compareDocumentPosition', 'DOCUMENT_POSITION_FOLLOWING']
        .filter(t => ic.includes(t));
    check('I7c InputController 无重复身份实现残留', inlineTraces.length === 0, inlineTraces.join(','));
    check('I7b manifest 在 InputController 之前加载 mediaIdentity.js',
        (() => {
            const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
            const js = m.content_scripts[0].js;
            return js.indexOf('Basic/mediaIdentity.js') !== -1 &&
                   js.indexOf('Basic/mediaIdentity.js') < js.indexOf('Basic/InputController.js');
        })(),
        'load order wrong');

    console.log(`\n===== 媒体身份判定: ${failed === 0 ? '全部通过' : failed + ' 项失败'} =====`);
    process.exit(failed ? 4 : 0);
})();
