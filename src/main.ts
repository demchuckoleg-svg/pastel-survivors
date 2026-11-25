import './style.css';
import { GameEngine } from './engine/game';
import { UIManager } from './ui/uiManager';

function bootstrap(): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  const uiRoot = document.getElementById('ui-root');
  if (!canvas || !uiRoot) return;

  let ui: UIManager | null = null;

  const game = new GameEngine(canvas, {
    onStateChange: (state) => ui?.handleStateChange(state),
    onAimModeChange: (mode) => ui?.handleAimModeChange(mode),
    onLevelUp: (choices) => ui?.handleLevelUp(choices),
    onBossChestCollected: (choices) => ui?.handleBossChestCollected(choices),
    onGameOver: (summary) => ui?.handleGameOver(summary),
  });

  ui = new UIManager(uiRoot, game);
  game.start();
}

bootstrap();
