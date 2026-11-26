import { PALETTE } from '@shared/data/palette';
import type { AbilityRenderState } from '@shared/sim/types';
import { drawPixelSprite, type SpriteAtlas } from '../../art/sprites';

/**
 * Client-only Canvas 2D renderer for AbilityRunner combat effects
 * (ground layer + foreground layer).
 */
export class AbilityRenderer {
  // ==========================================================================
  // RENDERING (GROUND LAYER + FOREGROUND LAYER)
  // ==========================================================================

  /**
   * Renders ground-level combat telegraphs, craters, nova waves, turrets, and damage trails.
   */
  public renderGroundLayer(
    state: AbilityRenderState,
    ctx2d: CanvasRenderingContext2D,
    worldToScreen: (wx: number, wy: number) => { x: number; y: number },
    sprites: SpriteAtlas
  ): void {
    // 1. Expanding Novas
    for (let i = 0; i < state.novas.length; i++) {
      const n = state.novas[i];
      const pos = worldToScreen(n.x, n.y);
      const alpha = Math.max(0, 1 - n.age / n.maxLife);

      ctx2d.save();
      ctx2d.globalAlpha = alpha * 0.34;
      ctx2d.fillStyle = n.color;
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, n.currentRadius, 0, Math.PI * 2);
      ctx2d.fill();

      ctx2d.globalAlpha = alpha * 0.92;
      ctx2d.strokeStyle = n.ringColor;
      ctx2d.lineWidth = 4;
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, n.currentRadius, 0, Math.PI * 2);
      ctx2d.stroke();

      ctx2d.strokeStyle = PALETTE.outline;
      ctx2d.lineWidth = 1.5;
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, n.currentRadius + 2, 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.restore();
    }

    // 2. Ground Trails & Afterimages
    for (let i = 0; i < state.trails.length; i++) {
      const tr = state.trails[i];
      const alpha = Math.max(0, 1 - tr.age / tr.maxLife);
      const s1 = worldToScreen(tr.x, tr.y);

      ctx2d.save();
      if (tr.kind === 'afterimage' && tr.heroId) {
        ctx2d.globalAlpha = alpha * 0.55;
        drawPixelSprite(
          ctx2d,
          sprites.heroes[tr.heroId][0],
          s1.x,
          s1.y,
          3,
          Boolean(tr.facingLeft),
          true
        );
      } else {
        const s2 = worldToScreen(tr.x2, tr.y2);
        ctx2d.globalAlpha = alpha * 0.65;
        ctx2d.strokeStyle = tr.color;
        ctx2d.lineCap = 'round';
        ctx2d.lineWidth = tr.radius * 1.4;
        ctx2d.beginPath();
        ctx2d.moveTo(s1.x, s1.y);
        ctx2d.lineTo(s2.x, s2.y);
        ctx2d.stroke();

        ctx2d.globalAlpha = alpha * 0.9;
        ctx2d.strokeStyle = PALETTE.white;
        ctx2d.lineWidth = Math.max(2, tr.radius * 0.45);
        ctx2d.stroke();
      }
      ctx2d.restore();
    }

    // 3. Strikes & Rain Telegraphs / Ground Craters
    for (let i = 0; i < state.strikes.length; i++) {
      const s = state.strikes[i];
      const pos = worldToScreen(s.x, s.y);

      ctx2d.save();
      if (!s.impacted) {
        const progress = Math.min(1, s.elapsed / Math.max(0.01, s.delay));
        // Soft pastel telegraph ring
        ctx2d.globalAlpha = 0.25 + progress * 0.25;
        ctx2d.fillStyle = s.color;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, s.radius * progress, 0, Math.PI * 2);
        ctx2d.fill();

        ctx2d.globalAlpha = 0.78;
        ctx2d.strokeStyle = s.color;
        ctx2d.lineWidth = 2;
        ctx2d.setLineDash([5, 4]);
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, s.radius, 0, Math.PI * 2);
        ctx2d.stroke();
        ctx2d.setLineDash([]);
      } else {
        const lingerAlpha = Math.max(0, 1 - (s.elapsed - s.delay) / Math.max(0.01, s.lingerTime));
        ctx2d.globalAlpha = lingerAlpha * 0.42;
        ctx2d.fillStyle = s.color;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, s.radius, 0, Math.PI * 2);
        ctx2d.fill();

        ctx2d.globalAlpha = lingerAlpha * 0.9;
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, s.radius, 0, Math.PI * 2);
        ctx2d.stroke();
      }
      ctx2d.restore();
    }

    // 4. Deployed Turrets
    for (let i = 0; i < state.turrets.length; i++) {
      const t = state.turrets[i];
      const pos = worldToScreen(t.x, t.y);
      const lifeRatio = Math.max(0, 1 - t.age / t.maxLife);

      ctx2d.save();
      // Shadow
      ctx2d.fillStyle = PALETTE.shadow;
      ctx2d.beginPath();
      ctx2d.ellipse(pos.x, pos.y + 11, 13, 5, 0, 0, Math.PI * 2);
      ctx2d.fill();

      // Base chassis
      ctx2d.fillStyle = t.isArtillery ? PALETTE.mintDark : PALETTE.sage;
      ctx2d.strokeStyle = PALETTE.outline;
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, t.isArtillery ? 12 : 10, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.stroke();

      // Rotating barrel(s)
      ctx2d.translate(pos.x, pos.y);
      ctx2d.rotate(t.angle);
      ctx2d.fillStyle = PALETTE.cream;
      if (t.isArtillery) {
        ctx2d.fillRect(2, -6, 15, 4);
        ctx2d.strokeRect(2, -6, 15, 4);
        ctx2d.fillRect(2, 2, 15, 4);
        ctx2d.strokeRect(2, 2, 15, 4);
      } else {
        ctx2d.fillRect(2, -3, 14, 6);
        ctx2d.strokeRect(2, -3, 14, 6);
      }
      ctx2d.restore();

      // Tiny lifetime bar under turret
      const bw = 24;
      const bx = Math.round(pos.x - bw / 2);
      const by = Math.round(pos.y + 15);
      ctx2d.fillStyle = PALETTE.outline;
      ctx2d.fillRect(bx - 1, by - 1, bw + 2, 5);
      ctx2d.fillStyle = PALETTE.creamDark;
      ctx2d.fillRect(bx, by, bw, 3);
      ctx2d.fillStyle = t.isArtillery ? PALETTE.mint : PALETTE.butter;
      ctx2d.fillRect(bx, by, Math.round(bw * lifeRatio), 3);
    }

    // 5. Lingering Alchemist Zones (Healing Mist, Acid Pool, Gravity Vortex, Sanctuary Choir, Caustic Singularity)
    for (let i = 0; i < state.zones.length; i++) {
      const z = state.zones[i];
      const pos = worldToScreen(z.x, z.y);
      const fadeIn = Math.min(1, z.age / 0.2);
      const fadeOut = Math.min(1, (z.maxLife - z.age) / 0.35);
      const alpha = Math.max(0, Math.min(fadeIn, fadeOut));
      const pulse = 1 + Math.sin(z.age * 5.2 + i) * 0.04;
      const r = z.radius * pulse;

      ctx2d.save();
      // Soft pastel cloud / pool body
      ctx2d.globalAlpha = alpha * (z.visualKind === 'healing_mist' || z.visualKind === 'sanctuary_choir' ? 0.24 : 0.28);
      ctx2d.fillStyle = z.color;
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx2d.fill();

      // Inner swirling or bubbling ring
      if (z.visualKind === 'gravity_vortex' || z.visualKind === 'caustic_singularity') {
        ctx2d.globalAlpha = alpha * 0.65;
        ctx2d.strokeStyle = z.ringColor;
        ctx2d.lineWidth = 2.5;
        const spin = z.age * 3.8;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, r * 0.62, spin, spin + Math.PI * 1.25);
        ctx2d.stroke();
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, r * 0.32, -spin * 1.4, -spin * 1.4 + Math.PI * 1.25);
        ctx2d.stroke();
      } else {
        ctx2d.globalAlpha = alpha * 0.45;
        ctx2d.fillStyle = z.ringColor;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, r * 0.55, 0, Math.PI * 2);
        ctx2d.fill();
      }

      // Crisp pastel dashed boundary
      ctx2d.globalAlpha = alpha * 0.82;
      ctx2d.strokeStyle = z.ringColor;
      ctx2d.lineWidth = 2.5;
      ctx2d.setLineDash([7, 5]);
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.setLineDash([]);
      ctx2d.restore();
    }

    // 6. Deployed Alchemist Totems (Revive Totem & Aegis Lantern)
    for (let i = 0; i < state.totems.length; i++) {
      const t = state.totems[i];
      const pos = worldToScreen(t.x, t.y);
      const lifeRatio = Math.max(0, 1 - t.age / t.maxLife);
      const pulse = 1 + Math.sin(t.age * 4.5) * 0.04;

      ctx2d.save();
      // Support / Revive aura ring
      ctx2d.globalAlpha = 0.14;
      ctx2d.fillStyle = t.isAegisLantern ? PALETTE.butter : PALETTE.mintLight;
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, t.radius * pulse, 0, Math.PI * 2);
      ctx2d.fill();

      ctx2d.globalAlpha = 0.72;
      ctx2d.strokeStyle = t.isAegisLantern ? PALETTE.butter : PALETTE.mint;
      ctx2d.lineWidth = 2;
      ctx2d.setLineDash([6, 4]);
      ctx2d.beginPath();
      ctx2d.arc(pos.x, pos.y, t.radius * pulse, 0, Math.PI * 2);
      ctx2d.stroke();
      ctx2d.setLineDash([]);

      // Shadow
      ctx2d.globalAlpha = 1;
      ctx2d.fillStyle = PALETTE.shadow;
      ctx2d.beginPath();
      ctx2d.ellipse(pos.x, pos.y + 12, 11, 4.5, 0, 0, Math.PI * 2);
      ctx2d.fill();

      // Pastel Lantern body
      ctx2d.fillStyle = t.isAegisLantern ? PALETTE.butter : PALETTE.mint;
      ctx2d.strokeStyle = PALETTE.outline;
      ctx2d.lineWidth = 2;
      ctx2d.fillRect(pos.x - 7, pos.y - 10, 14, 18);
      ctx2d.strokeRect(pos.x - 7, pos.y - 10, 14, 18);

      // Glowing core
      ctx2d.fillStyle = PALETTE.white;
      ctx2d.fillRect(pos.x - 3, pos.y - 6, 6, 10);

      // Lantern cap
      ctx2d.fillStyle = PALETTE.butterDark;
      ctx2d.fillRect(pos.x - 9, pos.y - 13, 18, 4);
      ctx2d.strokeRect(pos.x - 9, pos.y - 13, 18, 4);

      // Lifetime bar
      const bw = 24;
      const bx = Math.round(pos.x - bw / 2);
      const by = Math.round(pos.y + 15);
      ctx2d.fillStyle = PALETTE.outline;
      ctx2d.fillRect(bx - 1, by - 1, bw + 2, 5);
      ctx2d.fillStyle = PALETTE.creamDark;
      ctx2d.fillRect(bx, by, bw, 3);
      ctx2d.fillStyle = t.isAegisLantern ? PALETTE.butter : PALETTE.mint;
      ctx2d.fillRect(bx, by, Math.round(bw * lifeRatio), 3);
      ctx2d.restore();
    }
  }

  /**
   * Renders foreground combat visuals: melee arcs, beams, lightning chains,
   * orbiting weapons, falling meteors/hammers/arrows, and active projectiles.
   */
  public renderForegroundLayer(
    state: AbilityRenderState,
    ctx2d: CanvasRenderingContext2D,
    playerX: number,
    playerY: number,
    worldToScreen: (wx: number, wy: number) => { x: number; y: number },
    sprites: SpriteAtlas
  ): void {
    const pScreen = worldToScreen(playerX, playerY);

    // 1. Melee Arcs (Greatsword Cleave & Shield Bash)
    for (let i = 0; i < state.meleeArcs.length; i++) {
      const arc = state.meleeArcs[i];
      const progress = Math.min(1, arc.age / arc.maxLife);
      const alpha = Math.max(0, 1 - progress * 0.85);
      const half = arc.arcSpread * 0.5;

      ctx2d.save();
      ctx2d.translate(pScreen.x, pScreen.y);
      ctx2d.globalAlpha = alpha * 0.45;
      ctx2d.fillStyle = arc.color;
      ctx2d.beginPath();
      ctx2d.moveTo(0, 0);
      ctx2d.arc(0, 0, arc.radius, arc.angle - half, arc.angle + half);
      ctx2d.closePath();
      ctx2d.fill();

      // Crisp sweeping rim
      ctx2d.globalAlpha = alpha;
      ctx2d.strokeStyle = PALETTE.cream;
      ctx2d.lineWidth = arc.visualKind === 'shield' ? 9 : 6;
      ctx2d.lineCap = 'round';
      ctx2d.beginPath();
      ctx2d.arc(0, 0, arc.radius - 3, arc.angle - half, arc.angle + half);
      ctx2d.stroke();

      ctx2d.strokeStyle = PALETTE.outline;
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.arc(0, 0, arc.radius + 1, arc.angle - half, arc.angle + half);
      ctx2d.stroke();
      ctx2d.restore();
    }

    // 2. Beams (Plasma Beam, Rail-Bow, Spear Thrust, Tempest Lance, Starlight Railgun)
    for (let i = 0; i < state.beams.length; i++) {
      const b = state.beams[i];
      const alpha = Math.max(0, 1 - (b.age / b.maxLife) * 0.75);
      const s1 = worldToScreen(b.x, b.y);
      const s2 = worldToScreen(
        b.x + Math.cos(b.angle) * b.length,
        b.y + Math.sin(b.angle) * b.length
      );
      const pulseW = b.width * (0.8 + 0.25 * Math.sin(b.age * 40));

      ctx2d.save();
      ctx2d.lineCap = 'round';

      // Outer dark plum outline glow
      ctx2d.globalAlpha = alpha * 0.6;
      ctx2d.strokeStyle = PALETTE.outline;
      ctx2d.lineWidth = pulseW + 4;
      ctx2d.beginPath();
      ctx2d.moveTo(s1.x, s1.y);
      ctx2d.lineTo(s2.x, s2.y);
      ctx2d.stroke();

      // Main pastel beam body
      ctx2d.globalAlpha = alpha * 0.88;
      ctx2d.strokeStyle = b.color;
      ctx2d.lineWidth = pulseW;
      ctx2d.beginPath();
      ctx2d.moveTo(s1.x, s1.y);
      ctx2d.lineTo(s2.x, s2.y);
      ctx2d.stroke();

      // Bright core
      ctx2d.globalAlpha = alpha;
      ctx2d.strokeStyle = b.coreColor;
      ctx2d.lineWidth = Math.max(3, pulseW * 0.38);
      ctx2d.beginPath();
      ctx2d.moveTo(s1.x, s1.y);
      ctx2d.lineTo(s2.x, s2.y);
      ctx2d.stroke();

      // Spear sprite along thrust tip
      if (b.spriteId) {
        const tipFrac = Math.min(1, 0.4 + (b.age / b.maxLife) * 0.6);
        const tx = s1.x + (s2.x - s1.x) * tipFrac;
        const ty = s1.y + (s2.y - s1.y) * tipFrac;
        this.drawRotatedSprite(ctx2d, sprites.projectiles[b.spriteId], tx, ty, b.angle, 2.4);
      }
      ctx2d.restore();
    }

    // 3. Chain Lightning Arcs
    for (let i = 0; i < state.chains.length; i++) {
      const arc = state.chains[i];
      const alpha = Math.max(0, 1 - arc.age / arc.maxLife);

      ctx2d.save();
      ctx2d.lineJoin = 'round';
      ctx2d.lineCap = 'round';
      ctx2d.globalAlpha = alpha;

      for (let pIdx = 0; pIdx < arc.points.length - 1; pIdx++) {
        const a = worldToScreen(arc.points[pIdx].x, arc.points[pIdx].y);
        const b = worldToScreen(arc.points[pIdx + 1].x, arc.points[pIdx + 1].y);
        const midX = (a.x + b.x) * 0.5 + (Math.random() - 0.5) * 18;
        const midY = (a.y + b.y) * 0.5 + (Math.random() - 0.5) * 18;

        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = arc.lineWidth + 3;
        ctx2d.beginPath();
        ctx2d.moveTo(a.x, a.y);
        ctx2d.lineTo(midX, midY);
        ctx2d.lineTo(b.x, b.y);
        ctx2d.stroke();

        ctx2d.strokeStyle = arc.color;
        ctx2d.lineWidth = arc.lineWidth;
        ctx2d.stroke();

        ctx2d.strokeStyle = PALETTE.white;
        ctx2d.lineWidth = 1.4;
        ctx2d.stroke();
      }
      ctx2d.restore();
    }

    // 4. Orbiting Weapons (Arcane Orb, Orbiting Blades, Chain Flail, Eclipse Singularity, Whirlwind Tempest)
    for (let i = 0; i < state.orbiters.length; i++) {
      const orb = state.orbiters[i];
      for (let k = 0; k < orb.count; k++) {
        const a = orb.baseAngle + (k * Math.PI * 2) / orb.count;
        const ix = playerX + Math.cos(a) * orb.orbitRadius;
        const iy = playerY + Math.sin(a) * orb.orbitRadius;
        const pos = worldToScreen(ix, iy);

        ctx2d.save();
        if (orb.visualKind === 'flail') {
          // Chain tether links
          ctx2d.strokeStyle = PALETTE.outline;
          ctx2d.lineWidth = 3;
          ctx2d.setLineDash([4, 4]);
          ctx2d.beginPath();
          ctx2d.moveTo(pScreen.x, pScreen.y);
          ctx2d.lineTo(pos.x, pos.y);
          ctx2d.stroke();
          ctx2d.setLineDash([]);

          // Spiked pastel flail head
          ctx2d.fillStyle = PALETTE.slateLight;
          ctx2d.strokeStyle = PALETTE.outline;
          ctx2d.lineWidth = 2;
          ctx2d.beginPath();
          ctx2d.arc(pos.x, pos.y, orb.itemRadius * 0.72, 0, Math.PI * 2);
          ctx2d.fill();
          ctx2d.stroke();

          ctx2d.fillStyle = PALETTE.cream;
          ctx2d.beginPath();
          ctx2d.arc(pos.x - 3, pos.y - 3, 3.5, 0, Math.PI * 2);
          ctx2d.fill();
        } else if (orb.visualKind === 'blade' || orb.visualKind === 'greatsword') {
          const isGreat = orb.visualKind === 'greatsword';
          const len = isGreat ? 32 : 22;
          const wid = isGreat ? 10 : 7;
          ctx2d.translate(pos.x, pos.y);
          ctx2d.rotate(a + Math.PI / 2);

          // Blade body
          ctx2d.fillStyle = orb.color;
          ctx2d.strokeStyle = PALETTE.outline;
          ctx2d.lineWidth = 2;
          ctx2d.beginPath();
          ctx2d.moveTo(len * 0.65, 0);
          ctx2d.lineTo(-len * 0.35, -wid * 0.5);
          ctx2d.lineTo(-len * 0.55, 0);
          ctx2d.lineTo(-len * 0.35, wid * 0.5);
          ctx2d.closePath();
          ctx2d.fill();
          ctx2d.stroke();

          // Highlight streak
          ctx2d.fillStyle = PALETTE.cream;
          ctx2d.fillRect(-len * 0.2, -1.5, len * 0.65, 3);
        } else if (orb.visualKind === 'ward') {
          // Protective Ward pastel barrier diamond
          ctx2d.fillStyle = 'rgba(252, 244, 210, 0.35)';
          ctx2d.beginPath();
          ctx2d.arc(pos.x, pos.y, orb.itemRadius * 1.15, 0, Math.PI * 2);
          ctx2d.fill();

          ctx2d.fillStyle = PALETTE.butterLight;
          ctx2d.strokeStyle = PALETTE.outline;
          ctx2d.lineWidth = 2;
          ctx2d.beginPath();
          ctx2d.arc(pos.x, pos.y, orb.itemRadius * 0.72, 0, Math.PI * 2);
          ctx2d.fill();
          ctx2d.stroke();

          ctx2d.fillStyle = PALETTE.mint;
          ctx2d.beginPath();
          ctx2d.arc(pos.x, pos.y, orb.itemRadius * 0.35, 0, Math.PI * 2);
          ctx2d.fill();
        } else {
          // Arcane Orb or Eclipse Singularity
          if (orb.visualKind === 'singularity') {
            ctx2d.fillStyle = 'rgba(157, 136, 196, 0.35)';
            ctx2d.beginPath();
            ctx2d.arc(pos.x, pos.y, orb.itemRadius * 1.2, 0, Math.PI * 2);
            ctx2d.fill();
          }
          if (orb.spriteId) {
            this.drawRotatedSprite(
              ctx2d,
              sprites.projectiles[orb.spriteId],
              pos.x,
              pos.y,
              a * 2,
              orb.visualKind === 'singularity' ? 2.5 : 2.1
            );
          } else {
            ctx2d.fillStyle = orb.color;
            ctx2d.strokeStyle = PALETTE.outline;
            ctx2d.lineWidth = 2;
            ctx2d.beginPath();
            ctx2d.arc(pos.x, pos.y, orb.itemRadius * 0.7, 0, Math.PI * 2);
            ctx2d.fill();
            ctx2d.stroke();
          }
        }
        ctx2d.restore();
      }
    }

    // 5. Falling Meteors, Holy Hammers, Arrow Rain & Erupting Earth Spikes
    for (let i = 0; i < state.strikes.length; i++) {
      const s = state.strikes[i];
      const pos = worldToScreen(s.x, s.y);

      ctx2d.save();
      if (!s.impacted) {
        const progress = Math.min(1, s.elapsed / Math.max(0.01, s.delay));
        if (
          s.visualKind === 'meteor' ||
          s.visualKind === 'cataclysm_meteor' ||
          s.visualKind === 'holy_hammer' ||
          s.visualKind === 'divine_hammer'
        ) {
          const dropHeight = (1 - progress) * 240;
          const dropOffsetX =
            s.visualKind === 'meteor' || s.visualKind === 'cataclysm_meteor'
              ? (1 - progress) * 90
              : 0;
          const scale =
            s.visualKind === 'cataclysm_meteor' || s.visualKind === 'divine_hammer' ? 3.2 : 2.4;
          if (s.spriteId) {
            this.drawRotatedSprite(
              ctx2d,
              sprites.projectiles[s.spriteId],
              pos.x + dropOffsetX,
              pos.y - dropHeight,
              s.visualKind.includes('hammer') ? 0 : Math.PI * 0.65,
              scale
            );
          }
        } else if (s.visualKind === 'arrow_rain') {
          const dropHeight = (1 - progress) * 180;
          for (let k = -1; k <= 1; k++) {
            this.drawRotatedSprite(
              ctx2d,
              sprites.projectiles.arrow,
              pos.x + k * 14 + (1 - progress) * 28,
              pos.y - dropHeight + Math.abs(k) * 10,
              Math.PI * 0.55,
              1.65
            );
          }
        }
      } else if (s.visualKind === 'earth_spike' || s.visualKind === 'ground_slam') {
        const lingerRatio = Math.max(
          0,
          1 - (s.elapsed - s.delay) / Math.max(0.01, s.lingerTime)
        );
        ctx2d.globalAlpha = lingerRatio;
        const h = s.radius * 0.85 * Math.min(1, lingerRatio * 2);
        const w = s.radius * 0.42;
        ctx2d.fillStyle = s.color;
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.moveTo(pos.x, pos.y - h);
        ctx2d.lineTo(pos.x + w, pos.y + 6);
        ctx2d.lineTo(pos.x - w, pos.y + 6);
        ctx2d.closePath();
        ctx2d.fill();
        ctx2d.stroke();
      }
      ctx2d.restore();
    }

    // 6. Active Projectiles (Linear, Homing, Boomerang, Ricochet, Dash, Spiral)
    for (let i = 0; i < state.projectiles.length; i++) {
      const proj = state.projectiles[i];
      const pos = worldToScreen(proj.x, proj.y);

      ctx2d.save();

      // Reaper's Pendulum chain tether
      if (proj.tetherToPlayer) {
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 2.5;
        ctx2d.setLineDash([5, 5]);
        ctx2d.beginPath();
        ctx2d.moveTo(pScreen.x, pScreen.y);
        ctx2d.lineTo(pos.x, pos.y);
        ctx2d.stroke();
        ctx2d.setLineDash([]);
      }

      // Firestorm swirling cyclone halo
      if (proj.sourceId === 'firestorm') {
        ctx2d.globalAlpha = 0.32;
        ctx2d.fillStyle = PALETTE.coral;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, proj.radius * 1.25, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.globalAlpha = 0.85;
        ctx2d.strokeStyle = PALETTE.butter;
        ctx2d.lineWidth = 2.5;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, proj.radius, proj.rotation, proj.rotation + Math.PI * 1.4);
        ctx2d.stroke();
        ctx2d.globalAlpha = 1;
      }

      // Wind Blade pastel crescent
      if (proj.sourceId === 'wind_blade') {
        ctx2d.translate(pos.x, pos.y);
        ctx2d.rotate(proj.rotation);
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 6;
        ctx2d.lineCap = 'round';
        ctx2d.beginPath();
        ctx2d.arc(0, 0, proj.radius * 0.78, -1.1, 1.1);
        ctx2d.stroke();

        ctx2d.strokeStyle = PALETTE.mint;
        ctx2d.lineWidth = 3.5;
        ctx2d.stroke();
      } else if (proj.kind === 'dash' && !proj.spriteId) {
        // Blade Dash crescent slash
        ctx2d.translate(pos.x, pos.y);
        ctx2d.rotate(proj.rotation);
        ctx2d.fillStyle = proj.color;
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.ellipse(0, 0, proj.radius * 0.9, proj.radius * 0.42, 0, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.stroke();
      } else if (proj.spriteId) {
        this.drawRotatedSprite(
          ctx2d,
          sprites.projectiles[proj.spriteId],
          pos.x,
          pos.y,
          proj.rotation,
          proj.scale
        );
      } else {
        ctx2d.fillStyle = proj.color;
        ctx2d.strokeStyle = PALETTE.outline;
        ctx2d.lineWidth = 2;
        ctx2d.beginPath();
        ctx2d.arc(pos.x, pos.y, proj.radius, 0, Math.PI * 2);
        ctx2d.fill();
        ctx2d.stroke();
      }

      ctx2d.restore();
    }
  }

  private drawRotatedSprite(
    ctx2d: CanvasRenderingContext2D,
    sprite: HTMLCanvasElement,
    x: number,
    y: number,
    angle: number,
    scale: number
  ): void {
    const w = sprite.width * scale;
    const h = sprite.height * scale;
    ctx2d.save();
    ctx2d.imageSmoothingEnabled = false;
    ctx2d.translate(Math.round(x), Math.round(y));
    ctx2d.rotate(angle);
    ctx2d.drawImage(sprite, Math.round(-w / 2), Math.round(-h / 2), w, h);
    ctx2d.restore();
  }
}
