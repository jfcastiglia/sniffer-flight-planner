// Flight Planner — pure client-side
// No backend required: flight path generation runs in the browser via
// coordinate math + Turf.js. KMZ handled by JSZip.

// ── Constants ────────────────────────────────────────────────────────────────

const EARTH_R = 6371000;       // metres
const SHIFT_STEP_M = 5;        // metres per shift click
const DEFAULT_SPACING = 15;
const DEFAULT_ORIENTATION = 0;
const PLAN_COLOURS = ["#e05252", "#e09a30", "#5bc45b", "#4aaee0", "#c45be0", "#e05296"];

// ── State ────────────────────────────────────────────────────────────────────

let map, drawnItems, drawControl;
let workAreaLayer = null;
let locationMarker = null;
let plans = [];
let activePlanId = null;
let nextId = 1;
let pointEditHandler = null;

// ── Coordinate utilities ─────────────────────────────────────────────────────

function toXY(lat, lng, refLat, refLng) {
    const cosRef = Math.cos(refLat * Math.PI / 180);
    return [
        (lng - refLng) * (Math.PI / 180) * EARTH_R * cosRef,
        (lat - refLat) * (Math.PI / 180) * EARTH_R,
    ];
}

function fromXY(x, y, refLat, refLng) {
    const cosRef = Math.cos(refLat * Math.PI / 180);
    return [
        refLat + (y / EARTH_R) * (180 / Math.PI),
        refLng + (x / (EARTH_R * cosRef)) * (180 / Math.PI),
    ];
}

function rotXY([x, y], deg) {
    const r = deg * Math.PI / 180;
    return [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371, d2r = Math.PI / 180;
    const dLat = (lat2 - lat1) * d2r, dLng = (lng2 - lng1) * d2r;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * d2r) * Math.cos(lat2 * d2r) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function pathLengthKm(coords) {   // coords: [[lng, lat], ...]
    let km = 0;
    for (let i = 1; i < coords.length; i++) {
        km += haversineKm(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
    }
    return km;
}

// ── Rotation handle ───────────────────────────────────────────────────────────

const ROT_HANDLE_DIST_M = 80;   // distance from centroid to handle in metres

const rotHandleIcon = L.divIcon({
    className: "",
    html: `<div style="
        width:28px;height:28px;border-radius:50%;
        background:#1d5bd4;border:2px solid #fff;
        display:flex;align-items:center;justify-content:center;
        cursor:grab;box-shadow:0 2px 6px rgba(0,0,0,0.5);
        font-size:15px;line-height:1;user-select:none;">↻</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
});

function polygonCentroid(latLngs) {
    const lat = latLngs.reduce((s, p) => s + p.lat, 0) / latLngs.length;
    const lng = latLngs.reduce((s, p) => s + p.lng, 0) / latLngs.length;
    return { lat, lng };
}

function offsetLatLng(lat, lng, distM, angleDeg) {
    const bearing = angleDeg * Math.PI / 180;
    const dLat = (distM * Math.cos(bearing)) / EARTH_R * (180 / Math.PI);
    const dLng = (distM * Math.sin(bearing)) / (EARTH_R * Math.cos(lat * Math.PI / 180)) * (180 / Math.PI);
    return { lat: lat + dLat, lng: lng + dLng };
}

function angleBetween(refLat, refLng, toLat, toLng) {
    const cosRef = Math.cos(refLat * Math.PI / 180);
    const dx = (toLng - refLng) * cosRef;
    const dy = toLat - refLat;
    let deg = Math.atan2(dx, dy) * 180 / Math.PI;
    if (deg < 0) deg += 360;
    return deg % 360;
}

function updateRotHandle(plan) {
    const latLngs = plan.extentLayer.getLatLngs()[0];
    const c = polygonCentroid(latLngs);
    const hPos = offsetLatLng(c.lat, c.lng, ROT_HANDLE_DIST_M, plan.orientation);

    if (!plan.rotHandle) {
        plan.rotHandle = L.marker([hPos.lat, hPos.lng], {
            icon: rotHandleIcon,
            draggable: true,
            zIndexOffset: 1000,
        }).addTo(map);

        plan.rotLine = L.polyline([[c.lat, c.lng], [hPos.lat, hPos.lng]], {
            color: "#4a90d9", weight: 1.5, dashArray: "5 4", opacity: 0.7,
        }).addTo(map);

        let dragTimer = null;
        plan.rotHandle.on("drag", (e) => {
            const { lat, lng } = e.latlng;
            const latLngs2 = plan.extentLayer.getLatLngs()[0];
            const c2 = polygonCentroid(latLngs2);
            const angle = angleBetween(c2.lat, c2.lng, lat, lng);
            plan.rotLine.setLatLngs([[c2.lat, c2.lng], [lat, lng]]);
            document.getElementById("orientationInput").value = angle.toFixed(1);
            plan.orientation = angle;
            clearTimeout(dragTimer);
            dragTimer = setTimeout(() => regeneratePath(plan), 80);
        });

        plan.rotHandle.on("dragend", () => {
            clearTimeout(dragTimer);
            regeneratePath(plan);
        });
    } else {
        plan.rotHandle.setLatLng([hPos.lat, hPos.lng]);
        const latLngs2 = plan.extentLayer.getLatLngs()[0];
        const c2 = polygonCentroid(latLngs2);
        plan.rotLine.setLatLngs([[c2.lat, c2.lng], [hPos.lat, hPos.lng]]);
    }
}

function clearRotHandle(plan) {
    if (plan.rotHandle && map.hasLayer(plan.rotHandle)) map.removeLayer(plan.rotHandle);
    if (plan.rotLine   && map.hasLayer(plan.rotLine))   map.removeLayer(plan.rotLine);
    plan.rotHandle = null;
    plan.rotLine   = null;
}

// ── Lawnmower path generation ─────────────────────────────────────────────────

function generateLawnmower(latLngs, spacingM, orientationDeg, shiftM) {
    if (latLngs.length < 3) return null;

    // Build Turf polygon for robust intersection clipping
    const polyRing = latLngs.map(p => [p.lng, p.lat]);
    if (polyRing[0][0] !== polyRing[polyRing.length - 1][0] ||
        polyRing[0][1] !== polyRing[polyRing.length - 1][1]) {
        polyRing.push(polyRing[0]);
    }
    const turfPoly = turf.polygon([polyRing]);

    // centroid as local projection reference
    const refLat = latLngs.reduce((s, p) => s + p.lat, 0) / latLngs.length;
    const refLng = latLngs.reduce((s, p) => s + p.lng, 0) / latLngs.length;

    // project polygon vertices to local XY metres, then rotate so scan lines are horizontal
    const pts = latLngs.map(p => rotXY(toXY(p.lat, p.lng, refLat, refLng), -orientationDeg));

    const minX = Math.min(...pts.map(p => p[0]));
    const maxX = Math.max(...pts.map(p => p[0]));
    const minY = Math.min(...pts.map(p => p[1]));
    const maxY = Math.max(...pts.map(p => p[1]));
    const margin = (maxX - minX + maxY - minY); // extend scan lines well past bounds

    // normalise shift to [0, spacingM)
    const shift = ((shiftM % spacingM) + spacingM) % spacingM;

    const coords = [];
    const rows = [];
    let rowIdx = 0;

    for (let y = minY + shift; y <= maxY + 1e-9; y += spacingM) {
        // Build a long scan line in rotated space, convert endpoints to real lat/lng
        const [latL, lngL] = fromXY(...rotXY([minX - margin, y], orientationDeg), refLat, refLng);
        const [latR, lngR] = fromXY(...rotXY([maxX + margin, y], orientationDeg), refLat, refLng);
        const scanLine = turf.lineString([[lngL, latL], [lngR, latR]]);

        // Find where the scan line crosses the polygon boundary
        const hits = turf.lineIntersect(scanLine, turfPoly).features;
        if (hits.length < 2) continue;

        // Sort intersection points by rotated-x so we can pair enter/exit correctly
        const sorted = hits.map(f => {
            const [lng, lat] = f.geometry.coordinates;
            const [x] = rotXY(toXY(lat, lng, refLat, refLng), -orientationDeg);
            return { x, coord: [lng, lat] };
        }).sort((a, b) => a.x - b.x);

        // Pair up intersections; skip any pair whose midpoint is outside the polygon
        // or that's degenerate (scan line clipped a corner — zero-length row)
        for (let i = 0; i + 1 < sorted.length; i += 2) {
            const a = sorted[i].coord;
            const b = sorted[i + 1].coord;

            // Skip corner clips (start ≈ end)
            const dx = a[0] - b[0], dy = a[1] - b[1];
            if (Math.sqrt(dx * dx + dy * dy) < 1e-7) continue;

            const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
            if (!turf.booleanPointInPolygon(mid, turfPoly)) continue;

            const start = rowIdx % 2 === 0 ? a : b;
            const end   = rowIdx % 2 === 0 ? b : a;
            coords.push(start, end);
            rows.push([start, end]);
            rowIdx++;
        }
    }

    if (coords.length < 2) return null;

    return {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: { spacing_m: spacingM, orientation_deg: orientationDeg },
        rows,   // [[start_coord, end_coord], ...] — scan lines only
    };
}

// ── Auto-orientation (longest edge of polygon) ────────────────────────────────

function longestEdgeAngle(latLngs) {
    let best = 0, bestLen = -1;
    for (let i = 0; i < latLngs.length; i++) {
        const p1 = latLngs[i], p2 = latLngs[(i + 1) % latLngs.length];
        const dx = (p2.lng - p1.lng) * Math.cos(p1.lat * Math.PI / 180);
        const dy = p2.lat - p1.lat;
        const len = dx * dx + dy * dy;
        if (len > bestLen) { bestLen = len; best = Math.atan2(dy, dx) * 180 / Math.PI; }
    }
    // normalise to [0, 180)
    best = best % 180;
    if (best < 0) best += 180;
    return Math.round(best * 10) / 10;
}

// ── Coverage blob (via Turf) ──────────────────────────────────────────────────

function computeCoverage(planFeature, extentLatLngs, spacingM) {
    try {
        const extentCoords = extentLatLngs.map(p => [p.lng, p.lat]);
        extentCoords.push(extentCoords[0]);   // close ring
        const extentPoly = turf.polygon([extentCoords]);

        const swath = turf.buffer(planFeature, spacingM / 2, { units: "meters" });
        if (!swath) return null;

        // Use full swath for the visible blob (extends outside boundary)
        // Intersect only to compute coverage stats and the missing area
        const coveredInside = turf.intersect(swath, extentPoly);
        const missing       = coveredInside ? turf.difference(extentPoly, coveredInside) : extentPoly;
        const extArea       = turf.area(extentPoly);
        const covArea       = coveredInside ? turf.area(coveredInside) : 0;

        return {
            covered: swath,           // show full swath, not clipped to boundary
            missing: missing && turf.area(missing) > 1 ? missing : null,
            fraction: covArea / extArea,
            covAreaM2: covArea,
            missingAreaM2: extArea - covArea,
        };
    } catch (e) {
        console.warn("Coverage computation failed:", e);
        return null;
    }
}

// ── Plan helpers ──────────────────────────────────────────────────────────────

function getActivePlan() {
    return plans.find(p => p.id === activePlanId) || null;
}

function planColour(id) {
    return PLAN_COLOURS[(id - 1) % PLAN_COLOURS.length];
}

function refreshSelect() {
    const sel = document.getElementById("planSelect");
    if (!sel) return;
    sel.innerHTML = "";
    if (plans.length === 0) {
        sel.innerHTML = '<option value="">(no plans)</option>';
        sel.disabled = true;
        return;
    }
    plans.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
    });
    sel.disabled = false;
    if (activePlanId !== null) sel.value = activePlanId;
}

function syncSidebarToPlan(plan) {
    if (!plan) return;
    const nameEl  = document.getElementById("planNameInput");
    const spEl    = document.getElementById("spacingInput");
    const orEl    = document.getElementById("orientationInput");
    const covBtn  = document.getElementById("toggleCoverageBtn");
    const editBtn = document.getElementById("editPointsBtn");
    if (nameEl) nameEl.value = plan.name;
    if (spEl)   spEl.value   = plan.spacing;
    if (orEl)   orEl.value   = plan.orientation;
    if (covBtn) covBtn.textContent = plan.showCoverage ? "Hide Coverage Blob" : "Show Coverage Blob";
    if (editBtn) editBtn.textContent = plan.editMode ? "Finish Editing" : "Edit Path Points";
    updateInfoPanel(plan);
}

function setActive(id) {
    const plan = plans.find(p => p.id === id);
    if (!plan) return;
    const prevId = activePlanId;
    activePlanId = id;
    const sel = document.getElementById("planSelect");
    if (sel) sel.value = id;
    syncSidebarToPlan(plan);
    // Recolor paths and manage rotation handles
    if (prevId !== id) {
        const prev = plans.find(p => p.id === prevId);
        if (prev) {
            if (prev.pathFeature) drawPath(prev);
            clearRotHandle(prev);   // hide handle on deactivated plan
        }
    }
    if (plan.pathFeature) {
        drawPath(plan);
        updateRotHandle(plan);      // show handle on active plan
    }
}

function updateInfoPanel(plan) {
    const distEl = document.getElementById("distanceInfo");
    const covEl  = document.getElementById("coverageInfo");
    if (!plan || !plan.pathFeature) {
        if (distEl) distEl.textContent = "";
        if (covEl)  covEl.textContent  = "";
        return;
    }
    if (distEl) {
        const km = pathLengthKm(plan.pathFeature.geometry.coordinates);
        distEl.textContent = `Flight distance: ${km.toFixed(2)} km`;
    }
    if (covEl && plan.coverage) {
        const pct  = (plan.coverage.fraction * 100).toFixed(1);
        const covH = (plan.coverage.covAreaM2 / 10000).toFixed(2);
        const misH = (plan.coverage.missingAreaM2 / 10000).toFixed(2);
        covEl.textContent = `Coverage: ${pct}%  ·  ${covH} ha covered  ·  ${misH} ha missing`;
    } else if (covEl) {
        covEl.textContent = "";
    }
}

// ── Plan creation ─────────────────────────────────────────────────────────────

function createPlanFromLayer(layer) {
    const spacing     = parseFloat(document.getElementById("spacingInput").value)     || DEFAULT_SPACING;
    const orientation = parseFloat(document.getElementById("orientationInput").value) || DEFAULT_ORIENTATION;

    const id   = nextId++;
    const colour = planColour(id);
    const name = `Plan ${id}`;

    // Recreate the polygon in boundaryPane (z 350) so path lines (overlayPane z 400) render above it
    const latlngsOrig = layer.getLatLngs();
    drawnItems.removeLayer(layer);
    map.removeLayer(layer);
    const boundaryLayer = L.polygon(latlngsOrig, {
        color: "#ff2222", weight: 2, dashArray: "8 5", fillColor: colour, fillOpacity: 0.04, pane: "boundaryPane",
    }).addTo(map);
    drawnItems.addLayer(boundaryLayer);
    layer = boundaryLayer;

    // Start marker (first vertex)
    const rings = layer.getLatLngs();
    let startMarker = null;
    if (rings.length > 0 && rings[0].length > 0) {
        startMarker = L.circleMarker(rings[0][0], {
            radius: 6, color: "#ffd500", weight: 2,
            fillColor: "#ffff00", fillOpacity: 1,
        }).addTo(map);
    }

    const plan = {
        id, name, colour,
        extentLayer: layer,
        pathLayer: null,
        startMarker,
        coverageLayer: null,
        missingLayer: null,
        spacing,
        orientation,
        shiftM: 0,
        pathFeature: null,
        coverage: null,
        showCoverage: false,
        editMode: false,
        editMarkers: [],
        rotHandle: null,
        rotLine: null,
        endMarker: null,
    };

    layer.on("click", () => setActive(plan.id));

    plans.push(plan);
    refreshSelect();
    setActive(plan.id);
    saveState();
    return plan;
}

// ── Path drawing ──────────────────────────────────────────────────────────────

function drawPath(plan) {
    if (plan.pathLayer && map.hasLayer(plan.pathLayer)) map.removeLayer(plan.pathLayer);

    if (!plan.pathFeature) return;

    const pathColor = plan.id === activePlanId ? "#ffd700" : plan.colour;
    const coords = plan.pathFeature.geometry.coordinates;

    // Render the full drone path as one continuous line (rows + connecting turns)
    plan.pathLayer = L.polyline(
        coords.map(([lng, lat]) => [lat, lng]),
        { color: pathColor, weight: 2.5, opacity: 1, pane: "pathPane" }
    ).addTo(map);

    // Start marker (yellow) at first point
    if (coords.length > 0) {
        const [lng, lat] = coords[0];
        if (!plan.startMarker) {
            plan.startMarker = L.circleMarker([lat, lng], {
                radius: 6, color: "#ffd500", weight: 2,
                fillColor: "#ffff00", fillOpacity: 1,
            }).addTo(map);
        } else {
            plan.startMarker.setLatLng([lat, lng]);
        }
    }

    // End marker (red) at last point
    if (coords.length > 1) {
        const [lng, lat] = coords[coords.length - 1];
        if (!plan.endMarker) {
            plan.endMarker = L.circleMarker([lat, lng], {
                radius: 6, color: "#cc0000", weight: 2,
                fillColor: "#ff3333", fillOpacity: 1,
            }).addTo(map);
        } else {
            plan.endMarker.setLatLng([lat, lng]);
        }
    }

    updateRotHandle(plan);
}

function regeneratePath(plan) {
    const latLngs = plan.extentLayer.getLatLngs()[0];
    plan.pathFeature = generateLawnmower(latLngs, plan.spacing, plan.orientation, plan.shiftM);

    drawPath(plan);

    // Recompute coverage if it was shown
    if (plan.showCoverage) {
        clearCoverage(plan);
        computeAndShowCoverage(plan);
    } else {
        plan.coverage = plan.pathFeature
            ? computeCoverage(plan.pathFeature, latLngs, plan.spacing)
            : null;
    }

    updateInfoPanel(plan);
    saveState();
}

// ── Coverage display ──────────────────────────────────────────────────────────

function clearCoverage(plan) {
    if (plan.coverageLayer && map.hasLayer(plan.coverageLayer)) map.removeLayer(plan.coverageLayer);
    if (plan.missingLayer  && map.hasLayer(plan.missingLayer))  map.removeLayer(plan.missingLayer);
    plan.coverageLayer = null;
    plan.missingLayer  = null;
}

function computeAndShowCoverage(plan) {
    if (!plan.pathFeature) return;
    const latLngs = plan.extentLayer.getLatLngs()[0];
    plan.coverage = computeCoverage(plan.pathFeature, latLngs, plan.spacing);
    if (!plan.coverage) return;

    if (plan.coverage.covered) {
        plan.coverageLayer = L.geoJSON(plan.coverage.covered, {
            style: { color: "#00e5b4", weight: 0, fillColor: "#00e5b4", fillOpacity: 0.22 },
            pane: "coveragePane",
        }).addTo(map);
    }
    if (plan.coverage.missing) {
        plan.missingLayer = L.geoJSON(plan.coverage.missing, {
            style: { color: "#ff4d4d", weight: 0, fillColor: "#ff4d4d", fillOpacity: 0.30 },
            pane: "coveragePane",
        }).addTo(map);
    }
    updateInfoPanel(plan);
}

function toggleCoverage(plan) {
    plan.showCoverage = !plan.showCoverage;
    if (plan.showCoverage) {
        computeAndShowCoverage(plan);
    } else {
        clearCoverage(plan);
    }
    const btn = document.getElementById("toggleCoverageBtn");
    if (btn) btn.textContent = plan.showCoverage ? "Hide Coverage Blob" : "Show Coverage Blob";
}

// ── Point context menu ────────────────────────────────────────────────────────

// items: [{label, action, danger}]
function showContextMenu(e, items) {
    const menu = document.getElementById("ctxMenu");
    L.DomEvent.stopPropagation(e);

    menu.innerHTML = "";
    const handlers = [];

    items.forEach(item => {
        const btn = document.createElement("button");
        btn.textContent = item.label;
        if (item.danger) btn.classList.add("danger");
        const handler = () => { close(); item.action(); };
        btn.addEventListener("click", handler);
        handlers.push({ btn, handler });
        menu.appendChild(btn);
    });

    // Cancel
    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", close);
    menu.appendChild(cancelBtn);

    menu.style.left = e.originalEvent.clientX + "px";
    menu.style.top  = e.originalEvent.clientY + "px";
    menu.classList.remove("hidden");

    function close() {
        menu.classList.add("hidden");
        document.removeEventListener("mousedown", onOutside);
    }
    function onOutside(ev) { if (!menu.contains(ev.target)) close(); }
    setTimeout(() => document.addEventListener("mousedown", onOutside), 0);
}

// ── Point editing ─────────────────────────────────────────────────────────────

function startEditMode(plan) {
    if (!plan.pathFeature) { alert("Generate a flight plan first."); return; }
    if (plan.editMode) return;
    plan.editMode = true;

    const coords = plan.pathFeature.geometry.coordinates;
    plan.editMarkers = coords.map(([lng, lat]) => {
        const m = L.marker([lat, lng], { draggable: true }).addTo(map);
        m.on("drag", () => rebuildPathFromMarkers(plan));
        m.on("contextmenu", (e) => {
            if (plan.editMarkers.length <= 2) return;
            showContextMenu(e, [{
                label: "Delete point", danger: true,
                action: () => {
                    map.removeLayer(m);
                    plan.editMarkers = plan.editMarkers.filter(x => x !== m);
                    rebuildPathFromMarkers(plan);
                },
            }]);
        });
        return m;
    });

    // Right-click map to add a point via menu
    pointEditHandler = (e) => {
        showContextMenu(e, [{
            label: "Add point here",
            action: () => insertPoint(plan, e.latlng),
        }]);
    };
    map.on("contextmenu", pointEditHandler);
}

function finishEditMode(plan) {
    if (!plan.editMode) return;
    plan.editMode = false;

    plan.editMarkers.forEach(m => { if (map.hasLayer(m)) map.removeLayer(m); });
    plan.editMarkers = [];

    if (pointEditHandler) { map.off("contextmenu", pointEditHandler); pointEditHandler = null; }
}

function rebuildPathFromMarkers(plan) {
    const coords = plan.editMarkers.map(m => {
        const { lat, lng } = m.getLatLng();
        return [lng, lat];
    });
    plan.pathFeature = {
        type: "Feature",
        geometry: { type: "LineString", coordinates: coords },
        properties: {},
    };
    drawPath(plan);
    updateInfoPanel(plan);
}

function insertPoint(plan, clickLL) {
    const markers = plan.editMarkers;
    if (markers.length === 0) return;

    const pts = markers.map(m => m.getLatLng());
    let best = Infinity, idx = 0;

    for (let i = 0; i < pts.length - 1; i++) {
        const score = map.distance(clickLL, pts[i]) +
                      map.distance(clickLL, pts[i + 1]) -
                      map.distance(pts[i], pts[i + 1]);
        if (score < best) { best = score; idx = i + 1; }
    }
    // Also check prepend / append
    if (map.distance(clickLL, pts[0]) < best)              { best = Infinity; idx = 0; }
    if (map.distance(clickLL, pts[pts.length - 1]) < best) { idx = pts.length; }

    const m = L.marker(clickLL, { draggable: true }).addTo(map);
    m.on("drag", () => rebuildPathFromMarkers(plan));
    m.on("contextmenu", (e) => {
        if (plan.editMarkers.length <= 2) return;
        showContextMenu(e, [{
            label: "Delete point", danger: true,
            action: () => {
                map.removeLayer(m);
                plan.editMarkers = plan.editMarkers.filter(x => x !== m);
                rebuildPathFromMarkers(plan);
            },
        }]);
    });
    markers.splice(idx, 0, m);
    rebuildPathFromMarkers(plan);
}

// ── Delete plan ───────────────────────────────────────────────────────────────

function removePlanLayers(plan) {
    finishEditMode(plan);
    if (plan.extentLayer) {
        drawnItems.hasLayer(plan.extentLayer) && drawnItems.removeLayer(plan.extentLayer);
        map.hasLayer(plan.extentLayer) && map.removeLayer(plan.extentLayer);
    }
    if (plan.pathLayer    && map.hasLayer(plan.pathLayer))    map.removeLayer(plan.pathLayer);
    if (plan.startMarker  && map.hasLayer(plan.startMarker))  map.removeLayer(plan.startMarker);
    if (plan.endMarker    && map.hasLayer(plan.endMarker))    map.removeLayer(plan.endMarker);
    clearRotHandle(plan);
    clearCoverage(plan);
}

function deleteActive() {
    const plan = getActivePlan();
    if (!plan) { alert("No active plan to delete."); return; }

    removePlanLayers(plan);
    const idx = plans.findIndex(p => p.id === plan.id);
    plans.splice(idx, 1);

    activePlanId = plans.length > 0 ? plans[Math.max(0, idx - 1)].id : null;
    refreshSelect();
    if (activePlanId) setActive(activePlanId);
    else {
        document.getElementById("distanceInfo").textContent = "";
        document.getElementById("coverageInfo").textContent = "";
    }
    saveState();
}

// ── KMZ export ────────────────────────────────────────────────────────────────

function escXML(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function planToKML(plan) {
    const name   = escXML(plan.name);
    const coords = plan.pathFeature.geometry.coordinates
        .map(([lng, lat]) => `${lng},${lat},0`).join(" ");
    return `  <Placemark><name>${name}</name>` +
           `<LineString><tessellate>1</tessellate><coordinates>${coords}</coordinates></LineString>` +
           `</Placemark>`;
}

function extentToKML(plan) {
    const name   = escXML(plan.name + " extent");
    const rings  = plan.extentLayer.getLatLngs()[0];
    const coords = rings.map(p => `${p.lng},${p.lat},0`).join(" ");
    const first  = rings[0];
    return `  <Placemark><name>${name}</name>` +
           `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords} ${first.lng},${first.lat},0</coordinates></LinearRing></outerBoundaryIs></Polygon>` +
           `</Placemark>`;
}

async function exportKMZ(plansToExport, filename) {
    const placemarks = plansToExport.flatMap(p => [extentToKML(p), planToKML(p)]).join("\n");
    const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n<Document>\n${placemarks}\n</Document>\n</kml>`;

    const zip = new JSZip();
    zip.file("doc.kml", kml);
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const a    = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}

// ── KMZ import ────────────────────────────────────────────────────────────────

async function importKMZ(file) {
    const zip = await JSZip.loadAsync(file);
    const kmlFile = Object.values(zip.files).find(f => f.name.toLowerCase().endsWith(".kml"));
    if (!kmlFile) throw new Error("No KML found in archive.");

    const kmlText = await kmlFile.async("text");
    const doc = new DOMParser().parseFromString(kmlText, "text/xml");

    // collect all placemarks that contain a LineString
    const placemarks = Array.from(doc.querySelectorAll("Placemark"));
    let imported = 0;

    for (const pm of placemarks) {
        const lsEl = pm.querySelector("LineString coordinates");
        if (!lsEl) continue;   // skip extents / other geometry

        const coords = lsEl.textContent.trim().split(/\s+/).map(s => {
            const [lng, lat] = s.split(",").map(Number);
            return [lng, lat];
        }).filter(c => !isNaN(c[0]) && !isNaN(c[1]));

        if (coords.length < 2) continue;

        // Build a dummy polygon as the extent (convex hull of path)
        const pathFeature = { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
        const hull = turf.convex(turf.explode(pathFeature));
        if (!hull) continue;

        const hullCoords = hull.geometry.coordinates[0].slice(0, -1)
                               .map(([lng, lat]) => L.latLng(lat, lng));

        const extentLayer = L.polygon(hullCoords, { color: "#4aaee0", weight: 2 });
        drawnItems.addLayer(extentLayer);

        const plan    = createPlanFromLayer(extentLayer);
        const pmName  = pm.querySelector("name")?.textContent?.trim();
        if (pmName) { plan.name = pmName; refreshSelect(); setActive(plan.id); }

        plan.pathFeature = pathFeature;
        drawPath(plan);
        plan.coverage = computeCoverage(plan.pathFeature, hullCoords.map(ll => ({ lat: ll.lat, lng: ll.lng })), plan.spacing);
        updateInfoPanel(plan);
        imported++;
    }

    return imported;
}

// ── GeoTIFF overlay ───────────────────────────────────────────────────────────

let geotiffLayer = null;

function setGeotiffStatus(msg, isErr = false) {
    const el = document.getElementById("geotiffStatus");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isErr ? "#f87171" : "#555c6e";
}

function clearGeotiff() {
    if (geotiffLayer && map.hasLayer(geotiffLayer)) map.removeLayer(geotiffLayer);
    geotiffLayer = null;
    setGeotiffStatus("");
}

async function loadGeoTIFF(file) {
    setGeotiffStatus("Loading…");
    try {
        const arrayBuffer = await file.arrayBuffer();
        const georaster = await parseGeoraster(arrayBuffer);

        clearGeotiff();

        geotiffLayer = new GeoRasterLayer({
            georaster,
            opacity: 0.85,
            resolution: 256,
        });

        geotiffLayer.addTo(map);
        map.fitBounds(geotiffLayer.getBounds());
        setGeotiffStatus(`Loaded: ${file.name}`);
    } catch (e) {
        console.error("GeoTIFF load error:", e);
        setGeotiffStatus("Failed to load GeoTIFF.", true);
    }
}

// ── Work area GeoJSON / field-uploader config ─────────────────────────────────

function applyWorkAreaGeoJSON(geojson) {
    if (workAreaLayer) map.removeLayer(workAreaLayer);
    workAreaLayer = L.geoJSON(geojson, {
        style: { color: "#00e87a", weight: 2.5, fill: false },
    }).addTo(map);
    map.fitBounds(workAreaLayer.getBounds(), { padding: [20, 20] });
}

async function loadWorkAreaFromFieldUploader(config) {
    const layers = config["List of Layers and types"] || {};
    const bufferUrl = layers["dronebuffer"];
    if (!bufferUrl) {
        alert("Field uploader file has no 'dronebuffer' layer.");
        return;
    }
    const queryUrl = bufferUrl + "/query?where=1%3D1&outFields=*&f=geojson";
    try {
        const resp = await fetch(queryUrl);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const geojson = await resp.json();
        applyWorkAreaGeoJSON(geojson);
        const projectName = config["Project Name"] || "";
        if (projectName) {
            const el = document.getElementById("geotiffStatus");
            if (el) el.textContent = "Loaded: " + projectName;
        }
    } catch (err) {
        alert("Could not fetch work area from ArcGIS:\n" + err.message);
    }
}

function loadWorkArea(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result);
            // Detect field-uploader config: has "List of Layers and types" key
            if (data["List of Layers and types"]) {
                loadWorkAreaFromFieldUploader(data);
            } else {
                applyWorkAreaGeoJSON(data);
            }
        } catch {
            alert("Could not parse file — expected GeoJSON or field uploader JSON.");
        }
    };
    reader.readAsText(file);
}

// ── Location search ───────────────────────────────────────────────────────────

function setLocationStatus(msg, isErr = false) {
    const el = document.getElementById("locationStatus");
    if (!el) return;
    el.textContent = msg;
    el.className = isErr ? "err" : "";
}

function parseGPS(text) {
    const t = text.trim();

    // DMS: 39°30'0"N 98°45'0"W
    const dms = t.match(/(\d+)[°d]\s*(\d+)['′]\s*([\d.]+)[""″]?\s*([NS])[,\s]+(\d+)[°d]\s*(\d+)['′]\s*([\d.]+)[""″]?\s*([EW])/i);
    if (dms) {
        const lat = (parseInt(dms[1]) + parseInt(dms[2]) / 60 + parseFloat(dms[3]) / 3600) * (/S/i.test(dms[4]) ? -1 : 1);
        const lng = (parseInt(dms[5]) + parseInt(dms[6]) / 60 + parseFloat(dms[7]) / 3600) * (/W/i.test(dms[8]) ? -1 : 1);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
    }

    // Decimal: "39.5, -98.3" or "39.5 -98.3" or "-98.3 39.5" (lon first if |a|>90)
    const dec = t.match(/^[NSns]?\s*([-\d.]+)\s*°?\s*[,\s]\s*[EWew]?\s*([-\d.]+)/);
    if (dec) {
        let a = parseFloat(dec[1]), b = parseFloat(dec[2]);
        if (!isNaN(a) && !isNaN(b)) {
            if (Math.abs(a) > 90 && Math.abs(b) <= 90) [a, b] = [b, a];
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
        }
    }
    return null;
}

function dropLocationMarker(lat, lng, label) {
    if (locationMarker) map.removeLayer(locationMarker);
    map.setView([lat, lng], 15);
    locationMarker = L.marker([lat, lng]).addTo(map);
    locationMarker.bindPopup(
        `<strong>${label || "Location"}</strong><br>${lat.toFixed(6)}, ${lng.toFixed(6)}`
    ).openPopup();
    locationMarker.on("click", () => { map.removeLayer(locationMarker); locationMarker = null; });
}

async function goToLocation() {
    const raw = (document.getElementById("locationInput")?.value || "").trim();
    if (!raw) { setLocationStatus("Enter an address or coordinates.", true); return; }

    setLocationStatus("Searching…");

    const gps = parseGPS(raw);
    if (gps) {
        dropLocationMarker(gps.lat, gps.lng, null);
        setLocationStatus(`${gps.lat.toFixed(6)}, ${gps.lng.toFixed(6)}`);
        return;
    }

    try {
        const r = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(raw)}`,
            { headers: { "Accept-Language": "en" } }
        );
        if (!r.ok) throw new Error();
        const results = await r.json();
        if (!results.length) { setLocationStatus("Location not found.", true); return; }
        const { lat, lon, display_name } = results[0];
        dropLocationMarker(parseFloat(lat), parseFloat(lon), display_name);
        setLocationStatus(display_name);
    } catch {
        setLocationStatus("Geocoding error — check your connection.", true);
    }
}

// ── Map initialisation ────────────────────────────────────────────────────────

function initMap() {
    map = L.map("map").setView([39.0, -96.0], 4);

    // Three-tier z-order: boundary (350) < coverage (380) < paths (450)
    map.createPane("boundaryPane");
    map.getPane("boundaryPane").style.zIndex = 350;
    map.createPane("coveragePane");
    map.getPane("coveragePane").style.zIndex = 380;
    map.createPane("pathPane");
    map.getPane("pathPane").style.zIndex = 450;
    map.getPane("pathPane").style.pointerEvents = "none";

    L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 21, attribution: "Tiles © Esri" }
    ).addTo(map);

    drawnItems = new L.FeatureGroup().addTo(map);

    drawControl = new L.Control.Draw({
        draw: {
            polygon: {
                allowIntersection: false,
                shapeOptions: { color: "#4aaee0", weight: 2 },
                showArea: false,
            },
            polyline: false, rectangle: false, circle: false,
            marker: false, circlemarker: false,
        },
        edit: { featureGroup: drawnItems },
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.CREATED, (e) => {
        drawnItems.addLayer(e.layer);
        const plan = createPlanFromLayer(e.layer);
        if (plan) {
            // Defer one tick so Leaflet.Draw finishes its cleanup before we regenerate
            setTimeout(() => {
                const angle = longestEdgeAngle(plan.extentLayer.getLatLngs()[0]);
                const orEl = document.getElementById("orientationInput");
                if (orEl) orEl.value = Math.round(angle * 10) / 10;
                plan.orientation = angle;
                regeneratePath(plan);
                if (!plan.showCoverage) toggleCoverage(plan);
            }, 0);
        }
    });

    map.on(L.Draw.Event.EDITED, (e) => {
        e.layers.eachLayer(layer => {
            const plan = plans.find(p => p.extentLayer === layer);
            if (plan) { setActive(plan.id); regeneratePath(plan); }
        });
    });

    map.on(L.Draw.Event.DELETED, (e) => {
        e.layers.eachLayer(layer => {
            const idx = plans.findIndex(p => p.extentLayer === layer);
            if (idx === -1) return;
            const plan = plans[idx];
            if (plan.pathLayer   && map.hasLayer(plan.pathLayer))   map.removeLayer(plan.pathLayer);
            if (plan.startMarker && map.hasLayer(plan.startMarker)) map.removeLayer(plan.startMarker);
            if (plan.endMarker   && map.hasLayer(plan.endMarker))   map.removeLayer(plan.endMarker);
            clearRotHandle(plan);
            clearCoverage(plan);
            plans.splice(idx, 1);
        });
        activePlanId = plans.length ? plans[0].id : null;
        refreshSelect();
        if (activePlanId) setActive(activePlanId);
        saveState();
    });

    // Persist map view on pan/zoom
    map.on("moveend zoomend", saveState);
}

// ── Controls wiring ───────────────────────────────────────────────────────────

function initControls() {
    const $  = id => document.getElementById(id);

    // Location
    $("locationGoBtn").addEventListener("click", () => goToLocation().catch(console.error));
    $("locationInput").addEventListener("keydown", e => { if (e.key === "Enter") goToLocation().catch(console.error); });

    // GeoTIFF
    $("loadGeotiffBtn").addEventListener("click", () => {
        const f = $("geotiffFile").files[0];
        if (!f) { alert("Select a GeoTIFF file first."); return; }
        loadGeoTIFF(f).catch(console.error);
    });
    $("clearGeotiffBtn").addEventListener("click", () => {
        clearGeotiff();
        $("geotiffFile").value = "";
    });

    // Work area
    $("loadWorkAreaBtn").addEventListener("click", () => {
        const f = $("workAreaFile").files[0];
        if (!f) { alert("Select a GeoJSON file first."); return; }
        loadWorkArea(f);
    });

    // Plan select
    $("planSelect").addEventListener("change", e => {
        const id = parseInt(e.target.value);
        if (!isNaN(id)) setActive(id);
    });

    // Rename
    $("renamePlanBtn").addEventListener("click", () => {
        const plan = getActivePlan();
        if (!plan) return;
        const name = $("planNameInput").value.trim();
        if (!name) { alert("Enter a plan name."); return; }
        plan.name = name;
        refreshSelect();
        setActive(plan.id);
        saveState();
    });

    // Generate
    $("generateBtn").addEventListener("click", () => {
        const plan = getActivePlan();
        if (!plan) { alert("Draw a polygon on the map first."); return; }
        plan.spacing     = parseFloat($("spacingInput").value)     || DEFAULT_SPACING;
        plan.orientation = parseFloat($("orientationInput").value) || DEFAULT_ORIENTATION;
        plan.shiftM      = 0;
        regeneratePath(plan);
    });

    // Live update when orientation is typed/spun
    $("orientationInput").addEventListener("input", () => {
        const plan = getActivePlan();
        if (!plan?.pathFeature) return;
        const val = parseFloat($("orientationInput").value);
        if (isNaN(val)) return;
        plan.orientation = ((val % 360) + 360) % 360;
        regeneratePath(plan);
    });

    // Rotate buttons
    function rotateBy(delta) {
        const plan = getActivePlan();
        if (!plan?.pathFeature) return;
        const cur = parseFloat($("orientationInput").value) || 0;
        const next = ((cur + delta) % 360 + 360) % 360;
        $("orientationInput").value = Math.round(next * 10) / 10;
        plan.orientation = next;
        regeneratePath(plan);
    }
    $("rotCCW5Btn").addEventListener("click", () => rotateBy(-5));
    $("rotCCW1Btn").addEventListener("click", () => rotateBy(-1));
    $("rotCW1Btn").addEventListener("click",  () => rotateBy(+1));
    $("rotCW5Btn").addEventListener("click",  () => rotateBy(+5));

    // Auto orientation
    $("autoOrientBtn").addEventListener("click", () => {
        const plan = getActivePlan();
        if (!plan) { alert("Draw a polygon first."); return; }
        const angle = longestEdgeAngle(plan.extentLayer.getLatLngs()[0]);
        $("orientationInput").value = angle;
        plan.orientation = angle;
        if (plan.pathFeature) regeneratePath(plan);
    });

    // Shift
    $("shiftNegBtn").addEventListener("click", () => {
        const plan = getActivePlan();
        if (!plan || !plan.pathFeature) { alert("Generate a plan first."); return; }
        plan.shiftM -= SHIFT_STEP_M;
        regeneratePath(plan);
    });
    $("shiftPosBtn").addEventListener("click", () => {
        const plan = getActivePlan();
        if (!plan || !plan.pathFeature) { alert("Generate a plan first."); return; }
        plan.shiftM += SHIFT_STEP_M;
        regeneratePath(plan);
    });

    // Edit boundary (polygon reshape via Leaflet.Draw)
    let boundaryEditActive = false;
    let boundaryCtxDomHandler = null;
    let boundaryEditMarkers = [];
    let boundaryEditPolyline = null;
    const editBoundaryBtn = $("editBoundaryBtn");

    const vertexIcon = L.divIcon({
        className: "",
        html: '<div style="width:12px;height:12px;background:#fff;border:2px solid #4aaee0;border-radius:2px;cursor:move;box-sizing:border-box;"></div>',
        iconSize: [12, 12],
        iconAnchor: [6, 6],
    });

    function updateBoundaryPolyline() {
        const pts = boundaryEditMarkers.map(m => m.getLatLng());
        if (boundaryEditPolyline) {
            boundaryEditPolyline.setLatLngs([...pts, pts[0]]);
        } else {
            boundaryEditPolyline = L.polyline([...pts, pts[0]], {
                color: "#4aaee0", weight: 2, dashArray: "6 4",
            }).addTo(map);
        }
    }

    function enableBoundaryEdit(plan) {
        boundaryEditActive = true;
        editBoundaryBtn.textContent = "Save Boundary";
        editBoundaryBtn.classList.add("btn-primary");
        editBoundaryBtn.classList.remove("btn-warn");

        const latlngs = plan.extentLayer.getLatLngs()[0];

        boundaryEditMarkers = latlngs.map(ll => {
            const m = L.marker(ll, { draggable: true, icon: vertexIcon }).addTo(map);
            m.on("drag", () => {
                updateBoundaryPolyline();
                plan.extentLayer.setLatLngs([boundaryEditMarkers.map(mk => mk.getLatLng())]);
                regeneratePath(plan);
            });
            return m;
        });

        updateBoundaryPolyline();

        // Returns pixel distance from point p to segment a–b, and the t parameter (0–1)
        function ptSegDist(p, a, b) {
            const dx = b.x - a.x, dy = b.y - a.y;
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
            const cx = a.x + t * dx - p.x, cy = a.y + t * dy - p.y;
            return { dist: Math.sqrt(cx * cx + cy * cy), t };
        }

        boundaryCtxDomHandler = function(e) {
            if (!boundaryEditActive) return;
            // Prevent browser menu and Leaflet from consuming this event
            e.preventDefault();
            e.stopPropagation();

            // Check if a vertex marker was right-clicked
            const hit = boundaryEditMarkers.find(m => {
                const el = m.getElement();
                return el && (el === e.target || el.contains(e.target));
            });

            if (hit) {
                if (boundaryEditMarkers.length <= 3) return;
                showContextMenu({ originalEvent: e }, [{
                    label: "Delete vertex", danger: true,
                    action: () => {
                        const idx = boundaryEditMarkers.indexOf(hit);
                        map.removeLayer(hit);
                        boundaryEditMarkers.splice(idx, 1);
                        updateBoundaryPolyline();
                        plan.extentLayer.setLatLngs([boundaryEditMarkers.map(m => m.getLatLng())]);
                        regeneratePath(plan);
                    },
                }]);
                return;
            }

            // Check if the click is near the boundary polyline (within 10px of any edge)
            const rect = map.getContainer().getBoundingClientRect();
            const clickPx = map.latLngToContainerPoint(
                map.containerPointToLatLng(L.point(e.clientX - rect.left, e.clientY - rect.top))
            );
            const n = boundaryEditMarkers.length;
            let bestDist = Infinity, bestInsertIdx = -1, bestT = 0;
            for (let i = 0; i < n; i++) {
                const a = map.latLngToContainerPoint(boundaryEditMarkers[i].getLatLng());
                const b = map.latLngToContainerPoint(boundaryEditMarkers[(i + 1) % n].getLatLng());
                const { dist, t } = ptSegDist(clickPx, a, b);
                if (dist < bestDist) { bestDist = dist; bestInsertIdx = i + 1; bestT = t; }
            }

            if (bestDist > 10) return; // not close enough to any edge

            const clickedLL = map.containerPointToLatLng(L.point(e.clientX - rect.left, e.clientY - rect.top));
            showContextMenu({ originalEvent: e }, [{
                label: "Add vertex here",
                action: () => {
                    const m = L.marker(clickedLL, { draggable: true, icon: vertexIcon }).addTo(map);
                    m.on("drag", () => {
                        updateBoundaryPolyline();
                        plan.extentLayer.setLatLngs([boundaryEditMarkers.map(mk => mk.getLatLng())]);
                        regeneratePath(plan);
                    });
                    boundaryEditMarkers.splice(bestInsertIdx, 0, m);
                    updateBoundaryPolyline();
                    plan.extentLayer.setLatLngs([boundaryEditMarkers.map(mk => mk.getLatLng())]);
                    regeneratePath(plan);
                },
            }]);
        };
        map.getContainer().addEventListener("contextmenu", boundaryCtxDomHandler, true);
    }

    function disableBoundaryEdit(plan) {
        // Commit final marker positions to the polygon
        if (boundaryEditMarkers.length >= 3) {
            plan.extentLayer.setLatLngs([boundaryEditMarkers.map(m => m.getLatLng())]);
        }
        boundaryEditMarkers.forEach(m => map.removeLayer(m));
        boundaryEditMarkers = [];
        if (boundaryEditPolyline) { map.removeLayer(boundaryEditPolyline); boundaryEditPolyline = null; }
        regeneratePath(plan);
        boundaryEditActive = false;
        editBoundaryBtn.textContent = "Edit Boundary";
        editBoundaryBtn.classList.add("btn-warn");
        editBoundaryBtn.classList.remove("btn-primary");
        if (boundaryCtxDomHandler) {
            map.getContainer().removeEventListener("contextmenu", boundaryCtxDomHandler, true);
            boundaryCtxDomHandler = null;
        }
    }

    editBoundaryBtn.addEventListener("click", () => {
        const plan = getActivePlan();
        if (!plan?.extentLayer) { alert("Draw a polygon first."); return; }
        if (!boundaryEditActive) enableBoundaryEdit(plan);
        else disableBoundaryEdit(plan);
    });

    // Edit points
    $("editPointsBtn").addEventListener("click", () => {
        const plan = getActivePlan();
        if (!plan) { alert("Select a plan first."); return; }
        if (!plan.editMode) {
            startEditMode(plan);
            $("editPointsBtn").textContent = "Finish Editing";
            $("editPointsBtn").title = "Drag to move · Click map to add · Right-click to delete";
        } else {
            finishEditMode(plan);
            $("editPointsBtn").textContent = "Edit Path Points";
            $("editPointsBtn").title = "";
        }
    });

    // Save active
    $("saveActiveBtn").addEventListener("click", async () => {
        const plan = getActivePlan();
        if (!plan?.pathFeature) { alert("Generate a flight plan first."); return; }
        try {
            const name = plan.name.replace(/[^A-Za-z0-9_.-]+/g, "_");
            await exportKMZ([plan], name + ".kmz");
        } catch (e) { console.error(e); alert("Export failed."); }
    });

    // Save all
    $("saveAllBtn").addEventListener("click", async () => {
        const ready = plans.filter(p => p.pathFeature);
        if (!ready.length) { alert("No generated plans to save."); return; }
        try {
            await exportKMZ(ready, "flight_plans.kmz");
        } catch (e) { console.error(e); alert("Export failed."); }
    });

    // Delete
    $("deletePlanBtn").addEventListener("click", deleteActive);

    // Import KMZ (supports multiple files)
    $("importKmzBtn").addEventListener("click", async () => {
        const files = Array.from($("importKmzFile").files);
        if (!files.length) { alert("Select one or more KMZ files."); return; }
        let total = 0;
        const errors = [];
        for (const f of files) {
            try {
                total += await importKMZ(f);
            } catch (e) {
                console.error(e);
                errors.push(f.name + ": " + e.message);
            }
        }
        $("importKmzFile").value = "";
        if (errors.length) alert("Some files failed to import:\n" + errors.join("\n"));
        else if (total === 0) alert("No flight plans found in the selected files.");
    });

    // Coverage
    $("toggleCoverageBtn").addEventListener("click", () => {
        const plan = getActivePlan();
        if (!plan?.pathFeature) { alert("Generate a flight plan first."); return; }
        toggleCoverage(plan);
    });

    refreshSelect();
}

// ── Persistence ───────────────────────────────────────────────────────────────

const STORAGE_KEY = "flightPlanner_v1";

function saveState() {
    try {
        const state = {
            view: { lat: map.getCenter().lat, lng: map.getCenter().lng, zoom: map.getZoom() },
            activePlanId,
            nextId,
            plans: plans.map(p => ({
                id:          p.id,
                name:        p.name,
                colour:      p.colour,
                spacing:     p.spacing,
                orientation: p.orientation,
                shiftM:      p.shiftM,
                extent:      p.extentLayer.getLatLngs()[0].map(ll => ({ lat: ll.lat, lng: ll.lng })),
                pathFeature: p.pathFeature || null,
            })),
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* storage unavailable */ }
}

function loadState() {
    let state;
    try { state = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch (e) {}
    if (!state?.plans?.length) return;

    // Restore map view
    if (state.view) map.setView([state.view.lat, state.view.lng], state.view.zoom);

    nextId = state.nextId || 1;

    for (const s of state.plans) {
        const latlngs = s.extent.map(c => L.latLng(c.lat, c.lng));
        const layer = L.polygon([latlngs], {
            color: "#ff2222", weight: 2, dashArray: "8 5", fillColor: s.colour, fillOpacity: 0.04, pane: "boundaryPane",
        }).addTo(map);
        drawnItems.addLayer(layer);

        const startMarker = latlngs.length > 0
            ? L.circleMarker(latlngs[0], {
                radius: 6, color: "#ffd500", weight: 2,
                fillColor: "#ffff00", fillOpacity: 1,
              }).addTo(map)
            : null;

        const plan = {
            id:           s.id,
            name:         s.name,
            colour:       s.colour,
            extentLayer:  layer,
            pathLayer:    null,
            startMarker,
            coverageLayer: null,
            missingLayer:  null,
            spacing:      s.spacing,
            orientation:  s.orientation,
            shiftM:       s.shiftM || 0,
            pathFeature:  s.pathFeature || null,
            coverage:     null,
            showCoverage: false,
            editMode:     false,
            editMarkers:  [],
            rotHandle:    null,
            rotLine:      null,
            endMarker:    null,
        };

        layer.on("click", () => setActive(plan.id));
        plans.push(plan);

        if (plan.pathFeature) {
            drawPath(plan);
            updateInfoPanel(plan);
        }
        updateRotHandle(plan);
    }

    refreshSelect();
    activePlanId = state.activePlanId;
    if (activePlanId) setActive(activePlanId);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    initMap();
    initControls();
    loadState();
});
