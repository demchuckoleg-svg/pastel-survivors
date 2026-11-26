import { PALETTE } from '@shared/data/palette';
import type { BossRuntime, EnemyEntity } from '@shared/sim/types';

type WorldToScreenFn = (wx: number, wy: number) => { x: number; y: number };

/**
 * Client-only Canvas 2D renderer for Boss ground telegraphs and foreground effects.
 */
export class BossRenderer {
  // ==========================================================================
  // RENDERING: GROUND TELEGRAPHS & FOREGROUND ACTIVE EFFECTS
  // ==========================================================================

  /**
   * Renders crisp pastel telegraph rings, warning lanes, concentric safe-zones,
   * and beam previews underneath enemies and the player.
   */
  public renderGroundTelegraphs(
    ctx: CanvasRenderingContext2D,
    enemies: readonly EnemyEntity[],
    getRuntime: (enemyId: number) => Readonly<BossRuntime> | undefined,
    toScreen: WorldToScreenFn
  ): void {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive || !e.isBoss) continue;
      const rt = getRuntime(e.id);
      if (!rt || !rt.currentAttack) continue;

      const atkId = rt.currentAttack.id;

      // Render King Mochi's landing circle during both telegraph and mid-air leap!
      if (atkId === 'mochi_leap_slam' && (rt.state === 'telegraph' || rt.state === 'execute')) {
        const progress =
          rt.state === 'telegraph'
            ? Math.min(1, rt.stateElapsed / Math.max(0.01, rt.stateDuration))
            : 1;
        this.drawCircleTelegraph(
          ctx,
          toScreen,
          rt.data.targetX,
          rt.data.targetY,
          rt.data.radius,
          progress,
          PALETTE.coral,
          rt.state === 'execute'
        );
        continue;
      }

      if (rt.state !== 'telegraph') continue;
      const progress = Math.min(1, rt.stateElapsed / Math.max(0.01, rt.stateDuration));

      switch (atkId) {
        case 'mochi_syrup_burst': {
          this.drawRadialBurstTelegraph(
            ctx,
            toScreen,
            e.x,
            e.y,
            12,
            rt.data.baseAngle,
            rt.data.radius,
            progress,
            PALETTE.coral
          );
          break;
        }

        case 'mochi_summon_adds': {
          for (let s = 0; s < rt.data.summonSpots.length; s++) {
            const spot = rt.data.summonSpots[s];
            this.drawCircleTelegraph(ctx, toScreen, spot.x, spot.y, 20, progress, PALETTE.rose, false);
          }
          break;
        }

        case 'wisteria_petal_spiral': {
          this.drawRadialBurstTelegraph(
            ctx,
            toScreen,
            e.x,
            e.y,
            3 + Math.min(2, rt.cycle) + (rt.enraged ? 1 : 0),
            rt.data.baseAngle + progress * 0.9 * rt.data.rotDir,
            rt.data.radius,
            progress,
            PALETTE.lavender
          );
          break;
        }

        case 'wisteria_bloom_beam': {
          this.drawBeamTelegraphs(
            ctx,
            toScreen,
            e.x,
            e.y,
            rt.data.beamAngles,
            rt.data.beamLength,
            rt.data.beamHalfWidth,
            progress,
            PALETTE.lavender,
            0
          );
          break;
        }

        case 'wisteria_blink_dash': {
          this.drawLaneTelegraph(
            ctx,
            toScreen,
            rt.data.startX,
            rt.data.startY,
            rt.data.baseAngle,
            rt.data.laneLength,
            rt.data.halfWidth,
            progress,
            PALETTE.lavender
          );
          break;
        }

        case 'aegis_lance_charge': {
          this.drawLaneTelegraph(
            ctx,
            toScreen,
            rt.data.startX,
            rt.data.startY,
            rt.data.baseAngle,
            rt.data.laneLength,
            rt.data.halfWidth,
            progress,
            PALETTE.babyBlue
          );
          break;
        }

        case 'aegis_prism_cross': {
          this.drawBeamTelegraphs(
            ctx,
            toScreen,
            e.x,
            e.y,
            rt.data.beamAngles,
            rt.data.beamLength,
            rt.data.beamHalfWidth,
            progress,
            PALETTE.babyBlue,
            rt.data.rotDir
          );
          break;
        }

        case 'aegis_bastion_nova': {
          this.drawConcentricSafeZoneTelegraph(
            ctx,
            toScreen,
            e.x,
            e.y,
            rt.data.innerDangerRadius,
            rt.data.outerSafeRadius,
            rt.data.outerDangerRadius,
            progress
          );
          break;
        }
      }
    }
  }

  /**
   * Renders active foreground boss effects (ignited Dusk Ray beams, rotating Porcelain Prism beams).
   */
  public renderForegroundEffects(
    ctx: CanvasRenderingContext2D,
    enemies: readonly EnemyEntity[],
    getRuntime: (enemyId: number) => Readonly<BossRuntime> | undefined,
    toScreen: WorldToScreenFn
  ): void {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      if (!e.alive || !e.isBoss) continue;
      const rt = getRuntime(e.id);
      if (!rt || rt.state !== 'execute' || !rt.currentAttack) continue;

      const atkId = rt.currentAttack.id;
      if (atkId === 'wisteria_bloom_beam' || atkId === 'aegis_prism_cross') {
        const progress = Math.min(1, rt.stateElapsed / Math.max(0.01, rt.stateDuration));
        const fade = progress > 0.85 ? (1 - progress) / 0.15 : 1;
        const accent = atkId === 'wisteria_bloom_beam' ? PALETTE.lavender : PALETTE.babyBlue;
        const core = atkId === 'wisteria_bloom_beam' ? PALETTE.lavenderLight : PALETTE.babyBlueLight;
        this.drawActiveBeams(
          ctx,
          toScreen,
          e.x,
          e.y,
          rt.data.beamAngles,
          rt.data.beamLength,
          rt.data.beamHalfWidth,
          accent,
          core,
          fade,
          rt.stateElapsed
        );
      }
    }
  }

  // ==========================================================================
  // PASTEL TELEGRAPH & BEAM DRAWING PRIMITIVES
  // ==========================================================================

  private drawCircleTelegraph(
    ctx: CanvasRenderingContext2D,
    toScreen: WorldToScreenFn,
    wx: number,
    wy: number,
    radius: number,
    progress: number,
    accent: string,
    imminent: boolean
  ): void {
    const s = toScreen(wx, wy);
    ctx.save();

    // Soft danger fill
    ctx.globalAlpha = imminent ? 0.34 : 0.16 + progress * 0.16;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.fill();

    // Expanding inner countdown fill
    ctx.globalAlpha = 0.28 + progress * 0.22;
    ctx.fillStyle = PALETTE.coral;
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(4, radius * progress), 0, Math.PI * 2);
    ctx.fill();

    // Crisp dashed dark-plum outline
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = PALETTE.outline;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 5]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Inner bright ring
    ctx.setLineDash([]);
    ctx.strokeStyle = PALETTE.cream;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, Math.max(4, radius * progress), 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  private drawRadialBurstTelegraph(
    ctx: CanvasRenderingContext2D,
    toScreen: WorldToScreenFn,
    wx: number,
    wy: number,
    rayCount: number,
    startAngle: number,
    radius: number,
    progress: number,
    accent: string
  ): void {
    const s = toScreen(wx, wy);
    ctx.save();

    // Soft pulsing aura circle
    ctx.globalAlpha = 0.18 + progress * 0.16;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius * (0.65 + 0.35 * progress), 0, Math.PI * 2);
    ctx.fill();

    // Outer dashed boundary
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = PALETTE.outline;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Directional shot preview ticks
    ctx.strokeStyle = PALETTE.cream;
    ctx.lineWidth = 2.5;
    for (let i = 0; i < rayCount; i++) {
      const a = startAngle + (Math.PI * 2 * i) / rayCount;
      const r0 = 26;
      const r1 = 26 + (radius - 22) * progress;
      ctx.beginPath();
      ctx.moveTo(s.x + Math.cos(a) * r0, s.y + Math.sin(a) * r0);
      ctx.lineTo(s.x + Math.cos(a) * r1, s.y + Math.sin(a) * r1);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawLaneTelegraph(
    ctx: CanvasRenderingContext2D,
    toScreen: WorldToScreenFn,
    startX: number,
    startY: number,
    angle: number,
    length: number,
    halfWidth: number,
    progress: number,
    accent: string
  ): void {
    const s = toScreen(startX, startY);
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.rotate(angle);

    // Outer warning corridor
    ctx.globalAlpha = 0.18 + progress * 0.16;
    ctx.fillStyle = accent;
    ctx.fillRect(0, -halfWidth, length, halfWidth * 2);

    // Inner advancing fill bar
    ctx.globalAlpha = 0.28 + progress * 0.2;
    ctx.fillStyle = PALETTE.coral;
    ctx.fillRect(0, -halfWidth * 0.82, length * progress, halfWidth * 1.64);

    // Crisp dashed corridor border
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = PALETTE.outline;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(0, -halfWidth, length, halfWidth * 2);
    ctx.setLineDash([]);

    // Directional chevrons showing rush direction
    ctx.strokeStyle = PALETTE.cream;
    ctx.lineWidth = 2.5;
    const spacing = 56;
    const shift = (progress * spacing * 2) % spacing;
    for (let x = shift + 20; x < length - 20; x += spacing) {
      ctx.beginPath();
      ctx.moveTo(x - 10, -halfWidth * 0.45);
      ctx.lineTo(x + 4, 0);
      ctx.lineTo(x - 10, halfWidth * 0.45);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawBeamTelegraphs(
    ctx: CanvasRenderingContext2D,
    toScreen: WorldToScreenFn,
    originX: number,
    originY: number,
    angles: readonly number[],
    length: number,
    halfWidth: number,
    progress: number,
    accent: string,
    rotDir: number
  ): void {
    const s = toScreen(originX, originY);
    ctx.save();

    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(a);

      // Soft corridor
      ctx.globalAlpha = 0.18 + progress * 0.18;
      ctx.fillStyle = accent;
      ctx.fillRect(0, -halfWidth, length, halfWidth * 2);

      // Tightening center ignition line
      const innerH = Math.max(2, halfWidth * 2 * (1 - progress * 0.72));
      ctx.globalAlpha = 0.45 + progress * 0.45;
      ctx.fillStyle = PALETTE.cream;
      ctx.fillRect(0, -innerH * 0.5, length, innerH);

      // Dashed edges
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(0, -halfWidth, length, halfWidth * 2);
      ctx.setLineDash([]);

      ctx.restore();
    }

    // Rotation direction indicator arc for Aegis's Porcelain Prism
    if (rotDir !== 0) {
      const arcR = 72;
      ctx.globalAlpha = 0.82;
      ctx.strokeStyle = PALETTE.outline;
      ctx.lineWidth = 3;
      const startA = -Math.PI * 0.5;
      const endA = startA + rotDir * Math.PI * 0.65;
      ctx.beginPath();
      ctx.arc(s.x, s.y, arcR, startA, endA, rotDir < 0);
      ctx.stroke();

      // Arrowhead tip on the rotation arc
      const tipX = s.x + Math.cos(endA) * arcR;
      const tipY = s.y + Math.sin(endA) * arcR;
      const tan = endA + (rotDir > 0 ? Math.PI * 0.5 : -Math.PI * 0.5);
      ctx.fillStyle = PALETTE.cream;
      ctx.beginPath();
      ctx.moveTo(tipX + Math.cos(tan) * 9, tipY + Math.sin(tan) * 9);
      ctx.lineTo(tipX + Math.cos(tan + 2.3) * 7, tipY + Math.sin(tan + 2.3) * 7);
      ctx.lineTo(tipX + Math.cos(tan - 2.3) * 7, tipY + Math.sin(tan - 2.3) * 7);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawConcentricSafeZoneTelegraph(
    ctx: CanvasRenderingContext2D,
    toScreen: WorldToScreenFn,
    wx: number,
    wy: number,
    innerDanger: number,
    outerSafe: number,
    outerDanger: number,
    progress: number
  ): void {
    const s = toScreen(wx, wy);
    ctx.save();

    // Outer danger donut (outerSafe -> outerDanger)
    ctx.globalAlpha = 0.18 + progress * 0.22;
    ctx.fillStyle = PALETTE.coral;
    ctx.beginPath();
    ctx.arc(s.x, s.y, outerDanger, 0, Math.PI * 2);
    ctx.arc(s.x, s.y, outerSafe, 0, Math.PI * 2, true);
    ctx.fill();

    // Inner danger circle (0 -> innerDanger)
    ctx.beginPath();
    ctx.arc(s.x, s.y, innerDanger, 0, Math.PI * 2);
    ctx.fill();

    // Subtle mint highlight inside the SAFE donut so players spot it instantly
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = PALETTE.mint;
    ctx.beginPath();
    ctx.arc(s.x, s.y, outerSafe, 0, Math.PI * 2);
    ctx.arc(s.x, s.y, innerDanger, 0, Math.PI * 2, true);
    ctx.fill();

    // Crisp outlines for all 3 rings
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = PALETTE.outline;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 5]);
    for (const r of [innerDanger, outerSafe, outerDanger]) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Expanding countdown pulse ring
    ctx.strokeStyle = PALETTE.cream;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(s.x, s.y, innerDanger * progress, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(s.x, s.y, outerSafe + (outerDanger - outerSafe) * progress, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  private drawActiveBeams(
    ctx: CanvasRenderingContext2D,
    toScreen: WorldToScreenFn,
    originX: number,
    originY: number,
    angles: readonly number[],
    length: number,
    halfWidth: number,
    accent: string,
    core: string,
    fade: number,
    elapsed: number
  ): void {
    const s = toScreen(originX, originY);
    const pulse = 1 + Math.sin(elapsed * 32) * 0.08;
    const hw = halfWidth * pulse * fade;

    ctx.save();
    for (let i = 0; i < angles.length; i++) {
      const a = angles[i];
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(a);

      // Dark plum crisp outer rim
      ctx.globalAlpha = 0.78 * fade;
      ctx.fillStyle = PALETTE.outline;
      ctx.fillRect(0, -(hw + 3), length, (hw + 3) * 2);

      // Saturated pastel glow body
      ctx.globalAlpha = 0.92 * fade;
      ctx.fillStyle = accent;
      ctx.fillRect(0, -hw, length, hw * 2);

      // Soft inner light band
      ctx.fillStyle = core;
      ctx.fillRect(0, -hw * 0.58, length, hw * 1.16);

      // Bright cream laser core
      ctx.fillStyle = PALETTE.white;
      ctx.fillRect(0, -hw * 0.25, length, hw * 0.5);

      ctx.restore();
    }

    // Center focal orb
    ctx.globalAlpha = 0.95 * fade;
    ctx.fillStyle = PALETTE.outline;
    ctx.beginPath();
    ctx.arc(s.x, s.y, hw * 1.2 + 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.arc(s.x, s.y, hw * 1.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PALETTE.white;
    ctx.beginPath();
    ctx.arc(s.x, s.y, hw * 0.55, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }
}
