import { useConversation } from './hooks/useConversation';
import MicButton from './components/MicButton';
import StatusBadge from './components/StatusBadge';
import Transcript from './components/Transcript';
import DebugPanel from './components/DebugPanel';
import LatencyPanel from './components/LatencyPanel';
import './App.css';

export default function App() {
  const {
    connectionState,
    aiState,
    messages,
    debugLog,
    latencyHistory,
    lastLatency,
    errorMessage,
    start,
    stop,
  } = useConversation();

  const isActive = connectionState !== 'idle';

  return (
    <div className="app">
      <header className="app__header">
        <h1>A Voice You Can Interrupt</h1>
        <p className="app__subtitle">A small booking assistant that stops talking the instant you do.</p>
      </header>

      <main className="app__main">
        <section className="app__left">
          <div className="control-card">
            <MicButton isActive={isActive} onClick={isActive ? stop : start} />
            <StatusBadge aiState={aiState} connectionState={connectionState} />
            {errorMessage && <div className="app__error">{errorMessage}</div>}
          </div>
          <Transcript messages={messages} />
        </section>

        <section className="app__right">
          <LatencyPanel lastLatency={lastLatency} history={latencyHistory} />
          <DebugPanel log={debugLog} />
        </section>
      </main>
    </div>
  );
}
