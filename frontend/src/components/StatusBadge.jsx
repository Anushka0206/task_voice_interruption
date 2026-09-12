import { memo } from 'react';

const STATE_META = {
  idle: { label: 'Idle', color: '#94a3b8' },
  listening: { label: 'Listening', color: '#22c55e' },
  thinking: { label: 'Thinking', color: '#eab308' },
  speaking: { label: 'Speaking', color: '#3b82f6' },
  interrupted: { label: 'Interrupted!', color: '#ef4444' },
};

const CONN_META = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  error: 'Connection error',
};

function StatusBadge({ aiState, connectionState }) {
  const meta = STATE_META[aiState] || STATE_META.idle;
  return (
    <div className="status-badge">
      <div className="status-badge__pill" style={{ '--dot-color': meta.color }}>
        <span className="status-badge__dot" />
        {meta.label}
      </div>
      <div className="status-badge__conn">{CONN_META[connectionState] || connectionState}</div>
    </div>
  );
}

export default memo(StatusBadge);
