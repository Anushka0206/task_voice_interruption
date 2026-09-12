import { memo, useEffect, useRef } from 'react';

function Transcript({ messages }) {
  const bottomRef = useRef(null);
  const panelRef = useRef(null);

  useEffect(() => {
    const panel = panelRef.current;
    const bottom = bottomRef.current;
    if (!panel || !bottom) return;
    const nearBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight < 96;
    if (nearBottom) {
      bottom.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [messages]);

  return (
    <div className="transcript" ref={panelRef}>
      {messages.length === 0 && (
        <div className="transcript__empty">Say something like “Book me a dentist appointment tomorrow.”</div>
      )}
      {messages.map((m) => (
        <div key={m.id} className={`bubble bubble--${m.role}`}>
          <div className="bubble__role">{m.role === 'user' ? 'You' : 'Sam (AI)'}</div>
          <div className="bubble__text">
            {m.text || <span className="bubble__pending">…</span>}
            {!m.final && m.role === 'ai' && <span className="bubble__cursor">▍</span>}
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

export default memo(Transcript);
