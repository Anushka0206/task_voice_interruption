import { memo, useEffect, useRef } from 'react';

const EVENT_COLORS = {
  USER_STARTED: '#22c55e',
  USER_STOPPED: '#94a3b8',
  AI_STARTED: '#3b82f6',
  USER_INTERRUPTED: '#ef4444',
  AI_RESPONSE_CANCELLED: '#f97316',
  AI_STOPPED: '#a855f7',
  NEW_QUERY_STARTED: '#eab308',
  NEW_RESPONSE_STARTED: '#06b6d4',
  CLIENT_PLAYBACK_STOPPED: '#ef4444',
  WS_DISCONNECTED: '#f87171',
  ERROR: '#f87171',
};

function DebugPanel({ log }) {
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  return (
    <div className="debug-panel">
      <div className="debug-panel__header">Event Log</div>
      <div className="debug-panel__list" ref={listRef}>
        {log.length === 0 && <div className="debug-panel__empty">No events yet.</div>}
        {log.map((entry, i) => (
          <div key={`${entry.ts}-${entry.event}-${i}`} className="debug-panel__row">
            <span className="debug-panel__ts">{new Date(entry.ts).toLocaleTimeString([], { hour12: false })}</span>
            <span
              className="debug-panel__event"
              style={{ color: EVENT_COLORS[entry.event] || '#e2e8f0' }}
            >
              {entry.event}
            </span>
            {entry.meta && Object.keys(entry.meta).length > 0 && (
              <span className="debug-panel__meta">
                {Object.entries(entry.meta)
                  .filter(([k]) => k !== 'response_id')
                  .map(([k, v]) => `${k}=${v}`)
                  .join(' ')}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default memo(DebugPanel);
