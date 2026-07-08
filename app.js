import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import * as topojson from "topojson-client";
import { geoPath } from "d3-geo";
import { geoMollweide } from "d3-geo-projection";
import { Delaunay } from "d3-delaunay";

const EARTH_RADIUS_KM = 6378.137;
const MU_EARTH_KM3_S2 = 398600.4418;
const EARTH_ROTATION_RATE_RAD_PER_SEC = 7.2921150e-5;
const SCALE = 1 / EARTH_RADIUS_KM;

const SECONDS_PER_HOUR = 3600;

let scenarioDurationSeconds = 24 * SECONDS_PER_HOUR;
let scenarioTimeStepSeconds = 120;
let scenarioUseJ2 = false;

const PLANE_RAAN_BIN_DEG = 6.0;
const PLANE_INC_BIN_DEG = 1.0;

const SATELLITE_SPRITE_SCALE = 0.026;
const TRAJECTORY_RADIUS = 0.0008;
const COUNTRY_LINE_RADIUS = 0.00045;
const FOCUS_LINE_RADIUS = 0.00125;

const COVERAGE_HISTORY_LIMIT = 30;

function coverageWindowSeconds() {
  return (COVERAGE_HISTORY_LIMIT - 1) * scenarioTimeStepSeconds;
}

const GLOBAL_TESSELLATION_POINT_COUNT = 15000;

const COLOR_MIN = "#222222";
const COLOR_AVG = "#eaaa00";
const COLOR_MAX = "#777777";

const COVERAGE_ZERO_COLOR = "#eeeeee";
const COVERAGE_LOW_COLOR = "#fffdf1";
const COVERAGE_MID_LOW_COLOR = "#fff4b8";
const COVERAGE_MID_COLOR = "#ffe066";
const COVERAGE_HIGH_COLOR = "#eaaa00";
const COVERAGE_TOP_COLOR = "#b87900";
const ZERO_REGION_STROKE = "#4a4a4a";

let manifest = [];
let satObjects = [];
let trajectoryObjects = [];
let planeModels = [];

let targetPositions = [];
let targetLatLon = [];
let targetCoverageCounts = [];

let globalCellLatLon = [];
let globalCellPositions = [];
let globalCoverageCounts = [];

let coverageHistory = [];
let coverageCurrentMetrics = null;
let lastCoverageSampleSeconds = null;
let deferredMapDrawTimer = null;
let killRadiusKm = null;
let interceptAltitudeKm = 200;
let minElevationDeg = 0;
let focusLatDeg = 35.0;
let focusLonDeg = 103.0;

let worldFeatures = [];
let worldGeoJson = null;
let activeSatelliteMaterial = null;
let inactiveSatelliteMaterial = null;

let simulationSeconds = 0;
let lastFrameTime = performance.now();
let isPlaying = true;
let playbackMultiplier = 1.0;
let isHorizonView = false;

let visualizationMode = "3d";
let mapCells = [];
let mapProjection = null;
let mapPath = null;
let mapMaxCoverage = 1;
let mapColorScaleMax = 1;
let mapNeedsGeometryRebuild = true;

let mapZoom = 1;
let mapPanX = 0;
let mapPanY = 0;
let isMapDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let dragStartPanX = 0;
let dragStartPanY = 0;

let pinchStartDistance = 0;
let pinchStartZoom = 1;
let pinchStartPanX = 0;
let pinchStartPanY = 0;
let pinchCenterX = 0;
let pinchCenterY = 0;

const BASE_PLAYBACK_SIM_HOURS_PER_REAL_SECOND = 0.02;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xffffff);

const camera = new THREE.PerspectiveCamera(
  38,
  window.innerWidth / window.innerHeight,
  0.01,
  1000
);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true
});

renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.sortObjects = true;

document.getElementById("canvas-wrap").appendChild(renderer.domElement);

const mapCanvas = document.getElementById("map2dCanvas");
const mapCtx = mapCanvas ? mapCanvas.getContext("2d") : null;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const earthGroup = new THREE.Group();
const countryLineGroup = new THREE.Group();
const focusCountryLineGroup = new THREE.Group();
const trajectoryGroup = new THREE.Group();
const constellationGroup = new THREE.Group();

scene.add(earthGroup);
scene.add(countryLineGroup);
scene.add(focusCountryLineGroup);
scene.add(trajectoryGroup);
scene.add(constellationGroup);

const statusEl = document.getElementById("status");

const playBtn = document.getElementById("playBtn");
const speedHalfBtn = document.getElementById("speedHalfBtn");
const speedOneBtn = document.getElementById("speedOneBtn");
const speedTwoBtn = document.getElementById("speedTwoBtn");
const timelineSlider = document.getElementById("timelineSlider");

const zoomInBtn = document.getElementById("zoomInBtn");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const viewToggleBtn = document.getElementById("viewToggleBtn");

const mode3DBtn = document.getElementById("mode3DBtn");
const mode2DBtn = document.getElementById("mode2DBtn");

const cameraControls = document.getElementById("cameraControls");

const legend3D = document.getElementById("legend3D");
const legend2D = document.getElementById("legend2D");
const coverageMaxLabel = document.getElementById("coverageMaxLabel");

const countrySelect = document.getElementById("countrySelect");
const interceptorSelect = document.getElementById("interceptorSelect");
const salvoSelect = document.getElementById("salvoSelect");

const satelliteStat = document.getElementById("satelliteStat");
const planeStat = document.getElementById("planeStat");

const coverageChart = document.getElementById("coverageChart");
const coverageChartCtx = coverageChart ? coverageChart.getContext("2d") : null;

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function setStats(nSatellites = null, nPlanes = null) {
  satelliteStat.textContent = nSatellites === null
    ? "—"
    : Number(nSatellites).toLocaleString();

  planeStat.textContent = nPlanes === null
    ? "—"
    : Number(nPlanes).toLocaleString();
}

function formatCoverageValue(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }

  return Number(value).toLocaleString(undefined, {
    maximumFractionDigits: 1
  });
}

function updateCoverageLegendMax() {
  if (!coverageMaxLabel) return;
  coverageMaxLabel.textContent = String(Math.max(1, Math.round(mapColorScaleMax)));
}

function formatTimeHHMM(seconds) {
  const loopSeconds = scenarioDurationSeconds;
  const wrapped = ((seconds % loopSeconds) + loopSeconds) % loopSeconds;
  const totalMinutes = Math.floor(wrapped / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function resetCoverageHistory() {
  coverageHistory = [];
  coverageCurrentMetrics = null;
  lastCoverageSampleSeconds = null;
  drawCoverageChart();
}

function restartCoverageHistoryAtTime(timeSeconds) {
  coverageHistory = [];
  coverageCurrentMetrics = null;
  lastCoverageSampleSeconds = null;

  const metrics = sampleCoverageAtTime(timeSeconds);
  addCoverageSampleAtTime(timeSeconds, metrics);
  drawCoverageChart();
}

function satelliteCoversPoint(satPos, pointPos, killRadiusSceneSq) {
  if (satPos.distanceToSquared(pointPos) > killRadiusSceneSq) {
    return false;
  }

  const lineOfSight = satPos.clone().sub(pointPos);
  const lineOfSightLength = lineOfSight.length();

  if (lineOfSightLength <= 0) {
    return false;
  }

  const localUp = pointPos.clone().normalize();
  const sinElevation = lineOfSight.dot(localUp) / lineOfSightLength;
  const minSinElevation = Math.sin(degToRad(minElevationDeg));

  return sinElevation >= minSinElevation;
}

function computeCountsForPositions(positions, timeSeconds = simulationSeconds) {
  const counts = positions.map(() => 0);

  if (!killRadiusKm || positions.length === 0 || satObjects.length === 0) {
    return counts;
  }

  const killRadiusScene = killRadiusKm / EARTH_RADIUS_KM;
  const killRadiusSceneSq = killRadiusScene * killRadiusScene;

  satObjects.forEach(obj => {
    const satPos = analyticalOrbitalPosition(obj.row, timeSeconds);

    positions.forEach((pointPos, idx) => {
      if (satelliteCoversPoint(satPos, pointPos, killRadiusSceneSq)) {
        counts[idx] += 1;
      }
    });
  });

  return counts;
}

function updateMapColorScaleMax(currentMax) {
  mapMaxCoverage = Math.max(1, currentMax);
  mapColorScaleMax = Math.max(mapColorScaleMax, mapMaxCoverage);
  updateCoverageLegendMax();
}

function computeCoverageMetrics(updateMaterials = false, timeSeconds = simulationSeconds) {
  if (!killRadiusKm || targetPositions.length === 0 || satObjects.length === 0) {
    targetCoverageCounts = targetPositions.map(() => 0);

    if (updateMaterials && activeSatelliteMaterial) {
      satObjects.forEach(obj => {
        obj.sprite.material = activeSatelliteMaterial;
      });
    }

    return null;
  }

  const countsByTarget = targetPositions.map(() => 0);
  const activeSatellites = new Set();
  const killRadiusScene = killRadiusKm / EARTH_RADIUS_KM;
  const killRadiusSceneSq = killRadiusScene * killRadiusScene;

  satObjects.forEach((obj, satIdx) => {
    const satPos = analyticalOrbitalPosition(obj.row, timeSeconds);

    targetPositions.forEach((targetPos, targetIdx) => {
      if (satelliteCoversPoint(satPos, targetPos, killRadiusSceneSq)) {
        countsByTarget[targetIdx] += 1;
        activeSatellites.add(satIdx);
      }
    });
  });

  targetCoverageCounts = countsByTarget;

  if (visualizationMode === "2d") {
    globalCoverageCounts = computeCountsForPositions(globalCellPositions, timeSeconds);
    updateMapColorScaleMax(Math.max(1, ...globalCoverageCounts));
  }

  if (updateMaterials) {
    satObjects.forEach((obj, satIdx) => {
      obj.sprite.material = activeSatellites.has(satIdx)
        ? activeSatelliteMaterial
        : inactiveSatelliteMaterial;
    });
  }

  const min = Math.min(...countsByTarget);
  const max = Math.max(...countsByTarget);
  const avg = countsByTarget.reduce((sum, value) => sum + value, 0) / countsByTarget.length;

  return {
    min,
    avg,
    max,
    activeSatellites: activeSatellites.size
  };
}

function addCoverageSampleAtTime(timeSeconds, metrics) {
  if (!metrics) return;

  coverageHistory.push({
    timeSeconds,
    min: metrics.min,
    avg: metrics.avg,
    max: metrics.max
  });

  while (coverageHistory.length > COVERAGE_HISTORY_LIMIT) {
    coverageHistory.shift();
  }

  lastCoverageSampleSeconds = timeSeconds;
}

function sampleCoverageAtTime(timeSeconds) {
  satObjects.forEach(obj => {
    obj.sprite.position.copy(orbitalPosition(obj.row, timeSeconds));
  });

  return computeCoverageMetrics(false, timeSeconds);
}

function shouldAddCoverageSample(force = false) {
  if (force || lastCoverageSampleSeconds === null) return true;

  const loopSeconds = scenarioDurationSeconds;
  const rawDelta = simulationSeconds - lastCoverageSampleSeconds;
  const wrappedDelta = rawDelta < 0 ? rawDelta + loopSeconds : rawDelta;

  return wrappedDelta >= scenarioTimeStepSeconds;
}

function addCoverageSample(metrics, force = false) {
  if (!metrics) return;

  if (shouldAddCoverageSample(force)) {
    const sampleTime = force
      ? simulationSeconds
      : Math.floor(simulationSeconds / scenarioTimeStepSeconds) * scenarioTimeStepSeconds;

    const sampledMetrics = sampleCoverageAtTime(sampleTime);
    addCoverageSampleAtTime(sampleTime, sampledMetrics);
  }

  drawCoverageChart();
}

function fillCoverageHistoryToTime(targetSeconds) {
  if (satObjects.length === 0 || targetPositions.length === 0 || !killRadiusKm) {
    return;
  }

  const loopSeconds = scenarioDurationSeconds;
  const target = Math.max(0, Math.min(loopSeconds, targetSeconds));
  const epsilon = 0.0001;

  const shouldRebuild =
    lastCoverageSampleSeconds === null ||
    target + epsilon < lastCoverageSampleSeconds ||
    target - lastCoverageSampleSeconds > coverageWindowSeconds();

  if (shouldRebuild) {
    coverageHistory = [];
    lastCoverageSampleSeconds = null;

    const windowStart = Math.max(0, target - coverageWindowSeconds());
    const firstSample =
      Math.ceil(windowStart / scenarioTimeStepSeconds) *
      scenarioTimeStepSeconds;

    let sampleTime = Math.max(0, firstSample);

    if (sampleTime > target + epsilon) {
      sampleTime = target;
    }

    while (sampleTime <= target + epsilon) {
      const metrics = sampleCoverageAtTime(sampleTime);
      addCoverageSampleAtTime(sampleTime, metrics);
      sampleTime += scenarioTimeStepSeconds;
    }

    if (
      coverageHistory.length === 0 ||
      Math.abs(coverageHistory[coverageHistory.length - 1].timeSeconds - target) > epsilon
    ) {
      const metricsAtTarget = sampleCoverageAtTime(target);
      addCoverageSampleAtTime(target, metricsAtTarget);
    }

    drawCoverageChart();
    return;
  }

  let nextSampleTime =
    lastCoverageSampleSeconds + scenarioTimeStepSeconds;

  while (nextSampleTime <= target + epsilon) {
    const metrics = sampleCoverageAtTime(nextSampleTime);
    addCoverageSampleAtTime(nextSampleTime, metrics);
    nextSampleTime += scenarioTimeStepSeconds;
  }

  if (
    coverageHistory.length === 0 ||
    Math.abs(coverageHistory[coverageHistory.length - 1].timeSeconds - target) > epsilon
  ) {
    const metricsAtTarget = sampleCoverageAtTime(target);
    addCoverageSampleAtTime(target, metricsAtTarget);
  }

  drawCoverageChart();
}

function drawStepLine(ctx, points, strokeStyle, lineWidth) {
  if (!points || points.length === 0) return;

  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = lineWidth;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";

  ctx.beginPath();

  if (points.length === 1) {
    ctx.moveTo(points[0].x - 1, points[0].y);
    ctx.lineTo(points[0].x + 1, points[0].y);
    ctx.stroke();
    return;
  }

  ctx.moveTo(points[0].x, points[0].y);

  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];

    ctx.lineTo(curr.x, prev.y);
    ctx.lineTo(curr.x, curr.y);
  }

  ctx.stroke();
}

function drawRightSideValueLabel(ctx, label, value, y, color, chartRight, cssWidth) {
  const x = chartRight + 5;
  const text = `${label} ${formatCoverageValue(value)}`;

  ctx.font = "bold 10.5px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";

  const measured = ctx.measureText(text);
  const boxWidth = Math.min(cssWidth - x - 2, measured.width + 7);
  const boxHeight = 15;

  ctx.fillStyle = "rgba(255,255,255,.86)";
  ctx.fillRect(x - 3, y - boxHeight / 2, boxWidth, boxHeight);

  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function drawCoverageChart() {
  if (!coverageChart || !coverageChartCtx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = coverageChart.clientWidth || 280;
  const cssHeight = coverageChart.clientHeight || 142;

  const nextWidth = Math.round(cssWidth * dpr);
  const nextHeight = Math.round(cssHeight * dpr);

  if (coverageChart.width !== nextWidth || coverageChart.height !== nextHeight) {
    coverageChart.width = nextWidth;
    coverageChart.height = nextHeight;
  }

  const ctx = coverageChartCtx;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const chartLeft = 34;
  const chartRight = cssWidth - 62;
  const chartTop = 13;
  const chartBottom = cssHeight - 28;
  const chartWidth = chartRight - chartLeft;
  const chartHeight = chartBottom - chartTop;

  ctx.strokeStyle = "#e7e7e7";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 3; i += 1) {
    const y = chartTop + chartHeight * (i / 3);
    ctx.beginPath();
    ctx.moveTo(chartLeft, y);
    ctx.lineTo(chartRight, y);
    ctx.stroke();
  }

  ctx.strokeStyle = "#cfcfcf";
  ctx.beginPath();
  ctx.moveTo(chartLeft, chartTop);
  ctx.lineTo(chartLeft, chartBottom);
  ctx.lineTo(chartRight, chartBottom);
  ctx.stroke();

  ctx.save();
  ctx.translate(10, chartTop + chartHeight / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = "#555555";
  ctx.font = "10.5px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("Satellites", 0, -6);
  ctx.fillText("within range", 0, 6);
  ctx.restore();

  if (coverageHistory.length === 0) {
    ctx.fillStyle = "#999999";
    ctx.font = "12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("", chartLeft, cssHeight / 2 + 4);
    ctx.restore();
    return;
  }

  const allValues = [];

  coverageHistory.forEach(sample => {
    allValues.push(sample.min, sample.avg, sample.max);
  });

  const maxValue = Math.max(1, ...allValues);

  function makePoints(series) {
    const visibleWindowSeconds = coverageWindowSeconds();
    const visibleEndSeconds = simulationSeconds;

    return series
      .map((value, idx) => {
        const sample = coverageHistory[idx];
        const sampleTime = sample.timeSeconds;

        const ageSeconds = visibleEndSeconds - sampleTime;
        const fracFromRight = visibleWindowSeconds <= 0
          ? 0
          : ageSeconds / visibleWindowSeconds;

        const x = chartRight - (fracFromRight * chartWidth);
        const normalized = Math.min(1, Math.max(0, value / maxValue));
        const y = chartBottom - normalized * chartHeight;

        return { x, y, value };
      })
      .filter(point => point.x >= chartLeft - 2 && point.x <= chartRight + 2);
  }

  const minPoints = makePoints(coverageHistory.map(sample => sample.min));
  const avgPoints = makePoints(coverageHistory.map(sample => sample.avg));
  const maxPoints = makePoints(coverageHistory.map(sample => sample.max));

  drawStepLine(ctx, maxPoints, COLOR_MAX, 1.8);
  drawStepLine(ctx, avgPoints, COLOR_AVG, 2.2);
  drawStepLine(ctx, minPoints, COLOR_MIN, 2.0);

  const latest = coverageHistory[coverageHistory.length - 1];
  const latestMaxPoint = maxPoints[maxPoints.length - 1];
  const latestAvgPoint = avgPoints[avgPoints.length - 1];
  const latestMinPoint = minPoints[minPoints.length - 1];

  ctx.fillStyle = "#555555";
  ctx.font = "10px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText("0", chartLeft - 5, chartBottom);
  ctx.fillText(formatCoverageValue(maxValue), chartLeft - 5, chartTop);

  const tickCount = 4;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillStyle = "#666666";

  const visibleWindowSeconds = coverageWindowSeconds();
  const tickIntervalSeconds = visibleWindowSeconds / tickCount;
  const newestTickTimeSeconds =
    Math.floor(simulationSeconds / tickIntervalSeconds) * tickIntervalSeconds;

  for (let i = 0; i <= tickCount; i += 1) {
    const tickTimeSeconds = newestTickTimeSeconds - ((tickCount - i) * tickIntervalSeconds);

    if (tickTimeSeconds < 0) {
      continue;
    }

    const ageSeconds = simulationSeconds - tickTimeSeconds;
    const fracFromRight = visibleWindowSeconds <= 0
      ? 0
      : ageSeconds / visibleWindowSeconds;

    const x = chartRight - (fracFromRight * chartWidth);

    if (x < chartLeft || x > chartRight) {
      continue;
    }

    const label = formatTimeHHMM(tickTimeSeconds);

    ctx.strokeStyle = "#dddddd";
    ctx.beginPath();
    ctx.moveTo(x, chartBottom);
    ctx.lineTo(x, chartBottom + 3);
    ctx.stroke();

    ctx.fillText(label, x, chartBottom + 6);
  }

  if (latestMaxPoint) {
    drawRightSideValueLabel(ctx, "Max", latest.max, latestMaxPoint.y, COLOR_MAX, chartRight, cssWidth);
  }

  if (latestAvgPoint) {
    drawRightSideValueLabel(ctx, "Avg", latest.avg, latestAvgPoint.y, COLOR_AVG, chartRight, cssWidth);
  }

  if (latestMinPoint) {
    drawRightSideValueLabel(ctx, "Min", latest.min, latestMinPoint.y, COLOR_MIN, chartRight, cssWidth);
  }

  ctx.restore();
}

function parseHexColor(hex) {
  const clean = hex.replace("#", "");

  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  };
}

function interpolateHexColor(a, b, t) {
  const ca = parseHexColor(a);
  const cb = parseHexColor(b);
  const clamped = Math.max(0, Math.min(1, t));

  const r = Math.round(ca.r + (cb.r - ca.r) * clamped);
  const g = Math.round(ca.g + (cb.g - ca.g) * clamped);
  const bValue = Math.round(ca.b + (cb.b - ca.b) * clamped);

  return `rgb(${r},${g},${bValue})`;
}

function coverageColor(count, maxCount) {
  if (!count || count <= 0) return COVERAGE_ZERO_COLOR;

  const t = Math.max(0, Math.min(1, count / Math.max(1, maxCount)));

  if (t < 0.25) {
    return interpolateHexColor(COVERAGE_LOW_COLOR, COVERAGE_MID_LOW_COLOR, t / 0.25);
  }

  if (t < 0.5) {
    return interpolateHexColor(COVERAGE_MID_LOW_COLOR, COVERAGE_MID_COLOR, (t - 0.25) / 0.25);
  }

  if (t < 0.75) {
    return interpolateHexColor(COVERAGE_MID_COLOR, COVERAGE_HIGH_COLOR, (t - 0.5) / 0.25);
  }

  return interpolateHexColor(COVERAGE_HIGH_COLOR, COVERAGE_TOP_COLOR, (t - 0.75) / 0.25);
}

function generateGlobalFibonacciCells(count = GLOBAL_TESSELLATION_POINT_COUNT) {
  const cells = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let i = 0; i < count; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * i;

    const x = Math.cos(theta) * radius;
    const z = Math.sin(theta) * radius;

    const lat = radToDeg(Math.asin(y));
    const lon = normalizeLonDeg(radToDeg(Math.atan2(z, x)));

    cells.push({ lat, lon });
  }

  return cells;
}

function normalizeLonDeg(lon) {
  let normalized = ((lon + 180) % 360 + 360) % 360 - 180;

  if (normalized === -180) normalized = 180;

  return normalized;
}

function resizeMapCanvas() {
  if (!mapCanvas || !mapCtx) return;

  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;

  const nextWidth = Math.round(width * dpr);
  const nextHeight = Math.round(height * dpr);

  if (mapCanvas.width !== nextWidth || mapCanvas.height !== nextHeight) {
    mapCanvas.width = nextWidth;
    mapCanvas.height = nextHeight;
    mapNeedsGeometryRebuild = true;
  }

  mapCanvas.style.width = `${width}px`;
  mapCanvas.style.height = `${height}px`;
}

function getUiBounds() {
  const ui = document.getElementById("ui");

  if (!ui) {
    return {
      left: 18,
      right: 370,
      top: 18,
      bottom: window.innerHeight - 18
    };
  }

  return ui.getBoundingClientRect();
}

function getAvailableMapExtent() {
  const ui = getUiBounds();
  const margin = 22;

  return {
    left: ui.right + margin,
    top: margin,
    right: window.innerWidth - margin,
    bottom: window.innerHeight - margin,
    width: Math.max(100, window.innerWidth - ui.right - margin * 2),
    height: Math.max(100, window.innerHeight - margin * 2)
  };
}

function resetMapView() {
  mapZoom = 1;
  mapPanX = 0;
  mapPanY = 0;
  mapNeedsGeometryRebuild = true;
}

function makeMapProjection() {
  const extent = getAvailableMapExtent();
  const projection = geoMollweide();

  projection.fitExtent(
    [[extent.left, extent.top], [extent.right, extent.bottom]],
    { type: "Sphere" }
  );

  const translate = projection.translate();
  const scale = projection.scale();

  projection
    .scale(scale * mapZoom)
    .translate([
      translate[0] + mapPanX,
      translate[1] + mapPanY
    ]);

  return projection;
}

function projectMapPoint(target) {
  const projected = mapProjection([target.lon, target.lat]);

  if (!projected || !Number.isFinite(projected[0]) || !Number.isFinite(projected[1])) {
    return null;
  }

  return projected;
}

function rebuildMapGeometry() {
  if (!mapCanvas || !mapCtx || globalCellLatLon.length === 0) {
    mapCells = [];
    return;
  }

  resizeMapCanvas();

  const width = window.innerWidth;
  const height = window.innerHeight;

  mapProjection = makeMapProjection();
  mapPath = geoPath(mapProjection, mapCtx);

  const projectedPoints = globalCellLatLon
    .map((target, idx) => {
      const projected = projectMapPoint(target);

      if (!projected) return null;

      return {
        idx,
        x: projected[0],
        y: projected[1]
      };
    })
    .filter(Boolean);

  if (projectedPoints.length < 3) {
    mapCells = [];
    return;
  }

  const visibleBuffer = 260 * mapZoom;

  const delaunay = Delaunay.from(
    projectedPoints,
    point => point.x,
    point => point.y
  );

  const voronoi = delaunay.voronoi([
    -visibleBuffer,
    -visibleBuffer,
    width + visibleBuffer,
    height + visibleBuffer
  ]);

  mapCells = projectedPoints.map((point, localIdx) => {
    const polygon = voronoi.cellPolygon(localIdx);
    const path = new Path2D();
    const vertices = [];

    if (polygon && polygon.length > 0) {
      polygon.forEach(([x, y], vertexIdx) => {
        vertices.push([x, y]);

        if (vertexIdx === 0) {
          path.moveTo(x, y);
        } else {
          path.lineTo(x, y);
        }
      });

      path.closePath();
    }

    return {
      targetIdx: point.idx,
      path,
      vertices
    };
  });

  mapNeedsGeometryRebuild = false;
}

function drawMapBoundaries() {
  if (!mapCtx || !mapPath || !worldGeoJson) return;

  mapCtx.save();

  mapCtx.strokeStyle = "rgba(80,80,80,.42)";
  mapCtx.lineWidth = 0.55;

  mapCtx.beginPath();
  mapPath(worldGeoJson);
  mapCtx.stroke();

  const selectedCountry = countrySelect.value;
  const focusFeatures = worldFeatures.filter(feature =>
    countryMatches(feature.properties?.name || "", selectedCountry)
  );

  if (focusFeatures.length > 0) {
    mapCtx.strokeStyle = "rgba(20,20,20,.9)";
    mapCtx.lineWidth = 1.25;

    focusFeatures.forEach(feature => {
      mapCtx.beginPath();
      mapPath(feature);
      mapCtx.stroke();
    });
  }

  mapCtx.restore();
}

function edgeKey(a, b) {
  const ar = `${Math.round(a[0] * 10) / 10},${Math.round(a[1] * 10) / 10}`;
  const br = `${Math.round(b[0] * 10) / 10},${Math.round(b[1] * 10) / 10}`;

  return ar < br ? `${ar}|${br}` : `${br}|${ar}`;
}

function drawZeroCoverageOutlines() {
  if (!mapCtx || mapCells.length === 0) return;

  const edgeMap = new Map();

  mapCells.forEach(cell => {
    const count = globalCoverageCounts[cell.targetIdx] || 0;
    if (count > 0 || !cell.vertices || cell.vertices.length < 3) return;

    for (let i = 0; i < cell.vertices.length; i += 1) {
      const a = cell.vertices[i];
      const b = cell.vertices[(i + 1) % cell.vertices.length];
      const length = Math.hypot(a[0] - b[0], a[1] - b[1]);

      if (length < 1.5) continue;

      const key = edgeKey(a, b);

      if (edgeMap.has(key)) {
        edgeMap.delete(key);
      } else {
        edgeMap.set(key, [a, b]);
      }
    }
  });

  mapCtx.save();
  mapCtx.strokeStyle = ZERO_REGION_STROKE;
  mapCtx.lineWidth = 1.05;
  mapCtx.lineCap = "butt";
  mapCtx.lineJoin = "round";

  edgeMap.forEach(([a, b]) => {
    mapCtx.beginPath();
    mapCtx.moveTo(a[0], a[1]);
    mapCtx.lineTo(b[0], b[1]);
    mapCtx.stroke();
  });

  mapCtx.restore();
}

function scheduleDeferredMapDraw(delayMs = 80) {
  if (deferredMapDrawTimer !== null) {
    clearTimeout(deferredMapDrawTimer);
  }

  deferredMapDrawTimer = setTimeout(() => {
    deferredMapDrawTimer = null;
    draw2DMap();
  }, delayMs);
}

function draw2DMap() {
  if (visualizationMode !== "2d" || !mapCanvas || !mapCtx) return;

  resizeMapCanvas();

  const dpr = window.devicePixelRatio || 1;
  const width = window.innerWidth;
  const height = window.innerHeight;

  if (mapNeedsGeometryRebuild) {
    rebuildMapGeometry();
  }

  mapCtx.save();
  mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  mapCtx.clearRect(0, 0, width, height);

  mapCtx.fillStyle = "#ffffff";
  mapCtx.fillRect(0, 0, width, height);

  if (!mapPath) {
    mapCtx.restore();
    return;
  }

  mapCtx.save();
  mapCtx.beginPath();
  mapPath({ type: "Sphere" });
  mapCtx.clip();

  mapCells.forEach(cell => {
    const count = globalCoverageCounts[cell.targetIdx] || 0;
    mapCtx.fillStyle = coverageColor(count, mapColorScaleMax);
    mapCtx.fill(cell.path);
  });

  drawZeroCoverageOutlines();

  mapCtx.restore();

  mapCtx.strokeStyle = "#d0d0d0";
  mapCtx.lineWidth = 0.8;
  mapCtx.beginPath();
  mapPath({ type: "Sphere" });
  mapCtx.stroke();

  drawMapBoundaries();

  mapCtx.restore();
}

function setVisualizationMode(mode) {
  visualizationMode = mode;

  if (mode === "2d") {
    clear3DViewOffset();

    renderer.domElement.style.display = "none";
    if (mapCanvas) mapCanvas.style.display = "block";
    if (cameraControls) cameraControls.style.display = "flex";
    if (viewToggleBtn) viewToggleBtn.style.display = "none";
    if (legend3D) legend3D.style.display = "none";
    if (legend2D) legend2D.style.display = "block";

    mode2DBtn.classList.add("activeViewSwitch");
    mode3DBtn.classList.remove("activeViewSwitch");

    resetMapView();
    globalCoverageCounts = computeCountsForPositions(globalCellPositions);
    updateMapColorScaleMax(Math.max(1, ...globalCoverageCounts));
    mapNeedsGeometryRebuild = true;
    draw2DMap();
  } else {
    renderer.domElement.style.display = "block";
    if (mapCanvas) mapCanvas.style.display = "none";
    if (cameraControls) cameraControls.style.display = "flex";
    if (viewToggleBtn) viewToggleBtn.style.display = "block";
    if (legend3D) legend3D.style.display = "grid";
    if (legend2D) legend2D.style.display = "none";

    mode3DBtn.classList.add("activeViewSwitch");
    mode2DBtn.classList.remove("activeViewSwitch");

    if (!isHorizonView) {
      setFullEarthView();
    } else {
      setHorizonView();
    }

    renderer.render(scene, camera);
  }
}

function zoom2DMap(factor, centerX = window.innerWidth / 2, centerY = window.innerHeight / 2) {
  const previousZoom = mapZoom;
  const nextZoom = Math.max(1, Math.min(8, mapZoom * factor));

  if (nextZoom === previousZoom) return;

  mapPanX = centerX - ((centerX - mapPanX) * nextZoom / previousZoom);
  mapPanY = centerY - ((centerY - mapPanY) * nextZoom / previousZoom);
  mapZoom = nextZoom;

  if (mapZoom <= 1.0001) {
    mapPanX = 0;
    mapPanY = 0;
  }

  mapNeedsGeometryRebuild = true;
  draw2DMap();
}

function updatePlaybackButton() {
  if (isPlaying) {
    playBtn.innerHTML = `
      <span class="pauseIcon"></span>
    `;
  } else {
    playBtn.innerHTML = `
      <span class="playIcon"></span>
    `;
  }
}

function setPlaybackMultiplier(multiplier) {
  playbackMultiplier = multiplier;

  [speedHalfBtn, speedOneBtn, speedTwoBtn].forEach(btn => {
    btn.classList.remove("activeSpeed");
  });

  if (multiplier === 0.5) speedHalfBtn.classList.add("activeSpeed");
  if (multiplier === 1.0) speedOneBtn.classList.add("activeSpeed");
  if (multiplier === 2.0) speedTwoBtn.classList.add("activeSpeed");
}

function degToRad(d) {
  return d * Math.PI / 180;
}

function radToDeg(r) {
  return r * 180 / Math.PI;
}

function normalizeDeg(d) {
  return ((d % 360) + 360) % 360;
}

function formatThreatRegionName(name) {
  const normalized = String(name || "")
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .trim()
    .toLowerCase();

  if (normalized === "china") return "China";
  if (normalized === "iran") return "Iran";
  if (normalized === "russia") return "Russia";
  if (normalized === "north korea") return "North Korea";

  return normalized.replace(/\b\w/g, char => char.toUpperCase());
}

function normalizeCountryName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/-/g, " ")
    .trim();
}

function countryMatches(featureName, selectedName) {
  const a = normalizeCountryName(featureName);
  const b = normalizeCountryName(selectedName);

  if (a === b) return true;

  if (b === "north korea" && a.includes("korea")) {
    return a.includes("north") || a.includes("dem");
  }

  if (b === "russia" && a.includes("russia")) return true;
  if (b === "iran" && a.includes("iran")) return true;
  if (b === "china" && a === "china") return true;

  return false;
}

function meanAngleDeg(values) {
  let sx = 0;
  let sy = 0;

  values.forEach(v => {
    const r = degToRad(v);
    sx += Math.cos(r);
    sy += Math.sin(r);
  });

  return normalizeDeg(radToDeg(Math.atan2(sy, sx)));
}

function latLonToVector3(latDeg, lonDeg, radius = 1) {
  const lat = degToRad(latDeg);
  const lon = degToRad(lonDeg);

  return new THREE.Vector3(
    radius * Math.cos(lat) * Math.cos(lon),
    radius * Math.sin(lat),
    -radius * Math.cos(lat) * Math.sin(lon)
  );
}

function rotateInertialVectorToEarthFixed(position, tSeconds) {
  return position
    .clone()
    .applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      EARTH_ROTATION_RATE_RAD_PER_SEC * tSeconds
    );
}

function makeSatelliteSpriteTexture(fillColor, strokeColor) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, 128, 128);

  ctx.beginPath();
  ctx.arc(64, 64, 37, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();

  ctx.lineWidth = 12;
  ctx.strokeStyle = strokeColor;
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  return texture;
}

function makeFallbackEarth() {
  const earth = new THREE.Mesh(
    new THREE.SphereGeometry(1, 160, 160),
    new THREE.MeshBasicMaterial({
      color: 0xf7f7f7,
      depthTest: true,
      depthWrite: true
    })
  );

  earth.renderOrder = 0;
  earthGroup.add(earth);
}

async function loadWorldBoundaries() {
  const url = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
  const res = await fetch(url);
  const topology = await res.json();
  const countries = topojson.feature(topology, topology.objects.countries);

  worldFeatures = countries.features;
  worldGeoJson = countries;

  redrawCountryBoundaries();
  mapNeedsGeometryRebuild = true;
  draw2DMap();
}

function redrawCountryBoundaries() {
  clearGroup(countryLineGroup);
  clearGroup(focusCountryLineGroup);

  const selectedCountry = countrySelect.value;

  worldFeatures.forEach(feature => {
    const name = feature.properties?.name || "";
    const isFocus = countryMatches(name, selectedCountry);
    addCountryBoundary(feature.geometry, isFocus);
  });

  draw2DMap();
}

function addCountryBoundary(geometry, isFocus) {
  if (!geometry) return;

  if (geometry.type === "Polygon") {
    geometry.coordinates.forEach(ring => addBoundaryTube(ring, isFocus));
  }

  if (geometry.type === "MultiPolygon") {
    geometry.coordinates.forEach(poly => {
      poly.forEach(ring => addBoundaryTube(ring, isFocus));
    });
  }
}

function addBoundaryTube(ring, isFocus) {
  if (!ring || ring.length < 3) return;

  const radius = isFocus ? 1.0012 : 1.001;
  const points = ring.map(([lon, lat]) => latLonToVector3(lat, lon, radius));

  const curve = new THREE.CatmullRomCurve3(points, true);
  const tubeRadius = isFocus ? FOCUS_LINE_RADIUS : COUNTRY_LINE_RADIUS;

  const geom = new THREE.TubeGeometry(
    curve,
    Math.max(24, points.length * 2),
    tubeRadius,
    isFocus ? 8 : 5,
    true
  );

  const mat = new THREE.MeshBasicMaterial({
    color: isFocus ? 0x0a0a0a : 0xa8a8a8,
    transparent: true,
    opacity: isFocus ? 1.0 : 0.62,
    depthTest: true,
    depthWrite: false
  });

  const tube = new THREE.Mesh(geom, mat);
  tube.renderOrder = isFocus ? 8 : 3;

  if (isFocus) {
    focusCountryLineGroup.add(tube);
  } else {
    countryLineGroup.add(tube);
  }
}

function j2RaanRateRadPerSec(aKm, e, iRad) {
  const J2 = 1.08262668e-3;
  const earthRadiusKm = EARTH_RADIUS_KM;
  const n = Math.sqrt(MU_EARTH_KM3_S2 / Math.pow(aKm, 3));
  const p = aKm * (1 - e * e);

  return -1.5 * J2 * n * Math.pow(earthRadiusKm / p, 2) * Math.cos(iRad);
}

function raanAtTimeRad(raan0Rad, aKm, e, iRad, tSeconds) {
  if (!scenarioUseJ2) {
    return raan0Rad;
  }

  return raan0Rad + j2RaanRateRadPerSec(aKm, e, iRad) * tSeconds;
}

function orbitalPosition(row, tSeconds) {
  const displayPlane = row.assignedPlane || row;

  const a = Number(displayPlane.a_km ?? row.a_km);
  const i = degToRad(Number(displayPlane.i_deg ?? row.i_deg));
  const raan0 = degToRad(Number(displayPlane.raan_deg ?? row.raan_deg));
  const argLat0 = degToRad(Number(row.arg_lat_deg || 0));

  const n = Math.sqrt(MU_EARTH_KM3_S2 / Math.pow(a, 3));
  const raan = raanAtTimeRad(raan0, a, 0, i, tSeconds);
  const argLat = argLat0 + n * tSeconds;

  const xOrb = a * Math.cos(argLat);
  const yOrb = a * Math.sin(argLat);

  const cosO = Math.cos(raan);
  const sinO = Math.sin(raan);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);

  const x = xOrb * cosO - yOrb * sinO * cosI;
  const y = xOrb * sinO + yOrb * cosO * cosI;
  const z = yOrb * sinI;

  const inertialPosition = new THREE.Vector3(x * SCALE, z * SCALE, -y * SCALE);

  return rotateInertialVectorToEarthFixed(inertialPosition, tSeconds);
}

function analyticalOrbitalPosition(row, tSeconds) {
  const a = Number(row.a_km);
  const i = degToRad(Number(row.i_deg));
  const raan0 = degToRad(Number(row.raan_deg));
  const argLat0 = degToRad(Number(row.arg_lat_deg || 0));

  const n = Math.sqrt(MU_EARTH_KM3_S2 / Math.pow(a, 3));
  const raan = raanAtTimeRad(raan0, a, 0, i, tSeconds);
  const argLat = argLat0 + n * tSeconds;

  const xOrb = a * Math.cos(argLat);
  const yOrb = a * Math.sin(argLat);

  const cosO = Math.cos(raan);
  const sinO = Math.sin(raan);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);

  const x = xOrb * cosO - yOrb * sinO * cosI;
  const y = xOrb * sinO + yOrb * cosO * cosI;
  const z = yOrb * sinI;

  const inertialPosition = new THREE.Vector3(x * SCALE, z * SCALE, -y * SCALE);

  return rotateInertialVectorToEarthFixed(inertialPosition, tSeconds);
}

function orbitalPlanePoint(plane, uDeg, tSeconds) {
  const a = plane.a_km * SCALE;
  const i = degToRad(plane.i_deg);
  const raan0 = degToRad(plane.raan_deg);
  const raan = raanAtTimeRad(raan0, plane.a_km, 0, i, tSeconds);
  const u = degToRad(uDeg);

  const xOrb = a * Math.cos(u);
  const yOrb = a * Math.sin(u);

  const cosO = Math.cos(raan);
  const sinO = Math.sin(raan);
  const cosI = Math.cos(i);
  const sinI = Math.sin(i);

  const x = xOrb * cosO - yOrb * sinO * cosI;
  const y = xOrb * sinO + yOrb * cosO * cosI;
  const z = yOrb * sinI;

  const inertialPosition = new THREE.Vector3(x, z, -y);

  return rotateInertialVectorToEarthFixed(inertialPosition, tSeconds);
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(",").map(h => h.trim());

  return lines.slice(1).filter(Boolean).map(line => {
    const values = line.split(",").map(v => v.trim());
    const row = {};

    headers.forEach((h, idx) => {
      row[h] = values[idx];
    });

    return row;
  });
}

function clearGroup(group) {
  while (group.children.length > 0) {
    const child = group.children[0];
    group.remove(child);

    if (child.geometry) child.geometry.dispose();

    if (child.material) {
      if (Array.isArray(child.material)) {
        child.material.forEach(mat => mat.dispose());
      } else {
        child.material.dispose();
      }
    }
  }
}

function clearConstellation() {
  clearGroup(constellationGroup);
  clearGroup(trajectoryGroup);

  satObjects = [];
  trajectoryObjects = [];
  planeModels = [];
  targetPositions = [];
  targetLatLon = [];
  targetCoverageCounts = [];
  globalCoverageCounts = [];
  mapCells = [];
  mapNeedsGeometryRebuild = true;
  mapMaxCoverage = 1;
  mapColorScaleMax = 1;
  killRadiusKm = null;
  interceptAltitudeKm = 200;
  minElevationDeg = 0;
  scenarioUseJ2 = false;
  simulationSeconds = 0;
  isPlaying = true;

  updateCoverageLegendMax();
  updatePlaybackButton();
  setStats(null, null);
  resetCoverageHistory();

  if (timelineSlider) {
    timelineSlider.value = 0;
  }

  draw2DMap();
  renderer.render(scene, camera);
}

function clusterOrbitalPlanes(rows) {
  const bins = new Map();

  rows.forEach(row => {
    const iDeg = Number(row.i_deg);
    const raanDeg = normalizeDeg(Number(row.raan_deg));

    const iBin = Math.round(iDeg / PLANE_INC_BIN_DEG) * PLANE_INC_BIN_DEG;
    const raanBin = Math.round(raanDeg / PLANE_RAAN_BIN_DEG) * PLANE_RAAN_BIN_DEG;
    const key = `${iBin}_${normalizeDeg(raanBin)}`;

    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(row);
  });

  const planes = [];

  bins.forEach(groupRows => {
    const aMean = groupRows.reduce((s, r) => s + Number(r.a_km), 0) / groupRows.length;
    const iMean = groupRows.reduce((s, r) => s + Number(r.i_deg), 0) / groupRows.length;
    const raanMean = meanAngleDeg(groupRows.map(r => Number(r.raan_deg)));

    const plane = {
      a_km: aMean,
      i_deg: iMean,
      raan_deg: raanMean,
      count: groupRows.length
    };

    groupRows.forEach(row => {
      row.assignedPlane = plane;
    });

    planes.push(plane);
  });

  return planes;
}

function makeTrajectoryTube(plane) {
  const points = [];

  for (let u = 0; u <= 360; u += 3) {
    points.push(orbitalPlanePoint(plane, u, simulationSeconds));
  }

  const curve = new THREE.CatmullRomCurve3(points, true);
  const geom = new THREE.TubeGeometry(curve, 180, TRAJECTORY_RADIUS, 5, true);

  const mat = new THREE.MeshBasicMaterial({
    color: 0x666666,
    transparent: true,
    opacity: 0.24,
    depthTest: true,
    depthWrite: false
  });

  const tube = new THREE.Mesh(geom, mat);
  tube.visible = true;
  tube.renderOrder = 6;

  trajectoryObjects.push({ mesh: tube, plane });
  trajectoryGroup.add(tube);
}

function updateTrajectoryLines() {
  trajectoryObjects.forEach(obj => {
    const points = [];

    for (let u = 0; u <= 360; u += 3) {
      points.push(orbitalPlanePoint(obj.plane, u, simulationSeconds));
    }

    const curve = new THREE.CatmullRomCurve3(points, true);

    obj.mesh.geometry.dispose();
    obj.mesh.geometry = new THREE.TubeGeometry(
      curve,
      180,
      TRAJECTORY_RADIUS,
      5,
      true
    );
  });
}

function updateSatellitePositions() {
  satObjects.forEach(obj => {
    obj.sprite.position.copy(orbitalPosition(obj.row, simulationSeconds));
  });
}

function updateCoverageColors(forceCoverageSample = false, recordCoverageSample = true, deferMapDraw = false) {
  const metrics = computeCoverageMetrics(true);

  coverageCurrentMetrics = metrics;

  if (metrics !== null) {
    satObjects.activeCount = metrics.activeSatellites;

    if (recordCoverageSample) {
      addCoverageSample(metrics, forceCoverageSample);
    } else {
      drawCoverageChart();
    }
  } else {
    satObjects.activeCount = 0;
    drawCoverageChart();
  }

  draw2DMap();
}

function updateTimelineSlider() {
  if (!timelineSlider) return;

  const hours = simulationSeconds / SECONDS_PER_HOUR;
  timelineSlider.value = hours.toFixed(2);
}

function updateSceneForTime(forceCoverageSample = false, recordCoverageSample = true, deferMapDraw = false) {
  updateSatellitePositions();
  updateTrajectoryLines();
  updateCoverageColors(forceCoverageSample, recordCoverageSample, deferMapDraw);
  updateTimelineSlider();
}

function updateFocusFromTargets(targets) {
  if (!targets || targets.length === 0) return;

  let latSum = 0;
  let lonSum = 0;

  targets.forEach(t => {
    latSum += Number(t.lat_deg);
    lonSum += Number(t.lon_deg);
  });

  focusLatDeg = latSum / targets.length;
  focusLonDeg = lonSum / targets.length;
}

async function loadScenarioJson(csvPath) {
  const jsonPath = csvPath.replace(/\.csv$/i, ".json");
  const response = await fetch(jsonPath);

  if (!response.ok) {
    targetPositions = [];
    targetLatLon = [];
    targetCoverageCounts = [];
    killRadiusKm = null;

    return {
      loaded: false,
      message: `No scenario JSON found at ${jsonPath}`
    };
  }

  const data = await response.json();

  scenarioDurationSeconds =
    Number(data.sim?.horizon_s) || 24 * SECONDS_PER_HOUR;

  scenarioTimeStepSeconds =
    Number(data.sim?.dt_s) || 120;

  scenarioUseJ2 = data.sim?.use_j2 === true;

  if (timelineSlider) {
    timelineSlider.max = (
      scenarioDurationSeconds / SECONDS_PER_HOUR
    ).toFixed(2);
  }

  const runConfig = data.run_config || {};

  interceptAltitudeKm = Number(
    runConfig.intercept_alt_km ??
    data.cov?.intercept_alt_km ??
    200
  );

  killRadiusKm = Number(
    runConfig.r_max_km ??
    data.r_max_km ??
    null
  );

  minElevationDeg = Number(
    runConfig.min_elev_deg ??
    runConfig.min_elevation_deg ??
    data.cov?.min_elev_deg ??
    data.cov?.min_elevation_deg ??
    0
  );

  const targetRadius = (EARTH_RADIUS_KM + interceptAltitudeKm) / EARTH_RADIUS_KM;
  const targets = data.targets || [];

  updateFocusFromTargets(targets);

  targetLatLon = targets.map(t => ({
    lat: Number(t.lat_deg),
    lon: Number(t.lon_deg)
  }));

  targetCoverageCounts = targets.map(() => 0);

  targetPositions = targets.map(t =>
    latLonToVector3(Number(t.lat_deg), Number(t.lon_deg), targetRadius)
  );

  if (globalCellLatLon.length === 0) {
    globalCellLatLon = generateGlobalFibonacciCells();
  }

  globalCellPositions = globalCellLatLon.map(cell =>
    latLonToVector3(cell.lat, cell.lon, targetRadius)
  );

  globalCoverageCounts = globalCellLatLon.map(() => 0);
  mapMaxCoverage = 1;
  mapColorScaleMax = 1;
  updateCoverageLegendMax();
  mapNeedsGeometryRebuild = true;

  return {
    loaded: true,
    nTargets: targetPositions.length,
    killRadiusKm,
    interceptAltitudeKm
  };
}

function renderConstellation(rows, scenarioInfo = null) {
  clearGroup(constellationGroup);
  clearGroup(trajectoryGroup);

  satObjects = [];
  trajectoryObjects = [];
  planeModels = [];

  simulationSeconds = 0;
  isPlaying = true;
  updatePlaybackButton();

  if (timelineSlider) timelineSlider.value = 0;
  resetCoverageHistory();

  planeModels = clusterOrbitalPlanes(rows);
  setStats(rows.length, planeModels.length);

  activeSatelliteMaterial = new THREE.SpriteMaterial({
    map: makeSatelliteSpriteTexture("#eaaa00", "#000000"),
    transparent: true,
    depthTest: true,
    depthWrite: false,
    alphaTest: 0.02
  });

  inactiveSatelliteMaterial = new THREE.SpriteMaterial({
    map: makeSatelliteSpriteTexture("#a9a9a9", "#4a4a4a"),
    transparent: true,
    depthTest: true,
    depthWrite: false,
    alphaTest: 0.02
  });

  rows.forEach(row => {
    const sprite = new THREE.Sprite(inactiveSatelliteMaterial);
    sprite.scale.set(SATELLITE_SPRITE_SCALE, SATELLITE_SPRITE_SCALE, 1);
    sprite.position.copy(orbitalPosition(row, simulationSeconds));
    sprite.renderOrder = 8;

    satObjects.push({ sprite, row });
    constellationGroup.add(sprite);
  });

  planeModels.forEach(plane => makeTrajectoryTube(plane));
  fillCoverageHistoryToTime(0);
  updateSceneForTime(false, false);

  setStatus(
    `Loaded Scenario. Satellites: ${rows.length}. Orbital planes: ${planeModels.length}.`
  );
}

async function loadCSV(path) {
  setStatus(`Loading ${path}...`);
  clearConstellation();

  const response = await fetch(path);
  if (!response.ok) throw new Error(`Could not load ${path}`);

  const text = await response.text();
  const rows = parseCSV(text);

  const scenarioInfo = await loadScenarioJson(path);
  renderConstellation(rows, scenarioInfo);

  redrawCountryBoundaries();

  if (isHorizonView) {
    setHorizonView();
  } else {
    setFullEarthView();
  }

  draw2DMap();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);

    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;

    return String(a).localeCompare(String(b));
  });
}

function fillSelect(select, values, formatter = value => value) {
  select.innerHTML = "";

  values.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = formatter(v);
    select.appendChild(opt);
  });
}

function getSelectedScenario() {
  return manifest.find(r =>
    r.country === countrySelect.value &&
    r.interceptors === interceptorSelect.value &&
    r.salvo === salvoSelect.value
  );
}

async function loadSelectedScenario() {
  const row = getSelectedScenario();

  if (!row) {
    clearConstellation();
    setStatus("No matching scenario found.");
    return;
  }

  try {
    await loadCSV(row.path);
  } catch (err) {
    console.error(err);
    clearConstellation();
    setStatus(err.message);
  }
}

function refreshDropdowns(triggerLoad = true, resetLowerDropdowns = false) {
  const currentCountry = countrySelect.value;
  const currentInt = resetLowerDropdowns ? null : interceptorSelect.value;
  const currentSalvo = resetLowerDropdowns ? null : salvoSelect.value;

  fillSelect(
    countrySelect,
    uniqueSorted(manifest.map(r => r.country)),
    formatThreatRegionName
  );

  if (currentCountry) countrySelect.value = currentCountry;

  const countryRows = manifest.filter(r => r.country === countrySelect.value);

  const interceptorValues = uniqueSorted(countryRows.map(r => r.interceptors));
  fillSelect(interceptorSelect, interceptorValues);

  if (currentInt && interceptorValues.includes(currentInt)) {
    interceptorSelect.value = currentInt;
  } else if (interceptorValues.length > 0) {
    interceptorSelect.value = interceptorValues[0];
  }

  const intRows = countryRows.filter(r => r.interceptors === interceptorSelect.value);
  const salvoValues = uniqueSorted(intRows.map(r => r.salvo));

  fillSelect(salvoSelect, salvoValues);

  if (currentSalvo && salvoValues.includes(currentSalvo)) {
    salvoSelect.value = currentSalvo;
  } else if (salvoValues.length > 0) {
    salvoSelect.value = salvoValues[0];
  }

  redrawCountryBoundaries();

  if (triggerLoad) loadSelectedScenario();
}

async function loadManifest() {
  const res = await fetch("manifest.json");
  manifest = await res.json();

  refreshDropdowns(false, true);
  setStatus(`Loaded manifest with ${manifest.length} CSV files.`);
  loadSelectedScenario();
}

function getFocusVector(radius = 1) {
  return latLonToVector3(focusLatDeg, focusLonDeg, radius);
}

function apply3DViewOffset() {
  const ui = getUiBounds();
  const width = window.innerWidth;
  const height = window.innerHeight;

  const openAreaLeft = ui.right;
  const openAreaRight = width;
  const openAreaCenter = openAreaLeft + ((openAreaRight - openAreaLeft) / 2);
  const canvasCenter = width / 2;
  const shiftPixels = openAreaCenter - canvasCenter;

  camera.setViewOffset(
    width,
    height,
    -shiftPixels,
    0,
    width,
    height
  );

  camera.updateProjectionMatrix();
}

function clear3DViewOffset() {
  camera.clearViewOffset();
  camera.updateProjectionMatrix();
}

function setFullEarthView() {
  const focus = getFocusVector(1);

  camera.position.copy(focus.clone().multiplyScalar(4.1));
  camera.up.set(0, 1, 0);

  controls.target.set(0, 0, 0);
  controls.update();

  apply3DViewOffset();

  isHorizonView = false;
  viewToggleBtn.textContent = "◠";
}

function setHorizonView() {
  const focus = getFocusVector(1);
  const worldNorth = new THREE.Vector3(0, 1, 0);

  let tangentNorth = worldNorth
    .clone()
    .sub(focus.clone().multiplyScalar(worldNorth.dot(focus)));

  if (tangentNorth.lengthSq() < 0.0001) {
    tangentNorth = new THREE.Vector3(0, 0, 1);
  }

  tangentNorth.normalize();

  const tangentEast = new THREE.Vector3()
    .crossVectors(tangentNorth, focus)
    .normalize();

  const cameraPos = focus.clone()
    .multiplyScalar(2.22)
    .add(tangentNorth.clone().multiplyScalar(0.52))
    .add(tangentEast.clone().multiplyScalar(-0.18));

  const target = focus.clone()
    .multiplyScalar(0.82)
    .add(tangentNorth.clone().multiplyScalar(0.32));

  camera.position.copy(cameraPos);
  camera.up.copy(tangentNorth);

  controls.target.copy(target);
  controls.update();

  apply3DViewOffset();

  isHorizonView = true;
  viewToggleBtn.textContent = "◎";
}

function toggleView() {
  if (isHorizonView) {
    setFullEarthView();
  } else {
    setHorizonView();
  }
}

function zoomCamera(factor) {
  if (visualizationMode === "2d") {
    zoom2DMap(1 / factor);
    return;
  }

  const direction = camera.position.clone().sub(controls.target);
  direction.multiplyScalar(factor);
  camera.position.copy(controls.target.clone().add(direction));
  controls.update();
}

countrySelect.addEventListener("change", () => {
  clearConstellation();
  refreshDropdowns(true, true);
});

interceptorSelect.addEventListener("change", () => {
  clearConstellation();
  loadSelectedScenario();
});

salvoSelect.addEventListener("change", () => {
  clearConstellation();
  loadSelectedScenario();
});

zoomInBtn.addEventListener("click", () => zoomCamera(0.82));
zoomOutBtn.addEventListener("click", () => zoomCamera(1.22));
viewToggleBtn.addEventListener("click", toggleView);

if (mode3DBtn) {
  mode3DBtn.addEventListener("click", () => setVisualizationMode("3d"));
}

if (mode2DBtn) {
  mode2DBtn.addEventListener("click", () => setVisualizationMode("2d"));
}

playBtn.addEventListener("click", () => {
  isPlaying = !isPlaying;
  updatePlaybackButton();
});

speedHalfBtn.addEventListener("click", () => setPlaybackMultiplier(0.5));
speedOneBtn.addEventListener("click", () => setPlaybackMultiplier(1.0));
speedTwoBtn.addEventListener("click", () => setPlaybackMultiplier(2.0));

if (timelineSlider) {
  timelineSlider.addEventListener("input", () => {
    isPlaying = false;
    updatePlaybackButton();

    const targetSeconds = Number(timelineSlider.value) * SECONDS_PER_HOUR;

    simulationSeconds = targetSeconds;
    updateSceneForTime(false, false, visualizationMode === "2d");

    restartCoverageHistoryAtTime(targetSeconds);
  });
}

if (mapCanvas) {
  mapCanvas.addEventListener("wheel", event => {
    if (visualizationMode !== "2d") return;

    event.preventDefault();

    const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
    zoom2DMap(factor, event.clientX, event.clientY);
  }, { passive: false });

  mapCanvas.addEventListener("pointerdown", event => {
    if (visualizationMode !== "2d") return;

    mapCanvas.setPointerCapture(event.pointerId);
    mapCanvas.classList.add("dragging");

    isMapDragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartPanX = mapPanX;
    dragStartPanY = mapPanY;
  });

  mapCanvas.addEventListener("pointermove", event => {
    if (visualizationMode !== "2d" || !isMapDragging) return;

    const dx = event.clientX - dragStartX;
    const dy = event.clientY - dragStartY;

    if (mapZoom <= 1.0001) return;

    mapPanX = dragStartPanX + dx;
    mapPanY = dragStartPanY + dy;

    mapNeedsGeometryRebuild = true;
    draw2DMap();
  });

  mapCanvas.addEventListener("pointerup", event => {
    if (mapCanvas.hasPointerCapture(event.pointerId)) {
      mapCanvas.releasePointerCapture(event.pointerId);
    }

    isMapDragging = false;
    mapCanvas.classList.remove("dragging");
  });

  mapCanvas.addEventListener("pointercancel", event => {
    if (mapCanvas.hasPointerCapture(event.pointerId)) {
      mapCanvas.releasePointerCapture(event.pointerId);
    }

    isMapDragging = false;
    mapCanvas.classList.remove("dragging");
  });

  mapCanvas.addEventListener("touchstart", event => {
    if (visualizationMode !== "2d" || event.touches.length !== 2) return;

    const [a, b] = event.touches;
    pinchStartDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    pinchStartZoom = mapZoom;
    pinchStartPanX = mapPanX;
    pinchStartPanY = mapPanY;
    pinchCenterX = (a.clientX + b.clientX) / 2;
    pinchCenterY = (a.clientY + b.clientY) / 2;
  }, { passive: true });

  mapCanvas.addEventListener("touchmove", event => {
    if (visualizationMode !== "2d" || event.touches.length !== 2 || pinchStartDistance <= 0) {
      return;
    }

    event.preventDefault();

    const [a, b] = event.touches;
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const factor = distance / pinchStartDistance;
    const previousZoom = mapZoom;
    const nextZoom = Math.max(1, Math.min(8, pinchStartZoom * factor));

    mapPanX = pinchCenterX - ((pinchCenterX - pinchStartPanX) * nextZoom / pinchStartZoom);
    mapPanY = pinchCenterY - ((pinchCenterY - pinchStartPanY) * nextZoom / pinchStartZoom);
    mapZoom = nextZoom;

    if (mapZoom <= 1.0001) {
      mapPanX = 0;
      mapPanY = 0;
    }

    if (previousZoom !== mapZoom) {
      mapNeedsGeometryRebuild = true;
      draw2DMap();
    }
  }, { passive: false });
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  renderer.setSize(window.innerWidth, window.innerHeight);

  if (!isHorizonView && visualizationMode === "3d") {
    setFullEarthView();
  } else {
    camera.updateProjectionMatrix();
  }

  resetMapView();
  mapNeedsGeometryRebuild = true;
  drawCoverageChart();
  draw2DMap();
});

setStats(null, null);
resetCoverageHistory();
setPlaybackMultiplier(1.0);
updatePlaybackButton();
updateCoverageLegendMax();

makeFallbackEarth();
loadWorldBoundaries();
setFullEarthView();
setVisualizationMode("3d");
loadManifest();

function animate() {
  requestAnimationFrame(animate);

  const now = performance.now();
  const dt = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  if (isPlaying && satObjects.length > 0) {
    simulationSeconds += (
      dt *
      BASE_PLAYBACK_SIM_HOURS_PER_REAL_SECOND *
      playbackMultiplier *
      SECONDS_PER_HOUR
    );

    const loopSeconds = scenarioDurationSeconds;

    if (simulationSeconds > loopSeconds) {
      simulationSeconds = 0;
      resetCoverageHistory();
    }

    updateSceneForTime();
  }

  controls.update();

  if (visualizationMode === "3d") {
    renderer.render(scene, camera);
  }
}

animate();