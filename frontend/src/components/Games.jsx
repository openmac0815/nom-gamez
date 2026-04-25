import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * Games Component - Lists available games with their status
 * @param {object} props - Component props
 * @param {object|null} props.wallet - Connected wallet
 */
export default function Games({ wallet }) {
  const [games, setGames] = useState([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    // Fetch games from backend API
    const fetchGames = async () => {
      try {
        const response = await fetch('http://localhost:3001/api/games');
        const data = await response.json();
        setGames(data);
      } catch (error) {
        console.error('Failed to fetch games:', error);
        // Mock data for development
        setGames([
          {
            id: 'dice',
            name: 'Dice Roll',
            description: 'Simple dice roll game with adjustable win chance',
            active: true,
            minBet: 0.1,
            maxBet: 10,
          },
          {
            id: 'slots',
            name: 'Slots',
            description: 'Classic slot machine with crypto payouts',
            active: true,
            minBet: 0.1,
            maxBet: 5,
          },
          {
            id: 'shooter',
            name: 'Space Shooter',
            description: 'Provably fair space shooter - survive 5 waves',
            active: true,
            minBet: 0.1,
            maxBet: 10,
          },
        ]);
      } finally {
        setLoading(false);
      }
    };

    fetchGames();
  }, []);

  const handlePlayGame = (gameId) => {
    if (!wallet) {
      alert('Please connect your wallet first!');
      return;
    }
    if (gameId === 'shooter') {
      navigate('/games/shooter');
    } else {
      alert(`Playing ${gameId} - feature coming soon!`);
    }
  };

  if (loading) {
    return <div className="loading">Loading games...</div>;
  }

  return (
    <div className="games-container">
      <h1>Available Games</h1>
      <div className="games-grid">
        {games.map((game) => (
          <div key={game.id} className={`game-card ${!game.active ? 'disabled' : ''}`}>
            <h3>{game.name}</h3>
            <p>{game.description}</p>
            <div className="game-details">
              <span>Bet: {game.minBet} - {game.maxBet} ZNN</span>
              <span className={game.active ? 'status-active' : 'status-inactive'}>
                {game.active ? 'Active' : 'Disabled'}
              </span>
            </div>
            <button
              className="btn-play"
              disabled={!game.active}
              onClick={() => handlePlayGame(game.id)}
            >
              {game.active ? 'Play Now' : 'Coming Soon'}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
