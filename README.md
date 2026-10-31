# Apple TV Remote Card (v2)

[![GitHub Release][releases-shield]][releases]
[![License][license-shield]](LICENSE)
[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg?style=for-the-badge)](https://github.com/hacs/integration)
[![GitHub Activity][last-commit-shield]][commits]

A Lovelace card for controlling an Apple TV, styled after the Apple TV Remote in the iPhone Control Center: one dark panel with a large touchpad and round buttons underneath.

<img src="assets/screenshot-v2.png" alt="Apple TV Remote Card" width="300"/>

- **Touchpad**: swipe to move, tap to select, hold to repeat, right-click or double-tap for back. Trackpad scrolling works too.
- **Resizable**: drag the grip under the touchpad to change its height (remembered per device), double-click it to reset.
- **Now playing**: shows the Apple TV's name and what's playing when a media player is set.
- **Visual editor** and haptic feedback in the Home Assistant app.

Works with Home Assistant's [Apple TV integration](https://www.home-assistant.io/integrations/apple_tv/).

## Installation

### HACS

1. In HACS, add `https://github.com/jpnaifeh/tv-card` as a custom repository of type **Dashboard**.
2. Install **Apple TV Remote Card** and reload the browser.

### Manual

1. Copy `tv-card-v2.js` to `config/www/tv-card-v2/`.
2. Add `/local/tv-card-v2/tv-card-v2.js` as a dashboard resource of type **JavaScript module**.

## Configuration

```yaml
type: custom:tv-card-v2
remote_entity: remote.living_room
media_player_entity: media_player.living_room
```

| Name | Type | Default | Description
| ---- | ---- | ------- | -----------
| `remote_entity` | string | **Required** | The Apple TV `remote` entity that receives key presses.
| `media_player_entity` | string | | The Apple TV `media_player` entity, used for the header and app buttons.
| `title` | string | media player name | Header text. Set to `""` to hide the name (now playing still shows).
| `touchpad_height` | number | `360` | Touchpad height in px (160–720). Changing it resets any size dragged on a device.
| `buttons` | list | `[skip_backward, menu, skip_forward]` | Buttons below the touchpad, in order.
| `enable_double_click` | boolean | unset | Unset: every tap selects and a double tap also sends back. `true`: a double tap sends only back (single taps wait 200ms). `false`: no double tap.
| `double_click_key` | string | `menu` | Command sent on double tap.
| `enable_button_feedback` | boolean | `true` | Haptic feedback in the Home Assistant app.
| `swipe_threshold` | number | `80` | Pixels of swipe per arrow key.
| `custom_keys` | object | | Extra buttons, see below.
| `custom_sources` | object | | Extra app buttons, see below.
| `custom_icons` | object | | Custom SVG icons, see below.

### Touchpad

| Gesture | Sends
| ------- | -----
| Swipe | `up` / `down` / `left` / `right`, one per `swipe_threshold` px
| Tap | `select`
| Hold still | `select`, repeated every 200ms after 700ms
| Swipe, then hold | that direction, repeated
| Double tap | `double_click_key` (see `enable_double_click`)
| Right-click | `menu`
| Scroll (trackpad / mouse wheel) | one arrow per scroll gesture

### Buttons

Built-in buttons are the Apple TV remote commands `up`, `down`, `left`, `right`, `select`, `menu`, `skip_backward` and `skip_forward`, plus the apps `netflix`, `spotify` and `youtube` (these need `media_player_entity`).

`custom_keys` and `custom_sources` add buttons you can list in `buttons`. Each needs an `icon` and one of:

- `key`: a command for `remote.send_command` on the Apple TV
- `source`: an app name for `media_player.select_source`
- `service` (and optional `service_data`): any Home Assistant service

```yaml
type: custom:tv-card-v2
remote_entity: remote.living_room
media_player_entity: media_player.living_room
buttons:
  - menu
  - home
  - play_pause
  - disney
custom_keys:
  home:
    key: home
    icon: mdi:television
  play_pause:
    key: play_pause
    icon: mdi:play-pause
custom_sources:
  disney:
    source: Disney+
    icon: mdi:alpha-d-circle
```

`custom_icons` maps an icon name to an SVG path, for icons that aren't in MDI:

```yaml
custom_keys:
  tv:
    key: home
    icon: appletv
custom_icons:
  appletv: "M12 2a10 10 0 1 0 0 20a10 10 0 1 0 0-20z"
```

### Styling

The card is always dark, like the iPhone remote. Override these CSS variables (for example with [card-mod](https://github.com/thomasloven/lovelace-card-mod) or a theme) to change it:

`--tv-card-background`, `--tv-card-surface`, `--tv-card-surface-active`, `--tv-card-icon-color`, `--tv-card-secondary-text-color`, `--tv-card-border-radius`

## Upgrading from v1

v2 is a new card with a new name and config, so it doesn't replace existing `custom:tv-card` cards automatically.

- Change `type: custom:tv-card` to `type: custom:tv-card-v2`.
- Replace `entity` with `remote_entity` (and optionally `media_player_entity`).
- The row options (`power_row`, `navigation_row`, `volume_row`, …) are replaced by the touchpad and `buttons`.
- The volume slider is gone, so [slider-card](https://github.com/AnthonMS/my-cards) is no longer needed.
- `key` values in `custom_keys` are now Apple TV commands (`menu`), not `KEY_*` codes (`KEY_RETURN`).
- If you added the resource manually, point it at `tv-card-v2.js`.

v1 is still available in the git history.

## Credits

Based on [usernein's tv-card](https://github.com/usernein/tv-card), a fork of [marrobHD's tv-card](https://github.com/marrobHD/tv-card), with the touchpad originally from [iablon's Touchpad Card](https://github.com/iablon/HomeAssistant-Touchpad-Card).

[last-commit-shield]: https://img.shields.io/github/last-commit/jpnaifeh/tv-card?style=for-the-badge
[commits]: https://github.com/jpnaifeh/tv-card/commits/master
[license-shield]: https://img.shields.io/github/license/jpnaifeh/tv-card.svg?style=for-the-badge
[releases-shield]: https://img.shields.io/github/release/jpnaifeh/tv-card.svg?style=for-the-badge
[releases]: https://github.com/jpnaifeh/tv-card/releases
