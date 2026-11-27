import { serve, callHost } from '/runtime/block-sdk.js';

const STORAGE_KEY = 'hidden_slots';
const SETTINGS_PAGE_SURFACE = 'settings_page';
const SUPPORTED_SURFACES = new Set([SETTINGS_PAGE_SURFACE]);
const LOCKED_SLOT_IDS = new Set(['more']);
const SOURCE_SLOT_IDS = new Set(['wrap', 'zoom', 'reveal']);
const PREVIEW_SKIP_IDS = new Set(['reveal']);
const MARKDOWN_ORDER = ['plugin:', 'feedback', 'ai', 'send_all', 'more'];
const SOURCE_ORDER = ['wrap', 'zoom', 'plugin:', 'feedback', 'ai', 'more'];
const CHINESE_TEXT = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

const BUILTIN_SLOTS = [
  ['feedback', '反馈', 'Feedback', false],
  ['ai', 'AI Agent', 'AI Agent', false],
  ['send_all', '统一发送批注', 'Send All Annotations', false],
  ['wrap', '自动换行', 'Word Wrap', false],
  ['zoom', '缩放', 'Zoom', false],
  ['reveal', '在文件夹中显示', 'Reveal in Folder', false],
  ['more', '页面操作', 'Page Actions', true],
];

let pluginId = 'block-titlebar';
let dataDir = '';
let downloadsDir = '';
let locale = 'zh';
let kvTooltip = false;
let itemIcons = false;
let cachedHidden = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEn() {
  return String(locale || '').toLowerCase().startsWith('en');
}

function tr(zh, en) {
  return isEn() ? en : zh;
}

function localizeError(message) {
  const text = String(message || '').trim();
  if (isEn() && CHINESE_TEXT.test(text)) {
    return 'Operation failed';
  }
  return text || tr('操作失败', 'Operation failed');
}

function controlId(slotId) {
  return `show_${slotId}`;
}

function isLocked(item) {
  return Boolean(item.locked) || LOCKED_SLOT_IDS.has(String(item.id || ''));
}

function cleanHidden(rawIds) {
  if (!Array.isArray(rawIds)) {
    return [];
  }
  const cleaned = new Set();
  for (const raw of rawIds) {
    if (typeof raw !== 'string') {
      continue;
    }
    const slotId = raw.trim();
    if (slotId && !LOCKED_SLOT_IDS.has(slotId)) {
      cleaned.add(slotId);
    }
  }
  return [...cleaned].sort();
}

function setsEqual(a, b) {
  if (a.size !== b.size) {
    return false;
  }
  for (const value of a) {
    if (!b.has(value)) {
      return false;
    }
  }
  return true;
}

function fallbackItems() {
  const hiddenSet = new Set(cachedHidden || []);
  return BUILTIN_SLOTS.map(([slotId, zhLabel, enLabel, locked]) => ({
    id: slotId,
    label: isEn() ? enLabel : zhLabel,
    locked,
    hidden: locked ? false : hiddenSet.has(slotId),
  }));
}

function normalizeItems(rawItems) {
  const items = [];
  for (const raw of rawItems) {
    if (!isPlainObject(raw)) {
      continue;
    }
    const slotId = String(raw.id || '').trim();
    if (!slotId) {
      continue;
    }
    const locked = Boolean(raw.locked) || LOCKED_SLOT_IDS.has(slotId);
    const label = String(raw.label || slotId);
    const item = {
      id: slotId,
      label,
      locked,
      hidden: locked ? false : Boolean(raw.hidden),
    };
    if (isPlainObject(raw.icon)) {
      item.icon = { ...raw.icon };
    }
    items.push(item);
  }
  return items;
}

function getItems() {
  let res;
  try {
    res = callHost('host.titlebar.get_items', {});
  } catch (err) {
    if (err && err.code === -32601) {
      return fallbackItems();
    }
    throw err;
  }
  const rawItems = isPlainObject(res) ? res.items : null;
  if (Array.isArray(rawItems)) {
    return normalizeItems(rawItems);
  }
  return fallbackItems();
}

function setHidden(hiddenIds) {
  const cleaned = cleanHidden(hiddenIds);
  cachedHidden = [...cleaned];
  let updatedItems = null;
  try {
    const res = callHost('host.titlebar.set_hidden', { hidden: cleaned });
    if (isPlainObject(res) && Array.isArray(res.items)) {
      updatedItems = normalizeItems(res.items);
    }
  } catch (err) {
    if (!err || err.code !== -32601) {
      throw err;
    }
  }
  callHost('host.storage.set', { key: STORAGE_KEY, value: cleaned });
  if (updatedItems !== null) {
    return updatedItems;
  }
  return getItems();
}

function currentValues(items) {
  const values = {};
  for (const item of items) {
    if (!isLocked(item)) {
      values[controlId(item.id)] = !Boolean(item.hidden);
    }
  }
  return values;
}

function rowIcon(item) {
  if (itemIcons && isPlainObject(item.icon)) {
    return { ...item.icon };
  }
  return null;
}

function rankSlot(slotId, order) {
  for (let rank = 0; rank < order.length; rank += 1) {
    const key = order[rank];
    if (slotId === key || (key.endsWith(':') && slotId.startsWith(key))) {
      return rank;
    }
  }
  return null;
}

function stripIcons(item) {
  const icon = rowIcon(item);
  if (icon === null) {
    return [];
  }
  const label = String(item.label);
  if (item.id === 'zoom' && icon.name) {
    return [
      { name: 'tb-minus', tooltip: label },
      { chip: '100%', tooltip: label },
      { name: 'tb-plus', tooltip: label },
    ];
  }
  icon.tooltip = label;
  return [icon];
}

function buildStrip(items, order, label) {
  const visible = items
    .filter((item) => !item.hidden && !PREVIEW_SKIP_IDS.has(item.id) && rankSlot(item.id, order) !== null)
    .sort((a, b) => rankSlot(a.id, order) - rankSlot(b.id, order));
  const icons = [];
  for (const item of visible) {
    icons.push(...stripIcons(item));
  }
  return {
    kind: 'icon_strip',
    label: tr(`${label} · ${visible.length} 个`, `${label} · ${visible.length}`),
    icons,
    empty_text: tr('不显示图标', 'No icons shown'),
  };
}

function buildPreviewCard(cardId, items, order, label) {
  return {
    id: cardId,
    title: tr('预览', 'Preview'),
    items: [buildStrip(items, order, label)],
  };
}

function buildRows(items) {
  const rows = [];
  const lockedRows = [];
  for (const item of items) {
    const icon = rowIcon(item);
    if (isLocked(item)) {
      const row = {
        label: String(item.label),
        value: tr('始终显示', 'Always shown'),
      };
      if (icon) {
        row.icon = icon;
      }
      if (kvTooltip) {
        row.tooltip = tr(
          '该入口始终显示在顶栏右上角，不可隐藏',
          'This item is always shown in the titlebar and cannot be hidden',
        );
      }
      lockedRows.push(row);
      continue;
    }
    const sw = {
      kind: 'switch',
      id: controlId(item.id),
      label: String(item.label),
      value: !Boolean(item.hidden),
    };
    if (icon) {
      sw.icon = icon;
    }
    rows.push(sw);
  }
  if (lockedRows.length > 0) {
    rows.push({ kind: 'kv', rows: lockedRows });
  }
  return rows;
}

function buildPage(items, status = '') {
  const markdownItems = items.filter((item) => !SOURCE_SLOT_IDS.has(item.id));
  const sourceItems = items.filter((item) => SOURCE_SLOT_IDS.has(item.id));
  const actions = {
    kind: 'actions',
    buttons: [
      {
        id: 'show_all',
        label: tr('全部显示', 'Show all'),
        variant: 'secondary',
      },
    ],
  };
  const title = tr('顶栏图标', 'Titlebar Icons');
  const cards = [];
  if (itemIcons) {
    cards.push(buildPreviewCard('titlebar-markdown-preview', items, MARKDOWN_ORDER, 'Markdown'));
  }
  cards.push({ id: 'titlebar-markdown', title: 'Markdown', items: buildRows(markdownItems) });
  if (itemIcons) {
    cards.push(buildPreviewCard('titlebar-source-preview', items, SOURCE_ORDER, tr('源码模式', 'Source')));
  }
  const sourceRows = [...buildRows(sourceItems), actions];
  cards.push({ id: 'titlebar-source', title: tr('源码模式', 'Source Mode'), items: sourceRows });
  return { title, status, cards };
}

function validateSurface(params) {
  const raw = isPlainObject(params) ? params.surface : '';
  const surface = String(raw || SETTINGS_PAGE_SURFACE).trim() || SETTINGS_PAGE_SURFACE;
  if (!SUPPORTED_SURFACES.has(surface)) {
    throw new Error(tr(`不支持的界面: ${surface}`, `Unsupported surface: ${surface}`));
  }
  return surface;
}

function handle(method, params) {
  if (method === 'plugin.initialize') {
    pluginId = String(params.plugin_id || 'block-titlebar');
    dataDir = String(params.data_dir || '');
    downloadsDir = String(params.downloads_dir || '').trim();
    locale = String(params.locale || 'zh');
    const caps = new Set(Array.isArray(params.ui_capabilities) ? params.ui_capabilities : []);
    kvTooltip = caps.has('kv_tooltip');
    itemIcons = caps.has('item_icons');

    const stored = callHost('host.storage.get', { key: STORAGE_KEY });
    if (isPlainObject(stored) && stored.found && Array.isArray(stored.value)) {
      const savedHidden = cleanHidden(stored.value);
      cachedHidden = [...savedHidden];
      try {
        callHost('host.titlebar.set_hidden', { hidden: savedHidden });
      } catch (err) {
        if (!err || err.code !== -32601) {
          throw err;
        }
      }
    } else {
      cachedHidden = null;
    }
    return { ready: true };
  }

  if (method === 'plugin.render') {
    validateSurface(params);
    let items = getItems();
    const values = params.values;
    let accepted;
    if (isPlainObject(values) && Object.keys(values).length > 0) {
      const visibleIds = new Set(items.map((item) => item.id));
      const currentHidden = new Set(
        items.filter((item) => item.hidden && !isLocked(item)).map((item) => item.id),
      );
      const preservedHidden = new Set(
        (cachedHidden || []).filter((slotId) => slotId.startsWith('plugin:') && !visibleIds.has(slotId)),
      );
      const baselineHidden = new Set([...currentHidden, ...preservedHidden]);
      const nextHidden = new Set(baselineHidden);
      let touched = false;
      for (const item of items) {
        if (isLocked(item)) {
          continue;
        }
        const ctrlId = controlId(item.id);
        if (Object.prototype.hasOwnProperty.call(values, ctrlId)) {
          touched = true;
          if (Boolean(values[ctrlId])) {
            nextHidden.delete(item.id);
          } else {
            nextHidden.add(item.id);
          }
        }
      }
      if (touched && !setsEqual(nextHidden, baselineHidden)) {
        items = setHidden([...nextHidden].sort());
      }
      accepted = {};
      for (const item of items) {
        if (!isLocked(item)) {
          const ctrlId = controlId(item.id);
          if (Object.prototype.hasOwnProperty.call(values, ctrlId)) {
            accepted[ctrlId] = !Boolean(item.hidden);
          }
        }
      }
    } else {
      accepted = currentValues(items);
    }
    return { page: buildPage(items), values: accepted };
  }

  if (method === 'plugin.action') {
    validateSurface(params);
    const actionId = String(params.action_id || '');
    if (actionId === 'show_all') {
      const items = setHidden([]);
      const status = tr('已显示全部顶栏图标', 'All titlebar icons are now shown');
      return {
        ok: true,
        tone: 'success',
        values: currentValues(items),
        page: buildPage(items, status),
        status,
      };
    }
    const items = getItems();
    const status = tr('未知操作', 'Unknown action');
    return {
      ok: false,
      tone: 'warning',
      values: currentValues(items),
      page: buildPage(items),
      status,
    };
  }

  if (method === 'plugin.command') {
    const commandId = String(params.command_id || '');
    return {
      ok: false,
      tone: 'warning',
      status: commandId
        ? tr(`未知命令: ${commandId}`, `Unknown command: ${commandId}`)
        : tr('未知命令', 'Unknown command'),
    };
  }

  if (method === 'plugin.event') {
    const eventName = String(params.event || '');
    if (eventName === 'locale.changed' && params.locale) {
      locale = String(params.locale);
      return { handled: true };
    }
    return { handled: false };
  }

  if (method === 'plugin.shutdown') {
    return { ok: true };
  }

  throw new Error(tr(`不支持的方法: ${method}`, `Unsupported method: ${method}`));
}

serve((method, params) => {
  try {
    return handle(method, params);
  } catch (err) {
    const localized = new Error(localizeError(err && err.message ? err.message : err));
    if (err && typeof err.code === 'number') {
      localized.code = err.code;
    }
    throw localized;
  }
});
