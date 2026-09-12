import { memo } from 'react';

function average(arr) {
  if (arr.length === 0) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function LatencyPanel({ lastLatency, history }) {
  const avg = average(history);
  const best = history.length ? Math.min(...history) : null;
  const worst = history.length ? Math.max(...history) : null;

  return (
    <div className="latency-panel">
      <div className="latency-panel__header">Interruption Latency</div>
      <div className="latency-panel__big">
        {lastLatency !== null ? `${lastLatency} ms` : '—'}
        <span className="latency-panel__sub">last interrupt</span>
      </div>
      <div className="latency-panel__stats">
        <div>
          <div className="latency-panel__stat-value">{avg !== null ? `${Math.round(avg)} ms` : '—'}</div>
          <div className="latency-panel__stat-label">avg</div>
        </div>
        <div>
          <div className="latency-panel__stat-value">{best !== null ? `${best} ms` : '—'}</div>
          <div className="latency-panel__stat-label">best</div>
        </div>
        <div>
          <div className="latency-panel__stat-value">{worst !== null ? `${worst} ms` : '—'}</div>
          <div className="latency-panel__stat-label">worst</div>
        </div>
        <div>
          <div className="latency-panel__stat-value">{history.length}</div>
          <div className="latency-panel__stat-label">samples</div>
        </div>
      </div>
      <div className="latency-panel__note">
        Measured from the user's actual speech onset (local energy VAD) to the moment
        the browser stops the audio graph after receiving the server's interrupt signal.
      </div>
    </div>
  );
}

export default memo(LatencyPanel);
