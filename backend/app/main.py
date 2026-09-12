from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from . import config
from .session import RealtimeSession

app = FastAPI(title="Voice Interrupt Assistant Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "model": config.OPENAI_REALTIME_MODEL}


@app.websocket("/ws/conversation")
async def conversation_ws(websocket: WebSocket):
    """
    One WebSocket connection per browser tab / conversation.
    A fresh RealtimeSession (and fresh upstream OpenAI connection) is created
    per connection, and torn down cleanly on disconnect.
    """
    await websocket.accept()
    session = RealtimeSession(websocket)
    try:
        await session.run()
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, reload=True)
