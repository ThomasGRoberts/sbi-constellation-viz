import { geoMercator, geoPath } from "d3-geo";

const PUBLISHED_SHEET_BASE = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ5vUHnP-VooDg5X9zu3GRbVXdX7HYTn7GXRT-wyOtRKtH_0VPpsPl9YpDgp39U6L1RystRljXQiPnl/pub";

const THREAT_SHEET_GIDS = Object.freeze({
  "north korea": "0",
  iran: "1667678723",
  china: "1512423565",
  russia: "1222878229"
});

const ALLOWED_HTML_TAGS = new Set(["P", "EM", "I", "STRONG", "B", "BR"]);
const URL_PATTERN = /https?:\/\/[^\s<]+[^\s<.,;:!?()[\]{}'\"](?=$|\s|[.,;:!?()[\]{}'\"])/gi;

function normalizeThreatRegion(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatThreatTitle(value) {
  return normalizeThreatRegion(value).replace(/\b\w/g, character => character.toUpperCase());
}

export function parseCsvTable(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }

  return rows;
}

export function parseThreatScenarioCsv(text) {
  const rows = parseCsvTable(text);
  const scenarioFields = {};
  let locationHeaderIndex = -1;
  let locationColumns = null;

  rows.forEach((row, index) => {
    const normalized = row.map(cell => String(cell || "").trim().toLowerCase());

    if (
      locationHeaderIndex < 0 &&
      normalized.includes("latitude") &&
      normalized.includes("longitude") &&
      normalized.includes("title") &&
      normalized.includes("description_html")
    ) {
      locationHeaderIndex = index;
      locationColumns = {
        latitude: normalized.indexOf("latitude"),
        longitude: normalized.indexOf("longitude"),
        title: normalized.indexOf("title"),
        descriptionHtml: normalized.indexOf("description_html")
      };
      return;
    }

    if (locationHeaderIndex < 0) {
      const key = normalized[0];
      if (["threat_region", "salvo_size", "narrative_html"].includes(key)) {
        scenarioFields[key] = String(row[1] || "").trim();
      }
    }
  });

  if (locationHeaderIndex < 0 || !locationColumns) {
    throw new Error("The scenario sheet is missing its locations table.");
  }

  if (!scenarioFields.threat_region) {
    throw new Error("The scenario sheet is missing its threat region.");
  }

  const locations = rows.slice(locationHeaderIndex + 1).flatMap(row => {
    const latitude = Number(row[locationColumns.latitude]);
    const longitude = Number(row[locationColumns.longitude]);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return [];

    return [{
      latitude,
      longitude,
      title: String(row[locationColumns.title] || "Launch location").trim() || "Launch location",
      descriptionHtml: String(row[locationColumns.descriptionHtml] || "").trim()
    }];
  });

  return {
    threatRegion: scenarioFields.threat_region,
    salvoSize: scenarioFields.salvo_size,
    narrativeHtml: scenarioFields.narrative_html || "",
    locations
  };
}

export async function loadThreatScenario(threatRegion, fetchImpl = fetch) {
  const normalized = normalizeThreatRegion(threatRegion);
  const gid = THREAT_SHEET_GIDS[normalized];

  if (gid === undefined) {
    throw new Error("No scenario-detail sheet is configured for this threat region.");
  }

  const url = `${PUBLISHED_SHEET_BASE}?output=csv&gid=${encodeURIComponent(gid)}&refresh=${Date.now()}`;
  const response = await fetchImpl(url, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Scenario details could not be loaded (${response.status}).`);
  }

  const scenario = parseThreatScenarioCsv(await response.text());

  if (normalizeThreatRegion(scenario.threatRegion) !== normalized) {
    throw new Error("The published sheet returned a different threat region than requested.");
  }

  return scenario;
}

function appendLinkifiedText(target, value) {
  let cursor = 0;

  for (const match of value.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    if (start > cursor) target.append(document.createTextNode(value.slice(cursor, start)));

    const link = document.createElement("a");
    link.href = match[0];
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = match[0];
    target.append(link);
    cursor = start + match[0].length;
  }

  if (cursor < value.length) target.append(document.createTextNode(value.slice(cursor)));
}

function appendSanitizedNode(target, source, footnotes, counter, linkify = false) {
  if (source.nodeType === Node.TEXT_NODE) {
    if (linkify) appendLinkifiedText(target, source.textContent || "");
    else target.append(document.createTextNode(source.textContent || ""));
    return;
  }

  if (source.nodeType !== Node.ELEMENT_NODE) return;

  const tokenIndex = source.getAttribute("data-footnote-token");
  if (tokenIndex !== null && footnotes[Number(tokenIndex)] !== undefined) {
    counter.value += 1;
    target.append(createFootnote(footnotes[Number(tokenIndex)], counter.value));
    return;
  }

  if (!ALLOWED_HTML_TAGS.has(source.tagName)) {
    [...source.childNodes].forEach(child => appendSanitizedNode(target, child, footnotes, counter, linkify));
    return;
  }

  const clean = document.createElement(source.tagName.toLowerCase());
  [...source.childNodes].forEach(child => appendSanitizedNode(clean, child, footnotes, counter, linkify));
  target.append(clean);
}

function createFootnote(citationHtml, number) {
  const wrapper = document.createElement("span");
  wrapper.className = "scenarioFootnote";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "scenarioFootnoteRef";
  button.setAttribute("aria-label", `Show footnote ${number}`);
  button.setAttribute("aria-expanded", "false");
  const superscript = document.createElement("sup");
  superscript.textContent = String(number);
  button.append(superscript);

  const expanded = document.createElement("span");
  expanded.className = "scenarioFootnoteExpanded";
  expanded.setAttribute("aria-hidden", "true");

  const parsed = new DOMParser().parseFromString(`<body>${citationHtml}</body>`, "text/html");
  [...parsed.body.childNodes].forEach(child => {
    appendSanitizedNode(expanded, child, [], { value: 0 }, true);
  });

  const collapseButton = document.createElement("button");
  collapseButton.type = "button";
  collapseButton.className = "scenarioFootnoteCollapse";
  collapseButton.setAttribute("aria-label", `Collapse footnote ${number}`);
  collapseButton.textContent = "×";
  expanded.append(collapseButton);

  const setOpen = open => {
    wrapper.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", `${open ? "Collapse" : "Show"} footnote ${number}`);
    expanded.setAttribute("aria-hidden", String(!open));
    wrapper.dispatchEvent(new CustomEvent("scenario-footnote-toggle", {
      bubbles: true,
      detail: { footnote: wrapper, opened: open }
    }));
  };

  button.addEventListener("click", event => {
    event.stopPropagation();
    setOpen(!wrapper.classList.contains("is-open"));
  });

  button.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    setOpen(false);
  });

  collapseButton.addEventListener("click", event => {
    event.stopPropagation();
    setOpen(false);
    button.focus({ preventScroll: true });
  });

  wrapper.append(button, expanded);
  return wrapper;
}

function closeOpenFootnotes(except = null) {
  document.querySelectorAll(".scenarioFootnote.is-open").forEach(footnote => {
    if (footnote === except) return;
    footnote.classList.remove("is-open");
    footnote.querySelector(".scenarioFootnoteRef")?.setAttribute("aria-expanded", "false");
    footnote.querySelector(".scenarioFootnoteExpanded")?.setAttribute("aria-hidden", "true");
  });
}

export function renderAuthoredHtml(target, html, counter = { value: 0 }) {
  target.replaceChildren();
  if (!html) return;

  const footnotes = [];
  const tokenized = String(html).replace(/\[fn\]([\s\S]*?)\[\/fn\]/gi, (_, citation) => {
    const index = footnotes.push(citation) - 1;
    return `<span data-footnote-token="${index}"></span>`;
  });
  const parsed = new DOMParser().parseFromString(`<body>${tokenized}</body>`, "text/html");

  [...parsed.body.childNodes].forEach(child => {
    appendSanitizedNode(target, child, footnotes, counter);
  });
}

function featureMatchesThreatRegion(featureName, threatRegion) {
  const feature = normalizeThreatRegion(featureName);
  const selected = normalizeThreatRegion(threatRegion);
  if (feature === selected) return true;
  if (selected === "north korea") return feature.includes("korea") && (feature.includes("north") || feature.includes("dem"));
  return feature.includes(selected);
}

function distributeCoincidentMarkers(points) {
  const groups = new Map();
  points.forEach(point => {
    const key = `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(point);
  });

  groups.forEach(group => {
    if (group.length < 2) return;
    group.forEach((point, index) => {
      const angle = (Math.PI * 2 * index) / group.length - Math.PI / 2;
      point.x += Math.cos(angle) * 8;
      point.y += Math.sin(angle) * 8;
    });
  });
}

export function groupScenarioLocations(locations) {
  const groups = new Map();

  locations.forEach(location => {
    const key = location.title;
    if (!groups.has(key)) {
      groups.set(key, {
        title: location.title,
        descriptionHtml: location.descriptionHtml,
        locations: []
      });
    }
    groups.get(key).locations.push(location);
  });

  return [...groups.values()];
}

function collectLongitudesFromGeometry(geometry, longitudes) {
  if (!geometry) return;
  if (geometry.type === "GeometryCollection") {
    geometry.geometries?.forEach(item => collectLongitudesFromGeometry(item, longitudes));
    return;
  }

  const visit = coordinates => {
    if (!Array.isArray(coordinates)) return;
    if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
      longitudes.push(coordinates[0]);
      return;
    }
    coordinates.forEach(visit);
  };
  visit(geometry.coordinates);
}

function getCircularLongitudeCenter(features) {
  const longitudes = [];
  features.forEach(feature => collectLongitudesFromGeometry(feature.geometry, longitudes));
  if (longitudes.length === 0) return 0;

  const values = [...new Set(longitudes.map(longitude => ((longitude % 360) + 360) % 360))]
    .sort((a, b) => a - b);
  if (values.length === 1) return values[0] > 180 ? values[0] - 360 : values[0];

  let largestGap = -1;
  let arcStart = values[0];
  values.forEach((value, index) => {
    const next = index === values.length - 1 ? values[0] + 360 : values[index + 1];
    const gap = next - value;
    if (gap > largestGap) {
      largestGap = gap;
      arcStart = next % 360;
    }
  });

  const center = (arcStart + (360 - largestGap) / 2) % 360;
  return center > 180 ? center - 360 : center;
}

function renderDetailMap(svg, scenario, sites, worldFeatures, selectedSiteIndex, onSelect) {
  const width = 291;
  const height = 176;
  const focusFeatures = worldFeatures.filter(feature =>
    featureMatchesThreatRegion(feature.properties?.name || "", scenario.threatRegion)
  );
  const locationFeatures = sites.flatMap(site => site.locations).map(location => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [location.longitude, location.latitude] }
  }));
  const fitFeatures = focusFeatures.length > 0 ? focusFeatures : locationFeatures;
  const centralLongitude = getCircularLongitudeCenter(fitFeatures);
  const projection = geoMercator().rotate([-centralLongitude, 0]);

  if (fitFeatures.length > 0) {
    projection.fitExtent(
      [[16, 14], [width - 16, height - 14]],
      { type: "FeatureCollection", features: fitFeatures }
    );
  }

  const path = geoPath(projection);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.replaceChildren();

  const boundaryLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  boundaryLayer.setAttribute("class", "scenarioMapBoundaries");

  const orderedFeatures = [
    ...worldFeatures.filter(feature =>
      !featureMatchesThreatRegion(feature.properties?.name || "", scenario.threatRegion)
    ),
    ...focusFeatures
  ];

  orderedFeatures.forEach(feature => {
    const d = path(feature);
    if (!d) return;
    const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
    shape.setAttribute("d", d);
    if (featureMatchesThreatRegion(feature.properties?.name || "", scenario.threatRegion)) {
      shape.classList.add("scenarioMapFocusCountry");
    }
    boundaryLayer.append(shape);
  });

  svg.append(boundaryLayer);

  const projected = sites.flatMap((site, siteIndex) =>
    site.locations.map(location => {
      const point = projection([location.longitude, location.latitude]);
      return { siteIndex, location, x: point?.[0] ?? 0, y: point?.[1] ?? 0 };
    })
  );
  distributeCoincidentMarkers(projected);

  projected.forEach(point => {
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "g");
    marker.setAttribute("class", `scenarioMapMarker${point.siteIndex === selectedSiteIndex ? " is-selected" : ""}`);
    marker.dataset.siteIndex = String(point.siteIndex);
    marker.setAttribute("transform", `translate(${point.x} ${point.y})`);
    marker.setAttribute("role", "button");
    marker.setAttribute("tabindex", "0");
    marker.setAttribute("aria-label", point.location.title);

    const hitArea = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const core = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    const pulse = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    hitArea.setAttribute("class", "scenarioMapMarkerHitArea");
    hitArea.setAttribute("r", "8");
    marker.append(hitArea);

    pulse.setAttribute("class", "scenarioMapMarkerPulse");
    pulse.setAttribute("r", "10.2");
    marker.append(pulse);

    core.setAttribute("class", "scenarioMapMarkerCore");
    core.setAttribute("r", point.siteIndex === selectedSiteIndex ? "4.2" : "2.2");
    marker.append(core);

    marker.addEventListener("click", () => onSelect(point.siteIndex));
    marker.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      onSelect(point.siteIndex);
    });
    svg.append(marker);
  });
}

export function createSecretLegendActivation({ yellowDot, grayDot, onActivate, timeoutMs = 1800 }) {
  let armedAt = 0;

  const reset = () => { armedAt = 0; };
  const onYellow = event => {
    event.stopPropagation();
    armedAt = performance.now();
  };
  const onGray = event => {
    event.stopPropagation();
    const valid = armedAt > 0 && performance.now() - armedAt <= timeoutMs;
    reset();
    if (valid) onActivate();
  };
  const onUnrelatedInteraction = event => {
    if (event.target === yellowDot || event.target === grayDot) return;
    reset();
  };

  yellowDot?.addEventListener("click", onYellow);
  grayDot?.addEventListener("click", onGray);
  document.addEventListener("pointerdown", onUnrelatedInteraction, true);

  return reset;
}

export function createThreatScenarioDetailController({
  panel,
  flipper,
  front,
  back,
  backButton,
  scenarioNavigator,
  mapSvg,
  locationDetail,
  locationIndicators,
  locationPrevious,
  locationNext,
  narrative,
  narrativeHeading,
  launchHeading,
  loading,
  empty,
  error,
  content,
  getThreatRegion,
  setThreatRegion,
  getWorldFeatures,
  onLayoutChange
}) {
  const carouselIntervalMs = 6500;
  let scenario = null;
  let sites = [];
  let selectedSiteIndex = 0;
  let requestId = 0;
  let carouselTimer = null;
  let captionFootnoteStart = 0;
  let resizeFrame = 0;
  let measuredCaptionWidth = 0;

  const measureNaturalFaceHeight = face => {
    const previousHeight = face.style.height;
    const previousBottom = face.style.bottom;
    face.style.height = "auto";
    face.style.bottom = "auto";
    const naturalHeight = Math.ceil(face.scrollHeight);
    face.style.height = previousHeight;
    face.style.bottom = previousBottom;
    return naturalHeight;
  };

  const syncHeight = () => {
    const visibleFace = panel.classList.contains("is-detail-open") ? back : front;
    const maxHeight = Math.max(160, window.innerHeight - 100);
    panel.style.setProperty("--panel-height", `${Math.min(measureNaturalFaceHeight(visibleFace), maxHeight)}px`);
  };

  const stopCarousel = () => {
    if (carouselTimer !== null) window.clearTimeout(carouselTimer);
    carouselTimer = null;
  };

  const scheduleCarousel = () => {
    stopCarousel();
    if (!panel.classList.contains("is-detail-open") || sites.length < 2) return;
    carouselTimer = window.setTimeout(() => {
      if (back.querySelector(".scenarioFootnote.is-open")) {
        scheduleCarousel();
        return;
      }
      selectSite(selectedSiteIndex + 1);
    }, carouselIntervalMs);
  };

  const renderScenarioNavigation = threatRegion => {
    const normalized = normalizeThreatRegion(threatRegion).replace(/\s+/g, "-");
    scenarioNavigator.querySelectorAll("[data-threat-region]").forEach(button => {
      const current = button.dataset.threatRegion === normalized;
      button.classList.toggle("is-current", current);
      if (current) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    });
  };

  const renderIndicators = () => {
    locationIndicators.replaceChildren();
    sites.forEach((site, index) => {
      const indicator = document.createElement("button");
      indicator.type = "button";
      indicator.className = `scenarioLocationIndicator${index === selectedSiteIndex ? " is-current" : ""}`;
      indicator.setAttribute("role", "tab");
      indicator.setAttribute("aria-selected", String(index === selectedSiteIndex));
      indicator.setAttribute("aria-label", `Show site ${index + 1} of ${sites.length}: ${site.title}`);
      indicator.addEventListener("click", () => selectSite(index));
      locationIndicators.append(indicator);
    });
  };

  const renderSiteCaption = (target, site) => {
    target.replaceChildren();
    if (site) {
      const captionContent = document.createElement("div");
      captionContent.className = "scenarioLocationCaptionContent";
      const title = document.createElement("h3");
      title.textContent = site.title;
      captionContent.append(title);

      if (site.descriptionHtml) {
        const description = document.createElement("div");
        description.className = "scenarioLocationDescription";
        renderAuthoredHtml(description, site.descriptionHtml, { value: captionFootnoteStart });
        captionContent.append(description);
      }
      target.append(captionContent);
    }
  };

  const reserveCaptionHeight = () => {
    const carousel = locationDetail.closest(".scenarioLocationCarousel");
    if (!carousel || sites.length === 0) {
      locationDetail.style.removeProperty("min-height");
      return;
    }

    const captionWidth = locationDetail.getBoundingClientRect().width;
    if (captionWidth <= 0) return;
    measuredCaptionWidth = captionWidth;

    const measure = locationDetail.cloneNode(false);
    measure.removeAttribute("id");
    measure.removeAttribute("aria-live");
    measure.classList.add("scenarioLocationMeasure");
    measure.style.width = `${captionWidth}px`;
    carousel.append(measure);

    let maximumHeight = 0;
    sites.forEach(site => {
      renderSiteCaption(measure, site);
      maximumHeight = Math.max(maximumHeight, Math.ceil(measure.getBoundingClientRect().height));
    });
    measure.remove();
    locationDetail.style.minHeight = `${maximumHeight}px`;
  };

  const updateIndicators = () => {
    locationIndicators.querySelectorAll(".scenarioLocationIndicator").forEach((indicator, index) => {
      const current = index === selectedSiteIndex;
      indicator.classList.toggle("is-current", current);
      indicator.setAttribute("aria-selected", String(current));
    });
  };

  const updateMapSelection = () => {
    const markers = [...mapSvg.querySelectorAll(".scenarioMapMarker")];
    markers.forEach(marker => marker.classList.remove("is-selected"));
    void mapSvg.getBoundingClientRect();
    markers.forEach(marker => {
      const selected = Number(marker.dataset.siteIndex) === selectedSiteIndex;
      marker.classList.toggle("is-selected", selected);
      marker.querySelector(".scenarioMapMarkerCore")?.setAttribute("r", selected ? "4.2" : "2.2");
    });
  };

  const renderSelectedSite = () => {
    locationDetail.closest(".scenarioLocationCarousel")?.classList.remove("has-expanded-footnote");
    renderSiteCaption(locationDetail, sites[selectedSiteIndex]);
    updateIndicators();
    updateMapSelection();
  };

  const renderContent = () => {
    if (!scenario) return;
    const counter = { value: 0 };
    renderAuthoredHtml(narrative, scenario.narrativeHtml, counter);
    captionFootnoteStart = counter.value;

    renderDetailMap(mapSvg, scenario, sites, getWorldFeatures(), selectedSiteIndex, selectSite);
    renderIndicators();
    reserveCaptionHeight();
    renderSelectedSite();
    const hasMultipleSites = sites.length > 1;
    locationPrevious.disabled = !hasMultipleSites;
    locationNext.disabled = !hasMultipleSites;
  };

  function selectSite(index) {
    if (sites.length === 0) return;
    const preservedScrollTop = back.scrollTop;
    selectedSiteIndex = (index + sites.length) % sites.length;
    renderSelectedSite();
    back.scrollTop = preservedScrollTop;
    scheduleCarousel();
  }

  const showScenario = nextScenario => {
    stopCarousel();
    scenario = nextScenario;
    sites = groupScenarioLocations(scenario.locations);
    selectedSiteIndex = 0;
    renderScenarioNavigation(scenario.threatRegion);
    narrativeHeading.textContent = scenario.salvoSize
      ? `Why ${scenario.salvoSize} ${Number(scenario.salvoSize) === 1 ? "missile" : "missiles"}?`
      : "Why this salvo size?";
    launchHeading.textContent = `Which launch sites in ${formatThreatTitle(scenario.threatRegion)}?`;
    loading.hidden = true;
    empty.hidden = true;
    error.hidden = true;
    const hasContent = Boolean(
      scenario.salvoSize ||
      scenario.narrativeHtml ||
      scenario.locations.length > 0
    );
    content.hidden = !hasContent;

    if (!hasContent) {
      empty.hidden = false;
      empty.textContent = `Scenario details have not yet been added for ${scenario.threatRegion}.`;
      syncHeight();
      return;
    }

    renderContent();
    syncHeight();
    scheduleCarousel();
  };

  const showError = message => {
    scenario = null;
    sites = [];
    stopCarousel();
    mapSvg.replaceChildren();
    locationDetail.replaceChildren();
    narrative.replaceChildren();
    loading.hidden = true;
    empty.hidden = true;
    error.hidden = false;
    content.hidden = true;
    error.textContent = message;
    syncHeight();
  };

  const load = async threatRegion => {
    stopCarousel();
    const currentRequest = ++requestId;
    renderScenarioNavigation(threatRegion);
    launchHeading.textContent = `Which launch sites in ${formatThreatTitle(threatRegion)}?`;
    loading.hidden = false;
    empty.hidden = true;
    error.hidden = true;
    content.hidden = true;
    syncHeight();

    try {
      const nextScenario = await loadThreatScenario(threatRegion);
      if (currentRequest !== requestId) return;
      showScenario(nextScenario);
    } catch (loadError) {
      console.error(loadError);
      if (currentRequest !== requestId) return;
      showError("Scenario details are temporarily unavailable. The main visualization remains fully functional.");
    }
  };

  const open = () => {
    panel.classList.add("is-detail-open");
    onLayoutChange?.();
    window.setTimeout(() => {
      if (scenario) reserveCaptionHeight();
      syncHeight();
    }, 700);
    back.scrollTop = 0;
    flipper.setAttribute("aria-hidden", "false");
    front.setAttribute("aria-hidden", "true");
    front.inert = true;
    back.setAttribute("aria-hidden", "false");
    back.inert = false;
    const threatRegion = getThreatRegion();
    load(threatRegion);
  };

  const close = () => {
    requestId += 1;
    stopCarousel();
    closeOpenFootnotes();
    panel.classList.remove("is-detail-open");
    onLayoutChange?.();
    window.setTimeout(syncHeight, 700);
    front.setAttribute("aria-hidden", "false");
    front.inert = false;
    back.setAttribute("aria-hidden", "true");
    back.inert = true;
    syncHeight();
  };

  backButton.addEventListener("click", close);
  locationPrevious.addEventListener("click", () => selectSite(selectedSiteIndex - 1));
  locationNext.addEventListener("click", () => selectSite(selectedSiteIndex + 1));
  scenarioNavigator.addEventListener("click", async event => {
    const button = event.target.closest("[data-threat-region]");
    if (!button || button.classList.contains("is-current")) return;
    const nextRegion = button.dataset.threatRegion;
    const buttons = [...scenarioNavigator.querySelectorAll("[data-threat-region]")];
    buttons.forEach(item => { item.disabled = true; });
    scenarioNavigator.setAttribute("aria-busy", "true");
    try {
      await Promise.all([setThreatRegion(nextRegion), load(nextRegion)]);
    } finally {
      buttons.forEach(item => { item.disabled = false; });
      scenarioNavigator.removeAttribute("aria-busy");
    }
  });
  back.addEventListener("scenario-footnote-toggle", event => {
    const carousel = event.target.closest(".scenarioLocationCarousel");
    if (carousel) {
      carousel.classList.toggle(
        "has-expanded-footnote",
        Boolean(carousel.querySelector(".scenarioFootnote.is-open"))
      );
    }

  });
  window.addEventListener("resize", () => {
    syncHeight();
    if (!scenario || !panel.classList.contains("is-detail-open")) return;
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => {
      reserveCaptionHeight();
      syncHeight();
    });
  });
  if ("ResizeObserver" in window) {
    const captionResizeObserver = new ResizeObserver(() => {
      if (!scenario || !panel.classList.contains("is-detail-open")) return;
      const currentWidth = locationDetail.getBoundingClientRect().width;
      if (Math.abs(currentWidth - measuredCaptionWidth) < .5) return;
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        reserveCaptionHeight();
        syncHeight();
      });
    });
    captionResizeObserver.observe(locationDetail);
  }
  requestAnimationFrame(syncHeight);

  return {
    open,
    close,
    syncHeight,
    setScenarioOrder(threatRegions) {
      const buttons = new Map(
        [...scenarioNavigator.querySelectorAll("[data-threat-region]")]
          .map(button => [button.dataset.threatRegion, button])
      );
      threatRegions.forEach(threatRegion => {
        const button = buttons.get(threatRegion);
        if (button) scenarioNavigator.append(button);
      });
    },
    refreshMap() {
      if (scenario && panel.classList.contains("is-detail-open")) renderContent();
    }
  };
}
