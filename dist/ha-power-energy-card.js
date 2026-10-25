/*
 * Power & Energy Card for Home Assistant
 * https://github.com/duck-duck-dude/HA-power-energy-card
 *
 * Two sections in one card:
 *   - Active Load:  top N loads by live power, % of whole-home load,
 *                   unmonitored remainder and offline count.
 *   - Energy Today: top N loads by energy since midnight, optional cost.
 *
 * Energy today is read from Home Assistant's long-term statistics for each
 * load's lifetime energy sensor (found automatically on the same device as
 * the power sensor), so no utility_meter helpers are needed.
 *
 * Dependency-free: plain custom elements, no build step.
 */

const CARD_VERSION = "0.1.0";
const CARD_TYPE = "power-energy-card";
const EDITOR_TYPE = "power-energy-card-editor";
const STATS_REFRESH_MS = 5 * 60 * 1000;

const DEFAULTS = {
  top_n: 5,
  show_cost: true,
  show_load: true,
  show_energy: true,
  load_title: "Active Load",
  energy_title: "Energy Today",
};

const MDI = {
  pencil:
    "M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z",
  delete:
    "M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z",
  plus: "M19,13H13V19H11V13H5V11H11V5H13V11H19V13Z",
};

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

const numState = (stateObj) => {
  if (!stateObj) return null;
  const v = parseFloat(stateObj.state);
  return Number.isFinite(v) ? v : null;
};

/** Live power in W, honouring the sensor's unit (W / kW / MW / mW). */
const toWatts = (stateObj) => {
  const v = numState(stateObj);
  if (v === null) return null;
  const u = (stateObj.attributes.unit_of_measurement || "W").trim();
  if (u === "kW") return v * 1000;
  if (u === "MW") return v * 1e6;
  if (u === "mW") return v / 1000;
  return v;
};

/** Energy in kWh, honouring the sensor's unit (Wh / kWh / MWh). */
const toKwh = (stateObj) => {
  const v = numState(stateObj);
  if (v === null) return null;
  const u = (stateObj.attributes.unit_of_measurement || "kWh").trim();
  if (u === "Wh") return v / 1000;
  if (u === "MWh") return v * 1000;
  return v;
};

/** Price per kWh, honouring "/Wh" or "/MWh" units. */
const toPricePerKwh = (stateObj) => {
  const v = numState(stateObj);
  if (v === null) return null;
  const u = stateObj.attributes.unit_of_measurement || "";
  if (/\/\s*MWh$/i.test(u)) return v / 1000;
  if (/\/\s*Wh$/i.test(u)) return v * 1000;
  return v;
};

const isPowerSensor = (stateObj) =>
  !!stateObj &&
  stateObj.entity_id.startsWith("sensor.") &&
  (stateObj.attributes.device_class === "power" ||
    ["W", "kW", "MW"].includes(stateObj.attributes.unit_of_measurement));

const isEnergyCounter = (stateObj) =>
  !!stateObj &&
  stateObj.entity_id.startsWith("sensor.") &&
  stateObj.attributes.device_class === "energy" &&
  ["total_increasing", "total"].includes(stateObj.attributes.state_class);

const EXPORT_RE = /(return|export|produc|generat|feed.?in|injected)/i;

/**
 * Find the lifetime energy sensor that belongs to the same device as a power
 * sensor. Skips "returned"/"exported" counters (e.g. Shelly *_energy_returned).
 * If several remain, picks the one whose entity_id shares the longest prefix
 * with the power sensor.
 */
const findEnergyFor = (hass, powerId) => {
  if (!hass || !powerId) return undefined;
  const ent = hass.entities?.[powerId];
  if (!ent?.device_id) return undefined;
  const cands = Object.values(hass.entities)
    .filter((e) => e.device_id === ent.device_id && e.entity_id !== powerId)
    .map((e) => hass.states[e.entity_id])
    .filter(isEnergyCounter)
    .filter(
      (s) => !EXPORT_RE.test(s.entity_id) && !EXPORT_RE.test(s.attributes.friendly_name || "")
    );
  if (cands.length <= 1) return cands[0]?.entity_id;
  const common = (a, b) => {
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i;
  };
  cands.sort((a, b) => common(b.entity_id, powerId) - common(a.entity_id, powerId));
  return cands[0].entity_id;
};

const loadName = (hass, load) => {
  if (load.name) return load.name;
  const ent = hass?.entities?.[load.entity];
  if (ent?.device_id) {
    const dev = hass.devices?.[ent.device_id];
    if (dev) return dev.name_by_user || dev.name || load.entity;
  }
  return hass?.states[load.entity]?.attributes.friendly_name || load.entity;
};

const loadIcon = (hass, load) =>
  load.icon ||
  hass?.entities?.[load.entity]?.icon ||
  hass?.states[load.entity]?.attributes.icon ||
  "mdi:power-plug";

const normalizeConfig = (config) => {
  if (!config || typeof config !== "object") throw new Error("Invalid configuration");
  const loads = config.loads ?? [];
  if (!Array.isArray(loads)) throw new Error("'loads' must be a list");
  return {
    ...config,
    loads: loads
      .map((l) => (typeof l === "string" ? { entity: l } : { ...l }))
      .filter((l) => l && typeof l.entity === "string"),
  };
};

const opt = (config, key) => (config[key] === undefined ? DEFAULTS[key] : config[key]);

const fmtW = (w) =>
  w >= 1000 ? (w / 1000).toFixed(2) + " kW" : w >= 100 ? w.toFixed(0) + " W" : w.toFixed(1) + " W";

const fmtE = (k) => (k >= 1 ? k.toFixed(2) + " kWh" : (k * 1000).toFixed(0) + " Wh");

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
};

/* ------------------------------------------------------------------ */
/* Card                                                                */
/* ------------------------------------------------------------------ */

class PowerEnergyCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = undefined;
    this._hass = undefined;
    this._stats = { day: null, change: {}, last: {}, ids: "" };
    this._fetching = false;
    this._timer = undefined;
    this._energyCache = undefined;
  }

  static getConfigElement() {
    return document.createElement(EDITOR_TYPE);
  }

  static getStubConfig(hass) {
    const power = Object.values(hass.states)
      .filter((s) => isPowerSensor(s) && numState(s) !== null)
      .filter((s) => (s.attributes.unit_of_measurement || "W") === "W")
      .slice(0, 3)
      .map((s) => ({ entity: s.entity_id }));
    return { loads: power };
  }

  setConfig(config) {
    this._config = normalizeConfig(config);
    this._render();
    this._maybeFetch();
  }

  set hass(hass) {
    const old = this._hass;
    this._hass = hass;
    if (!this._config) return;
    if (!old || this._trackedChanged(old, hass)) this._render();
    this._maybeFetch();
  }

  get hass() {
    return this._hass;
  }

  connectedCallback() {
    if (!this._timer) {
      this._timer = setInterval(() => this._fetchStats(), STATS_REFRESH_MS);
    }
    this._maybeFetch();
  }

  disconnectedCallback() {
    clearInterval(this._timer);
    this._timer = undefined;
  }

  getCardSize() {
    const n = opt(this._config || {}, "top_n");
    let size = 0;
    if (opt(this._config || {}, "show_load")) size += 2 + Math.ceil(n * 0.8);
    if (opt(this._config || {}, "show_energy")) size += 2 + Math.ceil(n * 0.8);
    return size || 1;
  }

  getGridOptions() {
    return { columns: 12, min_columns: 6 };
  }

  /* ---- data ------------------------------------------------------ */

  _energyId(load) {
    if (load.energy) return load.energy;
    // findEnergyFor scans the entity registry, so cache per registry snapshot
    // (hass.entities only changes identity when the registry changes).
    const reg = this._hass?.entities;
    if (this._energyCache?.reg !== reg) this._energyCache = { reg, map: new Map() };
    const map = this._energyCache.map;
    if (!map.has(load.entity)) map.set(load.entity, findEnergyFor(this._hass, load.entity));
    return map.get(load.entity);
  }

  _trackedIds() {
    const c = this._config;
    const ids = [c.home_power, c.home_energy, c.rate];
    for (const l of c.loads) ids.push(l.entity, this._energyId(l));
    return ids.filter(Boolean);
  }

  _trackedChanged(oldHass, newHass) {
    return this._trackedIds().some((id) => oldHass.states[id] !== newHass.states[id]);
  }

  _maybeFetch() {
    if (!this._hass || !this._config || !this.isConnected) return;
    const ids = this._energyIds().join(",");
    if (this._stats.day !== todayKey() || this._stats.ids !== ids) this._fetchStats();
  }

  _energyIds() {
    if (!this._hass || !this._config) return [];
    return [...new Set(this._config.loads.map((l) => this._energyId(l)).filter(Boolean))].sort();
  }

  async _fetchStats() {
    const hass = this._hass;
    if (!hass || !this._config || this._fetching) return;
    const ids = this._energyIds();
    const day = todayKey();
    const key = ids.join(",");
    if (!ids.length) {
      this._stats = { day, change: {}, last: {}, ids: key };
      return;
    }
    this._fetching = true;
    try {
      const change = {};
      await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await hass.callWS({
              type: "recorder/statistic_during_period",
              statistic_id: id,
              calendar: { period: "day" },
              types: ["change"],
              units: { energy: "kWh" },
            });
            change[id] = typeof r?.change === "number" ? r.change : null;
          } catch (e) {
            change[id] = null;
          }
        })
      );
      // Latest 5-minute statistic state, so live sensor values can be added on
      // top of the statistics total between refreshes.
      const last = {};
      try {
        const r = await hass.callWS({
          type: "recorder/statistics_during_period",
          start_time: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
          statistic_ids: ids,
          period: "5minute",
          types: ["state"],
          units: { energy: "kWh" },
        });
        for (const id of ids) {
          const rows = r?.[id];
          const st = rows?.length ? rows[rows.length - 1].state : null;
          if (typeof st === "number") last[id] = st;
        }
      } catch (e) {
        /* live top-up is optional */
      }
      this._stats = { day, change, last, ids: key };
    } finally {
      this._fetching = false;
      this._render();
    }
  }

  /** kWh used today for one energy entity, or null if unknown. */
  _todayKwh(energyId) {
    if (!energyId || this._stats.day !== todayKey()) return null;
    const ch = this._stats.change[energyId];
    if (typeof ch !== "number") return null;
    let v = ch;
    const last = this._stats.last[energyId];
    const cur = toKwh(this._hass.states[energyId]);
    if (typeof last === "number" && cur !== null && cur >= last) v += cur - last;
    return Math.max(v, 0);
  }

  /* ---- rendering -------------------------------------------------- */

  _fmtMoney(amount) {
    const currency = this._hass?.config?.currency || "USD";
    const lang = this._hass?.locale?.language || this._hass?.language || "en";
    const f = (n) => {
      try {
        return new Intl.NumberFormat(lang, {
          style: "currency",
          currency,
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(n);
      } catch (e) {
        return "$" + n.toFixed(2);
      }
    };
    return amount > 0 && amount < 0.01 ? "&lt;" + f(0.01) : f(amount);
  }

  _row(icon, name, share, valueHtml, pct, accent, gradient) {
    return `
      <div class="row">
        <ha-icon icon="${esc(icon)}" style="color:${accent}"></ha-icon>
        <div class="mid">
          <div class="label"><span class="name">${esc(name)}</span><span class="share">${share}</span></div>
          <div class="track"><div class="bar" style="width:${pct}%;background:${gradient}"></div></div>
        </div>
        <div class="value">${valueHtml}</div>
      </div>`;
  }

  _renderLoad() {
    const c = this._config;
    const hass = this._hass;
    const all = c.loads.map((l) => ({ l, v: toWatts(hass.states[l.entity]) }));
    const live = all.filter((r) => r.v !== null).sort((a, b) => b.v - a.v);
    const offline = all.length - live.length;
    const top = live.slice(0, opt(c, "top_n"));
    const homeW = c.home_power ? toWatts(hass.states[c.home_power]) : null;
    const monitored = live.reduce((t, r) => t + r.v, 0);
    const max = Math.max(top.length ? top[0].v : 0, 1);

    const rows = top
      .map((r, i) => {
        const pct = Math.max((r.v / max) * 100, r.v > 0 ? 2 : 0);
        const sp = homeW && homeW > 0 ? (r.v / homeW) * 100 : null;
        const share = sp === null ? "" : sp > 0 && sp < 1 ? "&lt;1%" : Math.round(sp) + "%";
        return this._row(
          loadIcon(hass, r.l),
          loadName(hass, r.l),
          share,
          `<span class="strong">${fmtW(r.v)}</span>`,
          pct,
          i === 0 ? "#ff9800" : "var(--secondary-text-color)",
          "linear-gradient(90deg,#ffb74d,#f57c00)"
        );
      })
      .join("");

    const headerW = homeW !== null ? homeW : live.length ? monitored : null;
    const unmon = homeW === null ? null : Math.max(homeW - monitored, 0);
    const foot = [unmon === null ? "" : `Unmonitored ${fmtW(unmon)}`, offline ? `${offline} offline` : ""]
      .filter(Boolean)
      .join(" · ");

    return `
      <div class="section">
        <div class="header">
          <span class="title"><ha-icon icon="mdi:flash" style="color:#ff9800"></ha-icon> ${esc(opt(c, "load_title"))}</span>
          <span class="total">${headerW === null ? "—" : fmtW(headerW)}</span>
        </div>
        ${rows || '<div class="empty">No load data</div>'}
        ${foot ? `<div class="foot">${foot}</div>` : ""}
      </div>`;
  }

  _renderEnergy(divider) {
    const c = this._config;
    const hass = this._hass;
    const rate = c.rate && opt(c, "show_cost") ? toPricePerKwh(hass.states[c.rate]) : null;
    const money = (k) => (rate === null ? "" : this._fmtMoney(k * rate));

    const all = c.loads.map((l) => ({ l, v: this._todayKwh(this._energyId(l)) }));
    const live = all.filter((r) => r.v !== null).sort((a, b) => b.v - a.v);
    const top = live.slice(0, opt(c, "top_n"));
    const home = c.home_energy ? toKwh(hass.states[c.home_energy]) : null;
    const monitored = live.reduce((t, r) => t + r.v, 0);
    const max = Math.max(top.length ? top[0].v : 0, 0.001);

    const rows = top
      .map((r, i) => {
        const pct = Math.max((r.v / max) * 100, r.v > 0 ? 2 : 0);
        const sp = home && home > 0 ? (r.v / home) * 100 : null;
        const share = sp === null ? "" : sp > 0 && sp < 0.1 ? "&lt;0.1%" : sp.toFixed(1) + "%";
        const val = `<div class="strong">${fmtE(r.v)}</div>${
          rate === null ? "" : `<div class="sub">${money(r.v)}</div>`
        }`;
        return this._row(
          loadIcon(hass, r.l),
          loadName(hass, r.l),
          share,
          val,
          pct,
          i === 0 ? "#43a047" : "var(--secondary-text-color)",
          "linear-gradient(90deg,#81c784,#2e7d32)"
        );
      })
      .join("");

    const headerKwh = home !== null ? home : live.length ? monitored : null;
    const rateTxt =
      c.rate && opt(c, "show_cost")
        ? rate === null
          ? "rate unavailable"
          : `@ ${(rate * 100).toFixed(2)}¢/kWh`
        : "";
    const foot =
      home === null
        ? live.length && rateTxt
          ? `${rateTxt}`
          : rateTxt
        : `Monitored ${fmtE(monitored)}${rate === null ? "" : " (" + money(monitored) + ")"} of ${fmtE(home)} home usage${
            rateTxt ? " · " + rateTxt : ""
          }`;
    const loading = !rows && this._fetching;

    return `
      <div class="section ${divider ? "divider" : ""}">
        <div class="header">
          <span class="title"><ha-icon icon="mdi:lightning-bolt-circle" style="color:#43a047"></ha-icon> ${esc(opt(c, "energy_title"))}</span>
          <span>
            <span class="total">${headerKwh === null ? "—" : fmtE(headerKwh)}</span>
            ${headerKwh === null || rate === null ? "" : `<span class="total-sub">${money(headerKwh)}</span>`}
          </span>
        </div>
        ${rows || `<div class="empty">${loading ? "Loading…" : "No energy data yet"}</div>`}
        ${foot ? `<div class="foot">${foot}</div>` : ""}
      </div>`;
  }

  _render() {
    if (!this._config) return;
    if (!this._hass) {
      this.shadowRoot.innerHTML = "";
      return;
    }
    const c = this._config;
    const showLoad = opt(c, "show_load");
    const showEnergy = opt(c, "show_energy");
    let body = "";
    if (!c.loads.length) {
      body = `<div class="empty">Add loads in the card editor to get started.</div>`;
    } else {
      if (showLoad) body += this._renderLoad();
      if (showEnergy) body += this._renderEnergy(showLoad);
    }
    this.shadowRoot.innerHTML = `
      <style>
        ha-card { padding: 14px 16px 12px; }
        .section.divider { border-top: 1px solid var(--divider-color); padding-top: 12px; margin-top: 16px; }
        .header { display: flex; justify-content: space-between; align-items: baseline; }
        .title { font-size: 16px; font-weight: 600; }
        .title ha-icon { --mdc-icon-size: 18px; vertical-align: -3px; }
        .total { font-size: 20px; font-weight: 700; }
        .total-sub { font-size: 14px; color: var(--secondary-text-color); margin-left: 6px; }
        .row { display: grid; grid-template-columns: 22px 1fr auto; align-items: center; column-gap: 10px; margin-top: 9px; }
        .row ha-icon { --mdc-icon-size: 20px; }
        .mid { min-width: 0; }
        .label { display: flex; justify-content: space-between; font-size: 14px; }
        .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .share { color: var(--secondary-text-color); font-size: 12px; margin-left: 8px; }
        .track { height: 6px; border-radius: 3px; background: var(--divider-color); margin-top: 4px; overflow: hidden; }
        .bar { height: 100%; border-radius: 3px; }
        .value { min-width: 62px; text-align: right; line-height: 1.15; }
        .strong { font-size: 14px; font-weight: 600; }
        .sub { font-size: 12px; color: var(--secondary-text-color); }
        .foot { margin-top: 8px; font-size: 12px; color: var(--secondary-text-color); text-align: right; }
        .empty { margin-top: 9px; color: var(--secondary-text-color); }
      </style>
      <ha-card>${body}</ha-card>`;
  }
}

/* ------------------------------------------------------------------ */
/* Editor                                                              */
/* ------------------------------------------------------------------ */

const LABELS = {
  home_power: "Whole-home power",
  home_energy: "Whole-home energy today",
  rate: "Electricity rate (price per kWh)",
  top_n: "Loads to show",
  show_cost: "Show cost",
  load_title: "Live section title",
  energy_title: "Energy section title",
  show_load: "Show live power section",
  show_energy: "Show energy today section",
  name: "Name",
  icon: "Icon",
  energy: "Energy sensor",
};

const HELPERS = {
  home_power: "Optional. Used for % of home and the unmonitored remainder.",
  home_energy: "Optional. A sensor that resets daily (shown as-is).",
  rate: "Optional. Cost = kWh × this rate.",
};

const TOP_SCHEMA = [
  { name: "home_power", selector: { entity: { filter: { domain: "sensor", device_class: "power" } } } },
  { name: "home_energy", selector: { entity: { filter: { domain: "sensor", device_class: "energy" } } } },
  { name: "rate", selector: { entity: { filter: { domain: ["sensor", "input_number", "number"] } } } },
  {
    type: "grid",
    name: "",
    flatten: true,
    schema: [
      { name: "top_n", selector: { number: { min: 1, max: 20, mode: "box" } } },
      { name: "show_cost", selector: { boolean: {} } },
    ],
  },
  {
    type: "expandable",
    name: "",
    title: "Appearance",
    flatten: true,
    schema: [
      {
        type: "grid",
        name: "",
        flatten: true,
        schema: [
          { name: "load_title", selector: { text: {} } },
          { name: "energy_title", selector: { text: {} } },
          { name: "show_load", selector: { boolean: {} } },
          { name: "show_energy", selector: { boolean: {} } },
        ],
      },
    ],
  },
];

const ROW_SCHEMA = [
  { name: "name", selector: { text: {} } },
  { name: "icon", selector: { icon: {} }, context: { icon_entity: "entity" } },
  { name: "energy", selector: { entity: { filter: { domain: "sensor", device_class: "energy" } } } },
];

/**
 * HA lazy-loads its form/picker elements. Creating the built-in Entities
 * card's editor pulls in ha-form and the entity pickers, the same trick most
 * custom cards use.
 */
let haComponentsPromise;
const loadHaComponents = () => {
  if (
    customElements.get("ha-form") &&
    customElements.get("ha-entity-picker") &&
    customElements.get("ha-icon-button")
  ) {
    return Promise.resolve();
  }
  if (!haComponentsPromise) {
    haComponentsPromise = (async () => {
      try {
        const helpers = await window.loadCardHelpers?.();
        if (helpers) {
          const card = await helpers.createCardElement({ type: "entities", entities: [] });
          await card.constructor.getConfigElement?.();
        }
      } catch (e) {
        /* fall through and wait */
      }
      await Promise.race([
        Promise.all(["ha-form", "ha-entity-picker"].map((t) => customElements.whenDefined(t))),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    })();
  }
  return haComponentsPromise;
};

class PowerEnergyCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = { loads: [] };
    this._hass = undefined;
    this._built = false;
    this._expanded = new Set();
    this._rowEls = [];
  }

  setConfig(config) {
    this._config = normalizeConfig(config);
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._update();
  }

  connectedCallback() {
    loadHaComponents().then(() => {
      this._ready = true;
      this._update();
    });
  }

  _fire(config) {
    this._config = config;
    const ev = new Event("config-changed", { bubbles: true, composed: true });
    ev.detail = { config };
    this.dispatchEvent(ev);
  }

  /** Drop options that equal their default so the YAML stays short. */
  _clean(config) {
    const out = {};
    for (const [k, v] of Object.entries(config)) {
      if (v === undefined || v === "" || v === null) continue;
      if (k in DEFAULTS && DEFAULTS[k] === v) continue;
      out[k] = v;
    }
    out.loads = (config.loads || []).map((l) => {
      const o = { entity: l.entity };
      if (l.name) o.name = l.name;
      if (l.icon) o.icon = l.icon;
      if (l.energy) o.energy = l.energy;
      return o;
    });
    return out;
  }

  _build() {
    this.shadowRoot.innerHTML = `
      <style>
        .loads-header { display: flex; align-items: baseline; justify-content: space-between; margin: 20px 0 4px; }
        .loads-header h3 { margin: 0; font-size: 16px; font-weight: 500; }
        .loads-header span { color: var(--secondary-text-color); font-size: 12px; }
        .load { border-bottom: 1px solid var(--divider-color); padding: 6px 0; }
        .load-main { display: flex; align-items: center; gap: 8px; }
        .load-main > ha-icon { color: var(--secondary-text-color); flex: none; }
        .load-main .picker { flex: 1; min-width: 0; }
        .load-main ha-icon-button { color: var(--secondary-text-color); flex: none; }
        .details { padding: 8px 0 4px 32px; }
        .details[hidden] { display: none; }
        .auto { color: var(--secondary-text-color); font-size: 12px; margin-top: 4px; }
        .auto.warn { color: var(--warning-color, #ff9800); }
        .add { margin-top: 12px; }
      </style>
      <ha-form class="top"></ha-form>
      <div class="loads-header"><h3>Loads</h3><span></span></div>
      <div class="loads"></div>
      <div class="add"></div>`;

    const form = this.shadowRoot.querySelector("ha-form.top");
    form.schema = TOP_SCHEMA;
    form.computeLabel = (s) => LABELS[s.name] ?? s.name;
    form.computeHelper = (s) => HELPERS[s.name];
    form.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      const v = ev.detail.value;
      this._fire(this._clean({ ...v, loads: this._config.loads }));
    });

    const add = document.createElement("ha-entity-picker");
    add.addButton = true;
    add.setAttribute("add-button", "");
    add.addButtonLabel = "Add load";
    add.includeDomains = ["sensor"];
    add.entityFilter = (s) => isPowerSensor(s);
    add.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      const id = ev.detail.value;
      if (!id) return;
      if (this._config.loads.some((l) => l.entity === id)) return;
      this._fire(this._clean({ ...this._config, loads: [...this._config.loads, { entity: id }] }));
      add.value = undefined;
    });
    this.shadowRoot.querySelector(".add").appendChild(add);
    this._built = true;
  }

  _makeRow(index) {
    const wrap = document.createElement("div");
    wrap.className = "load";
    wrap.innerHTML = `
      <div class="load-main">
        <ha-icon></ha-icon>
        <ha-selector class="picker"></ha-selector>
        <ha-icon-button class="edit" label="Edit"></ha-icon-button>
        <ha-icon-button class="remove" label="Remove"></ha-icon-button>
      </div>
      <div class="details" hidden>
        <ha-form></ha-form>
        <div class="auto"></div>
      </div>`;

    const picker = wrap.querySelector("ha-selector");
    picker.selector = { entity: { filter: { domain: "sensor" } } };
    picker.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      const id = ev.detail.value;
      const loads = [...this._config.loads];
      if (!id) {
        loads.splice(index, 1);
        this._expanded.delete(index);
      } else {
        // New sensor: drop the old energy override, it belonged to the old device.
        loads[index] = { ...loads[index], entity: id, energy: undefined };
      }
      this._fire(this._clean({ ...this._config, loads }));
      this._update();
    });

    const edit = wrap.querySelector(".edit");
    edit.path = MDI.pencil;
    edit.addEventListener("click", () => {
      if (this._expanded.has(index)) this._expanded.delete(index);
      else this._expanded.add(index);
      this._update();
    });

    const remove = wrap.querySelector(".remove");
    remove.path = MDI.delete;
    remove.addEventListener("click", () => {
      const loads = this._config.loads.filter((_, i) => i !== index);
      // Shift expanded indexes after the removed row.
      this._expanded = new Set(
        [...this._expanded].filter((i) => i !== index).map((i) => (i > index ? i - 1 : i))
      );
      this._fire(this._clean({ ...this._config, loads }));
      this._update();
    });

    const form = wrap.querySelector(".details ha-form");
    form.schema = ROW_SCHEMA;
    form.computeLabel = (s) => LABELS[s.name] ?? s.name;
    form.addEventListener("value-changed", (ev) => {
      ev.stopPropagation();
      const v = ev.detail.value;
      const loads = [...this._config.loads];
      loads[index] = { entity: loads[index].entity, name: v.name, icon: v.icon, energy: v.energy };
      this._fire(this._clean({ ...this._config, loads }));
      this._updateRow(index);
    });

    return wrap;
  }

  _updateRow(index) {
    const el = this._rowEls[index];
    const load = this._config.loads[index];
    if (!el || !load) return;
    const hass = this._hass;
    el.querySelector(".load-main > ha-icon").icon = loadIcon(hass, load);
    const picker = el.querySelector("ha-selector");
    picker.hass = hass;
    picker.value = load.entity;
    const details = el.querySelector(".details");
    const open = this._expanded.has(index);
    details.hidden = !open;
    if (open) {
      const form = el.querySelector(".details ha-form");
      form.hass = hass;
      form.data = { entity: load.entity, name: load.name, icon: load.icon, energy: load.energy };
      form.computeHelper = (s) =>
        s.name === "name" ? `Default: ${loadName(hass, { entity: load.entity })}` : undefined;
      const auto = el.querySelector(".auto");
      const found = findEnergyFor(hass, load.entity);
      if (load.energy) {
        auto.textContent = "Using the energy sensor chosen above.";
        auto.classList.remove("warn");
      } else if (found) {
        auto.textContent = `Energy sensor: ${found} (found automatically).`;
        auto.classList.remove("warn");
      } else {
        auto.textContent =
          "No energy sensor found on this device. Pick one above, or this load will only appear in the live section.";
        auto.classList.add("warn");
      }
    }
  }

  _update() {
    if (!this._hass || !this._ready) return;
    if (!this._built) this._build();
    const hass = this._hass;
    const c = this._config;

    const form = this.shadowRoot.querySelector("ha-form.top");
    form.hass = hass;
    const data = { ...c };
    delete data.loads;
    for (const [k, v] of Object.entries(DEFAULTS)) if (data[k] === undefined) data[k] = v;
    form.data = data;

    const list = this.shadowRoot.querySelector(".loads");
    if (this._rowEls.length !== c.loads.length) {
      list.innerHTML = "";
      this._rowEls = c.loads.map((_, i) => {
        const el = this._makeRow(i);
        list.appendChild(el);
        return el;
      });
    }
    c.loads.forEach((_, i) => this._updateRow(i));

    this.shadowRoot.querySelector(".loads-header span").textContent = c.loads.length
      ? `${c.loads.length} load${c.loads.length === 1 ? "" : "s"}`
      : "None yet: add one below";

    const add = this.shadowRoot.querySelector(".add ha-entity-picker");
    add.hass = hass;
    add.excludeEntities = c.loads.map((l) => l.entity);
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

if (!customElements.get(CARD_TYPE)) customElements.define(CARD_TYPE, PowerEnergyCard);
if (!customElements.get(EDITOR_TYPE)) customElements.define(EDITOR_TYPE, PowerEnergyCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === CARD_TYPE)) {
  window.customCards.push({
    type: CARD_TYPE,
    name: "Power & Energy Card",
    description: "Top loads by live power and energy today, with optional cost.",
    preview: true,
    documentationURL: "https://github.com/duck-duck-dude/HA-power-energy-card",
  });
}

console.info(
  `%c POWER-ENERGY-CARD %c v${CARD_VERSION} `,
  "color:#fff;background:#f57c00;font-weight:700;",
  "color:#f57c00;background:transparent;"
);
