import { serve, callHost } from '/runtime/block-sdk.js';

const STORAGE_KEY = 'hidden_slots';
const SETTINGS_PAGE_SURFACE = 'settings_page';
const SUPPORTED_SURFACES = new Set([SETTINGS_PAGE_SURFACE]);
const CHINESE_TEXT = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;

// Fallback slot list used only when a standalone runtime without desktop
// ContribHost (e.g. CLI block-plugin-check) returns -32601 for get_items.
// Never used for grouping or previews.
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
  return Boolean(item && item.locked);
}

function cleanHidden(rawIds, lockedIds = null) {
  if (!Array.isArray(rawIds)) {
    return [];
  }
  const cleaned = new Set();
  for (const raw of rawIds) {
    if (typeof raw !== 'string') {
      continue;
    }
    const slotId = raw.trim();
    if (slotId && !(lockedIds && lockedIds.has(slotId))) {
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
    group: '',
  }));
}

function normalizePreview(rawPreview) {
  if (!Array.isArray(rawPreview)) {
    return null;
  }
  const icons = [];
  for (const rawIcon of rawPreview) {
    if (isPlainObject(rawIcon)) {
      icons.push({ ...rawIcon });
    }
  }
  return icons;
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
    const locked = Boolean(raw.locked);
    const label = String(raw.label || slotId);
    const item = {
      id: slotId,
      label,
      locked,
      hidden: locked ? false : Boolean(raw.hidden),
      group: typeof raw.group === 'string' ? raw.group.trim() : '',
    };
    if (isPlainObject(raw.icon)) {
      item.icon = { ...raw.icon };
    }
    const preview = normalizePreview(raw.preview);
    if (preview !== null) {
      item.preview = preview;
    }
    items.push(item);
  }
  return items;
}

function normalizeGroups(rawGroups) {
  if (!Array.isArray(rawGroups)) {
    return null;
  }
  const groups = [];
  for (const raw of rawGroups) {
    if (!isPlainObject(raw)) {
      continue;
    }
    const id = String(raw.id || '').trim();
    if (!id) {
      continue;
    }
    const label = String(raw.label || id);
    const order = [];
    if (Array.isArray(raw.order)) {
      for (const rawId of raw.order) {
        if (typeof rawId !== 'string') {
          continue;
        }
        const slotId = rawId.trim();
        if (slotId) {
          order.push(slotId);
        }
      }
    }
    groups.push({ id, label, order });
  }
  return groups.length > 0 ? groups : null;
}

function getTitlebarState() {
  let res;
  try {
    res = callHost('host.titlebar.get_items', {});
  } catch (err) {
    if (err && err.code === -32601) {
      return { items: fallbackItems(), groups: null };
    }
    throw err;
  }
  const rawItems = isPlainObject(res) ? res.items : null;
  if (Array.isArray(rawItems)) {
    return {
      items: normalizeItems(rawItems),
      groups: normalizeGroups(res.groups),
    };
  }
  return { items: fallbackItems(), groups: null };
}

function setHidden(hiddenIds, lockedIds = null) {
  const cleaned = cleanHidden(hiddenIds, lockedIds);
  cachedHidden = [...cleaned];
  let updated = null;
  try {
    const res = callHost('host.titlebar.set_hidden', { hidden: cleaned });
    if (isPlainObject(res) && Array.isArray(res.items)) {
      updated = {
        items: normalizeItems(res.items),
        groups: normalizeGroups(res.groups),
      };
    }
  } catch (err) {
    if (!err || err.code !== -32601) {
      throw err;
    }
  }
  callHost('host.storage.set', { key: STORAGE_KEY, value: cleaned });
  if (updated !== null) {
    if (updated.groups === null) {
      const latest = getTitlebarState();
      if (latest.groups !== null) {
        return latest;
      }
    }
    return updated;
  }
  return getTitlebarState();
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

function buildPreviewStrip(group, itemById) {
  let visibleCount = 0;
  const icons = [];
  for (const slotId of group.order) {
    const item = itemById.get(slotId);
    if (!item || item.hidden) {
      continue;
    }
    const preview = Array.isArray(item.preview) ? item.preview : [];
    if (preview.length === 0) {
      continue;
    }
    visibleCount += 1;
    for (const rawIcon of preview) {
      if (!isPlainObject(rawIcon) || icons.length >= 32) {
        continue;
      }
      const icon = { ...rawIcon };
      if (!icon.tooltip) {
        icon.tooltip = String(item.label);
      }
      icons.push(icon);
    }
  }
  return {
    kind: 'icon_strip',
    label: tr(`${group.label} · ${visibleCount} 个`, `${group.label} · ${visibleCount}`),
    icons,
    empty_text: tr('不显示图标', 'No icons shown'),
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

function buildPage(state, status = '') {
  const items = Array.isArray(state && state.items) ? state.items : [];
  const groups = Array.isArray(state && state.groups) ? state.groups : null;
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

  // Older hosts without `groups` degrade to a single flat switch list without preview.
  if (!groups || groups.length === 0) {
    return {
      title,
      status,
      cards: [
        {
          id: 'titlebar-items',
          title,
          items: [...buildRows(items), actions],
        },
      ],
    };
  }

  const itemById = new Map(items.map((item) => [item.id, item]));
  const itemsByGroup = new Map();
  const knownGroupIds = new Set(groups.map((g) => g.id));
  const ungrouped = [];
  for (const item of items) {
    if (item.group && knownGroupIds.has(item.group)) {
      let bucket = itemsByGroup.get(item.group);
      if (!bucket) {
        bucket = [];
        itemsByGroup.set(item.group, bucket);
      }
      bucket.push(item);
    } else {
      ungrouped.push(item);
    }
  }

  const cards = [];
  for (const group of groups) {
    if (itemIcons && group.order.length > 0) {
      cards.push({
        id: `titlebar-${group.id}-preview`,
        title: tr('预览', 'Preview'),
        items: [buildPreviewStrip(group, itemById)],
      });
    }
    const groupItems = itemsByGroup.get(group.id) || [];
    if (groupItems.length > 0) {
      cards.push({
        id: `titlebar-${group.id}`,
        title: group.label,
        items: buildRows(groupItems),
      });
    }
  }
  if (ungrouped.length > 0) {
    cards.push({
      id: 'titlebar-other',
      title: tr('其他', 'Other'),
      items: buildRows(ungrouped),
    });
  }

  const settingsCards = cards.filter((c) => !c.id.endsWith('-preview'));
  if (settingsCards.length > 0) {
    settingsCards[settingsCards.length - 1].items.push(actions);
  } else {
    cards.push({ id: 'titlebar-items', title, items: [actions] });
  }
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
      let savedHidden = cleanHidden(stored.value);
      cachedHidden = [...savedHidden];
      try {
        const res = callHost('host.titlebar.set_hidden', { hidden: savedHidden });
        if (isPlainObject(res) && Array.isArray(res.items)) {
          const items = normalizeItems(res.items);
          const lockedIds = new Set(items.filter(isLocked).map((item) => item.id));
          const filtered = cleanHidden(savedHidden, lockedIds);
          if (filtered.length !== savedHidden.length) {
            savedHidden = filtered;
            cachedHidden = [...filtered];
            callHost('host.storage.set', { key: STORAGE_KEY, value: filtered });
          }
        }
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
    let state = getTitlebarState();
    let items = state.items;
    const values = params.values;
    let accepted;
    if (isPlainObject(values) && Object.keys(values).length > 0) {
      const visibleIds = new Set(items.map((item) => item.id));
      const lockedIds = new Set(items.filter(isLocked).map((item) => item.id));
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
        state = setHidden([...nextHidden].sort(), lockedIds);
        items = state.items;
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
    return { page: buildPage(state), values: accepted };
  }

  if (method === 'plugin.action') {
    validateSurface(params);
    const actionId = String(params.action_id || '');
    if (actionId === 'show_all') {
      const state = setHidden([]);
      const status = tr('已显示全部顶栏图标', 'All titlebar icons are now shown');
      return {
        ok: true,
        tone: 'success',
        values: currentValues(state.items),
        page: buildPage(state, status),
        status,
      };
    }
    const state = getTitlebarState();
    const status = tr('未知操作', 'Unknown action');
    return {
      ok: false,
      tone: 'warning',
      values: currentValues(state.items),
      page: buildPage(state),
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
