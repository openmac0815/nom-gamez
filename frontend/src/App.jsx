import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import { useState, useEffect } from 'react';
import Games from './components/Games';
import Markets from './components/Markets';
import Wallet from './components/Wallet';
import ShooterGame from './components/ShooterGame';
import './index.css';

function App() {
  const [wallet, setWallet] = useState(null);
  const [balance, setBalance] = useState(null);

  // Check for existing wallet connection on mount
  useEffect(() => {
    const savedWallet = localStorage.getItem('nom-gamez-wallet');
    if (savedWallet) {
      setWallet(JSON.parse(savedWallet));
    }
  }, []);

  const connectZenonWallet = async () => {
    try {
      // Mock Zenon wallet connection (replace with actual SDK when available)
      const mockWallet = {
        type: 'zenon',
        address: 'z1' + Math.random().toString(36).substring(2, 15),
        balance: 0,
      };
      setWallet(mockWallet);
      localStorage.setItem('nom-gamez-wallet', JSON.stringify(mockWallet));
    } catch (error) {
      console.error('Failed to connect Zenon wallet:', error);
    }
  };

  const connectBTCWallet = async () => {
    try {
      // Mock BTC wallet connection (replace with actual BTC wallet adapter)
      const mockWallet = {
        type: 'btc',
        address: 'bc1' + Math.random().toString(36).substring(2, 15),
        balance: 0,
      };
      setWallet(mockWallet);
      localStorage.setItem('nom-gamez-wallet', JSON.stringify(mockWallet));
    } catch (error) {
      console.error('Failed to connect BTC wallet:', error);
    }
  };

  const disconnectWallet = () => {
    setWallet(null);
    localStorage.removeItem('nom-gamez-wallet');
  };

  return (
    <Router>
      <div className="app">
        {/* Header */}
        <header className="app-header">
          <div className="header-content">
            <NavLink to="/" className="logo">
              🎰 NOM-GAMEZ
            </NavLink>
            
            <nav className="main-nav">
              <NavLink to="/games" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
                Games
              </NavLink>
              <NavLink to="/markets" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>
                Markets
              </NavLink>
            </nav>

            <Wallet 
              wallet={wallet}
              onConnectZenon={connectZenonWallet}
              onConnectBTC={connectBTCWallet}
              onDisconnect={disconnectWallet}
            />
          </div>
        </header>

        {/* Main Content */}
        <main className="app-main">
          <Routes>
            <Route path="/" element={<Games wallet={wallet} />} />
            <Route path="/games" element={<Games wallet={wallet} />} />
            <Route path="/games/shooter" element={<ShooterGame wallet={wallet} />} />
            <Route path="/markets" element={<Markets wallet={wallet} />} />
          </Routes>
        </main>

        {/* Footer */}
        <footer className="app-footer">
          <p>© {new Date().getFullYear()} NOM-GAMEZ — Provably Fair Crypto Gaming</p>
        </footer>
      </div>
    </Router>
  );
}

export default App;
