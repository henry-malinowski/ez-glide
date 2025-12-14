// Module presence checks
(async () => {
  if (game.modules.get('ez-glide')?.active) {
    ui.notifications.warn("EZGlide module is active. Configure zoom in module settings instead.");
    return;
  }
  if (game.modules.get('aeris-smooth-camera')?.active) {
    ui.notifications.warn("Aeris Smooth Camera module is active. Configure zoom in module settings instead.");
    return;
  }
  if (!game.modules.get('lib-wrapper')?.active) {
    ui.notifications.warn("LibWrapper module is not active.");
    return;
  }

// Hook persistence system - track registered hooks per world
if (!globalThis._ezGlideMacroHooks) {
  globalThis._ezGlideMacroHooks = new WeakMap();
}

// Get or create hook ID set for this world
const worldHooks = globalThis._ezGlideMacroHooks.get(game.world) || new Set();
globalThis._ezGlideMacroHooks.set(game.world, worldHooks);

// Define the settings data model
class EzGlideMacroSettings extends foundry.abstract.DataModel {
  static defineSchema() {
    return {
      enableZoom: new foundry.data.fields.BooleanField({
        label: "Smooth Zoom",
        hint: "Disable to use Foundry's default wheel behavior.",
        initial: true
      }),
      zoomSpeed: new foundry.data.fields.NumberField({
        label: "Zoom Speed",
        hint: "Lower values have slower convergence, higher values are faster.",
        min: 0.1,
        max: 25,
        step: 0.1,
        initial: 5
      }),
      zoomStep: new foundry.data.fields.NumberField({
        label: "Zoom Step Size",
        hint: "Zoom factor per wheel step (1.01 – 1.5)",
        min: 1.01,
        max: 1.5,
        step: 0.01,
        initial: 1.12
      }),
      enablePan: new foundry.data.fields.BooleanField({
        label: "Smooth Panning",
        hint: "Disable to use Foundry's default panning behavior.",
        initial: true
      }),
      panSpeed: new foundry.data.fields.NumberField({
        label: "Pan Speed",
        hint: "Lower values have slower convergence, higher values are faster.",
        min: 0.1,
        max: 25,
        step: 0.1,
        initial: 8
      })
    };
  }

  constructor(data = {}, options = {}) {
    // Merge provided data with field defaults for missing values
    const defaults = {};
    const schemaDefinition = EzGlideMacroSettings.defineSchema();
    for (const [fieldName, field] of Object.entries(schemaDefinition)) {
      if (!(fieldName in data) && field.initial !== undefined) {
        defaults[fieldName] = field.initial;
      }
    }
    const mergedData = {...defaults, ...data};
    super(mergedData, options);
  }
}

// Get previous settings from user flags
const previousSettings = await game.user.getFlag("world", "ez-glide-macro") ?? {};

// Create settings model instance
const settingsModel = new EzGlideMacroSettings(previousSettings);

const template = `
  <fieldset>
    <legend>Zoom Settings</legend>
    {{formGroup fields.fields.enableZoom value=enableZoom}}
    {{formGroup fields.fields.zoomSpeed value=zoomSpeed}}
    {{formGroup fields.fields.zoomStep value=zoomStep}}
  </fieldset>

  <fieldset>
    <legend>Pan Settings</legend>
    {{formGroup fields.fields.enablePan value=enablePan}}
    {{formGroup fields.fields.panSpeed value=panSpeed}}
  </fieldset>
`;

const content = Handlebars.compile(template)({...settingsModel.toObject(), fields: settingsModel.schema});

// Prompt user for configuration before unregistering any hooks
let configResult;
try {
  configResult = await foundry.applications.api.DialogV2.prompt({
    window: { 
      title: "EZGlide Macro",
      icon: "fa-solid fa-person-skating"
    },
    content: content,
    ok: {
      label: "Enable EZGlide Macro",
      callback: (event, button, dialog) => {
        const form = button.form;
        return {
          enableZoom: form.enableZoom.checked,
          enablePan: form.enablePan.checked,
          zoomSpeed: parseFloat(form.zoomSpeed.value),
          panSpeed: parseFloat(form.panSpeed.value),
          zoomStep: parseFloat(form.zoomStep.value)
        };
      }
    }
  });
} catch (error) {
  // User cancelled or closed dialog - bail out without unregistering anything
  return;
}

// Validate that we got all required configuration values
if (!configResult ||
    typeof configResult.enableZoom !== 'boolean' ||
    typeof configResult.enablePan !== 'boolean' ||
    typeof configResult.zoomSpeed !== 'number' ||
    typeof configResult.panSpeed !== 'number' ||
    typeof configResult.zoomStep !== 'number') {
  ui.notifications.error("Invalid configuration provided. Macro cancelled.");
  return;
}

// Save settings to user flags for next macro run
await game.user.setFlag("world", "ez-glide-macro", configResult);

// Unregister existing hooks if any exist
if (worldHooks.size > 0) {
  worldHooks.forEach(hookId => {
    try {
      libWrapper.unregister(game.world.id, hookId);
    } catch (e) {
      console.warn("Failed to unregister hook:", hookId, e);
    }
  });
  worldHooks.clear();
}

// Constants
const MACRO_ID = game.world.id; // libwrapper requires a world ID if a macro can not be provided
const STOP_EPS = 1e-3;
const INTERNAL_PAN = Symbol('ez-glide-internal');

const HOOK_MODES = {
  NONE: 0,
  PANNING: 1,
  ZOOMING: 2
};

// User configuration from dialog
const CONFIG = configResult;

// State objects (as const since properties are modified, not reassigned)
const settings = {
  zoomSpeed: CONFIG.zoomSpeed,
  panSpeed: CONFIG.panSpeed,
  zoomStep: CONFIG.zoomStep
};

const animationState = {
  currentView: {x: 0, y: 0, scale: 1},
  targetView: {x: 0, y: 0, scale: 1},
  viewTicker: null,
  lastViewTime: 0
};

const errorState = {
  wrapperError: null,
  conflictingPackage: null
};

function expDecay(speed, t) {
  return 1 - Math.exp(-speed * t);
}

function lerpSnap(current, target, factor) {
  const remaining = target - current;
  if (Math.abs(remaining) <= STOP_EPS) {
    return { value: target, delta: 0 };
  }
  const value = current + remaining * factor;
  return { value, delta: Math.abs(target - value) };
}

function getFrameDelta() {
  const now = performance.now();
  const dt = Math.max(0, (now - animationState.lastViewTime) / 1000);
  animationState.lastViewTime = now;
  return dt;
}

const MODE_HANDLERS = {
  NONE: {
    registerWrappers(packageId, hookIds) {
    }
  },

  ZOOM_ONLY: {
    registerWrappers(packageId, hookIds) {
      const hookId = libWrapper.register(
        packageId,
        'foundry.canvas.Canvas.prototype._onMouseWheel',
        function zoomOnlyWheel(event) {
          const canvas = this;

          syncViewState(canvas);

          const dz = event.deltaY < 0 ? settings.zoomStep : 1 / settings.zoomStep;
          animationState.targetView.scale = canvas._constrainView({scale: dz * animationState.targetView.scale}).scale;

          startViewTicker(canvas);
        },
        libWrapper.OVERRIDE
      );
      hookIds.add(hookId);
    },

    createTicker(canvas) {
      return () => {
        const dt = getFrameDelta();

        const factor = expDecay(settings.zoomSpeed, dt);
        const rs = lerpSnap(animationState.currentView.scale, animationState.targetView.scale, factor);

        animationState.currentView.scale = rs.value;

        canvas.stage.scale.set(animationState.currentView.scale, animationState.currentView.scale);
        canvas.scene._viewPosition.scale = animationState.currentView.scale;
        canvas.updateBlur();

        if (rs.delta === 0) {
          stopViewTicker(canvas);
        }
      };
    }
  },

  PAN_ONLY: {
    registerWrappers(packageId, hookIds) {
      const animatePanHookId = libWrapper.register(
        packageId,
        'foundry.canvas.Canvas.prototype.animatePan',
        function smoothPan(wrapper, args = {}) {
          const denom = expDecay(settings.panSpeed, 1);
          function easing(pt) {
            const factor = expDecay(settings.panSpeed, pt) / denom;
            return lerpSnap(0, 1, factor).value;
          }
          return wrapper({...args, easing});
        },
        libWrapper.WRAPPER
      );
      hookIds.add(animatePanHookId);

      const dragHookId = libWrapper.register(
        packageId,
        'foundry.canvas.Canvas.prototype._onDragRightMove',
        function smoothDragRightMove(event) {
          const canvas = this;
          const data = event?.interactionData;
          if (!canvas?.stage || !data?.origin || !data?.destination) return;

          const dx = data.destination.x - data.origin.x;
          const dy = data.destination.y - data.origin.y;
          const mod = globalThis.CONFIG.Canvas.dragSpeedModifier;

          syncViewState(canvas);

          const desired = canvas._constrainView({
            x: canvas.stage.pivot.x - (dx * mod),
            y: canvas.stage.pivot.y - (dy * mod),
            scale: animationState.currentView.scale
          });

          animationState.targetView.x = desired.x;
          animationState.targetView.y = desired.y;
          animationState.targetView.scale = animationState.currentView.scale;

          startViewTicker(canvas);

          // Mirror core behavior: reset token tab cycling
          canvas.tokens._tabIndex = null;
        },
        libWrapper.OVERRIDE
      );
      hookIds.add(dragHookId);
    },

    createTicker(canvas) {
      return () => {
        const dt = getFrameDelta();

        const factorPan = expDecay(settings.panSpeed, dt);
        const rx = lerpSnap(animationState.currentView.x, animationState.targetView.x, factorPan);
        const ry = lerpSnap(animationState.currentView.y, animationState.targetView.y, factorPan);

        animationState.currentView.x = rx.value;
        animationState.currentView.y = ry.value;

        animationState.currentView.scale = canvas.stage.scale.x;

        canvas.pan({...animationState.currentView, [INTERNAL_PAN]: true});
        canvas.updateBlur();

        // Align to constrained live values
        syncViewState(canvas);

        // Check convergence for x/y only (scale is passthrough)
        if (rx.delta === 0 && ry.delta === 0) {
          stopViewTicker(canvas);
        }
      };
    }
  },

  BOTH: {
    registerWrappers(packageId, hookIds) {
      const panWrapperHookId = libWrapper.register(
        packageId,
        'foundry.canvas.Canvas.prototype.pan',
        function panWrapper(wrapper, options = {}) {
          const isInternal = options?.[INTERNAL_PAN];

          if (!isInternal) {
            stopViewTicker(this);
            alignTargetsToCurrent(this);
          }
          return wrapper(options);
        },
        libWrapper.WRAPPER
      );
      hookIds.add(panWrapperHookId);

      const animatePanHookId = libWrapper.register(
        packageId,
        'foundry.canvas.Canvas.prototype.animatePan',
        function smoothPan(wrapper, args = {}) {
          const denom = expDecay(settings.panSpeed, 1);
          function easing(pt) {
            const factor = expDecay(settings.panSpeed, pt) / denom;
            return lerpSnap(0, 1, factor).value;
          }
          return wrapper({...args, easing});
        },
        libWrapper.WRAPPER
      );
      hookIds.add(animatePanHookId);

      const wheelHookId = libWrapper.register(
        packageId,
        'foundry.canvas.Canvas.prototype._onMouseWheel',
        function smoothWheel(event) {
          const canvas = this;

          syncViewState(canvas);

          const dz = event.deltaY < 0 ? settings.zoomStep : 1 / settings.zoomStep;
          const targetScale = canvas._constrainView({scale: dz * animationState.targetView.scale}).scale;
          animationState.targetView = {x: animationState.currentView.x, y: animationState.currentView.y, scale: targetScale};

          startViewTicker(canvas);
        },
        libWrapper.OVERRIDE
      );
      hookIds.add(wheelHookId);

      const dragHookId = libWrapper.register(
        packageId,
        'foundry.canvas.Canvas.prototype._onDragRightMove',
        function smoothDragRightMove(event) {
          const canvas = this;
          const data = event?.interactionData;
          if (!canvas?.stage || !data?.origin || !data?.destination) return;

          const dx = data.destination.x - data.origin.x;
          const dy = data.destination.y - data.origin.y;
          const mod = globalThis.CONFIG.Canvas.dragSpeedModifier;

          syncViewState(canvas);

          const desired = canvas._constrainView({
            x: canvas.stage.pivot.x - (dx * mod),
            y: canvas.stage.pivot.y - (dy * mod),
            scale: animationState.targetView.scale
          });

          animationState.targetView = {x: desired.x, y: desired.y, scale: animationState.targetView.scale};
          startViewTicker(canvas);

          canvas.tokens._tabIndex = null;
        },
        libWrapper.OVERRIDE
      );
      hookIds.add(dragHookId);
    },

    createTicker(canvas) {
      return () => {
        const dt = getFrameDelta();

        const factorPan = expDecay(settings.panSpeed, dt);
        const factorZoom = expDecay(settings.zoomSpeed, dt);

        const rx = lerpSnap(animationState.currentView.x, animationState.targetView.x, factorPan);
        const ry = lerpSnap(animationState.currentView.y, animationState.targetView.y, factorPan);
        const rs = lerpSnap(animationState.currentView.scale, animationState.targetView.scale, factorZoom);

        animationState.currentView.x = rx.value;
        animationState.currentView.y = ry.value;
        animationState.currentView.scale = rs.value;

        canvas.pan({...animationState.currentView, [INTERNAL_PAN]: true});
        canvas.updateBlur();

        syncViewState(canvas);

        if (rx.delta === 0 && ry.delta === 0 && rs.delta === 0) {
          stopViewTicker(canvas);
        }
      };
    }
  }
};

function stopViewTicker(canvas) {
  if (animationState.viewTicker && canvas?.app) {
    canvas.app.ticker.remove(animationState.viewTicker);
    animationState.viewTicker = null;
  }
}

function syncViewState(canvas) {
  animationState.currentView = {
    x: canvas.stage.pivot.x,
    y: canvas.stage.pivot.y,
    scale: canvas.stage.scale.x
  };
}

function alignTargetsToCurrent(canvas) {
  syncViewState(canvas);
  animationState.targetView = {...animationState.currentView};
}

function startViewTicker(canvas) {
  if (animationState.viewTicker || !canvas?.app) return;

  animationState.lastViewTime = performance.now();

  if (currentHandler?.createTicker) {
    animationState.viewTicker = currentHandler.createTicker(canvas);
  }

  canvas.app.ticker.add(animationState.viewTicker);
}

function getHandlerKey(mode) {
  if (mode === HOOK_MODES.NONE) return 'NONE';

  const hasZoom = mode & HOOK_MODES.ZOOMING;
  const hasPan = mode & HOOK_MODES.PANNING;

  if (hasZoom && hasPan) return 'BOTH';
  if (hasZoom) return 'ZOOM_ONLY';
  if (hasPan) return 'PAN_ONLY';

  return 'NONE';
}

function registerMacroHooks(mode, hookIds) {
  // Map HOOK_MODES flags to handler key
  const handlerKey = getHandlerKey(mode);
  const handler = MODE_HANDLERS[handlerKey];

  if (!handler) {
    currentHandler = null;
    return;
  }

  try {
    handler.registerWrappers(MACRO_ID, hookIds);
    currentHandler = handler;
  } catch (err) {
    console.error(err);
    errorState.wrapperError = err;
    // Clean up on error by unregistering everything
    hookIds.forEach(hookId => {
      try {
        libWrapper.unregister(MACRO_ID, hookId);
      } catch (unregisterErr) {
        console.warn("Failed to unregister hook during error cleanup:", hookId, unregisterErr);
      }
    });
    hookIds.clear();
    currentHandler = null;
  }
}

let currentHandler = null;

// Compute hook mode from CONFIG
let hookMode = HOOK_MODES.NONE;
if (CONFIG.enablePan) hookMode |= HOOK_MODES.PANNING;
if (CONFIG.enableZoom) hookMode |= HOOK_MODES.ZOOMING;

// Register hooks and track IDs
registerMacroHooks(hookMode, worldHooks);

  // Initialize view state if canvas is ready
  if (canvas?.ready) {
    alignTargetsToCurrent(canvas);
    canvas?.draw();
  }

  ui.notifications.info("ez-glide macro enabled");
})();
