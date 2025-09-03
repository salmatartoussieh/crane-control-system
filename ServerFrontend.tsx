// ServerFrontend.tsx
// UI for controlling and monitoring multiple cranes.
//
// Architecture (big picture):
// - This component renders sliders/buttons for position & control.
// - When you move a slider, we compute the delta (dx/dy/dz) and
//   send relative G-code jogs to the backend via HTTP (/move).
// - A persistent WebSocket listens for backend events relayed from MQTT
//   (e.g., crane/<id>/resp and crane/<id>/lwt) and updates the UI in real time.
// - We "debounce" slider changes so a burst of tiny moves becomes one command.
// - We also suppress automatic jogs during homing so we don't fight the firmware.
//
// Key concepts implemented here:
// - React state for positions per crane, with per-axis debounced jog effects
// - Refs to track previous positions (to compute deltas for G91 moves)
// - WebSocket event stream for status + live positions (parsed from M114)
// - Simple collision check example between Crane 1 and 2
// ===============================================

"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import CraneSchematic from "./CraneSchematic";

// === Constants (tweak for your setup) ===
const BACKEND_URL = "http://localhost:3006"; // Your backend (Express) host:port
const COLLISION_BUFFER = 100;                // Safety spacing between cranes (mm)
const CRANE_WIDTH = 125;                     // Approx width/footprint (mm)
const MIN_SAFE_DISTANCE = COLLISION_BUFFER + CRANE_WIDTH; // Derived safe distance

// === Types to keep state safe & readable ===
type CraneKey =
  | "crane-1" | "crane-2" | "crane-3" | "crane-4" | "crane-5" | "crane-6" | "crane-7";

type Axis = "x" | "y" | "z";
type Position = { x: number; y: number; z: number };
type CranePositions = Record<CraneKey, Position>;

type CraneConfig = {
  [key in CraneKey]: {
    name: string;                                         // Display name in the UI
    limits: { x: [number, number]; y: [number, number]; z: [number, number] }; // Axis ranges
    initial: Position;                                    // Initial slider positions
    color: string;                                        // Rendering color for schematic
    offset: { x: number; y: number };                     // Global offset for layout diagram
  };
};

// === Config per crane (UI ranges, starting positions, visuals)
// NOTE: Make sure these ranges match your Marlin limits where possible.
const craneConfig: CraneConfig = {
  "crane-1": { name: "Crane 1",  limits: { x: [0, 500], y: [0, 500], z: [0, 500] }, initial: { x: 0, y: 0, z: 0 }, color: "#e74444ff", offset: { x: 900,  y: 1450 } },
  "crane-2": { name: "Crane 2",  limits: { x: [0, 400], y: [0, 700], z: [0, 500] }, initial: { x: 0, y: 0, z: 0 }, color: "#a43ca4ff", offset: { x: 400,  y: 1450 } },
  "crane-3": { name: "Gantry 1", limits: { x: [0, 300], y: [0, 400], z: [0, 500] }, initial: { x: 0, y: 0, z: 0 }, color: "#3f64d4ff", offset: { x: 1425, y: 1450 } },
  "crane-4": { name: "Gantry 2", limits: { x: [0, 400], y: [0, 500], z: [0, 500] }, initial: { x: 0, y: 0, z: 0 }, color: "#1a661a",   offset: { x: 1650, y: 250  } },
  "crane-5": { name: "Gantry 3", limits: { x: [0, 650], y: [0, 400], z: [0, 500] }, initial: { x: 0, y: 0, z: 0 }, color: "#ff9999",  offset: { x: 450,  y: 950  } },
  "crane-6": { name: "Gantry 4", limits: { x: [0, 650], y: [0, 400], z: [0, 500] }, initial: { x: 0, y: 0, z: 0 }, color: "#f0b2f0",  offset: { x: 450,  y: 550  } },
  "crane-7": { name: "Gantry 5", limits: { x: [0, 650], y: [0, 400], z: [0, 500] }, initial: { x: 0, y: 0, z: 0 }, color: "#adc2ff",  offset: { x: 450,  y: 150  } },
};

export default function CraneControl() {
  // Positions state holds current slider values for ALL cranes.
  // We initialize with each crane's "initial" config.
  const [positions, setPositions] = useState<CranePositions>(() => {
    const init = {} as CranePositions;
    (Object.keys(craneConfig) as CraneKey[]).forEach(k => { init[k] = { ...craneConfig[k].initial }; });
    return init;
  });

  // Which crane the controls apply to
  const [selectedCrane, setSelectedCrane] = useState<CraneKey>("crane-1");

  // Jog speed (mm/min) used in G0 moves
  const [feedrate, setFeedrate] = useState(500);

  // Console-style history of commands & status lines for operator visibility
  const [commandHistory, setCommandHistory] = useState<string[]>([]);

  // Simple global alarm flag (used for glow in schematic, e.g., offline state)
  const [alarmState, setAlarmState] = useState<string | null>(null);

  // ------------------------------------------
  // sendCommand: POST /move -> backend publishes to crane/<id>/cmd
  // We capture selectedCrane via dependency so commands target the active unit.
  // ------------------------------------------
  const sendCommand = useCallback(async (gcode: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/move`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gcode, craneId: selectedCrane }),
      });
      // If backend accepted it, add to UI history (top of list)
      if (res.ok) setCommandHistory(prev => [gcode, ...prev.slice(0, 49)]);
    } catch {
      // Network errors are ignored to keep the UI responsive
    }
  }, [selectedCrane]);

  // ------------------------------------------
  // Refs: we track previous positions to compute deltas (dx/dy/dz).
  // Why? We send RELATIVE jogs (G91) of just the change, not absolute.
  // ------------------------------------------
  const previousX = useRef(positions[selectedCrane].x);
  const previousY = useRef(positions[selectedCrane].y);
  const previousZ = useRef(positions[selectedCrane].z);

  // Timer refs: used to debounce slider changes per-axis
  const xTimer = useRef<number | null>(null);
  const yTimer = useRef<number | null>(null);
  const zTimer = useRef<number | null>(null);

  // Flag to temporarily suppress jog effects (e.g., during/after homing)
  const suppressJog = useRef(false);

  // When the selected crane changes, reset the previous* refs
  useEffect(() => { previousX.current = positions[selectedCrane].x; }, [selectedCrane]);
  useEffect(() => { previousY.current = positions[selectedCrane].y; }, [selectedCrane]);
  useEffect(() => { previousZ.current = positions[selectedCrane].z; }, [selectedCrane]);

  // ------------------------------------------
  // Debounced X jog effect
  // - Runs when positions[selectedCrane].x changes
  // - Computes dx = newX - previousX
  // - Sends G91/G0/G90/M114 with a 300ms debounce
  // - Optional collision check for Crane 1 & 2
  // ------------------------------------------
  useEffect(() => {
    if (suppressJog.current) return;

    const x = positions[selectedCrane].x;
    const dx = x - previousX.current;
    if (!Number.isFinite(dx) || dx === 0) return;

    if (xTimer.current) clearTimeout(xTimer.current);
    xTimer.current = window.setTimeout(() => {
      // Example: block X jog if Crane 1 & 2 would collide
      const isCrane1Or2 = selectedCrane === "crane-1" || selectedCrane === "crane-2";
      if (isCrane1Or2 && checkForCollision()) return;

      // Relative move (G91) by dx at current feedrate, then back to absolute (G90)
      sendCommand("G91");
      sendCommand(`G0 X${dx} F${feedrate}`);
      sendCommand("G90");

      // Ask firmware to report absolute position; we parse it in WS handler
      sendCommand("M114");

      // Update "previous" AFTER actually sending the jog
      previousX.current = x;
    }, 300);

    // Cleanup if effect re-runs before timeout fires
    return () => { if (xTimer.current) clearTimeout(xTimer.current); };
  }, [positions[selectedCrane].x, feedrate, selectedCrane]);

  // Debounced Y jog effect (same pattern as X)
  useEffect(() => {
    if (suppressJog.current) return;

    const y = positions[selectedCrane].y;
    const dy = y - previousY.current;
    if (!Number.isFinite(dy) || dy === 0) return;

    if (yTimer.current) clearTimeout(yTimer.current);
    yTimer.current = window.setTimeout(() => {
      sendCommand("G91");
      sendCommand(`G0 Y${dy} F${feedrate}`);
      sendCommand("G90");
      sendCommand("M114");

      previousY.current = y;
    }, 300);

    return () => { if (yTimer.current) clearTimeout(yTimer.current); };
  }, [positions[selectedCrane].y, feedrate, selectedCrane]);

  // Debounced Z jog effect (same pattern as X/Y)
  useEffect(() => {
    if (suppressJog.current) return;

    const z = positions[selectedCrane].z;
    const dz = z - previousZ.current;
    if (!Number.isFinite(dz) || dz === 0) return;

    if (zTimer.current) clearTimeout(zTimer.current);
    zTimer.current = window.setTimeout(() => {
      sendCommand("G91");
      sendCommand(`G0 Z${dz} F${feedrate}`);
      sendCommand("G90");
      sendCommand("M114");

      previousZ.current = z;
    }, 300);

    return () => { if (zTimer.current) clearTimeout(zTimer.current); };
  }, [positions[selectedCrane].z, feedrate, selectedCrane]);

  // ------------------------------------------
  // Homing helpers
  // - We set needSyncAfterHome so when the next M114 arrives,
  //   we snap previousX/Y/Z to the reported absolute positions.
  // - We suppress automatic jogs during homing to avoid conflicts.
  // ------------------------------------------
  const needSyncAfterHome = useRef(false);

  // Home all axes
  const handleReset = () => {
    suppressJog.current = true;
    needSyncAfterHome.current = true;

    // Cancel any pending debounced jogs
    if (xTimer.current) clearTimeout(xTimer.current);
    if (yTimer.current) clearTimeout(yTimer.current);
    if (zTimer.current) clearTimeout(zTimer.current);

    // Issue homing + wait + request absolute position report
    sendCommand("G28");
    sendCommand("M400"); // Wait for moves to finish
    sendCommand("M114"); // Report absolute XYZ
  };

  // Home X only
  const handleResetX = () => {
    suppressJog.current = true;
    needSyncAfterHome.current = true;
    if (xTimer.current) clearTimeout(xTimer.current);
    if (yTimer.current) clearTimeout(yTimer.current);
    if (zTimer.current) clearTimeout(zTimer.current);

    sendCommand("G28 X");
    sendCommand("M400");
    sendCommand("M114");
  };

  // Home Y only
  const handleResetY = () => {
    suppressJog.current = true;
    needSyncAfterHome.current = true;
    if (xTimer.current) clearTimeout(xTimer.current);
    if (yTimer.current) clearTimeout(yTimer.current);
    if (zTimer.current) clearTimeout(zTimer.current);

    sendCommand("G28 Y");
    sendCommand("M400");
    sendCommand("M114");
  };

  // Home Z only
  const handleResetZ = () => {
    suppressJog.current = true;
    needSyncAfterHome.current = true;
    if (xTimer.current) clearTimeout(xTimer.current);
    if (yTimer.current) clearTimeout(yTimer.current);
    if (zTimer.current) clearTimeout(zTimer.current);

    sendCommand("G28 Z");
    sendCommand("M400");
    sendCommand("M114");
  };

  // ------------------------------------------
  // M114 parser: turns a firmware line like
  // "X:10.00 Y:31.10 Z:2.00 E:0.00 Count X:... Y:... Z:..."
  // into { x, y, z }. If no match, return null.
  // ------------------------------------------
  const tryParseM114 = (line: string): Partial<Position> | null => {
    const m = line.match(/X:\s*(-?\d+(\.\d+)?)\s+Y:\s*(-?\d+(\.\d+)?)\s+Z:\s*(-?\d+(\.\d+)?)/i);
    if (!m) return null;
    return { x: parseFloat(m[1]), y: parseFloat(m[3]), z: parseFloat(m[5]) };
  };

  // ------------------------------------------
  // WebSocket wiring:
  // - Connect to the backend WS once on mount.
  // - For each message { topic, payload }, decide what to do:
  //   * /lwt  -> online/offline (show alarm)
  //   * /resp -> push to history, optionally parse M114 to update positions
  // - After homing: when the first good M114 for selected crane arrives,
  //   sync previousX/Y/Z and re-enable jogging.
  // ------------------------------------------
  useEffect(() => {
    const ws = new WebSocket("ws://localhost:3006");

    ws.onopen = () => console.log("✅ Status WebSocket connected");

    ws.onmessage = (evt) => {
      try {
        const { topic, payload } = JSON.parse(evt.data);

        // Presence (Last Will) messages
        if (topic.endsWith("/lwt")) {
          const online = payload.includes('"online":true');
          if (!online) setAlarmState("offline");
          else setAlarmState(null);
          return;
        }

        // Crane responses / logs / M114 lines
        if (topic.endsWith("/resp")) {
          // Mirror raw payloads in the console/history
          setCommandHistory(prev => [payload, ...prev.slice(0, 49)]);

          // Extract crane id from "crane/<id>/resp"
          const id = topic.split("/")[1] as CraneKey;

          // If this payload is an M114 report, use it to update absolute positions
          const pos = tryParseM114(payload);
          if (pos) {
            setPositions(prev => ({
              ...prev,
              [id]: {
                x: pos.x ?? prev[id].x,
                y: pos.y ?? prev[id].y,
                z: pos.z ?? prev[id].z,
              }
            }));

            // After homing, we need to "snap" previousX/Y/Z to the true position
            if (needSyncAfterHome.current && id === selectedCrane) {
              if (Number.isFinite(pos.x!)) previousX.current = pos.x!;
              if (Number.isFinite(pos.y!)) previousY.current = pos.y!;
              if (Number.isFinite(pos.z!)) previousZ.current = pos.z!;
              needSyncAfterHome.current = false;
              suppressJog.current = false; // allow sliders to jog again
            }
          }
        }
      } catch {
        // Malformed messages are ignored
      }
    };

    ws.onclose = () => console.warn("WebSocket disconnected");
    ws.onerror = (err) => console.error("WebSocket error:", err);

    // Clean up connection on unmount
    return () => ws.close();
  }, [selectedCrane]); // (selectedCrane) only used for homing sync check

  // ------------------------------------------
  // Simple collision check example (Crane 1 vs Crane 2 on X only)
  // - Combines each crane's X with its global schematic X offset,
  //   then compares distance to a safe threshold.
  // - If too close, issue emergency stop (M112) and block the jog.
  // ------------------------------------------
  const checkForCollision = () => {
    const pos1 = positions["crane-1"].x + craneConfig["crane-1"].offset.x;
    const pos2 = positions["crane-2"].x + craneConfig["crane-2"].offset.x;
    const distance = Math.abs(pos1 - pos2);

    if (distance < MIN_SAFE_DISTANCE) {
      console.warn("🛑 Collision risk between Crane 1 & 2");
      sendCommand("M112");
      return true;
    }
    return false;
  };

  // ------------------------------------------
  // UI Rendering
  // - Feedrate dropdown
  // - Schematic view (glowActive when alarmState set)
  // - Axis sliders for the selected crane
  // - Crane picker
  // - Control buttons (home/enable/pause/resume/reset/estop)
  // - Console history panel
  // ------------------------------------------
  return (
    <div className="flex flex-col items-center min-h-screen bg-[#0a0a23] text-white p-10 font-sans">
      <h1 className="text-3xl font-bold mb-6">CRANE CONTROL PANEL</h1>

      {/* Feedrate selector controls jog speed (mm/min) */}
      <div className="mb-6 w-[200px]">
        <label className="block mb-2 font-semibold text-center w-full">Feedrate</label>
        <select
          value={feedrate}
          onChange={(e) => setFeedrate(Number(e.target.value))}
          className="w-full p-2 rounded bg-[#1e1e2e] text-white"
        >
          <option value={500}>500 mm/min</option>
          <option value={1000}>1000 mm/min</option>
          <option value={1500}>1500 mm/min</option>
          <option value={2000}>2000 mm/min</option>
        </select>
      </div>

      {/* Schematic draws cranes with absolute offsets; glow indicates alarm */}
      <CraneSchematic
        selectedCrane={selectedCrane}
        positions={positions}
        config={craneConfig}
        glowActive={Boolean(alarmState)}
      />

      {/* Axis sliders: bound to the selected crane's [x,y,z] */}
      {(["X","Y","Z"] as const).map((axis) => (
        <div key={axis} className="w-[1400px] mb-6">
          <label className="block mb-2 font-semibold">
            {axis}-Axis Position: {positions[selectedCrane][axis.toLowerCase() as Axis]} mm
          </label>
          <input
            type="range"
            min={craneConfig[selectedCrane].limits[axis.toLowerCase() as Axis][0]}
            max={craneConfig[selectedCrane].limits[axis.toLowerCase() as Axis][1]}
            value={positions[selectedCrane][axis.toLowerCase() as Axis]}
            onChange={(e) => {
              // Sliders set the target absolute position in UI state.
              // The corresponding effect will compute the delta and send a jog.
              const val = Number(e.target.value);
              setPositions(prev => ({
                ...prev,
                [selectedCrane]: { ...prev[selectedCrane], [axis.toLowerCase()]: val }
              }));
            }}
            className="w-full"
          />
        </div>
      ))}

      {/* Crane picker to switch which crane the sliders/buttons control */}
      <div className="mb-6 w-[300px]">
        <label className="block mb-2 font-semibold text-center w-full">Select Crane</label>
        <select
          value={selectedCrane}
          onChange={(e) => setSelectedCrane(e.target.value as CraneKey)}
          className="w-full p-2 rounded bg-[#1e1e2e] text-white"
        >
          {Object.entries(craneConfig).map(([key, crane]) => (
            <option key={key} value={key}>{crane.name}</option>
          ))}
        </select>
      </div>

      {/* Control buttons: homing, motor enable, pause/resume, reset, E‑STOP */}
      <div className="flex gap-10 mt-10">
        {/* Column 1: Homing */}
        <div className="flex flex-col gap-2">
          <button className="px-6 py-2 bg-blue-500 text-black font-bold rounded" onClick={handleReset}>
            HOME ALL
          </button>
          <button className="px-6 py-2 bg-sky-200 text-black font-bold rounded" onClick={handleResetX}>
            HOME X
          </button>
          <button className="px-6 py-2 bg-sky-200 text-black font-bold rounded" onClick={handleResetY}>
            HOME Y
          </button>
          <button className="px-6 py-2 bg-sky-200 text-black font-bold rounded" onClick={handleResetZ}>
            HOME Z
          </button>
        </div>

        {/* Column 2: Unlock + Pause */}
        <div className="flex flex-col gap-2">
          <button className="px-6 py-2 bg-green-500 text-black font-bold rounded" onClick={() => sendCommand("M17")}>
            ENABLE MOTORS
          </button>
          <button className="px-6 py-2 bg-gray-300 text-black font-bold rounded" onClick={() => sendCommand("M0")}>
            PAUSE MOTION
          </button>
          <button className="px-6 py-2 bg-gray-300 text-black font-bold rounded" onClick={() => sendCommand("M108")}>
            RESUME MOTION
          </button>
        </div>

        {/* Column 3: Emergency Stop + Reset */}
        <div className="flex flex-col gap-2">
          <button className="px-6 py-2 bg-purple-300 text-black font-bold rounded" onClick={() => sendCommand("M999")}>
            RESET MACHINE
          </button>
          <button className="px-6 py-2 bg-red-600 text-black font-bold rounded" onClick={() => sendCommand("M112")}>
            EMERGENCY STOP
          </button>
        </div>
      </div>

      {/* Console / history panel for operator feedback */}
      <div className="mt-10 w-full max-w-[800px] bg-[#1e1e2e] rounded p-4">
        <h2 className="text-xl font-semibold mb-2">Console / History</h2>
        <ul className="space-y-1 text-sm text-gray-300 max-h-64 overflow-y-auto">
          {commandHistory.map((cmd, idx) => <li key={idx}>➤ {cmd}</li>)}
        </ul>
      </div>
    </div>
  );
}
