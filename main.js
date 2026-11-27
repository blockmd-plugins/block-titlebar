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

function protocolErrorText() {
  return tr('协议错误：宿主返回了无效的顶栏数据', 'Protocol error: host returned invalid titlebar data');
}

function normalizePreview(rawPreview) {
  if (rawPreview === undefined || rawPreview === null) {
    return null;
  }
  if (!Array.isArray(rawPreview)) {
    return false;
  }
  const icons = [];
  for (const rawIcon of rawPreview) {
    if (!isPlainObject(rawIcon)) {
      return false;
    }
    icons.push({ ...rawIcon });
  }
  return icons;
}

function displayText(text, fallback) {
  const value = String(text || '').trim();
  if (!value || (isEn() && CHINESE_TEXT.test(value))) {
    return fallback;
  }
  return value;
}

function normalizeItems(rawItems) {
  const items = [];
  for (const raw of rawItems) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string') {
      return null;
    }
    const slotId = raw.id.trim();
    if (!slotId) {
      return null;
    }
    if (raw.icon !== undefined && raw.icon !== null && !isPlainObject(raw.icon)) {
      return null;
    }
    const preview = normalizePreview(raw.preview);
    if (preview === false) {
      return null;
    }
    const locked = raw.locked === true;
    const label = displayText(raw.label, slotId.replace(/^plugin:/, ''));
    const item = {
      id: slotId,
      label,
      locked,
      hidden: locked ? false : raw.hidden === true,
      group: typeof raw.group === 'string' ? raw.group.trim() : '',
    };
    if (isPlainObject(raw.icon)) {
      item.icon = { ...raw.icon };
    }
    if (preview !== null) {
      item.preview = preview;
    }
    items.push(item);
  }
  return items;
}

function normalizeGroups(rawGroups) {
  if (rawGroups === undefined || rawGroups === null) {
    return { groups: null, valid: true };
  }
  if (!Array.isArray(rawGroups)) {
    return { groups: null, valid: false };
  }
  const groups = [];
  for (const raw of rawGroups) {
    if (!isPlainObject(raw) || typeof raw.id !== 'string' || !Array.isArray(raw.order)) {
      return { groups: null, valid: false };
    }
    const id = raw.id.trim();
    if (!id) {
      return { groups: null, valid: false };
    }
    const label = displayText(raw.label, id);
    const order = [];
    for (const rawId of raw.order) {
      if (typeof rawId !== 'string') {
        return { groups: null, valid: false };
      }
      const slotId = rawId.trim();
      if (slotId) {
        order.push(slotId);
      }
    }
    groups.push({ id, label, order });
  }
  return { groups: groups.length > 0 ? groups : null, valid: true };
}

function parseTitlebarResponse(res, requireItems = true) {
  if (!isPlainObject(res)) {
    return { items: [], groups: null, error: protocolErrorText() };
  }
  if (!Object.prototype.hasOwnProperty.call(res, 'items')) {
    if (!requireItems) {
      return null;
    }
    return { items: [], groups: null, error: protocolErrorText() };
  }
  if (!Array.isArray(res.items)) {
    return { items: [], groups: null, error: protocolErrorText() };
  }
  const items = normalizeItems(res.items);
  if (items === null) {
    return { items: [], groups: null, error: protocolErrorText() };
  }
  const { groups, valid } = normalizeGroups(res.groups);
  if (!valid) {
    return { items: [], groups: null, error: protocolErrorText() };
  }
  return { items, groups, error: '' };
}

function getTitlebarState() {
  let res;
  try {
    res = callHost('host.titlebar.get_items', {});
  } catch (err) {
    if (err && err.code === -32601) {
      return { items: fallbackItems(), groups: null, error: '' };
    }
    throw err;
  }
  return parseTitlebarResponse(res, true);
}

function setHidden(hiddenIds, lockedIds = null) {
  const cleaned = cleanHidden(hiddenIds, lockedIds);
  cachedHidden = [...cleaned];
  let updated = null;
  try {
    const res = callHost('host.titlebar.set_hidden', { hidden: cleaned });
    updated = parseTitlebarResponse(res, false);
  } catch (err) {
    if (!err || err.code !== -32601) {
      throw err;
    }
  }
  callHost('host.storage.set', { key: STORAGE_KEY, value: cleaned });
  if (updated !== null) {
    if (updated.error) {
      return updated;
    }
    if (updated.groups === null) {
      const latest = getTitlebarState();
      if (latest.error || latest.groups !== null) {
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
  const errorStatus = state && typeof state.error === 'string' ? state.error.trim() : '';
  const title = tr('顶栏图标', 'Titlebar Icons');
  if (errorStatus) {
    return {
      title,
      status: errorStatus,
      cards: [
        {
          id: 'titlebar-error',
          title,
          items: [
            {
              kind: 'kv',
              rows: [{ label: tr('状态', 'Status'), value: errorStatus }],
            },
          ],
        },
      ],
    };
  }
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
  let lastSettingsCard = null;
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
      lastSettingsCard = {
        id: `titlebar-${group.id}`,
        title: group.label,
        items: buildRows(groupItems),
      };
      cards.push(lastSettingsCard);
    }
  }
  if (ungrouped.length > 0) {
    lastSettingsCard = {
      id: 'titlebar-other',
      title: tr('其他', 'Other'),
      items: buildRows(ungrouped),
    };
    cards.push(lastSettingsCard);
  }

  if (lastSettingsCard) {
    lastSettingsCard.items.push(actions);
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
        const parsed = parseTitlebarResponse(res, false);
        if (parsed && !parsed.error) {
          const manageableIds = new Set(
            parsed.items.filter((item) => !isLocked(item)).map((item) => item.id),
          );
          const filtered = savedHidden.filter(
            (slotId) => manageableIds.has(slotId) || slotId.startsWith('plugin:'),
          );
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
      if (state.error) {
        return {
          ok: false,
          tone: 'danger',
          values: currentValues(state.items),
          page: buildPage(state),
          status: state.error,
        };
      }
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
    const status = state.error || tr('未知操作', 'Unknown action');
    return {
      ok: false,
      tone: state.error ? 'danger' : 'warning',
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
