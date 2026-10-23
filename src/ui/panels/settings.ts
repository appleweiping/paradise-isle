/**
 * 设置面板：语言、音效/音乐、存档导入导出、回到标题。
 */
import type { GameState } from '../../core/types';
import { exportSave, importSave, saveToSlot, activeSlot } from '../../save/save';
import { setLang, t } from '../../i18n';
import { setMusic, setSound } from '../../audio/sound';
import { h, clearChildren } from '../dom';
import { closePanel, confirmDialog, openPanel, promptDialog } from '../modal';
import { toast } from '../toast';

export interface SettingsCtx {
  state: GameState;
  now: () => number;
  /** 语言切换后需要整体刷新 UI */
  onLangChange: () => void;
  onImported: (state: GameState) => void;
  onBackToTitle: () => void;
}

export function openSettings(ctx: SettingsCtx): void {
  openPanel({
    title: t('panel.settings'),
    body: (body) => render(body, ctx),
  });
}

function toggleRow(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const btn = h('button', {
    class: `btn btn-sm ${value ? 'btn-primary' : ''}`,
    onclick: () => onChange(!value),
  }, value ? 'ON' : 'OFF');
  return h('div', { class: 'set-row' }, h('span', {}, label), btn);
}

function render(body: HTMLElement, ctx: SettingsCtx): void {
  clearChildren(body);
  const { state } = ctx;
  const rerender = (): void => render(body, ctx);

  // 语言
  const langBtn = h('button', {
    class: 'btn btn-sm',
    onclick: () => {
      state.settings.lang = state.settings.lang === 'zh' ? 'en' : 'zh';
      setLang(state.settings.lang);
      ctx.onLangChange();
      openSettings(ctx);
    },
  }, state.settings.lang === 'zh' ? '中文' : 'English');
  body.append(h('div', { class: 'set-row' }, h('span', {}, t('set.lang')), langBtn));

  body.append(toggleRow(t('set.sound'), state.settings.sound, (v) => {
    state.settings.sound = v;
    setSound(v);
    rerender();
  }));
  body.append(toggleRow(t('set.music'), state.settings.music, (v) => {
    state.settings.music = v;
    setMusic(v);
    rerender();
  }));

  body.append(h('div', { class: 'set-row' },
    h('button', {
      class: 'btn',
      onclick: () => {
        const data = exportSave(state, ctx.now());
        void navigator.clipboard?.writeText(data).then(
          () => toast(t('set.exportDone'), 'good'),
          () => promptDialog(t('set.export'), data, () => {}),
        );
      },
    }, `⬆ ${t('set.export')}`),
    h('button', {
      class: 'btn',
      onclick: () => {
        promptDialog(t('set.importPrompt'), '', (data) => {
          try {
            const imported = importSave(data, ctx.now());
            saveToSlot(imported, activeSlot(), ctx.now());
            toast(t('set.importDone'), 'good');
            closePanel();
            ctx.onImported(imported);
          } catch {
            toast(t('set.importBad'), 'bad');
          }
        });
      },
    }, `⬇ ${t('set.import')}`),
  ));

  body.append(h('div', { class: 'set-row' },
    h('button', {
      class: 'btn',
      onclick: () => {
        confirmDialog(t('set.reset') + '?', () => {
          saveToSlot(state, activeSlot(), ctx.now());
          closePanel();
          ctx.onBackToTitle();
        });
      },
    }, `🏝 ${t('set.reset')}`),
  ));

  body.append(h('div', { class: 'set-about' },
    h('div', {}, `${t('start.title')} v1.0`),
    h('div', {}, t('set.aboutArt')),
  ));
}
