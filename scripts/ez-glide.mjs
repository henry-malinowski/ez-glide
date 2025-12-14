const MODULE_ID = 'ez-glide';
const STOP_EPS = 1e-3;
const INTERNAL_PAN = Symbol(`${MODULE_ID}-internal`);

const HOOK_MODES = {
  NONE: 0,
  PANNING: 1,
  ZOOMING: 2
};

const settings = {
  zoomSpeed: 5,
  panSpeed: 8,
  zoomStep: 1.12
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
let currentHandler = null;

/**
 * Mode-specific handlers implementing the Strategy pattern.
 * Each handler encapsulates all behavior for its mode: wrapper registration and ticker creation.
 */
const MODE_HANDLERS = {
  NONE: {
    registerWrappers(libWrapper, MODULE_ID) {
      // No-op - no wrappers to register
    }
  },

  ZOOM_ONLY: {
    registerWrappers(libWrapper, MODULE_ID) {
      // Zoom-only mode: register wheel handler only
      libWrapper.register(
        MODULE_ID,
        'foundry.canvas.Canvas.prototype._onMouseWheel',
        function zoomOnlyWheel(event) {
          const canvas = this;
          
          // Sync current state
          syncViewState(canvas);
          
          // Compute target scale - accumulate on animationState.targetView.scale
          const dz = event.deltaY < 0 ? settings.zoomStep : 1 / settings.zoomStep;
          animationState.targetView.scale = canvas._constrainView({scale: dz * animationState.targetView.scale}).scale;
          
          startViewTicker(canvas);
        },
        libWrapper.OVERRIDE
      );
    },
    
    createTicker(canvas) {
      // Zoom-only ticker: animate scale using direct manipulation
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
    registerWrappers(libWrapper, MODULE_ID) {
      // Pan-only mode: register drag and animatePan handlers
      libWrapper.register(
        MODULE_ID,
        'foundry.canvas.Canvas.prototype.animatePan',
        function smoothPan(wrapper, args = {}) {
          // Inject exponential easing
          const denom = expDecay(settings.panSpeed, 1);
          function easing(pt) {
            const factor = expDecay(settings.panSpeed, pt) / denom;
            return lerpSnap(0, 1, factor).value;
          }
          return wrapper({...args, easing});
        },
        libWrapper.WRAPPER
      );

      libWrapper.register(
        MODULE_ID,
        'foundry.canvas.Canvas.prototype._onDragRightMove',
        function smoothDragRightMove(event) {
          const canvas = this;
          const data = event?.interactionData;
          if (!canvas?.stage || !data?.origin || !data?.destination) return;

          const dx = data.destination.x - data.origin.x;
          const dy = data.destination.y - data.origin.y;
          const mod = CONFIG.Canvas.dragSpeedModifier;

          // INFERENCE CONTRACT: Sync from canvas and pass current scale explicitly
          // Since we're not animating scale, we read it fresh from canvas
          syncViewState(canvas);
          
          const desired = canvas._constrainView({
            x: canvas.stage.pivot.x - (dx * mod),
            y: canvas.stage.pivot.y - (dy * mod),
            scale: animationState.currentView.scale  // Explicit: not animating scale
          });

          // Set new pan target, keep scale synced (not animated)
          animationState.targetView.x = desired.x;
          animationState.targetView.y = desired.y;
          animationState.targetView.scale = animationState.currentView.scale;  // Keep in sync, don't animate

          startViewTicker(canvas);

          // Mirror core behavior: reset token tab cycling
          canvas.tokens._tabIndex = null;
        },
        libWrapper.OVERRIDE
      );
    },
    
    createTicker(canvas) {
      // Pan-only ticker: animate x/y, read scale live from canvas
      return () => {
        const dt = getFrameDelta();

        const factorPan = expDecay(settings.panSpeed, dt);

        // Animate x/y only
        const rx = lerpSnap(animationState.currentView.x, animationState.targetView.x, factorPan);
        const ry = lerpSnap(animationState.currentView.y, animationState.targetView.y, factorPan);

        animationState.currentView.x = rx.value;
        animationState.currentView.y = ry.value;
        
        // INFERENCE CONTRACT: Read scale fresh from canvas each frame
        // Never animate it - Foundry controls scale in PAN_ONLY mode
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
    registerWrappers(libWrapper, MODULE_ID) {
      // Both modes: register pan wrapper, wheel, drag, and animatePan
      
      // Pan wrapper prevents interference when both modes are active
      libWrapper.register(
        MODULE_ID,
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

      // AnimatePan for smooth panning
      libWrapper.register(
        MODULE_ID,
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

      // Mouse wheel for smooth zooming
      libWrapper.register(
        MODULE_ID,
        'foundry.canvas.Canvas.prototype._onMouseWheel',
        function smoothWheel(event) {
          const canvas = this;

          // Blend from the live visual scale; accumulate deltas from the intended target.
          syncViewState(canvas);

          // INFERENCE CONTRACT: Must provide animationState.targetView.scale explicitly
          // All three dimensions are being animated
          const dz = event.deltaY < 0 ? settings.zoomStep : 1 / settings.zoomStep;
          const targetScale = canvas._constrainView({scale: dz * animationState.targetView.scale}).scale;
          animationState.targetView = {x: animationState.currentView.x, y: animationState.currentView.y, scale: targetScale};

          startViewTicker(canvas);
        },
        libWrapper.OVERRIDE
      );

      // Drag for smooth panning
      libWrapper.register(
        MODULE_ID,
        'foundry.canvas.Canvas.prototype._onDragRightMove',
        function smoothDragRightMove(event) {
          const canvas = this;
          const data = event?.interactionData;
          if (!canvas?.stage || !data?.origin || !data?.destination) return;

          const dx = data.destination.x - data.origin.x;
          const dy = data.destination.y - data.origin.y;
          const mod = CONFIG.Canvas.dragSpeedModifier;

          syncViewState(canvas);
          
          // INFERENCE CONTRACT: Must provide animationState.targetView.scale explicitly
          // Since scale is being animated, we can't let it be inferred
          const desired = canvas._constrainView({
            x: canvas.stage.pivot.x - (dx * mod),
            y: canvas.stage.pivot.y - (dy * mod),
            scale: animationState.targetView.scale  // Explicit: we're animating scale
          });

          animationState.targetView = {x: desired.x, y: desired.y, scale: animationState.targetView.scale};
          startViewTicker(canvas);

          // Mirror core behavior: reset token tab cycling
          canvas.tokens._tabIndex = null;
        },
        libWrapper.OVERRIDE
      );
    },
    
    createTicker(canvas) {
      // Combined ticker: animate x, y, and scale together
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

        // Align to constrained live values after pan
        syncViewState(canvas);

        if (rx.delta === 0 && ry.delta === 0 && rs.delta === 0) {
          stopViewTicker(canvas);
        }
      };
    }
  }
};

/**
 * Exponential decay factor: 1 - e^(-speed * t)
 * @param {number} speed - Decay rate (higher = faster)
 * @param {number} t - Time or progress value
 * @returns {number} Decay factor (0 → 1 as t → ∞)
 */
function expDecay(speed, t) {
  return 1 - Math.exp(-speed * t);
}

/**
 * Lerp with snap-to-target when within STOP_EPS.
 * @param {number} current - Current value
 * @param {number} target - Target value
 * @param {number} factor - Interpolation factor (0-1)
 * @returns {{value: number, delta: number}} Interpolated value and remaining delta (0 if snapped)
 */
function lerpSnap(current, target, factor) {
  const remaining = target - current;
  if (Math.abs(remaining) <= STOP_EPS) {
    return { value: target, delta: 0 };
  }
  const value = current + remaining * factor;
  return { value, delta: Math.abs(target - value) };
}

/**
 * Get frame delta time and update last frame time.
 * @returns {number} Delta time in seconds since last frame
 */
function getFrameDelta() {
  const now = performance.now();
  const dt = Math.max(0, (now - animationState.lastViewTime) / 1000);
  animationState.lastViewTime = now;
  return dt;
}

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'enableSmoothZoom', {
    name: 'ez-glide.settings.enableSmoothZoom.name',
    hint: 'ez-glide.settings.enableSmoothZoom.hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      if (errorState.conflictingPackage || errorState.wrapperError) return;
      updateHooksFromSettings();
      canvas?.draw(); // reload canvas to rebuild from Canvas.prototype.* without a client reload
    }
  });

  game.settings.register(MODULE_ID, 'zoomSpeed', {
    name: 'ez-glide.settings.zoomSpeed.name',
    hint: 'ez-glide.settings.zoomSpeed.hint',
    scope: 'client',
    config: true,
    type: Number,
    range: {min: 0.1, max: 25, step: 0.1},
    default: settings.zoomSpeed,
    onChange: value => settings.zoomSpeed = value
  });


  game.settings.register(MODULE_ID, 'stepSize', {
    name: 'ez-glide.settings.zoomStepSize.name',
    hint: 'ez-glide.settings.zoomStepSize.hint',
    scope: 'client',
    config: true,
    type: Number,
    range: {min: 1.01, max: 1.5, step: 0.01},
    default: settings.zoomStep,
    onChange: value => settings.zoomStep = value
  });

  game.settings.register(MODULE_ID, 'enableSmoothPan', {
    name: 'ez-glide.settings.enableSmoothPan.name',
    hint: 'ez-glide.settings.enableSmoothPan.hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      if (errorState.conflictingPackage || errorState.wrapperError) return;
      updateHooksFromSettings();
      canvas?.draw(); // reload canvas to rebuild from Canvas.prototype.* without a client reload
    }
  });
  
  game.settings.register(MODULE_ID, 'panSpeed', {
    name: 'ez-glide.settings.panSpeed.name',
    hint: 'ez-glide.settings.panSpeed.hint',
    scope: 'client',
    config: true,
    type: Number,
    range: {min: 0.1, max: 25, step: 0.1},
    default: settings.panSpeed,
    onChange: value => settings.panSpeed = value
  });
});

function updateHooksFromSettings() {
  const enableSmoothZoom = game.settings.get(MODULE_ID, 'enableSmoothZoom');
  const enableSmoothPan = game.settings.get(MODULE_ID, 'enableSmoothPan');

  let hookMode = HOOK_MODES.NONE;
  if (enableSmoothPan) hookMode |= HOOK_MODES.PANNING;
  if (enableSmoothZoom) hookMode |= HOOK_MODES.ZOOMING;

  registerHooks(hookMode);
}

// Initialize wrapper according to user settings
Hooks.once('setup', () => {
  // Check for conflicting modules
  const conflicts = game.modules.get(MODULE_ID).relationships.conflicts;
  for (const conflict of conflicts) {
    if (game.modules.get(conflict.id)?.active) {
      errorState.conflictingPackage = conflict;
      console.warn(`${MODULE_ID}: Detected conflicting module '${conflict.id}' is active. Reason: ${conflict.reason}`);
      return; // Skip the rest of setup
    }
  }

  settings.zoomStep = game.settings.get(MODULE_ID, 'stepSize');
  settings.zoomSpeed = game.settings.get(MODULE_ID, 'zoomSpeed');
  settings.panSpeed = game.settings.get(MODULE_ID, 'panSpeed');

  updateHooksFromSettings();
});

// Display error if wrappers failed to register
Hooks.once('ready', () => {
  if (errorState.conflictingPackage) {
    const notificationOptions = {
      format: errorState.conflictingPackage,
      permanent: true
    };
    ui.notifications.error('ez-glide.warnings.conflictDetected', notificationOptions);
  } else if (errorState.wrapperError) {
    const notificationOptions = {
      format: {package_id: errorState.wrapperError.package_info.id, error_name: errorState.wrapperError.name},
      permanent: true,
      console: false
    };
    ui.notifications.error('ez-glide.warnings.failedToRegisterWrappers', notificationOptions);
  }
});

// Initialize view state when canvas is ready
Hooks.on('canvasReady', function onCanvasReady(canvas) {
  // Sync animationState.currentView and animationState.targetView from the actual canvas state.
  // This ensures both variables reflect the scene's initial view position
  // (stored in scene._viewPosition) whenever a scene loads or reloads.
  alignTargetsToCurrent(canvas);
});

function stopViewTicker(canvas) {
  if (animationState.viewTicker && canvas?.app) {
    canvas.app.ticker.remove(animationState.viewTicker);
    animationState.viewTicker = null;
  }
}

function syncViewState(canvas) {
  // it might be possible to use canvas._constrainView({}) here
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

// Foundry builds a single PIXI.Application (PIXI is global) for the canvas in core code and stores
// it as canvas.app. Using canvas.app.ticker keeps us on the same render loop the rest of the canvas uses.
function startViewTicker(canvas) {
  if (animationState.viewTicker || !canvas?.app) return;

  animationState.lastViewTime = performance.now();

  // Delegate ticker creation to current handler
  if (currentHandler?.createTicker) {
    animationState.viewTicker = currentHandler.createTicker(canvas);
  }

  canvas.app.ticker.add(animationState.viewTicker);
}

/**
 * Map HOOK_MODES flags to handler key.
 * @param {number} mode - Bitwise combination of HOOK_MODES flags
 * @returns {string} Handler key ('NONE', 'ZOOM_ONLY', 'PAN_ONLY', or 'BOTH')
 */
function getHandlerKey(mode) {
  if (mode === HOOK_MODES.NONE) return 'NONE';
  
  const hasZoom = mode & HOOK_MODES.ZOOMING;
  const hasPan = mode & HOOK_MODES.PANNING;
  
  if (hasZoom && hasPan) return 'BOTH';
  if (hasZoom) return 'ZOOM_ONLY';
  if (hasPan) return 'PAN_ONLY';
  
  return 'NONE';
}

/**
 * Register libWrapper hooks based on the selected mode.
 * Uses Strategy pattern - delegates wrapper registration to mode-specific handlers.
 * @param {number} mode - Bitwise combination of HOOK_MODES flags
 */
function registerHooks(mode) {
  libWrapper.unregister_all(MODULE_ID);
  
  // Map HOOK_MODES flags to handler key
  const handlerKey = getHandlerKey(mode);
  const handler = MODE_HANDLERS[handlerKey];
  
  if (!handler) {
    currentHandler = null;
    return;
  }
  
  try {
    handler.registerWrappers(libWrapper, MODULE_ID);
    currentHandler = handler;
  } catch (err) {
    console.error(err);
    errorState.wrapperError = err;
    // Clean up on error by unregistering everything
    libWrapper.unregister_all(MODULE_ID);
    currentHandler = null;
  }
}
