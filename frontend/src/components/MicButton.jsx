import { memo } from 'react';

function MicButton({ isActive, onClick, disabled }) {
  return (
    <button className={`mic-button ${isActive ? 'mic-button--active' : ''}`} onClick={onClick} disabled={disabled}>
      <span className="mic-button__icon">{isActive ? '■' : '●'}</span>
      <span className="mic-button__label">{isActive ? 'Stop Conversation' : 'Start Conversation'}</span>
      {isActive && <span className="mic-button__pulse" />}
    </button>
  );
}

export default memo(MicButton);
