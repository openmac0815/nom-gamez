import { useState, useEffect } from 'react';

/**
 * TreasuryDashboard Component - Admin UI for liability/balance visualization
 * @param {object} props - Component props
 * @param {object|null} props.wallet - Connected wallet (must be admin)
 */
export default function TreasuryDashboard({ wallet }) {
  const [treasuryData, setTreasuryData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!wallet || wallet.address !== process.env.REACT_APP_ADMIN_ADDRESS) {
      setError('Admin access only');
      setLoading(false);
      return;
    }

    const fetchTreasuryData = async () => {
      try {
        const response = await fetch('http://localhost:3001/admin/treasury', {
          headers: {
            'Authorization': `Bearer ${process.env.REACT_APP_ADMIN_TOKEN}`,
          },
        });
        const data = await response.json();
        setTreasuryData(data);
      } catch (err) {
        setError('Failed to fetch treasury data: ' + err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchTreasuryData();
  }, [wallet]);

  if (loading) return <div className="loading">Loading treasury data...</div>;
  if (error) return <div className="error">{error}</div>;
  if (!treasuryData) return <div className="no-data">No treasury data available</div>;

  return (
    <div className="treasury-dashboard">
      <h1>Treasury Dashboard</h1>
      
      <div className="treasury-cards">
        <div className="treasury-card">
          <h3>ZNN Balance</h3>
          <p className="balance">{treasuryData.znnBalance?.toFixed(2) || '0.00'} ZNN</p>
        </div>

        <div className="treasury-card">
          <h3>BTC Balance</h3>
          <p className="balance">{treasuryData.btcBalance?.toFixed(8) || '0.00000000'} BTC</p>
        </div>

        <div className="treasury-card">
          <h3>Pending Liabilities</h3>
          <p className="balance">{treasuryData.pendingLiability?.toFixed(2) || '0.00'} ZNN</p>
        </div>

        <div className="treasury-card">
          <h3>Reserve Ratio</h3>
          <p className="balance">{treasuryData.reserveRatio?.toFixed(2) || '0.00'}%</p>
        </div>
      </div>

      <div className="treasury-details">
        <h2>Recent Transactions</h2>
        <table className="treasury-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Amount</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {treasuryData.recentTransactions?.map((tx, i) => (
              <tr key={i}>
                <td>{new Date(tx.timestamp).toLocaleString()}</td>
                <td>{tx.type}</td>
                <td>{tx.amount} {tx.asset}</td>
                <td>{tx.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
