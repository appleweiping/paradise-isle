/**
 * 任务与成就引擎：所有玩法动作产出 GameEvent，统一流入 applyEvents，
 * 在这里更新统计、推进任务/成就，并产出完成回执（发奖由 UI 层确认领取）。
 */
import type {
  ActionResult, DailyState, GameEvent, GameState, QuestProgress, QuestReward,
} from './types';
import { achievementDef, allAchievements, allQuests, questDef } from './registry';
import { DAILY_QUEST_COUNT } from './balance';
import { addItem, gainCoins, gainEnergy, gainFood, gainReputation, gainXp } from './player';
import { hashSeed, mulberry32, shuffle } from './rng';
import { fail } from './types';

export function dayKey(now: number): string {
  const d = new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 统计键映射：事件 → stats 字段 */
const STAT_KEY: Partial<Record<GameEvent['type'], string>> = {
  harvest: 'harvests',
  plant: 'plantings',
  water: 'waterings',
  collectAnimal: 'animalsCollected',
  feedAnimal: 'animalsFed',
  fishCatch: 'fishCaught',
  beastKill: 'beastsDefeated',
  clearWeed: 'weedsCleared',
  place: 'buildingsPlaced',
  buyClothing: 'clothesBought',
  adoptPet: 'petsAdopted',
  feedPet: 'petFeeds',
  playPet: 'petPlays',
  visit: 'visits',
  helpNeighbor: 'helps',
  prank: 'pranks',
  hire: 'hires',
  expand: 'expansions',
};

function stepMatches(stepType: string, stepTarget: string | undefined, ev: GameEvent): boolean {
  if (stepType !== ev.type) return false;
  if (!stepTarget || stepTarget === '*') return true;
  return stepTarget === ev.target;
}

/**
 * 应用一批事件：更新统计 + 推进任务；返回衍生事件（任务可领取提示等）。
 */
export function applyEvents(state: GameState, events: readonly GameEvent[], now: number): GameEvent[] {
  const derived: GameEvent[] = [];
  for (const ev of events) {
    const statKey = STAT_KEY[ev.type];
    if (statKey) {
      (state.stats as Record<string, number | string>)[statKey] =
        ((state.stats as Record<string, number | string>)[statKey] as number || 0) + (ev.amount ?? 1);
    }
    if (ev.type === 'fishCatch' && (ev.target === 'rare' || ev.target === 'epic' || ev.target === 'legendary')) {
      state.stats.rareFishCaught += ev.amount ?? 1;
    }
    // 推进进行中的任务
    for (const qp of state.quests.active) {
      const def = questDef(qp.defId);
      const wasComplete = questComplete(qp);
      def.steps.forEach((step, i) => {
        if (step.type === 'reachLevel') {
          if (ev.type === 'reachLevel') qp.counts[i] = Math.max(qp.counts[i], ev.amount ?? 0);
        } else if (step.type === 'earnCoins') {
          if (ev.type === 'earnCoins') qp.counts[i] += ev.amount ?? 0;
        } else if (stepMatches(step.type, step.target, ev)) {
          qp.counts[i] += ev.amount ?? 1;
        }
      });
      // announce only the moment a quest becomes claimable, not on every later event
      if (!wasComplete && questComplete(qp)) {
        derived.push({ type: 'toast', target: 'msg.questReady', data: qp.defId });
      }
    }
  }
  syncTutorialQuests(state, now);
  return derived;
}

export function questComplete(qp: QuestProgress): boolean {
  const def = questDef(qp.defId);
  return def.steps.every((s, i) => {
    if (s.type === 'reachLevel') return qp.counts[i] >= s.count;
    return qp.counts[i] >= s.count;
  });
}

/** 领奖并移除任务；教程任务记录到 tutorialDone */
export function claimQuest(state: GameState, defId: string, now: number): ActionResult {
  const idx = state.quests.active.findIndex((q) => q.defId === defId);
  if (idx < 0) return fail('msg.notFound');
  const qp = state.quests.active[idx];
  if (!questComplete(qp)) return fail('msg.notReady');
  const def = questDef(defId);
  state.quests.active.splice(idx, 1);
  const events = grantReward(state, def.reward);
  state.stats.questsDone += 1;
  if (def.daily) {
    state.quests.daily.completed.push(defId);
  } else {
    state.quests.tutorialDone.push(defId);
    syncTutorialQuests(state, now);
  }
  return { ok: true, events };
}

export function grantReward(state: GameState, reward: QuestReward): GameEvent[] {
  const events: GameEvent[] = [];
  if (reward.coins) events.push(...gainCoins(state, reward.coins));
  if (reward.xp) events.push(...gainXp(state, reward.xp));
  if (reward.food) gainFood(state, reward.food);
  if (reward.energy) gainEnergy(state, reward.energy);
  if (reward.reputation) gainReputation(state, reward.reputation);
  if (reward.items) {
    for (const [id, n] of Object.entries(reward.items)) addItem(state, id, n);
  }
  return events;
}

/** 把满足前置的教程任务加入 active */
export function syncTutorialQuests(state: GameState, now: number): void {
  for (const def of allQuests()) {
    if (def.daily) continue;
    if (state.quests.tutorialDone.includes(def.id)) continue;
    if (state.quests.active.some((q) => q.defId === def.id)) continue;
    if (def.after && !state.quests.tutorialDone.includes(def.after)) continue;
    if (def.minLevel && state.player.level < def.minLevel) continue;
    state.quests.active.push({
      defId: def.id,
      counts: def.steps.map((s) => (s.type === 'reachLevel' ? state.player.level : 0)),
      startedAt: now,
    });
  }
}

/** 每日任务：按天+存档种子确定性抽取 */
export function refreshDaily(state: GameState, now: number): void {
  const day = dayKey(now);
  if (state.quests.daily.day === day) return;
  // 移除旧的每日任务
  state.quests.active = state.quests.active.filter((q) => !questDef(q.defId).daily);
  const pool = allQuests().filter(
    (q) => q.daily && (!q.minLevel || state.player.level >= q.minLevel),
  );
  const rng = mulberry32(hashSeed(`${state.seed}:${day}`));
  const chosen = shuffle(rng, pool).slice(0, DAILY_QUEST_COUNT);
  const daily: DailyState = { day, questIds: chosen.map((q) => q.id), completed: [] };
  state.quests.daily = daily;
  for (const q of chosen) {
    state.quests.active.push({
      defId: q.id,
      counts: q.steps.map(() => 0),
      startedAt: now,
    });
  }
  // 顺带记录游玩天数
  if (state.stats.lastPlayDay !== day) {
    state.stats.lastPlayDay = day;
    state.stats.daysPlayed += 1;
  }
}

// ---------------------------------------------------------------- 成就

export interface AchievementView {
  id: string;
  tier: number;          // 已达成层数（含未领取）
  claimed: number;       // 已领取层数
  current: number;       // 当前统计值
  next: number | null;   // 下一层目标
}

export function achievementViews(state: GameState): AchievementView[] {
  return allAchievements().map((a) => {
    const current = Number(state.stats[a.stat] ?? 0);
    let tier = 0;
    for (const t of a.tiers) if (current >= t) tier++;
    const claimed = state.achievements[a.id] || 0;
    return {
      id: a.id,
      tier,
      claimed,
      current,
      next: tier < a.tiers.length ? a.tiers[tier] : null,
    };
  });
}

/** 领取一层成就奖励 */
export function claimAchievement(state: GameState, id: string): ActionResult {
  const def = achievementDef(id);
  const current = Number(state.stats[def.stat] ?? 0);
  const claimed = state.achievements[id] || 0;
  if (claimed >= def.tiers.length) return fail('msg.allClaimed');
  if (current < def.tiers[claimed]) return fail('msg.notReady');
  state.achievements[id] = claimed + 1;
  const events = grantReward(state, def.rewardPerTier);
  events.push({ type: 'achievement', target: id, amount: claimed + 1 });
  return { ok: true, events };
}
