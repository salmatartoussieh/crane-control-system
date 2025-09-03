//Acts as a bridge:
//   Frontend (HTTP + WebSocket) ⇆ Backend ⇆ MQTT Broker ⇆ Cranes
// - HTTP is used for user-initiated commands (e.g., send G-code)
// - WebSocket is used to stream live status/events to the frontend
// - MQTT is used to talk to cranes (publish commands, subscribe to responses)

const express = require("express");
const cors = require("cors");
const WebSocket = require("ws");
const mqtt = require("mqtt");

// Create the Express app and an HTTP server that both Express and WS will share
const app = express();
const server = require("http").createServer(app);

// Attach a WebSocket server to the same HTTP server/port
const wss = new WebSocket.Server({ server });

// The TCP port your backend listens on (visit http://localhost:3006/ to check it's up)
const PORT = 3006;

// --- CONFIG -------------------------------------------------------
// MQTT broker address. Replace the IP with the machine running Mosquitto.
// "mqtt://<IP>:1883" — 1883 is the default MQTT port (unencrypted).
const MQTT_URL = "mqtt://192.168.1.2:1883"; // same broker you used before
// ---------------

app.use(cors());
app.use(express.json());

// ------------------------------------------------------
// MQTT: Connect to the broker (this runs as the “backend client”)
// ------------------------------------------------------
const mqttClient = mqtt.connect(MQTT_URL);

// When MQTT connects successfully:
mqttClient.on("connect", () => {
  console.log("✅ Connected to MQTT broker");

  // Subscribe to two wildcard topics:
  // - crane/+/resp : all cranes’ response streams (the '+' matches any craneId)
  // - crane/+/lwt  : MQTT Last Will & Testament messages (online/offline presence)
  mqttClient.subscribe(["crane/+/resp", "crane/+/lwt"], (err) => {
    if (err) console.error("❌ MQTT subscribe error:", err.message);
    else console.log("📡 Subscribed to crane/+/resp and crane/+/lwt");
  });
});

// Whenever any subscribed MQTT message arrives:
mqttClient.on("message", (topic, payloadBuf) => {
  const payload = payloadBuf.toString();

    // Pack the message with its topic and a timestamp so the UI has context
  const out = JSON.stringify({ topic, payload, ts: Date.now() });

    // Broadcast this update to ALL connected WebSocket clients (frontends)
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(out);
  });
});

// ------------------------------------------------------
// WebSocket: Frontend connects here to receive live updates
// ------------------------------------------------------

wss.on("connection", (frontendWs) => {
  console.log("🌐 Frontend connected");
  frontendWs.on("close", () => console.log("🌐 Frontend disconnected"));
});

// ------------------------------------------------------
// HTTP: Command endpoints (frontend → backend → MQTT → crane)
// ------------------------------------------------------

/**
 * POST /move
 * Send raw G-code to a specific crane.
 * Body example:
 *   {
 *     "craneId": "1",       // which crane to target
 *     "gcode": "G1 X100"    // the command to send
 *   }
 */

app.post("/move", (req, res) => {
  const { gcode, craneId } = req.body;

  // Validate required fields early and return a 400 Bad Request if missing
  if (!gcode || !craneId)
    return res
      .status(400)
      .json({ success: false, message: "Missing gcode or craneId" });

  // Construct the command topic for this crane, e.g. crane/1/cmd
  const topic = `crane/${craneId}/cmd`;
  mqttClient.publish(topic, gcode, { qos: 1 }, (err) => {
    if (err) {
      console.error(`❌ MQTT publish failed for ${topic}:`, err.message);
      return res.status(500).json({ success: false, message: "MQTT publish error" });
    }

    // Log for debugging/traceability
    console.log(`📨 ${topic} <= ${gcode}`);

    // Respond to the HTTP caller that we accepted the command
    res.json({ success: true });
  });
});

/**
 * POST /estop
 * Trigger an emergency stop on a specific crane by sending M112.
 * Body example:
 *   { "craneId": "1" }
 */
app.post("/estop", (req, res) => {
  const { craneId } = req.body;

  if (!craneId) return res
    .status(400)
    .json({ success: false, message: "Missing craneId" });

  // Send E‑STOP G-code (M112) to the crane’s command topic
  mqttClient.publish(`crane/${craneId}/cmd`, "M112", { qos: 1 }, (err) => {
    if (err) {
      return res
        .status(500)
        .json({ success: false, message: "MQTT publish error" });
    }
    res.json({ success: true });
  });
});

// Simple health check: hit http://localhost:3006/ to verify server is up
app.get("/", (_, res) => res.send("✅ Backend is running"));

// Start the HTTP + WebSocket server
server.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
