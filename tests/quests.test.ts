/** 任务/成就/每日任务引擎测试 */
import { describe, expect, it } from 'vitest';
import { makeGame, NOW } from './helpers';
import {
  achievementViews, applyEvents, claimAchievement, claimQuest, dayKey, questComplete, refreshDaily,
} from '../src/core/quests';
import { questDef } from '../src/core/registry';
import { DAILY_QUEST_COUNT } from '../src/core/balance';
import { plant } from '../src/core/crops';

describe('任务链', () => {
  it('新档只挂第一条教程任务', () => {
    const state = makeGame();
    const tutorial = state.quests.active.filter((q) => !questDef(q.defId).daily);
    expect(tutorial.map((q) => q.defId)).toEqual(['q_welcome']);
  });

  it('事件推进任务并可领奖，随后解锁后继任务', () => {
    const state = makeGame();
    // 种两颗胡萝卜（真实动作产生事件）
    for (const plotUid of [state.plots[0].uid, state.plots[1].uid]) {
      const r = plant(state, plotUid, 'crop_carrot', NOW);
      expect(r.ok).toBe(true);
      applyEvents(state, r.events!, NOW);
    }
    const qp = state.quests.active.find((q) => q.defId === 'q_welcome')!;
    expect(questComplete(qp)).toBe(true);

    const coins = state.player.coins;
    expect(claimQuest(state, 'q_welcome', NOW).ok).toBe(true);
    expect(state.player.coins).toBe(coins + questDef('q_welcome').reward.coins!);
    expect(state.quests.tutorialDone).toContain('q_welcome');
    // 后继任务自动挂上
    expect(state.quests.active.some((q) => q.defId === 'q_water')).toBe(true);
  });

  it('only announces a quest as ready once', () => {
    const state = makeGame();
    const ready: string[] = [];
    for (const plot of state.plots) {
      const r = plant(state, plot.uid, 'crop_carrot', NOW);
      expect(r.ok).toBe(true);
      for (const ev of applyEvents(state, r.events!, NOW)) {
        if (ev.target === 'msg.questReady') ready.push(String(ev.data));
      }
    }
    expect(ready.filter((id) => id === 'q_welcome')).toHaveLength(1);
  });

  it('未完成不能领奖', () => {
    const state = makeGame();
    expect(claimQuest(state, 'q_welcome', NOW).ok).toBe(false);
  });

  it('expand 事件计一次扩岛', () => {
    const state = makeGame();
    state.quests.active.push({ defId: 'q_expand', counts: [0], startedAt: NOW });
    applyEvents(state, [{ type: 'expand', amount: 1, data: 2 }], NOW);
    const qp = state.quests.active.find((q) => q.defId === 'q_expand')!;
    expect(qp.counts[0]).toBe(1);
    expect(state.stats.expansions).toBe(1);
  });
});

describe('每日任务', () => {
  it('按天确定性刷出固定数量', () => {
    const state = makeGame();
    const daily = state.quests.daily;
    expect(daily.day).toBe(dayKey(NOW));
    expect(daily.questIds.length).toBeGreaterThan(0);
    expect(daily.questIds.length).toBeLessThanOrEqual(DAILY_QUEST_COUNT);

    // 同一天重复刷新不变
    const ids = [...daily.questIds];
    refreshDaily(state, NOW + 3600_000);
    expect(state.quests.daily.questIds).toEqual(ids);

    // 相同种子第二次生成一致（确定性）
    const state2 = makeGame();
    expect(state2.quests.daily.questIds).toEqual(ids);

    // 次日刷新换题
    refreshDaily(state, NOW + 24 * 3600_000);
    expect(state.quests.daily.day).toBe(dayKey(NOW + 24 * 3600_000));
  });
});

describe('成就', () => {
  it('统计达标后可逐层领取', () => {
    const state = makeGame();
    state.stats.harvests = 60; // 达到 10 和 50 两层
    const view = achievementViews(state).find((v) => v.id === 'ach_harvest')!;
    expect(view.tier).toBe(2);
    expect(claimAchievement(state, 'ach_harvest').ok).toBe(true);
    expect(claimAchievement(state, 'ach_harvest').ok).toBe(true);
    expect(claimAchievement(state, 'ach_harvest').ok).toBe(false); // 第三层未达标
    expect(state.achievements['ach_harvest']).toBe(2);
  });
});
