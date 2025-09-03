# Crane Control System (Port Model, TUHH)

Modernized a legacy Arduino-based crane control system into a WiFi-enabled architecture.  
Features:
- Node.js backend with MQTT/HTTP/WebSocket integration
- React frontend for real-time motion control
- Firmware tuning for TMC stepper drivers (sensorless homing, StallGuard)

## 🔧 How to Run

### 1. Backend (Node.js)
```bash
cd "folder where the backend is placed"
npm install
node serverbackend.js

2. Frontend
```bash
cd "folder where the frontend is placed"
npm install
npm start
