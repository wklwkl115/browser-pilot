# WebSocket session fixture

Synthetic local-only websocket transcript fixture descriptor for eval 27.

- Endpoint type: local websocket echo/pong server
- Required behavior:
  - accept explicit open
  - echo outbound text or reply with deterministic pong payload
  - require no external network
- This fixture descriptor is documentation-only and does not start a server by itself.
