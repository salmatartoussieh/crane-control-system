"use client";

import React from "react";

// --- Static background zones (unchanged) ---
const STATIC_ZONES = [
  { name: "Zone 1", x: 400,  y: 1200, width: 1000, height: 400,  color: "#a4c2f4" },
  { name: "Zone 2", x: 400,  y: 800,  width: 1000, height: 400,  color: "#ffe599" },
  { name: "Zone 3", x: 0,    y: 800,  width: 400,  height: 800,  color: "#f6b26b" },
  { name: "Zone 4", x: 1400, y: 800,  width: 600,  height: 800,  color: "#b6d7a8" },
  { name: "Zone 5", x: 1400, y: 0,    width: 600,  height: 800,  color: "#76a5af" },
  { name: "Zone 6", x: 0,    y: 0,    width: 1400, height: 800,  color: "#b4a7d6" },
  { name: "Zone 7", x: 0,    y: 0,    width: 2000, height: 200,  color: "#e06666" },
];

const SCHEMATIC_WIDTH_MM = 2000;
const SCHEMATIC_HEIGHT_MM = 1600;
const SVG_WIDTH_PX = 1000;
const SVG_HEIGHT_PX = 800;

const mmToPx = (val: number, axis: "x" | "y") =>
  axis === "x"
    ? (val / SCHEMATIC_WIDTH_MM) * SVG_WIDTH_PX
    : (val / SCHEMATIC_HEIGHT_MM) * SVG_HEIGHT_PX;

// ---- Types ----
type CraneSchematicProps = {
  selectedCrane: string;
  positions: { [key: string]: { x: number; y: number; z: number } };
  config: {
    [key: string]: {
      name: string;
      limits: { x: [number, number]; y: [number, number]; z: [number, number] };
      initial: { x: number; y: number; z: number };
      offset: { x: number; y: number };
      color: string;
    };
  };
  glowActive: boolean;
};

// ---- Helpers / constants for gantry visuals ----
const BRIDGE_W_PX = 70;       // width of the tall gantry bridge (px)
const TROLLEY_H_PX = 18;      // height of the trolley (px)
const TROLLEY_MARGIN_PX = 4;  // inset from bridge walls (px)
const CAB_W_PX = 80;          // legacy non-gantry cab width (px)
const CAB_H_PX = 40;          // legacy non-gantry cab height (px)

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const isGantry = (name: string) => /^gantry/i.test(name);

// ======================================================
const CraneSchematic: React.FC<CraneSchematicProps> = ({
  selectedCrane,
  positions,
  config,
  glowActive,
}) => {
  // Draw dashed movement zone for each crane (same as your version)
  const renderZones = () =>
    Object.entries(config).map(([key, crane]) => {
      const { limits, color } = crane;

      const zoneX = mmToPx(limits.x[0] + crane.offset.x, "x");
      const zoneY = mmToPx(limits.y[0] + crane.offset.y, "y");
      const zoneW = mmToPx(limits.x[1] - limits.x[0], "x");
      const zoneH = mmToPx(limits.y[1] - limits.y[0], "y");

      const isSelected = key === selectedCrane;

      return (
        <g key={`${key}-zone`}>
          <rect x={zoneX} y={zoneY} width={zoneW} height={zoneH} fill={color} opacity={0.15} rx={4} />
          <rect
            x={zoneX}
            y={zoneY}
            width={zoneW}
            height={zoneH}
            fill="none"
            stroke={isSelected ? "#ffffff" : "#0a0a0aff"}
            strokeWidth={isSelected ? 2.5 : 2}
            strokeDasharray="6 4"
            rx={4}
          />
        </g>
      );
    });

  // NEW: render gantry vs non-gantry differently
  const renderCranes = () =>
    Object.entries(config).map(([key, crane]) => {
      const { name, color, limits, offset } = crane;
      const pos = positions[key];
      if (!pos) return null;

      const isSelected = key === selectedCrane;

      // Movement zone, in px (we'll use this to clamp / span)
      const zoneX = mmToPx(limits.x[0] + offset.x, "x");
      const zoneY = mmToPx(limits.y[0] + offset.y, "y");
      const zoneW = mmToPx(limits.x[1] - limits.x[0], "x");
      const zoneH = mmToPx(limits.y[1] - limits.y[0], "y");

      if (isGantry(name)) {
        // --- GANTRY ---
        // Bridge (vertical) moves in X with pos.x, spans the full dashed box height
        // --- GANTRY ---
const bridgeLeftCandidate = mmToPx(pos.x + offset.x, "x");
const bridgeX = clamp(bridgeLeftCandidate, zoneX, zoneX + zoneW - BRIDGE_W_PX);

const trolleyTopCandidate = mmToPx(pos.y + offset.y, "y");
const trolleyY = clamp(
  trolleyTopCandidate,
  zoneY + TROLLEY_MARGIN_PX,
  zoneY + zoneH - (TROLLEY_H_PX + TROLLEY_MARGIN_PX)
);

// handy locals for centering the text
const trolleyX = bridgeX + TROLLEY_MARGIN_PX;
const trolleyW = BRIDGE_W_PX - 2 * TROLLEY_MARGIN_PX;
const trolleyCX = trolleyX + trolleyW / 2;
const trolleyCY = trolleyY + TROLLEY_H_PX / 2;

return (
  <g key={key} style={{ transition: "all 0.2s ease-in-out" }}>
    {/* Bridge (full height, moves with X) */}
    <rect
      x={bridgeX}
      y={zoneY}
      width={BRIDGE_W_PX}
      height={zoneH}
      fill={color}
      stroke={isSelected ? (glowActive ? "#ffff66" : "#ffffff") : "#000"}
      strokeWidth={isSelected ? 3 : 1}
      filter={isSelected && glowActive ? "url(#glow)" : undefined}
      rx={8}
    />

    {/* Trolley (moves with Y) */}
    <rect
      x={trolleyX}
      y={trolleyY}
      width={trolleyW}
      height={TROLLEY_H_PX}
      fill="#111"
      stroke="#fff2"
      strokeWidth={1}
      rx={6}
    />

    {/* *** Label inside the trolley *** */}
    <text
      x={trolleyCX}
      y={trolleyCY}
      textAnchor="middle"
      dominantBaseline="middle"
      fill="#fff"           // white text in the black box
      fontWeight="bold"
      fontSize={10}         // tweak if you want it bigger
      pointerEvents="none"
      style={{ paintOrder: "stroke fill" }}
    >
      {name}
    </text>

    {/* Optional Z readout (kept below trolley) */}
    {isSelected && (
      <text
        x={bridgeX + BRIDGE_W_PX / 2}
        y={trolleyY + TROLLEY_H_PX + 14}
        textAnchor="middle"
        fill="#ccc"
        fontSize={10}
        pointerEvents="none"
      >
        Z: {pos.z} mm
      </text>
    )}
  </g>
);

      } else {
        // --- NON-GANTRY (legacy square that moves 2D) ---
        const baseX = mmToPx(pos.x + offset.x, "x");
        const baseY = mmToPx(pos.y + offset.y, "y");

        return (
          <g key={key} style={{ transition: "all 0.2s ease-in-out" }}>
            <rect
              x={baseX}
              y={baseY}
              width={CAB_W_PX}
              height={CAB_H_PX}
              fill={color}
              stroke={isSelected ? (glowActive ? "#ffff66" : "#ffffff") : "#000"}
              strokeWidth={isSelected ? 4 : 1}
              filter={isSelected && glowActive ? "url(#glow)" : undefined}
              rx={8}
              ry={8}
            />
            <text
              x={baseX + CAB_W_PX / 2}
              y={baseY + CAB_H_PX / 2 + 5}
              textAnchor="middle"
              fill="#000"
              fontWeight="bold"
              fontSize={12}
            >
              {name}
            </text>
            {isSelected && (
              <text
                x={baseX + CAB_W_PX / 2}
                y={baseY + CAB_H_PX + 16}
                textAnchor="middle"
                fill="#ccc"
                fontSize={10}
              >
                Z: {pos.z} mm
              </text>
            )}
          </g>
        );
      }
    });

  return (
    <div className="mb-10 w-full flex justify-center">
      <svg
        width={SVG_WIDTH_PX}
        height={SVG_HEIGHT_PX}
        style={{ background: "#0a0a23", border: "2px solid #ffffff44", borderRadius: "12px" }}
      >
        {/* Glow filter for alarms/selection */}
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Background */}
        <rect x={0} y={0} width="100%" height="100%" fill="#0a0a23" />

        {/* Static colored zones */}
        {STATIC_ZONES.map((zone, i) => (
          <rect
            key={`static-zone-${i}`}
            x={mmToPx(zone.x, "x")}
            y={mmToPx(zone.y, "y")}
            width={mmToPx(zone.width, "x")}
            height={mmToPx(zone.height, "y")}
            fill={zone.color}
            opacity={0.5}
            rx={8}
          />
        ))}

        {/* Dashed movement zones */}
        {renderZones()}

        {/* Cranes (gantry vs non-gantry) */}
        {renderCranes()}
      </svg>
    </div>
  );
};

export default CraneSchematic;
