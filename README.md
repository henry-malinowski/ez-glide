# ⛸ EZGlide (Exponential-Zoom & Glide)

[![Foundry Version](https://img.shields.io/endpoint?url=https%3A%2F%2Ffoundryshields.com%2Fversion%3Fstyle%3Dfor-the-badge%26url%3Dhttps%3A%2F%2Fraw.githubusercontent.com%2Fhenry-malinowski%2Fez-glide%2Frefs%2Fheads%2Fmain%2Fmodule.json)](https://foundryvtt.com)
[![License](https://img.shields.io/github/license/henry-malinowski/ez-glide?style=for-the-badge)](https://www.gnu.org/licenses/gpl-3.0)

Smooths canvas zooming and panning with animated, exponential easing for a more polished tabletop experience.

## Demo
[ez-glide.webm](https://github.com/user-attachments/assets/ffe362e1-eb5d-436b-8011-465ac30a26eb)

## Features

- **Smooth Zooming**: Mouse wheel zooming with exponential decay animation
- **Smooth Panning**: Right-click drag panning with slick interpolation
- **Configurable Speeds**: Independent controls for zoom and pan animation speeds
- **User Choice**: Per-user settings allow individual players to opt-out while others use smooth controls
- **Macro Alternative**: Companion macro for players who can't install modules, but want to experience this module.

## Installation

### Option 1: Module Installation (Recommended)

1. In Foundry VTT, go to **Add-on Modules**
2. Click **Install Module**
3. Search for "EZGlide" and install
4. Enable the module in your world settings

### Option 2: Macro Alternative

For players who can't get their GM to install modules, use the companion macro:

1. Copy the contents of [`macro/macro.js`](macro/macro.js)
2. Create a new macro in Foundry VTT
3. Paste the code and run it
4. Configure your preferred settings in the dialog

**Note**: You will need to run the macro each time you load into the world to apply it, but your settings from past runs are saved.

## Configuration

Access settings through **Game Settings (tab)** → **⚙ Configure Settings** → **⛸ EZGlide (Exponential-Zoom & Glide)**:

- **Smooth Zoom**: Enable/disable smooth zooming behavior
    - **Zoom Smoothing Factor**: Controls animation speed (Lower values have slower convergence, higher values are faster.)
    - **Zoom Step Size**: Multiplier for each wheel scroll (Foundry's default is equivlent to 1.05, but higher values pair well with smooth zooming)
- **Smooth Panning**: Enable/disable smooth panning behavior
    - **Pan Smoothing Factor**: Controls pan animation speed

All settings are **user-scoped**, allowing individual players to disable smooth controls while others keep them enabled.

## Technical Details

- **Dependencies**: Requires [lib-wrapper](https://github.com/ruipin/fvtt-lib-wrapper)
- **Conflicts**: Incompatible with [aeris-smooth-camera](https://foundryvtt.com/packages/aeris-smooth-camera) (both modify canvas interaction). Note: unlike aeris-smooth-camera, this modules allows for simultaneous panning and zooming.

## License

This module is licensed under the [GPL v3.0](LICENSE) license.
