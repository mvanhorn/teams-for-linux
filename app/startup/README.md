# Startup Module

Handles Electron command line switches and initialization flags.

## commandLine.js

Manages command line switches that must be set during app startup. Some switches are applied before config loading, others after.

**Key responsibilities:**
- Media key handling configuration
- Wayland/X11 display server detection and configuration
- GPU acceleration settings
- Proxy and authentication configuration
- User-defined Electron CLI flags from config
- Flatpak follow-OS theme workaround

### Flatpak system dark theme

On Linux, when `FLATPAK_ID` is nonempty, `addSwitchesAfterConfigLoad` appends `UsePortalAccentColor` to the final `--disable-features` value after `electronCLIFlags` are applied ([#3023](https://github.com/IsmaelMartinez/teams-for-linux/issues/3023)). Electron's portal accent-color integration currently reports a light theme inside Flatpak when the portal `color-scheme` preference is dark, so Teams stays light while configured to follow the OS. Disabling the feature restores system dark theme detection.

The merge keeps every existing feature token, appends `UsePortalAccentColor` only when that token is absent, and writes a nonempty list when the current switch value is empty. `HardwareMediaKeyHandling` keeps its current policy: the default is added only when `--disable-features` is unset, and an explicit list is preserved as the user supplied it, including a list that omits the media-key feature (the existing warning still applies). Linux with an unset or empty `FLATPAK_ID`, and macOS or Windows even with `FLATPAK_ID` set, keep the disable-features list startup already produced.

Flatpak builds lose portal accent-color integration while this workaround is in place. Reevaluate it when upgrading Electron.
