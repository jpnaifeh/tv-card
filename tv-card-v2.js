const LitElement = Object.getPrototypeOf(
    customElements.get("ha-panel-lovelace")
);
const html = LitElement.prototype.html;

// Commands understood by the Apple TV integration's remote.send_command.
const KEYS = {
    "up": {"icon": "mdi:chevron-up"},
    "down": {"icon": "mdi:chevron-down"},
    "left": {"icon": "mdi:chevron-left"},
    "right": {"icon": "mdi:chevron-right"},
    "select": {"icon": "mdi:circle-outline"},
    "menu": {"icon": "mdi:chevron-left", "hold": "top_menu"},  // holding Back goes to the main menu, as on the Siri Remote
    "home": {"icon": "mdi:television"},
    "play_pause": {"icon": "mdi:play-pause"},
    "skip_backward": {"icon": "mdi:rewind-10"},
    "skip_forward": {"icon": "mdi:fast-forward-10"},
};

// States in which the skip buttons appear on the touchpad.
const PLAYING_STATES = ["playing", "paused"];
const OFF_STATES = ["off", "standby"];

const SOURCES = {
    "netflix": {"source": "Netflix", "icon": "mdi:netflix"},
    "spotify": {"source": "Spotify", "icon": "mdi:spotify"},
    "youtube": {"source": "YouTube", "icon": "mdi:youtube"},
};

const DEFAULT_BUTTONS = ["play_pause", "menu", "home"];
const DEFAULT_HEADER_RIGHT = "power";

const DEFAULT_HEIGHT = 360;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 720;

const SWIPE_THRESHOLD = 80;   // px of finger travel per arrow key
const WHEEL_THRESHOLD = 75;   // accumulated wheel delta that sends the arrow key
const WHEEL_GESTURE_GAP = 150; // ms without wheel events that ends a scroll gesture
const HOLD_DELAY = 700;       // ms held still before the current key starts repeating
const REPEAT_INTERVAL = 400;  // ms between repeats, overridable with repeat_interval
const TAP_MAX_DURATION = 500;
const DOUBLE_TAP_DELAY = 200;    // how long a single tap waits when enable_double_click is true
const DOUBLE_TAP_WINDOW = 400;   // max gap between the taps of a double tap
const BUTTON_HOLD_DELAY = 600;   // ms a button is held before its `hold` command is sent

const fireEvent = (node, type, detail) => {
    const event = new Event(type, { bubbles: false });
    event.detail = detail === null || detail === undefined ? {} : detail;
    node.dispatchEvent(event);
    return event;
};

class TVCard extends LitElement {
    constructor() {
        super();
        this._drag = null;
        this._resize = null;
        this._wheel = { x: 0, y: 0 };
    }

    static get properties() {
        return {
            _hass: {},
            _config: {},
            _height: {},
        };
    }

    static getConfigElement() {
        return document.createElement("tv-card-v2-editor");
    }

    static getStubConfig(hass) {
        const remote = Object.keys(hass.states).find((eid) => eid.startsWith("remote.")) || "remote.apple_tv";
        const player = remote.replace("remote.", "media_player.");
        return hass.states[player]
            ? { remote_entity: remote, media_player_entity: player }
            : { remote_entity: remote };
    }

    getCardSize() {
        return Math.ceil((this._height + 300) / 50);
    }

    setConfig(config) {
        if (!config.remote_entity) {
            throw new Error("remote_entity is required");
        }
        this._config = config;
        this._height = this._loadHeight();
    }

    set hass(hass) {
        this._hass = hass;
    }

    get hass() {
        return this._hass;
    }

    // ---- actions ----

    _feedback(type = "light") {
        if (this._config.enable_button_feedback !== false) fireEvent(window, "haptic", type);
    }

    _sendKey(command, entity = this._config.remote_entity) {
        this._hass.callService("remote", "send_command", { command }, { entity_id: entity });
    }

    _selectSource(source, entity = this._config.media_player_entity) {
        this._hass.callService("media_player", "select_source", { source }, { entity_id: entity });
    }

    _player() {
        return this._config.media_player_entity && this._hass.states[this._config.media_player_entity];
    }

    _builtin(name) {
        if (KEYS[name]) return { key: name, ...KEYS[name] };
        if (name === "power") return { power: true, icon: "mdi:power" };
        return SOURCES[name];
    }

    // A custom_keys/custom_sources entry with its own action replaces the built-in button;
    // one without (e.g. only `entity` or `icon`) just overrides those fields of the built-in.
    _resolve(name) {
        const custom = (this._config.custom_keys || {})[name] || (this._config.custom_sources || {})[name];
        const builtin = this._builtin(name);
        if (!custom) return builtin;
        if (["key", "source", "service"].some((action) => action in custom)) {
            return { icon: builtin && builtin.icon, ...custom };
        }
        return builtin && { ...builtin, ...custom };
    }

    // The remote entity's turn_off only disconnects HA, so power defaults to the media player.
    _powerEntity(info) {
        return info.entity || this._config.media_player_entity;
    }

    _showMoreInfo() {
        const entityId = this._config.media_player_entity || this._config.remote_entity;
        this.dispatchEvent(new CustomEvent("hass-more-info", {
            detail: { entityId },
            bubbles: true,
            composed: true,
        }));
    }

    _runAction(name) {
        const info = this._resolve(name);
        if (!info) return;

        // A button's own `entity` takes the place of the card's remote/media player.
        if (info.key) {
            this._sendKey(info.key, info.entity);
        } else if (info.source) {
            this._selectSource(info.source, info.entity);
        } else if (info.power) {
            this._hass.callService("homeassistant", "toggle", {}, { entity_id: this._powerEntity(info) });
        } else if (info.service) {
            const [domain, service] = info.service.split(".", 2);
            this._hass.callService(domain, service, info.service_data, info.entity ? { entity_id: info.entity } : undefined);
        }
        this._feedback();
    }

    // ---- touchpad: swipes become arrow keys, taps become select ----

    _onPadDown(e) {
        if (e.button !== 0) return;
        const pad = e.currentTarget;
        pad.setPointerCapture(e.pointerId);
        this._drag = { pad, x: e.clientX, y: e.clientY, start: e.timeStamp, moved: false, key: "select" };
        this._placeDot(e, true);
        this._startRepeat();
    }

    _onPadMove(e) {
        const drag = this._drag;
        if (!drag) return;
        this._placeDot(e, true);

        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < (this._config.swipe_threshold || SWIPE_THRESHOLD)) return;

        const dir = Math.abs(dx) > Math.abs(dy)
            ? (dx > 0 ? "right" : "left")
            : (dy > 0 ? "down" : "up");
        drag.x = e.clientX;
        drag.y = e.clientY;
        drag.moved = true;
        drag.key = dir;

        this._sendKey(dir);
        this._feedback("selection");
        this._startRepeat();
    }

    // Holding still repeats select; resting after a swipe repeats that direction.
    _startRepeat() {
        this._stopRepeat();
        this._holdTimer = setTimeout(() => {
            this._repeatTimer = setInterval(() => {
                if (!this._drag) return;
                this._sendKey(this._drag.key);
                this._feedback(this._drag.key === "select" ? "light" : "selection");
            }, this._config.repeat_interval || REPEAT_INTERVAL);
        }, HOLD_DELAY);
    }

    _onPadUp(e) {
        const drag = this._drag;
        this._endDrag(e);
        if (drag && !drag.moved && e.timeStamp - drag.start < TAP_MAX_DURATION) this._onTap();
    }

    _endDrag(e) {
        this._stopRepeat();
        if (this._drag) this._placeDot(e, false);
        this._drag = null;
    }

    _stopRepeat() {
        clearTimeout(this._holdTimer);
        clearInterval(this._repeatTimer);
    }

    // enable_double_click unset: every tap selects immediately, and a double tap also sends back.
    // true: a single tap waits briefly so a double tap sends only back.
    // false: no double tap.
    _onTap() {
        const mode = this._config.enable_double_click;
        const is_double = this._lastTap !== undefined && performance.now() - this._lastTap < DOUBLE_TAP_WINDOW;
        this._lastTap = is_double ? undefined : performance.now();

        if (mode !== false && is_double) {
            clearTimeout(this._tapTimer);
            this._tapTimer = null;
            this._sendKey(this._config.double_click_key || "menu");
            this._feedback("success");
            return;
        }

        const select = () => {
            this._tapTimer = null;
            this._sendKey("select");
            this._feedback();
        };
        if (mode === true) {
            this._tapTimer = setTimeout(select, DOUBLE_TAP_DELAY);
        } else {
            select();
        }
    }

    // ---- buttons: a long press sends the button's `hold` command instead of its normal action ----

    _onButtonDown(e, info) {
        // Keep presses on buttons inside the touchpad from also counting as touchpad gestures.
        e.stopPropagation();
        this._buttonHeld = false;
        clearTimeout(this._buttonHoldTimer);
        if (!info.hold) return;
        this._buttonHoldTimer = setTimeout(() => {
            this._buttonHeld = true;
            this._sendKey(info.hold, info.entity);
            this._feedback("success");
        }, BUTTON_HOLD_DELAY);
    }

    _onButtonUp() {
        clearTimeout(this._buttonHoldTimer);
    }

    _onButtonClick(name) {
        if (this._buttonHeld) {
            this._buttonHeld = false;
            return;
        }
        this._runAction(name);
    }

    _onContextMenu(e) {
        e.preventDefault();
        // Long-presses on touch screens also raise contextmenu; only a real right click means back.
        if (e.pointerType === "touch") return;
        this._sendKey("menu");
        this._feedback();
    }

    // One arrow per scroll gesture: once it is sent, the rest of the gesture
    // (including trackpad momentum after the fingers lift) is ignored until the events pause.
    _onWheel(e) {
        e.preventDefault();
        clearTimeout(this._wheelReset);
        this._wheelReset = setTimeout(() => {
            this._wheel = { x: 0, y: 0 };
            this._wheelLocked = false;
        }, WHEEL_GESTURE_GAP);
        if (this._wheelLocked) return;

        const wheel = this._wheel;
        wheel.x += e.deltaX;
        wheel.y += e.deltaY;

        let dir = null;
        if (Math.abs(wheel.x) > Math.abs(wheel.y)) {
            if (wheel.x >= WHEEL_THRESHOLD) dir = "left";
            else if (wheel.x <= -WHEEL_THRESHOLD) dir = "right";
        } else {
            if (wheel.y >= WHEEL_THRESHOLD) dir = "up";
            else if (wheel.y <= -WHEEL_THRESHOLD) dir = "down";
        }
        if (!dir) return;

        this._wheelLocked = true;
        this._sendKey(dir);
        this._feedback("selection");
    }

    _placeDot(e, active) {
        const dot = this.renderRoot.querySelector(".dot");
        if (!dot || !this._drag) return;
        const rect = this._drag.pad.getBoundingClientRect();
        dot.style.transform = `translate(${e.clientX - rect.left}px, ${e.clientY - rect.top}px)`;
        dot.classList.toggle("active", active);
    }

    // ---- resizing: drag the grip under the touchpad, double-click it to reset ----

    _storageKey() {
        return `tv-card-v2:${this._config.remote_entity}:height`;
    }

    _defaultHeight() {
        return this._config.touchpad_height || DEFAULT_HEIGHT;
    }

    _loadHeight() {
        try {
            const saved = JSON.parse(localStorage.getItem(this._storageKey()));
            // A saved size only applies while touchpad_height is unchanged in the config.
            if (saved && saved.base === this._defaultHeight()) return saved.height;
        } catch (err) {}
        return this._defaultHeight();
    }

    _saveHeight() {
        try {
            localStorage.setItem(this._storageKey(), JSON.stringify({ base: this._defaultHeight(), height: this._height }));
        } catch (err) {}
    }

    _onGripDown(e) {
        e.currentTarget.setPointerCapture(e.pointerId);
        this._resize = { y: e.clientY, height: this._height };
    }

    _onGripMove(e) {
        if (!this._resize) return;
        const height = this._resize.height + e.clientY - this._resize.y;
        this._height = Math.round(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height)));
    }

    _onGripUp() {
        if (!this._resize) return;
        this._resize = null;
        this._saveHeight();
    }

    _onGripReset() {
        this._height = this._defaultHeight();
        try { localStorage.removeItem(this._storageKey()); } catch (err) {}
    }

    // ---- rendering ----

    _renderIcon(info) {
        const svg_path = (this._config.custom_icons || {})[info.icon];
        return svg_path
            ? html`<ha-svg-icon .path="${svg_path}"></ha-svg-icon>`
            : html`<ha-icon .icon="${info.icon}"></ha-icon>`;
    }

    _renderButton(name, class_name = "button") {
        const info = this._resolve(name);
        if (!info || (info.power && !this._powerEntity(info))) return html`<div></div>`;
        const power_state = info.power && this._hass.states[this._powerEntity(info)];
        const off = power_state && OFF_STATES.includes(power_state.state);

        return html`
            <button
                class="${class_name}${off ? " off" : ""}"
                title="${name}"
                aria-label="${name}"
                @pointerdown="${(e) => this._onButtonDown(e, info)}"
                @pointerup="${this._onButtonUp}"
                @pointerleave="${this._onButtonUp}"
                @pointercancel="${this._onButtonUp}"
                @contextmenu="${(e) => e.preventDefault()}"
                @click="${() => this._onButtonClick(name)}">
                ${this._renderIcon(info)}
            </button>
        `;
    }

    _renderHeader() {
        const player = this._player();
        const title = this._config.title !== undefined
            ? this._config.title
            : (player ? player.attributes.friendly_name : "Apple TV");
        const left = this._config.header_left;
        const right = this._config.header_right || DEFAULT_HEADER_RIGHT;

        let now_playing = "";
        if (player && ["playing", "paused"].includes(player.state)) {
            const attrs = player.attributes;
            now_playing = [attrs.media_title, attrs.media_artist || attrs.app_name].filter(Boolean).join(" · ");
        }

        return html`
            <div class="header">
                ${left && left !== "none" ? this._renderButton(left, "button small") : html`<div></div>`}
                <button class="pill" @click="${this._showMoreInfo}">
                    <span class="badge"><ha-icon .icon="${"mdi:television-play"}"></ha-icon></span>
                    <span class="title">${title}</span>
                    <ha-icon class="chevron" .icon="${"mdi:chevron-right"}"></ha-icon>
                </button>
                ${right !== "none" ? this._renderButton(right, "button small") : html`<div></div>`}
            </div>
            ${now_playing ? html`<div class="subtitle">${now_playing}</div>` : ""}
        `;
    }

    // Skip back/forward sit inside the touchpad and only appear while something is playing.
    _renderPadControls() {
        const player = this._player();
        const visible = !this._config.media_player_entity || (player && PLAYING_STATES.includes(player.state));

        return html`
            <div class="pad-controls ${visible ? "" : "hidden"}">
                ${this._renderButton("skip_backward", "pad-button")}
                ${this._renderButton("skip_forward", "pad-button")}
            </div>
        `;
    }

    render() {
        if (!this._config || !this._hass) {
            return html``;
        }
        const buttons = this._config.buttons || DEFAULT_BUTTONS;

        return html`
            ${this._renderStyle()}
            <ha-card>
                ${this._renderHeader()}
                <div
                    class="touchpad"
                    style="height: ${this._height}px"
                    @pointerdown="${this._onPadDown}"
                    @pointermove="${this._onPadMove}"
                    @pointerup="${this._onPadUp}"
                    @pointercancel="${this._endDrag}"
                    @contextmenu="${this._onContextMenu}"
                    @wheel="${this._onWheel}">
                    <div class="dot"></div>
                    ${this._renderPadControls()}
                </div>
                <div
                    class="grip"
                    title="Drag to resize, double-click to reset"
                    @pointerdown="${this._onGripDown}"
                    @pointermove="${this._onGripMove}"
                    @pointerup="${this._onGripUp}"
                    @pointercancel="${this._onGripUp}"
                    @dblclick="${this._onGripReset}">
                    <span></span>
                </div>
                ${buttons.length ? html`
                    <div class="buttons">
                        ${buttons.map((name, i) => this._renderButton(
                            name,
                            // With three buttons the middle one is the large one, as in the iPhone remote.
                            buttons.length === 3 && i === 1 ? "button large" : "button"
                        ))}
                    </div>
                ` : ""}
            </ha-card>
        `;
    }

    _renderStyle() {
        return html`
            <style>
                :host {
                    --tv-background: var(--tv-card-background, #000000);
                    --tv-surface: var(--tv-card-surface, #1c1c1e);
                    --tv-surface-active: var(--tv-card-surface-active, #3a3a3c);
                    --tv-edge: var(--tv-card-edge-color, rgba(255, 255, 255, 0.12));
                    --tv-icon: var(--tv-card-icon-color, #f2f2f7);
                    --tv-secondary-text: var(--tv-card-secondary-text-color, #8e8e93);
                }
                ha-card {
                    display: flex;
                    flex-direction: column;
                    padding: 20px 20px 28px;
                    background: var(--tv-background);
                    color: var(--tv-icon);
                    border: none;
                    border-radius: var(--tv-card-border-radius, 32px);
                    overflow: hidden;
                    font-family: -apple-system, BlinkMacSystemFont, var(--paper-font-body1_-_font-family, sans-serif);
                }
                /* Raised "glass" edge shared by the header, buttons and touchpad. */
                .pill,
                .button,
                .touchpad {
                    background: var(--tv-surface);
                    border: 1px solid var(--tv-edge);
                    box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.06), 0 2px 8px rgba(0, 0, 0, 0.6);
                }
                .header {
                    display: grid;
                    grid-template-columns: 56px 1fr 56px;
                    align-items: center;
                    gap: 14px;
                }
                .pill {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    gap: 10px;
                    min-width: 0;
                    height: 56px;
                    padding: 0 18px;
                    border-radius: 28px;
                    color: var(--tv-icon);
                    font: inherit;
                    cursor: pointer;
                    -webkit-tap-highlight-color: transparent;
                }
                .badge {
                    display: flex;
                    flex: none;
                    align-items: center;
                    justify-content: center;
                    width: 26px;
                    height: 26px;
                    border-radius: 6px;
                    background: #ffffff;
                    color: #000000;
                    --mdc-icon-size: 18px;
                }
                .title {
                    overflow: hidden;
                    font-size: 20px;
                    font-weight: 600;
                    letter-spacing: -0.01em;
                    white-space: nowrap;
                    text-overflow: ellipsis;
                }
                .chevron {
                    flex: none;
                    color: var(--tv-secondary-text);
                    --mdc-icon-size: 22px;
                }
                .subtitle {
                    margin-top: 10px;
                    font-size: 13px;
                    text-align: center;
                    color: var(--tv-secondary-text);
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .touchpad {
                    position: relative;
                    margin-top: 24px;
                    border-radius: 36px;
                    overflow: hidden;
                    cursor: pointer;
                    touch-action: none;
                    user-select: none;
                    -webkit-user-select: none;
                    -webkit-touch-callout: none;
                    -webkit-tap-highlight-color: transparent;
                }
                .dot {
                    position: absolute;
                    left: 0;
                    top: 0;
                    width: 80px;
                    height: 80px;
                    margin: -40px 0 0 -40px;
                    border-radius: 50%;
                    background: radial-gradient(circle, rgba(255, 255, 255, 0.22), rgba(255, 255, 255, 0) 70%);
                    opacity: 0;
                    transition: opacity 0.25s;
                    pointer-events: none;
                }
                .dot.active {
                    opacity: 1;
                    transition: opacity 0.05s;
                }
                .pad-controls {
                    position: absolute;
                    left: 6%;
                    right: 6%;
                    bottom: 16px;
                    display: flex;
                    justify-content: space-between;
                    transition: opacity 0.25s;
                }
                .pad-controls.hidden {
                    opacity: 0;
                    visibility: hidden;
                    transition: opacity 0.25s, visibility 0s 0.25s;
                }
                .pad-button {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: 64px;
                    height: 64px;
                    padding: 0;
                    border: none;
                    border-radius: 50%;
                    background: none;
                    color: var(--tv-icon);
                    cursor: pointer;
                    --mdc-icon-size: 40px;
                    -webkit-tap-highlight-color: transparent;
                    transition: background 0.15s, transform 0.1s;
                }
                .pad-button:active {
                    background: var(--tv-surface-active);
                    transform: scale(0.94);
                }
                .grip {
                    display: flex;
                    justify-content: center;
                    padding: 10px 0 14px;
                    cursor: ns-resize;
                    touch-action: none;
                }
                .grip span {
                    width: 36px;
                    height: 5px;
                    border-radius: 3px;
                    background: var(--tv-surface-active);
                    opacity: 0.6;
                    transition: opacity 0.15s;
                }
                .grip:hover span,
                .grip:active span {
                    opacity: 1;
                }
                .buttons {
                    display: flex;
                    flex-wrap: wrap;
                    align-items: center;
                    justify-content: space-between;
                    row-gap: 16px;
                }
                .buttons:has(> :nth-child(4)) {
                    justify-content: space-evenly;
                }
                .button {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    width: min(112px, 25%);
                    aspect-ratio: 1;
                    padding: 0;
                    border-radius: 50%;
                    color: var(--tv-icon);
                    cursor: pointer;
                    container-type: inline-size;
                    --mdc-icon-size: 36px;
                    user-select: none;
                    -webkit-user-select: none;
                    -webkit-touch-callout: none;
                    -webkit-tap-highlight-color: transparent;
                    transition: background 0.15s, transform 0.1s;
                }
                .button.large {
                    width: min(140px, 32%);
                    --mdc-icon-size: 46px;
                }
                .button.small {
                    width: 56px;
                    --mdc-icon-size: 28px;
                }
                /* Icons are a fixed share of their button's width, so they shrink and grow with it. */
                @supports (width: 1cqi) {
                    .button,
                    .button.large {
                        --mdc-icon-size: 33cqi;
                    }
                    .button.small {
                        --mdc-icon-size: 50cqi;
                    }
                }
                .button.off {
                    color: var(--tv-secondary-text);
                }
                .button:active {
                    background: var(--tv-surface-active);
                    transform: scale(0.95);
                }
                .button:focus-visible,
                .pill:focus-visible,
                .pad-button:focus-visible {
                    outline: 2px solid var(--tv-icon);
                    outline-offset: 2px;
                }
            </style>
        `;
    }
}

if (!customElements.get("tv-card-v2")) {
    customElements.define("tv-card-v2", TVCard);
    window.customCards = window.customCards || [];
    window.customCards.push({
        type: "tv-card-v2",
        name: "Apple TV Remote (v2)",
        description: "Touchpad remote for an Apple TV, styled like the iPhone Remote app.",
    });
}

// ---- visual editor ----

const BUTTON_OPTIONS = [
    { value: "play_pause", label: "Play / pause" },
    { value: "menu", label: "Back" },
    { value: "home", label: "Home (TV)" },
    { value: "power", label: "Power" },
    { value: "skip_backward", label: "Skip back 10s" },
    { value: "skip_forward", label: "Skip forward 10s" },
    { value: "select", label: "Select" },
    { value: "up", label: "Up" },
    { value: "down", label: "Down" },
    { value: "left", label: "Left" },
    { value: "right", label: "Right" },
    { value: "netflix", label: "Netflix" },
    { value: "spotify", label: "Spotify" },
    { value: "youtube", label: "YouTube" },
];

const HEADER_OPTIONS = [{ value: "none", label: "None" }, ...BUTTON_OPTIONS];

const SCHEMA = [
    { name: "remote_entity", required: true, selector: { entity: { domain: "remote" } } },
    { name: "media_player_entity", selector: { entity: { domain: "media_player" } } },
    { name: "title", selector: { text: {} } },
    {
        name: "touchpad_height",
        selector: { number: { min: 160, max: 720, step: 10, mode: "slider", unit_of_measurement: "px" } },
    },
    {
        name: "repeat_interval",
        selector: { number: { min: 100, max: 1500, step: 50, mode: "slider", unit_of_measurement: "ms" } },
    },
    {
        name: "buttons",
        selector: { select: { multiple: true, custom_value: true, reorder: true, options: BUTTON_OPTIONS } },
    },
    {
        type: "grid",
        name: "",
        schema: [
            { name: "header_left", selector: { select: { mode: "dropdown", custom_value: true, options: HEADER_OPTIONS } } },
            { name: "header_right", selector: { select: { mode: "dropdown", custom_value: true, options: HEADER_OPTIONS } } },
        ],
    },
    {
        name: "enable_double_click",
        selector: {
            select: {
                mode: "dropdown",
                options: [
                    { value: "default", label: "Every tap selects, double tap also goes back" },
                    { value: "true", label: "Double tap only goes back (single taps wait briefly)" },
                    { value: "false", label: "Off" },
                ],
            },
        },
    },
    { name: "enable_button_feedback", selector: { boolean: {} } },
];

// enable_double_click has three states (unset/true/false), so the dropdown uses strings.
const DOUBLE_CLICK_TO_FORM = { undefined: "default", true: "true", false: "false" };
const DOUBLE_CLICK_FROM_FORM = { default: undefined, true: true, false: false };

const LABELS = {
    remote_entity: "Apple TV remote",
    media_player_entity: "Apple TV media player (for power, apps, skip buttons and now playing)",
    title: "Title (defaults to the media player name)",
    touchpad_height: "Touchpad height",
    repeat_interval: "Hold-to-repeat speed (time between repeats, default 400ms)",
    buttons: "Buttons below the touchpad",
    header_left: "Button left of the name",
    header_right: "Button right of the name (default: power)",
    enable_double_click: "Double tap",
    enable_button_feedback: "Haptic feedback",
};

class TVCardEditor extends LitElement {
    static get properties() {
        return { hass: {}, _config: {} };
    }

    setConfig(config) {
        this._config = config;
    }

    render() {
        if (!this.hass || !this._config) {
            return html``;
        }
        const data = {
            enable_button_feedback: true,
            ...this._config,
            enable_double_click: DOUBLE_CLICK_TO_FORM[this._config.enable_double_click],
        };

        return html`
            <ha-form
                .hass="${this.hass}"
                .data="${data}"
                .schema="${SCHEMA}"
                .computeLabel="${(schema) => LABELS[schema.name] || schema.name}"
                @value-changed="${this._valueChanged}"
            ></ha-form>
            <p style="color: var(--secondary-text-color)">
                Custom keys, apps, icons and per-button entities can be set in the YAML editor.
            </p>
        `;
    }

    _valueChanged(ev) {
        const config = { ...ev.detail.value };
        config.enable_double_click = DOUBLE_CLICK_FROM_FORM[config.enable_double_click];
        Object.keys(config).forEach((key) => {
            if (config[key] === "" || config[key] === undefined) delete config[key];
        });
        if (config.enable_button_feedback === true) delete config.enable_button_feedback;

        this.dispatchEvent(new CustomEvent("config-changed", {
            detail: { config },
            bubbles: true,
            composed: true,
        }));
    }
}

if (!customElements.get("tv-card-v2-editor")) {
    customElements.define("tv-card-v2-editor", TVCardEditor);
}
