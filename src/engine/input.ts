import { PALETTE } from '../art/palette';
import {
  getAimModePreference,
  setAimModePreference,
  type AimMode,
} from './storage';

/**
 * Unified input handler for desktop (WASD / Arrow keys, ESC/P pause, M aim toggle,
 * mouse aiming) and mobile (floating virtual touch joystick with deadzone & pastel rings).
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface InputCallbacks {
  onPauseToggle?: () => void;
  onAimModeToggle?: (mode: AimMode) => void;
  onUserGesture?: () => void;
}

export interface JoystickState {
  active: boolean;
  pointerId: number | null;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
  knobX: number;
  knobY: number;
  vectorX: number;
  vectorY: number;
  magnitude: number;
}

const JOYSTICK_MAX_RADIUS = 56;
const JOYSTICK_DEADZONE = 10;
const JOYSTICK_KNOB_RADIUS = 22;

export class InputManager {
  private readonly canvas: HTMLCanvasElement;
  private readonly callbacks: InputCallbacks;
  private readonly keysDown = new Set<string>();

  private aimMode: AimMode;
  private mouseScreenX = 0;
  private mouseScreenY = 0;
  private hasMouseMoved = false;

  private readonly joystick: JoystickState = {
    active: false,
    pointerId: null,
    originX: 0,
    originY: 0,
    currentX: 0,
    currentY: 0,
    knobX: 0,
    knobY: 0,
    vectorX: 0,
    vectorY: 0,
    magnitude: 0,
  };

  constructor(canvas: HTMLCanvasElement, callbacks: InputCallbacks = {}) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.aimMode = getAimModePreference();

    this.attachListeners();
  }

  public getAimMode(): AimMode {
    return this.aimMode;
  }

  public setAimMode(mode: AimMode): void {
    this.aimMode = mode;
    setAimModePreference(mode);
    this.callbacks.onAimModeToggle?.(mode);
  }

  public toggleAimMode(): AimMode {
    const next: AimMode = this.aimMode === 'auto' ? 'mouse' : 'auto';
    this.setAimMode(next);
    return next;
  }

  public isJoystickActive(): boolean {
    return this.joystick.active;
  }

  public hasMousePosition(): boolean {
    return this.hasMouseMoved;
  }

  public getMouseScreen(): Vec2 {
    return { x: this.mouseScreenX, y: this.mouseScreenY };
  }

  public getMouseWorld(
    camX: number,
    camY: number,
    viewportWidth: number,
    viewportHeight: number
  ): Vec2 {
    return {
      x: this.mouseScreenX - viewportWidth / 2 + camX,
      y: this.mouseScreenY - viewportHeight / 2 + camY,
    };
  }

  /**
   * Returns normalized movement vector combining keyboard (WASD / Arrows)
   * and the floating virtual touch joystick.
   */
  public getMoveVector(): Vec2 {
    let x = 0;
    let y = 0;

    if (this.keysDown.has('KeyW') || this.keysDown.has('ArrowUp')) y -= 1;
    if (this.keysDown.has('KeyS') || this.keysDown.has('ArrowDown')) y += 1;
    if (this.keysDown.has('KeyA') || this.keysDown.has('ArrowLeft')) x -= 1;
    if (this.keysDown.has('KeyD') || this.keysDown.has('ArrowRight')) x += 1;

    if (x !== 0 || y !== 0) {
      const len = Math.hypot(x, y);
      return { x: x / len, y: y / len };
    }

    if (this.joystick.active && this.joystick.magnitude > 0) {
      return { x: this.joystick.vectorX, y: this.joystick.vectorY };
    }

    return { x: 0, y: 0 };
  }

  /**
   * Clears held keys and releases any active touch joystick (e.g. on pause or blur).
   */
  public reset(): void {
    this.keysDown.clear();
    this.resetJoystick();
  }

  /**
   * Renders the floating virtual joystick directly on the canvas with soft pastel rings.
   */
  public renderJoystick(ctx: CanvasRenderingContext2D): void {
    if (!this.joystick.active) return;

    const { originX, originY, knobX, knobY, magnitude } = this.joystick;

    ctx.save();

    // Outer translucent pastel base fill
    ctx.beginPath();
    ctx.arc(originX, originY, JOYSTICK_MAX_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(253, 246, 227, 0.28)';
    ctx.fill();

    // Outer pastel lavender ring + crisp dark plum border
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(197, 180, 227, 0.85)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(originX, originY, JOYSTICK_MAX_RADIUS + 2, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(58, 50, 69, 0.45)';
    ctx.stroke();

    // Subtle deadzone guide ring
    ctx.beginPath();
    ctx.arc(originX, originY, JOYSTICK_DEADZONE, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(58, 50, 69, 0.2)';
    ctx.stroke();

    // Soft tether line between origin and thumb knob when outside deadzone
    if (magnitude > 0) {
      ctx.beginPath();
      ctx.moveTo(originX, originY);
      ctx.lineTo(knobX, knobY);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(247, 197, 168, 0.7)';
      ctx.stroke();
    }

    // Inner thumb knob shadow
    ctx.beginPath();
    ctx.arc(knobX, knobY + 2, JOYSTICK_KNOB_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = PALETTE.shadow;
    ctx.fill();

    // Inner pastel peach/cream knob
    ctx.beginPath();
    ctx.arc(knobX, knobY, JOYSTICK_KNOB_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = magnitude > 0 ? PALETTE.peach : PALETTE.cream;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = PALETTE.outline;
    ctx.stroke();

    // Small highlight dot on knob
    ctx.beginPath();
    ctx.arc(knobX - 6, knobY - 6, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.fill();

    ctx.restore();
  }

  public destroy(): void {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
    window.removeEventListener('pointermove', this.handlePointerMove);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('pointercancel', this.handlePointerUp);
  }

  private attachListeners(): void {
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    this.canvas.addEventListener('pointerdown', this.handlePointerDown);
    window.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('pointercancel', this.handlePointerUp);
  }

  private resetJoystick(): void {
    this.joystick.active = false;
    this.joystick.pointerId = null;
    this.joystick.vectorX = 0;
    this.joystick.vectorY = 0;
    this.joystick.magnitude = 0;
  }

  private updateJoystickPosition(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    this.joystick.currentX = x;
    this.joystick.currentY = y;

    const dx = x - this.joystick.originX;
    const dy = y - this.joystick.originY;
    const dist = Math.hypot(dx, dy);

    if (dist <= 0.0001) {
      this.joystick.knobX = this.joystick.originX;
      this.joystick.knobY = this.joystick.originY;
      this.joystick.vectorX = 0;
      this.joystick.vectorY = 0;
      this.joystick.magnitude = 0;
      return;
    }

    const clampedDist = Math.min(dist, JOYSTICK_MAX_RADIUS);
    const nx = dx / dist;
    const ny = dy / dist;

    this.joystick.knobX = this.joystick.originX + nx * clampedDist;
    this.joystick.knobY = this.joystick.originY + ny * clampedDist;

    if (dist < JOYSTICK_DEADZONE) {
      this.joystick.vectorX = 0;
      this.joystick.vectorY = 0;
      this.joystick.magnitude = 0;
    } else {
      const effectiveRange = JOYSTICK_MAX_RADIUS - JOYSTICK_DEADZONE;
      const mag = Math.min((dist - JOYSTICK_DEADZONE) / effectiveRange, 1);
      this.joystick.vectorX = nx * mag;
      this.joystick.vectorY = ny * mag;
      this.joystick.magnitude = mag;
    }
  }

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    this.callbacks.onUserGesture?.();

    if (
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight' ||
      e.code === 'Space'
    ) {
      e.preventDefault();
    }

    if (!e.repeat) {
      if (e.code === 'Escape' || e.code === 'KeyP') {
        this.callbacks.onPauseToggle?.();
        return;
      }
      if (e.code === 'KeyM') {
        this.toggleAimMode();
        return;
      }
    }

    this.keysDown.add(e.code);
  };

  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    this.keysDown.delete(e.code);
  };

  private readonly handleBlur = (): void => {
    this.reset();
  };

  private readonly handlePointerDown = (e: PointerEvent): void => {
    this.callbacks.onUserGesture?.();

    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (e.pointerType === 'mouse') {
      this.mouseScreenX = x;
      this.mouseScreenY = y;
      this.hasMouseMoved = true;
      return;
    }

    // Touch / pen: spawn floating virtual joystick wherever the user touches
    if (!this.joystick.active) {
      this.joystick.active = true;
      this.joystick.pointerId = e.pointerId;
      this.joystick.originX = x;
      this.joystick.originY = y;
      this.joystick.currentX = x;
      this.joystick.currentY = y;
      this.joystick.knobX = x;
      this.joystick.knobY = y;
      this.joystick.vectorX = 0;
      this.joystick.vectorY = 0;
      this.joystick.magnitude = 0;

      try {
        this.canvas.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if capture is unsupported
      }
    }
  };

  private readonly handlePointerMove = (e: PointerEvent): void => {
    if (e.pointerType === 'mouse') {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseScreenX = e.clientX - rect.left;
      this.mouseScreenY = e.clientY - rect.top;
      this.hasMouseMoved = true;
      return;
    }

    if (this.joystick.active && e.pointerId === this.joystick.pointerId) {
      this.updateJoystickPosition(e.clientX, e.clientY);
    }
  };

  private readonly handlePointerUp = (e: PointerEvent): void => {
    if (this.joystick.active && e.pointerId === this.joystick.pointerId) {
      this.resetJoystick();
    }
  };
}
