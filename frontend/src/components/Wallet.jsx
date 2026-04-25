import { useState } from 'react';

/**
 * Wallet Component - Handles Zenon and BTC wallet connections
 * @param {object} props - Component props
 * @param {object|null} props.wallet - Connected wallet object
 * @param {function} props.onConnectZenon - Zenon wallet connect handler
 * @param {function} props.onConnectBTC - BTC wallet connect handler
 * @param {function} props.onDisconnect - Disconnect handler
 */
export default function Wallet({ wallet, onConnectZenon, onConnectBTC, onDisconnect }) {
  const [showModal, setShowModal] = useState(false);

  const handleConnectZenon = () => {
    onConnectZenon();
    setShowModal(false);
  };

  const handleConnectBTC = () => {
    onConnectBTC();
    setShowModal(false);
  };

  if (wallet) {
    return (
      <div className="wallet-connected">
        <span className="wallet-type">
          {wallet.type === 'zenon' ? '🧿 Zenon' : '₿ BTC'}
        </span>
        <span className="wallet-address">
          {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
        </span>
        <button className="btn-disconnect" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className="wallet-container">
      <button className="btn-connect" onClick={() => setShowModal(true)}>
        Connect Wallet
      </button>

      {showModal && (
        <div className="wallet-modal">
          <div className="wallet-modal-content">
            <h3>Connect Wallet</h3>
            <button className="btn-wallet-option" onClick={handleConnectZenon}>
              🧿 Connect Zenon Wallet
            </button>
            <button className="btn-wallet-option" onClick={handleConnectBTC}>
              ₿ Connect BTC Wallet
            </button>
            <button className="btn-close-modal" onClick={() => setShowModal(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
