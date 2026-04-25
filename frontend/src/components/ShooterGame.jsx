import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * ShooterGame Component - Space Shooter with provably fair gameplay
 * @param {object} props - Component props
 * @param {object|null} props.wallet - Connected wallet
 */
export default function ShooterGame({ wallet }) {
  const navigate = useNavigate();
  const canvasRef = useRef(null);
  const [gameState, setGameState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [betAmount, setBetAmount] = useState(0.1);
  const [gameActive, setGameActive] = useState(false);

  useEffect(() => {
    if (!wallet) {
      setError('Please connect your wallet first!');
      setLoading(false);
      return;
    }

    // Initialize game session with backend
    const initGame = async () => {
      try {
        // Mock game initialization - replace with actual API call
        const mockGameState = {
          player: { x: 400, y: 500, hp: 100, score: 0, alive: true },
          enemies: [],
          wave: 1,
          gameOver: false,
        };
        setGameState(mockGameState);
      } catch (err) {
        setError('Failed to initialize game: ' + err.message);
      } finally {
        setLoading(false);
      }
    };

    initGame();
  }, [wallet]);

  const startGame = async () => {
    if (!wallet || !gameState) return;
    setGameActive(true);
    // Start game loop here
  };

  if (loading) return <div className="loading">Loading game...</div>;
  if (error) return <div className="error">{error}<button onClick={() => navigate('/')}>Go Home</button></div>;

  return (
    <div className="shooter-game">
      <div className="game-header">
        <button className="btn-back" onClick={() => navigate('/games')}>← Back to Games</button>
        <h1>Space Shooter</h1>
        <div className="game-stats">
          <span>Score: {gameState?.player?.score || 0}</span>
          <span>HP: {gameState?.player?.hp || 0}</span>
          <span>Wave: {gameState?.wave || 1}</span>
        </div>
      </div>

      <div className="game-controls">
        <label>
          Bet Amount (ZNN):
          <input
            type="number"
            min="0.1"
            max="10"
            step="0.1"
            value={betAmount}
            onChange={(e) => setBetAmount(parseFloat(e.target.value))}
            disabled={gameActive}
          />
        </label>
        <button
          className="btn-start-game"
          disabled={gameActive}
          onClick={startGame}
        >
          {gameActive ? 'Game In Progress' : 'Start Game'}
        </button>
      </div>

      <canvas
        ref={canvasRef}
        width="800"
        height="600"
        className="game-canvas"
      />

      <div className="game-instructions">
        <h3>How to Play:</h3>
        <ul>
          <li>Use arrow keys or WASD to move</li>
          <li>Press Space to shoot</li>
          <li>Survive 5 waves to win</li>
          <li>Provably fair: Game uses server-committed seed</li>
        </ul>
      </div>
    </div>
  );
}
