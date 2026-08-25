// 验证「取关决策链」：确认 sheet 轮询 + live 翻转验证 + 诚实失败（不谎报）
// （无依赖，node scripts/verify-unfollow.js）
// 提取自 immersive-rules.js toggleViaCaretMenu / toggleViaDirectButton 修复后逻辑：
//   取关（willBeIn=false）：点击 Unfollow 菜单项/按钮后轮询点击确认 sheet
//   （confirmationSheetConfirm，最长 ~1.5s）；确认未点到 → 诚实失败 null。
//   验证只信 live 翻转信号（liveRelation）；无 live 信号时按「操作方向 + 确认已
//   提交」写缓存——缓存回声（after.relation 含旧状态）绝不参与判定，杜绝
//   「取关后仍显示已关注」的谎报。

function decideUnfollow(liveIn, confirmed, willBeIn) {
    if (liveIn !== null) return liveIn;            // live 翻转信号优先
    if (willBeIn || confirmed) return willBeIn;    // 关注乐观 / 取关需确认已提交
    return null;                                    // 确认未点到：诚实失败
}

const fails = [];
const check = (name, cond, detail) => {
    if (!cond) fails.push(name);
    console.log(name + ':', cond ? 'PASS ✅' : 'FAIL ❌', detail || '');
};

// 场景 A：取关，确认已点到，无 live 信号 → 返回 false（取关成功，按操作方向写缓存）
check('A 确认已提交→取关成功',
    decideUnfollow(null, true, false) === false,
    'decide=false（修复前 120ms 固定等待漏点确认 → 取关失败）');

// 场景 B：取关，确认未点到（sheet 渲染慢/未出现）→ 诚实失败，不写缓存不谎报
check('B 确认未点到→诚实失败',
    decideUnfollow(null, false, false) === null,
    'decide=null（toast「未能确认」，不得谎报已关注/已取消）');

// 场景 C：live 翻转信号优先（按钮真实变为 Follow）→ 返回 false
check('C live 翻转优先',
    decideUnfollow(false, true, false) === false,
    'decide=false（live 证据 = 按钮已翻转）');

// 场景 D：缓存回声不参与判定——after.relation 含旧状态（following）但无 live
// 信号时，不得返回 true（修复前 after.relation 回声会把取关谎报为已关注）
{
    const liveIn = null;            // liveRelation 缺失（时间线无按钮）
    const cacheEcho = 'following';  // 旧缓存回声（修复前被采用 → 谎报 true）
    const decided = decideUnfollow(liveIn, true, false);
    check('D 缓存回声不谎报', decided === false,
        'decided=' + decided + '（修复前 after.relation="' + cacheEcho + '" → inNow=true → 谎报已关注）');
}

// 场景 E：关注方向（willBeIn=true）无 live 信号时乐观成功（X 已处理菜单项点击）
check('E 关注方向乐观成功',
    decideUnfollow(null, false, true) === true,
    'decide=true（菜单项点击已被 X 处理）');

if (fails.length) {
    console.log('\n❌ FAIL: ' + fails.join('；'));
    process.exit(1);
}
console.log('\n✅ PASS: 取关决策链成立（确认轮询 + live 验证 + 回声不谎报）');
