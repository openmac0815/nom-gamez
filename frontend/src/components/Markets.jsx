import { useState, useEffect } from 'react';

/**
 * Markets Component - Displays open prediction markets
 * @param {object} props - Component props
 * @param {object|null} props.wallet - Connected wallet
 */
export default function Markets({ wallet }) {
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchMarkets = async () => {
      try {
        const response = await fetch('http://localhost:3001/api/markets/open');
        const data = await response.json();
        setMarkets(data);
      } catch (err) {
        console.error('Failed to fetch markets:', err);
        // Mock data for development
        setMarkets([
          {
            id: 'mkt_123',
            question: 'Will BTC be above $100k by end of 2026?',
            totalPool: 12.5,
            yesPool: 7.5,
            noPool: 5.0,
            resolvesAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
            outcome: null,
          },
          {
            id: 'mkt_456',
            question: 'Will ZNN price increase by 20% in the next 7 days?',
            totalPool: 4.2,
            yesPool: 3.1,
            noPool: 1.1,
            resolvesAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
            outcome: null,
          },
        ]);
      } finally {
        setLoading(false);
      }
    };

    fetchMarkets();
  }, []);

  const handleTakePosition = async (marketId, side) => {
    if (!wallet) {
      alert('Please connect your wallet first!');
      return;
    }
    alert(`Taking ${side.toUpperCase()} position on market ${marketId} - feature coming soon!`);
  };

  if (loading) return <div className="loading">Loading markets...</div>;
  if (error) return <div className="error">{error}</div>;

  return (
    <div className="markets-container">
      <h1>Prediction Markets</h1>
      <p className="markets-intro">
        Bet on real-world events with ZNN. Provably fair settlement.
      </p>

      <div className="markets-grid">
        {markets.map((market) => {
          const yesOdds = market.totalPool > 0 ? (market.yesPool / market.totalPool * 100).toFixed(1) : 50;
          const noOdds = market.totalPool > 0 ? (market.noPool / market.totalPool * 100).toFixed(1) : 50;
          const timeLeft = Math.max(0, market.resolvesAt - Date.now());
          const daysLeft = Math.floor(timeLeft / (24 * 60 * 60 * 1000));

          return (
            <div key={market.id} className="market-card">
              <h3 className="market-question">{market.question}</h3>
              
              <div className="market-pool">
                <span>Pool: {market.totalPool.toFixed(2)} ZNN</span>
                <span>Closes in: {daysLeft}d</span>
              </div>

              <div className="market-odds">
                <div className="odds-yes">
                  <span>YES {yesOdds}%</span>
                </div>
                <div className="odds-no">
                  <span>NO {noOdds}%</span>
                </div>
              </div>

              <div className="market-actions">
                <button
                  className="btn-yes"
                  onClick={() => handleTakePosition(market.id, 'yes')}
                  disabled={!wallet}
                >
                  Bet YES
                </button>
                <button
                  className="btn-no"
                  onClick={() => handleTakePosition(market.id, 'no')}
                  disabled={!wallet}
                >
                  Bet NO
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
