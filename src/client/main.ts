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
    onCoopConnectionChange: (conn) => ui?.handleCoopConnectionChange(conn),
    onCoopRoomState: (roomState) => ui?.handleCoopRoomState(roomState),
    onCoopUpgradeChoices: (upgrade) => ui?.handleCoopUpgradeChoices(upgrade),
    onCoopPauseToggle: (open) => ui?.handleCoopPauseToggle(open),
    onCoopMatchEnd: (summary) => ui?.handleCoopMatchEnd(summary),
    onCoopError: (code, message) => ui?.handleCoopError(code, message),
    onCoopReconnectFailed: (reason) => ui?.handleCoopReconnectFailed(reason),
  });

  ui = new UIManager(uiRoot, game);
  game.start();
}

bootstrap();
