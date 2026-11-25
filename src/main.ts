import './style.css';
import { GameEngine } from './engine/game';

function bootstrap(): void {
  const canvas = document.getElementById('game-canvas') as HTMLCanvasElement | null;
  if (!canvas) return;

  const game = new GameEngine(canvas);
  game.startRun('mage');
  game.start();
}

bootstrap();
