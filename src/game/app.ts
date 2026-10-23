/**
 * 游戏主编排：主循环（tick + 渲染）、输入（平移/缩放/点击）、
 * 三种场景模式（自家岛/NPC邻居岛/好友快照岛）、编辑摆放模式、事件分发。
 */
import type { ActionResult, GameEvent, GameState, NeighborState } from '../core/types';
import { tickWorld } from '../core/state';
import { updateEnergy } from '../core/player';
import { buildTerrain, isFishable, terrainAt } from '../core/island';
import { cropView, harvest, plant, plotByUid, removePlot, till, water } from '../core/crops';
import { animalPhase, collectAnimal, feedAnimal } from '../core/animals';
import { clearWeed } from '../core/weeds';
import { feedPet, petHungry, playPet } from '../core/pets';
import { canPlace, movePlacement, placeBuilding, rotatePlacement, storePlacement } from '../core/build';
import { buyBuilding, refundBuilding } from '../core/economy';
import {
  helpChaseBeast, helpWater, helpWeed, neighborByDefId, prankNeighbor, simulateNeighbor, visitNeighbor,
} from '../core/social';
import { applyEvents } from '../core/quests';
import { tillCost, PRANK_PER_NEIGHBOR_PER_DAY } from '../core/balance';
import { buildingDef, cropDef, itemDef, neighborDef, petDef, allCrops } from '../core/registry';
import { saveToSlot } from '../save/save';
import type { IslandSnapshot } from '../social/friendcode';
import { Renderer, sceneFromState, type RenderScene, type SceneActor } from '../render/renderer';
import { isoX, isoY } from '../render/iso';
import { Hud } from '../ui/hud';
import { hideActionMenu, isActionMenuOpen, showActionMenu, type MenuAction } from '../ui/actionMenu';
import { openInventory } from '../ui/panels/inventory';
import { openShop } from '../ui/panels/shop';
import { openQuestLog } from '../ui/panels/questlog';
import { openCollections } from '../ui/panels/collections';
import { openWardrobe } from '../ui/panels/wardrobe';
import { openNeighbors } from '../ui/panels/neighbors';
import { openSettings } from '../ui/panels/settings';
import { closePanel, isPanelOpen } from '../ui/modal';
import { floatText, toast } from '../ui/toast';
import { startFishing } from './fishing';
import { startBattle } from './battle';
import { fmtDuration, t, tl } from '../i18n';
import { setMusic, setSound, sfx, startBgm } from '../audio/sound';

type Mode =
  | { kind: 'home' }
  | { kind: 'neighbor'; ns: NeighborState }
  | { kind: 'snapshot'; snap: IslandSnapshot };

interface EditState {
  /** 摆放新建筑（已付费，取消需退款） */
  placing: string | null;
  /** 移动已有摆放 */
  movingUid: number | null;
  active: boolean;
}

const AUTOSAVE_MS = 30_000;

export class App {
  state: GameState;
  private slot: number;
  private renderer: Renderer;
  private hud: Hud;
  private mode: Mode = { kind: 'home' };
  private edit: EditState = { placing: null, movingUid: null, active: false };
  private hover: { tx: number; ty: number } | null = null;
  private playerActor: SceneActor;
  private walkTarget: { x: number; y: number; cb: (() => void) | null } | null = null;
  private lastSave = 0;
  private running = true;
  private raf = 0;
  private onBackToTitle: () => void;

  constructor(canvas: HTMLCanvasElement, state: GameState, slot: number, onBackToTitle: () => void) {
    this.state = state;
    this.slot = slot;
    this.onBackToTitle = onBackToTitle;
    this.renderer = new Renderer(canvas);
    this.playerActor = {
      avatar: state.player.avatar,
      x: state.player.px,
      y: state.player.py,
      walking: false,
    };

    setSound(state.settings.sound);
    setMusic(state.settings.music);

    this.hud = new Hud({
      onOpen: (panel) => this.openPanel(panel),
      onToggleEdit: () => this.toggleEdit(),
      onGoHome: () => this.goHome(),
    });

    this.bindInput(canvas);
    this.renderer.centerOnIsland(sceneFromState(state));
    window.addEventListener('resize', () => this.renderer.resize());
    window.addEventListener('beforeunload', () => this.save());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.save();
    });
    // 首次交互解锁音频
    const unlock = (): void => {
      startBgm();
      window.removeEventListener('pointerdown', unlock);
    };
    window.addEventListener('pointerdown', unlock);

    this.lastSave = Date.now();
    // 调试/自动化测试钩子（不影响正常游玩）
    (window as unknown as Record<string, unknown>).__PI__ = {
      app: this,
      state: () => this.state,
      isFishable: (x: number, y: number) => isFishable(this.state, x, y),
      terrainAt: (x: number, y: number) => terrainAt(this.state, x, y),
      tileToScreen: (x: number, y: number) => [
        this.renderer.camera.sx(isoX(x, y)),
        this.renderer.camera.sy(isoY(x, y)),
      ],
    };
    this.loop();
  }

  destroy(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  now(): number {
    return Date.now();
  }

  save(): void {
    this.state.player.px = this.playerActor.x;
    this.state.player.py = this.playerActor.y;
    saveToSlot(this.state, this.slot, this.now());
  }

  // ---------------------------------------------------------------- 事件分发

  dispatch = (result: ActionResult): void => {
    const now = this.now();
    if (!result.ok) {
      if (result.reason) toast(t(result.reason), 'bad');
      sfx('error');
      return;
    }
    const events = result.events ?? [];
    const derived = applyEvents(this.state, events, now);
    for (const ev of [...events, ...derived]) this.handleEvent(ev);
  };

  private handleEvent(ev: GameEvent): void {
    const px = this.playerScreenX();
    const py = this.playerScreenY();
    switch (ev.type) {
      case 'levelUp':
        sfx('levelup');
        toast(t('msg.levelUp', { lv: ev.amount ?? 0 }), 'good');
        floatText(px, py - 80, `Lv.${ev.amount}!`, 'float-level');
        break;
      case 'harvest':
        sfx('harvest');
        floatText(px, py - 60, `+${ev.amount}`, 'float-good');
        break;
      case 'plant': sfx('plant'); break;
      case 'water': sfx('water'); break;
      case 'earnCoins':
        if ((ev.amount ?? 0) > 0) sfx('coin');
        break;
      case 'fishCatch': break; // 钓鱼弹窗自带
      case 'collectAnimal':
        sfx('harvest');
        floatText(px, py - 60, `+${ev.amount}`, 'float-good');
        break;
      case 'feedAnimal':
      case 'feedPet':
        sfx('eat');
        break;
      case 'playPet':
        sfx('happy');
        floatText(px, py - 60, '♥', 'float-heart');
        break;
      case 'place': sfx('build'); break;
      case 'expand':
        sfx('levelup');
        toast(t('msg.expanded'), 'good');
        this.renderer.centerOnIsland(sceneFromState(this.state));
        break;
      case 'achievement':
        sfx('quest');
        break;
      case 'toast': {
        if (ev.target === 'msg.questReady') {
          sfx('quest');
          toast(t('msg.questReady'), 'good');
        } else if (ev.target === 'msg.friendGift') {
          const persona = neighborDef(String(ev.data));
          toast(t('msg.friendGift', { name: tl(persona.name), n: ev.amount ?? 0 }), 'good');
        } else if (ev.target === 'msg.hireDone') {
          toast(t('msg.hireDone', { n: ev.amount ?? 0 }), 'good');
        } else if (ev.target) {
          toast(t(ev.target), 'info');
        }
        break;
      }
      default:
        break;
    }
  }

  private playerScreenX(): number {
    return this.renderer.camera.sx(isoX(this.playerActor.x, this.playerActor.y));
  }

  private playerScreenY(): number {
    return this.renderer.camera.sy(isoY(this.playerActor.x, this.playerActor.y));
  }

  // ---------------------------------------------------------------- 面板

  private openPanel(panel: string): void {
    hideActionMenu();
    switch (panel) {
      case 'inventory': openInventory(this.state, this.dispatch); break;
      case 'shop':
        openShop({
          state: this.state,
          now: () => this.now(),
          dispatch: this.dispatch,
          onPlaceBuilding: (defId) => this.beginPlaceBuilding(defId),
        });
        break;
      case 'quests': openQuestLog(this.state, () => this.now(), this.dispatch); break;
      case 'collections': openCollections(this.state); break;
      case 'wardrobe':
        openWardrobe(this.state, (r) => {
          this.dispatch(r);
          this.playerActor.avatar = this.state.player.avatar;
        });
        break;
      case 'neighbors':
        openNeighbors({
          state: this.state,
          now: () => this.now(),
          dispatch: this.dispatch,
          onVisit: (npcId) => this.visitNpc(npcId),
          onVisitSnapshot: (snap) => this.visitSnapshot(snap),
        });
        break;
      case 'settings':
        openSettings({
          state: this.state,
          now: () => this.now(),
          onLangChange: () => window.location.reload(),
          onImported: () => window.location.reload(),
          onBackToTitle: () => {
            this.destroy();
            this.onBackToTitle();
          },
        });
        break;
    }
  }

  // ---------------------------------------------------------------- 编辑模式

  private toggleEdit(): void {
    if (this.mode.kind !== 'home') return;
    this.edit.active = !this.edit.active;
    if (!this.edit.active) this.cancelEdit();
    this.hud.setEditActive(this.edit.active);
    sfx('click');
  }

  private cancelEdit(): void {
    if (this.edit.placing) {
      refundBuilding(this.state, this.edit.placing);
      toast(t('ui.cancel'), 'info');
    }
    this.edit.placing = null;
    this.edit.movingUid = null;
  }

  private beginPlaceBuilding(defId: string): void {
    const buyResult = buyBuilding(this.state, defId);
    if (!buyResult.ok) {
      this.dispatch(buyResult);
      return;
    }
    closePanel();
    this.edit.active = true;
    this.edit.placing = defId;
    this.edit.movingUid = null;
    this.hud.setEditActive(true);
  }

  // ---------------------------------------------------------------- 场景切换

  private visitNpc(npcId: string): void {
    const ns = neighborByDefId(this.state, npcId);
    if (!ns) return;
    simulateNeighbor(ns, this.now());
    this.dispatch(visitNeighbor(this.state, npcId, this.now()));
    this.mode = { kind: 'neighbor', ns };
    this.edit.active = false;
    this.hud.setEditActive(false);
    const persona = neighborDef(npcId);
    this.hud.setVisiting(tl(persona.name), false);
    this.renderer.camera.centerOnTile(9, 9);
    // 邻居打招呼
    const g = persona.greetings[Math.floor(Math.random() * persona.greetings.length)];
    toast(`${tl(persona.name)}: ${tl(g)}`, 'info');
    sfx('happy');
  }

  private visitSnapshot(snap: IslandSnapshot): void {
    this.mode = { kind: 'snapshot', snap };
    this.edit.active = false;
    this.hud.setEditActive(false);
    this.hud.setVisiting(snap.name, true);
    const size = buildTerrain(snap.seed, snap.islandTier).length;
    this.renderer.camera.centerOnTile(size / 2, size / 2);
    this.dispatch({ ok: true, events: [{ type: 'visit', target: 'snapshot', amount: 1 }] });
  }

  private goHome(): void {
    this.mode = { kind: 'home' };
    this.hud.setVisiting(null, false);
    this.renderer.centerOnIsland(sceneFromState(this.state));
  }

  // ---------------------------------------------------------------- 输入

  private bindInput(canvas: HTMLCanvasElement): void {
    let downX = 0;
    let downY = 0;
    let dragging = false;
    let panning = false;
    // two-finger pinch zoom on touch screens (the mouse wheel does this on desktop)
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    let pinching = false;
    const spread = (): { d: number; mx: number; my: number } => {
      const [a, b] = [...pointers.values()];
      return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };

    canvas.addEventListener('pointerdown', (ev) => {
      pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pointers.size === 2) {
        pinching = true;
        pinchDist = spread().d;
        return;
      }
      downX = ev.clientX;
      downY = ev.clientY;
      dragging = true;
      panning = false;
    });
    const dropPointer = (ev: PointerEvent): void => {
      pointers.delete(ev.pointerId);
    };
    window.addEventListener('pointercancel', dropPointer);
    canvas.addEventListener('pointermove', (ev) => {
      const cam = this.renderer.camera;
      if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (pinching) {
        if (pointers.size === 2) {
          const { d, mx, my } = spread();
          if (pinchDist > 0 && d > 0) cam.zoomAt(d / pinchDist, mx, my);
          pinchDist = d;
        }
        return;
      }
      if (dragging) {
        const dx = ev.clientX - downX;
        const dy = ev.clientY - downY;
        if (panning || Math.hypot(dx, dy) > 6) {
          panning = true;
          cam.pan(ev.movementX, ev.movementY);
        }
      }
      const tile = cam.tileAt(ev.clientX, ev.clientY);
      this.hover = tile;
    });
    canvas.addEventListener('pointerup', (ev) => {
      dropPointer(ev);
      dragging = false;
      if (pinching) {
        // a pinch never counts as a tap; wait until every finger is up
        if (pointers.size === 0) pinching = false;
        panning = false;
        return;
      }
      if (panning) {
        panning = false;
        return;
      }
      this.onClick(ev.clientX, ev.clientY);
    });
    canvas.addEventListener('pointerleave', (ev) => {
      if (ev.pointerType === 'mouse') dropPointer(ev);
      dragging = false;
      this.hover = null;
    });
    canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      this.renderer.camera.zoomAt(ev.deltaY < 0 ? 1.12 : 0.9, ev.clientX, ev.clientY);
    }, { passive: false });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        if (isActionMenuOpen()) hideActionMenu();
        else if (isPanelOpen()) closePanel();
        else if (this.edit.placing || this.edit.movingUid) this.cancelEdit();
      }
    });
  }

  // ---------------------------------------------------------------- 点击处理

  private onClick(sx: number, sy: number): void {
    if (isActionMenuOpen()) {
      hideActionMenu();
      return;
    }
    const { tx, ty } = this.renderer.camera.tileAt(sx, sy);
    const now = this.now();

    if (this.mode.kind === 'snapshot') {
      return; // 快照岛纯参观
    }
    if (this.mode.kind === 'neighbor') {
      this.onClickNeighbor(this.mode.ns, tx, ty, sx, sy, now);
      return;
    }

    // ---- 编辑摆放
    if (this.edit.placing) {
      const defId = this.edit.placing;
      if (canPlace(this.state, defId, tx, ty)) {
        this.edit.placing = null;
        this.dispatch(placeBuilding(this.state, defId, tx, ty));
      } else {
        toast(t('msg.cannotPlace'), 'bad');
      }
      return;
    }
    if (this.edit.movingUid !== null) {
      const uid = this.edit.movingUid;
      const pl = this.state.placements.find((p) => p.uid === uid);
      if (pl && canPlace(this.state, pl.defId, tx, ty, uid)) {
        this.edit.movingUid = null;
        this.dispatch(movePlacement(this.state, uid, tx, ty));
        sfx('build');
      } else {
        toast(t('msg.cannotPlace'), 'bad');
      }
      return;
    }

    const state = this.state;

    // ---- 实体优先级：野兽 > 动物 > 宠物 > 杂草 > 农田 > 建筑(编辑) > 水(钓鱼) > 空草地
    const beast = state.beasts.find((b) => b.x === tx && b.y === ty);
    if (beast) {
      const def = beastDefSafe(beast.defId);
      this.walkNear(tx, ty, () => {
        showActionMenu(sx, sy, def, [{
          label: t('act.fight'),
          icon: 'fx:beast',
          onClick: () => startBattle(state, beast.uid, () => this.now(), this.dispatch, () => {}),
        }]);
      });
      return;
    }

    const animal = state.animals.find((a) => a.x === tx && a.y === ty);
    if (animal) {
      const phase = animalPhase(animal, now);
      const def = itemNameSafe(() => tl(cropOrAnimalName(animal.defId)));
      const actions: MenuAction[] = [];
      if (phase === 'hungry') {
        actions.push({ label: t('act.feed'), icon: 'fx:hungry', onClick: () => this.dispatch(feedAnimal(state, animal.uid, this.now())) });
      } else if (phase === 'ready') {
        actions.push({ label: t('act.collect'), icon: 'fx:ready', onClick: () => this.dispatch(collectAnimal(state, animal.uid, this.now())) });
      } else {
        actions.push({ label: `⏳ ${fmtDuration(animalEtaSafe(animal, now))}`, disabled: true, onClick: () => {} });
      }
      this.walkNear(tx, ty, () => showActionMenu(sx, sy, def, actions));
      return;
    }

    const pet = state.pets.find((p) => Math.round(p.x) === tx && Math.round(p.y) === ty);
    if (pet) {
      const actions: MenuAction[] = [];
      if (petHungry(pet, now)) {
        actions.push({ label: t('act.pet.feed'), icon: 'fx:hungry', onClick: () => this.dispatch(feedPet(state, pet.uid, this.now())) });
      }
      actions.push({ label: t('act.pet.play'), icon: 'fx:heart', onClick: () => this.dispatch(playPet(state, pet.uid, this.now())) });
      this.walkNear(tx, ty, () => showActionMenu(sx, sy, `${pet.name} Lv.${petLevelSafe(pet.xp)}`, actions));
      return;
    }

    const weed = state.weeds.find((w) => w.x === tx && w.y === ty);
    if (weed) {
      this.walkNear(tx, ty, () => this.dispatch(clearWeed(state, weed.uid, this.now())));
      return;
    }

    const plot = state.plots.find((p) => p.x === tx && p.y === ty);
    if (plot) {
      this.onClickPlot(plot.uid, tx, ty, sx, sy, now);
      return;
    }

    const placement = state.placements.find((p) => {
      const def = buildingDef(p.defId);
      return tx >= p.x && tx < p.x + def.w && ty >= p.y && ty < p.y + def.h;
    });
    if (placement && this.edit.active) {
      const def = buildingDef(placement.defId);
      showActionMenu(sx, sy, tl(def.name), [
        { label: '↔ ' + t('hud.edit'), onClick: () => { this.edit.movingUid = placement.uid; } },
        { label: '🔄', onClick: () => this.dispatch(rotatePlacement(state, placement.uid)) },
        { label: `📦 +${Math.floor(def.price / 2)}`, onClick: () => { this.dispatch(storePlacement(state, placement.uid)); sfx('coin'); } },
      ]);
      return;
    }

    if (isFishable(state, tx, ty)) {
      this.walkNear(tx, ty, () => startFishing(state, () => this.now(), this.dispatch));
      return;
    }

    if (terrainAt(state, tx, ty) === 'grass') {
      const cost = tillCost(state.plots.length);
      this.walkNear(tx, ty, () => {
        showActionMenu(sx, sy, `(${tx}, ${ty})`, [{
          label: t('act.till', { coins: cost }),
          icon: 'tile:plot:dry',
          onClick: () => this.dispatch(till(state, tx, ty, this.now())),
        }]);
      });
    }
  }

  private onClickPlot(plotUid: number, tx: number, ty: number, sx: number, sy: number, now: number): void {
    const state = this.state;
    const plot = plotByUid(state, plotUid);
    if (!plot) return;
    const actions: MenuAction[] = [];
    let title = t('msg.noCrop');
    if (!plot.crop) {
      title = `🌱 (${tx}, ${ty})`;
      // 列出背包里已有种子
      const seeds = allCrops().filter((c) => (state.inventory[c.seedId] || 0) > 0);
      for (const c of seeds.slice(0, 6)) {
        actions.push({
          label: `${tl(c.name)} ×${state.inventory[c.seedId]}`,
          icon: `icon:${c.seedId}`,
          onClick: () => this.dispatch(plant(state, plotUid, c.id, this.now())),
        });
      }
      actions.push({
        label: `🛒 ${t('shop.seeds')}`,
        onClick: () => this.openPanel('shop'),
      });
      actions.push({
        label: t('act.removePlot'),
        onClick: () => this.dispatch(removePlot(state, plotUid)),
      });
    } else {
      const crop = plot.crop;
      const def = cropDef(crop.defId);
      const view = cropView(crop, now);
      title = tl(def.name);
      if (view.stage === 'ready') {
        actions.push({ label: t('act.harvest'), icon: 'fx:ready', onClick: () => this.dispatch(harvest(state, plotUid, this.now())) });
      } else if (view.stage === 'withered') {
        actions.push({ label: t('act.clear'), icon: 'fx:hungry', onClick: () => this.dispatch(harvest(state, plotUid, this.now())) });
      } else {
        actions.push({ label: `⏳ ${fmtDuration(view.etaMs)}`, disabled: true, onClick: () => {} });
        actions.push({ label: t('act.water'), icon: 'fx:drop', onClick: () => this.dispatch(water(state, plotUid, this.now())) });
      }
    }
    this.walkNear(tx, ty, () => showActionMenu(sx, sy, title, actions));
  }

  private onClickNeighbor(ns: NeighborState, tx: number, ty: number, sx: number, sy: number, now: number): void {
    simulateNeighbor(ns, now);
    const persona = neighborDef(ns.defId);

    const beast = ns.beasts.find((b) => b.x === tx && b.y === ty);
    if (beast) {
      showActionMenu(sx, sy, tl(persona.name), [{
        label: t('act.chase'), icon: 'fx:beast',
        onClick: () => this.dispatch(helpChaseBeast(this.state, ns, beast.uid, this.now())),
      }]);
      return;
    }
    const weed = ns.weeds.find((w) => w.x === tx && w.y === ty);
    if (weed) {
      showActionMenu(sx, sy, tl(persona.name), [{
        label: t('act.weed'), icon: 'weed',
        onClick: () => this.dispatch(helpWeed(this.state, ns, weed.uid, this.now())),
      }]);
      return;
    }
    const plot = ns.plots.find((p) => p.x === tx && p.y === ty);
    if (plot && plot.crop) {
      const view = cropView(plot.crop, now);
      const actions: MenuAction[] = [];
      if (view.stage !== 'ready' && view.stage !== 'withered') {
        actions.push({
          label: t('act.helpWater'), icon: 'fx:drop',
          onClick: () => this.dispatch(helpWater(this.state, ns, plot.uid, this.now())),
        });
      }
      actions.push({
        label: `${t('act.prank')} (${Math.max(0, PRANK_PER_NEIGHBOR_PER_DAY - ns.prankedToday)})`,
        icon: 'fx:sparkle',
        onClick: () => this.doPrank(ns),
      });
      showActionMenu(sx, sy, tl(cropDef(plot.crop.defId).name), actions);
      return;
    }
    // 空地：捣蛋选项
    showActionMenu(sx, sy, tl(persona.name), [{
      label: `${t('act.prank')} (${Math.max(0, PRANK_PER_NEIGHBOR_PER_DAY - ns.prankedToday)})`,
      icon: 'fx:sparkle',
      onClick: () => this.doPrank(ns),
    }]);
  }

  private doPrank(ns: NeighborState): void {
    const persona = neighborDef(ns.defId);
    const result = prankNeighbor(this.state, ns, this.now());
    this.dispatch(result);
    if (result.ok) {
      const angry = persona.angry[Math.floor(Math.random() * persona.angry.length)];
      toast(`${tl(persona.name)}: ${tl(angry)}`, 'info');
      sfx('happy');
    }
  }

  // ---------------------------------------------------------------- 行走

  private walkNear(tx: number, ty: number, cb: () => void): void {
    if (this.mode.kind !== 'home') {
      cb();
      return;
    }
    const dist = Math.hypot(this.playerActor.x - tx, this.playerActor.y - ty);
    if (dist <= 1.6) {
      cb();
      return;
    }
    // 目标：邻近一格
    const dx = this.playerActor.x - tx;
    const dy = this.playerActor.y - ty;
    const len = Math.max(0.001, Math.hypot(dx, dy));
    this.walkTarget = {
      x: tx + (dx / len) * 0.9,
      y: ty + (dy / len) * 0.9,
      cb,
    };
  }

  // ---------------------------------------------------------------- 主循环

  private lastFrame = 0;

  private loop = (): void => {
    if (!this.running) return;
    const now = this.now();
    const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
    this.lastFrame = now;

    // 世界推进
    const tickSummary = tickWorld(this.state, now);
    updateEnergy(this.state, now);
    if (tickSummary.beastsArrived > 0 && this.mode.kind === 'home') {
      sfx('roar');
      toast(t('msg.beastArrive'), 'bad');
    }
    if (tickSummary.petGift) {
      const pet = this.state.pets.find((p) => petDef(p.defId).skill === 'find_gift');
      toast(t('msg.petGift', {
        pet: pet?.name ?? '?', item: tl(itemDef(tickSummary.petGift).name),
      }), 'good');
    }

    // 行走插值
    if (this.walkTarget) {
      const speed = 4.6 / 1000; // 格/毫秒
      const dx = this.walkTarget.x - this.playerActor.x;
      const dy = this.walkTarget.y - this.playerActor.y;
      const dist = Math.hypot(dx, dy);
      const step = speed * dt;
      if (dist <= step) {
        this.playerActor.x = this.walkTarget.x;
        this.playerActor.y = this.walkTarget.y;
        const cb = this.walkTarget.cb;
        this.walkTarget = null;
        this.playerActor.walking = false;
        cb?.();
      } else {
        this.playerActor.x += (dx / dist) * step;
        this.playerActor.y += (dy / dist) * step;
        this.playerActor.walking = true;
      }
    }

    // 场景组装
    const scene = this.buildScene(now);
    this.renderer.render(scene, now);
    this.hud.update(this.state, now);

    // 自动保存
    if (now - this.lastSave > AUTOSAVE_MS) {
      this.lastSave = now;
      this.save();
    }

    this.raf = requestAnimationFrame(this.loop);
  };

  private buildScene(now: number): RenderScene {
    if (this.mode.kind === 'neighbor') {
      const ns = this.mode.ns;
      const persona = neighborDef(ns.defId);
      return {
        seed: persona.islandSeed,
        islandTier: 1,
        plots: ns.plots,
        placements: ns.placements,
        animals: [],
        beasts: ns.beasts,
        weeds: ns.weeds,
        pets: [],
        actors: [
          { avatar: persona.avatar, x: 9, y: 7, walking: false, name: tl(persona.name) },
          { ...this.playerActor, x: 10, y: 10, walking: false },
        ],
        hover: null,
        ghost: null,
      };
    }
    if (this.mode.kind === 'snapshot') {
      const snap = this.mode.snap;
      const size = buildTerrain(snap.seed, snap.islandTier).length;
      return {
        seed: snap.seed,
        islandTier: snap.islandTier,
        plots: snap.plots,
        placements: snap.placements,
        animals: snap.animals.map((a, i) => ({ uid: -1 - i, defId: a.defId, x: a.x, y: a.y, fedAt: now })),
        beasts: [],
        weeds: [],
        pets: snap.pets.map((p, i) => ({ defId: p.defId, x: Math.floor(size / 2) + i, y: Math.floor(size / 2) + 3 })),
        actors: [{ avatar: snap.avatar, x: size / 2, y: size / 2, walking: false, name: snap.name }],
        hover: null,
        ghost: null,
      };
    }

    const scene = sceneFromState(this.state);
    this.playerActor.avatar = this.state.player.avatar;
    scene.actors = [{ ...this.playerActor, name: this.state.player.name }];
    if (this.hover) {
      const ok = this.edit.placing
        ? canPlace(this.state, this.edit.placing, this.hover.tx, this.hover.ty)
        : this.edit.movingUid !== null
          ? movableOk(this.state, this.edit.movingUid, this.hover.tx, this.hover.ty)
          : terrainAt(this.state, this.hover.tx, this.hover.ty) !== 'water' || isFishable(this.state, this.hover.tx, this.hover.ty);
      scene.hover = { tx: this.hover.tx, ty: this.hover.ty, ok };
      if (this.edit.placing) {
        scene.ghost = { defId: this.edit.placing, tx: this.hover.tx, ty: this.hover.ty, ok };
      } else if (this.edit.movingUid !== null) {
        const pl = this.state.placements.find((p) => p.uid === this.edit.movingUid);
        if (pl) scene.ghost = { defId: pl.defId, tx: this.hover.tx, ty: this.hover.ty, ok };
      }
    }
    return scene;
  }
}

// ---------------------------------------------------------------- 小助手

import { beastDef as _beastDef, animalDef as _animalDef } from '../core/registry';
import { petLevel } from '../core/balance';
import { animalEta } from '../core/animals';

function beastDefSafe(defId: string): string {
  try { return tl(_beastDef(defId).name); } catch { return defId; }
}

function cropOrAnimalName(defId: string): { zh: string; en: string } {
  try { return _animalDef(defId).name; } catch { return { zh: defId, en: defId }; }
}

function itemNameSafe(fn: () => string): string {
  try { return fn(); } catch { return '?'; }
}

function animalEtaSafe(a: { defId: string; fedAt: number | null; uid: number; x: number; y: number }, now: number): number {
  try { return animalEta(a, now); } catch { return 0; }
}

function petLevelSafe(xp: number): number {
  return petLevel(xp);
}

function movableOk(state: GameState, uid: number, tx: number, ty: number): boolean {
  const pl = state.placements.find((p) => p.uid === uid);
  if (!pl) return false;
  return canPlace(state, pl.defId, tx, ty, uid);
}
