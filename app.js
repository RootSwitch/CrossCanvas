/*
 * CrossCanvas - the whole app in one file, on purpose: zero dependencies, no build
 * step, runs from file:// or any static host. (See "Why one file?" in the
 * README.) Rendering is SVG; the model lives in `state`; everything is inside
 * one IIFE.
 *
 * TABLE OF CONTENTS - every entry matches a "// --- <name> ---" banner below;
 * Ctrl+F the name to jump. In file order:
 *
 *   Foundations
 *     Canvas tiers (Layers menu) · Collapsible sidebar sections · Utility
 *     Attachment Points · Label Positioning
 *   Rendering
 *     Device Rendering · Connection Routing · Imported-route conversion
 *     Arrow Marker Defs · Path Geometry Helpers for Annotations
 *     Connection Rendering
 *   Chrome & controls
 *     Device Templates & Import · Canvas Drop · Tool Selection · Zoom controls
 *     Grid show/hide · Alignment guides · Toolbar quick-action buttons
 *     Menu bar · Dark mode toggle · Properties pane · Alignment segmented
 *     controls · App modal (native <dialog>) · Help · Font families
 *     Batch edit · Right-click context menu · Diagram Title / Version fields
 *   Interaction
 *     Canvas Interaction (mousedown/move/up: drag, marquee, connect, resize)
 *     Groups · Selection · Connection annotation selection
 *   Object properties
 *     Device Properties · Themes · Device Scaling · Device Details
 *     Font & Label Controls (Device) · Image property panel · Zones
 *     Pasted Images · Connection Properties · Delete · Z-order / arrange
 *   Persistence
 *     Save / Load · Recent diagrams · Autosave + restore
 *   Import / export
 *     Gliffy Import (3 phases) · Batch convert · Visio (.vsdx) import
 *     draw.io (.drawio) import · Export JPEG (raster/PDF exporters)
 *     Inventory import · Vendor CSV profiles (CC/ISE/Kea/DHCP + text
 *     parsers) · draw.io export
 *   Text & embedding
 *     Inline Canvas Text Editing · Embed hook (read-only hosts: the
 *     PingCanvas kiosk)
 */
(() => {
    // Snap step. The VISIBLE grid pattern (index.html #grid-pattern) stays at
    // 20px - objects snap to half-lines, Visio-style - so the canvas doesn't
    // get busier while imported (Gliffy/Visio) positions barely move on first
    // touch and fine layout needs less Alt. Alt = half of this (5px).
    const GRID_SIZE = 10;
    const VISIBLE_GRID = 20;       // drawn grid spacing (canvas pattern + raster exports)
    const APP_VERSION = '4.0.0';   // stamped into saved files; bump on release
    let DEVICE_SIZE = 60;
    let DEFAULT_FONT_SIZE = 16;
    let DEFAULT_FONT_FAMILY = '';      // FONT_STACKS key; '' = default face
    let DEFAULT_FONT_COLOR = '#333333';
    let DEFAULT_DEVICE_TINT = null;    // null = untinted stencil colors
    let DEFAULT_CONN_COLOR = '#333333';   // theme ink for connections - the
    // #conn-color input can't be the source of truth (it mirrors whichever
    // connection is selected), so resets/seeding/swatches read this instead.
    let DEFAULT_ICON_BG = null;        // null = classic white device face
    let activeThemeSeed = null;        // the active theme's canvas seed (null = Classic);
                                       // the Reset buttons restore THESE values
    let DEFAULT_ZONE_FILL = null;      // null = classic light-blue fill
    let DEFAULT_ZONE_BORDER = null;    // null = auto: device-frame blue, or derived from a custom fill
    let DEFAULT_AP_COUNT = 8;   // attachment points on newly placed devices, zones and pasted images
    // Inventory-CSV import grid spacing multipliers (1 = the default packing).
    // Widen for long hostnames, heighten for multi-line labels.
    let IMPORT_HSPACE = 1;
    let IMPORT_VSPACE = 1;
    // How devices are ordered within each zone on inventory-CSV import.
    let IMPORT_SORT = 'file';   // 'file' | 'mac' | 'type' | 'label'
    const AP_RADIUS = 6;

    let state = {
        tool: 'select',
        devices: [],
        connections: [],
        zones: [],
        textBoxes: [],
        images: [],
        deviceTemplates: [],
        selectedDevice: null,
        selectedDevices: [],
        selectedZones: [],
        selectedTextBoxes: [],
        selectedImages: [],
        selectedConnections: [],
        selectedConnection: null,
        selectedZone: null,
        selectedTextBox: null,
        selectedImage: null,
        selectedAnnotation: null,
        dragging: null,
        connecting: null,
        marquee: null,
        resizingZone: null,
        resizingDevice: null,
        resizingImage: null,
        draggingBend: null,
        draggingAnnotation: null,
        draggingEndpoint: null,
        clipboard: null,
        nextId: 1,
        dirty: false,
        inlineEditing: null,
        diagramTitle: 'network-diagram',
        diagramVersion: 1,
        zoom: 1,
        panning: null,
        showGrid: true,
        showGuides: true,
        groups: []
    };

    const MIN_ZOOM = 0.2, MAX_ZOOM = 4;

    // Read-only embed mode: a host page (e.g. the PingCanvas kiosk fork) sets
    // window.CROSSCANVAS_EMBED = true BEFORE this script loads. Embed mode never
    // prompts (no autosave-restore confirm, no first-visit sample, no unload
    // warning) and never WRITES the autosave - an embedder served from the
    // same origin must not clobber the editor's autosaved work. Everything
    // else behaves identically; see the window.CrossCanvas hook near the end of
    // this file for the surface embedders call. (The pre-rename NETDRAW_EMBED
    // flag stays honored so an older kiosk page works against a newer app.js.)
    const EMBED = !!(window.CROSSCANVAS_EMBED || window.NETDRAW_EMBED);

    // tests.html drives the REAL app in a same-origin iframe, sharing this
    // origin's localStorage. Theme/round-trip fixtures dirty the document,
    // which would autosave the fixture over a developer's real work and even
    // pop a restore prompt on boot. In cctest mode the app must never touch the
    // autosave slot - same rule as EMBED, different reason.
    const CCTEST = location.search.indexOf('cctest') >= 0;

    // One-time migration of pre-rename localStorage (netdraw-*) so nobody
    // loses their settings to the rebrand. The list is the FULL v3.1 key
    // inventory - panel side, collapse states, and the saved inventory
    // import template were missed at first and silently reset on upgrade.
    try {
        ['autosave', 'dark', 'grid', 'guides', 'recents', 'theme', 'visited',
         'props-side', 'collapse-devprops', 'collapse-devdetails',
         'inventory-template'].forEach(k => {
            const old = localStorage.getItem('netdraw-' + k);
            if (old !== null && localStorage.getItem('crosscanvas-' + k) === null) {
                localStorage.setItem('crosscanvas-' + k, old);
            }
        });
    } catch (e) { /* storage unavailable */ }

    const undoStack = [];
    const redoStack = [];
    const MAX_UNDO = 50;

    // Undo snapshots intern image data URIs: state carries icons inline, so a
    // plain stringify used to cost multi-MB per drag start (twice: capture +
    // compare) with up to 50 copies retained on the stack. The session-scoped
    // intern table swaps each distinct data URI for a short key; the reviver
    // swaps it back on restore. '\u0000' cannot appear in a data URI, so the
    // keys can never collide with real image strings.
    const snapKeyByImage = new Map();
    const snapImageByKey = new Map();
    let snapImageN = 0;
    function snapshotReplacer(key, value) {
        if ((key === 'image' || key === 'originalImage' || key === 'dataURL') &&
            typeof value === 'string' && value.startsWith('data:')) {
            let k = snapKeyByImage.get(value);
            if (!k) {
                k = '\u0000img' + (++snapImageN);
                snapKeyByImage.set(value, k);
                snapImageByKey.set(k, value);
            }
            return k;
        }
        return value;
    }
    function snapshotReviver(key, value) {
        if (typeof value === 'string' && value.charCodeAt(0) === 0) {
            const orig = snapImageByKey.get(value);
            if (orig !== undefined) return orig;
        }
        return value;
    }
    // The intern tables would otherwise grow for the whole session: a key
    // minted for a snapshot that is later evicted off the capped undo stack
    // stays in the maps, so a long session pasting screenshots retains every
    // image until reload. Sweep unreferenced keys once the table gets large -
    // cheap no-op below the threshold, so normal editing never pays for it.
    const INTERN_GC_THRESHOLD = 128;
    function gcSnapshotIntern() {
        if (snapImageByKey.size < INTERN_GC_THRESHOLD) return;
        const live = new Set();
        // Keys serialize into the JSON snapshots as the escape \u0000img<N>;
        // reconstruct the in-memory key form (real NUL + img<N>) to compare.
        const re = /\\u0000img(\d+)/g;
        const scan = (json) => { let m; re.lastIndex = 0; while ((m = re.exec(json))) { live.add('\u0000img' + m[1]); } };
        undoStack.forEach(scan);
        redoStack.forEach(scan);
        Array.from(snapImageByKey.keys()).forEach(k => {
            if (!live.has(k)) { const img = snapImageByKey.get(k); snapImageByKey.delete(k); snapKeyByImage.delete(img); }
        });
    }

    function snapshotState() {
        return JSON.stringify({
            devices: state.devices,
            connections: state.connections,
            zones: state.zones,
            textBoxes: state.textBoxes,
            images: state.images,
            groups: state.groups,
            nextId: state.nextId,
            // Document identity travels with the snapshot so undoing across
            // an Open/Merge restores the old content under its OWN title -
            // not the newly opened file's name (which Save would then reuse).
            diagramTitle: state.diagramTitle,
            diagramVersion: state.diagramVersion
        }, snapshotReplacer);
    }

    function pushUndo() {
        // A pending debounced snapshot predates the current state - commit it
        // first so history stays ordered (it used to land 500ms later ON TOP
        // of this push, making the second Ctrl+Z move forward in time).
        flushDebouncedUndo();
        undoStack.push(snapshotState());
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
        gcSnapshotIntern();
        updateUndoRedoButtons();
        setDirty(true);
    }

    function restoreSnapshot(json) {
        // Remember the single selection so it can survive the undo/redo -
        // re-selecting through the normal select* path repopulates the
        // property panel from the restored values (panels used to keep their
        // pre-undo numbers until the object was manually re-selected).
        const prevSel = {
            device: state.selectedDevice, zone: state.selectedZone,
            conn: state.selectedConnection, textBox: state.selectedTextBox,
            image: state.selectedImage
        };
        const data = JSON.parse(json, snapshotReviver);
        state.devices = data.devices;
        state.connections = data.connections;
        state.zones = data.zones;
        state.textBoxes = data.textBoxes || [];
        state.images = data.images || [];
        state.groups = data.groups || [];
        state.nextId = data.nextId;
        // Older snapshots (pre-identity) lack these - leave the current
        // title/version alone rather than blanking them.
        if (data.diagramTitle !== undefined) {
            state.diagramTitle = data.diagramTitle;
            state.diagramVersion = data.diagramVersion || 1;
            updateTitleVersionUI();
        }
        state.selectedDevice = null;
        state.selectedConnection = null;
        state.selectedZone = null;
        state.selectedTextBox = null;
        state.selectedImage = null;
        state.selectedDevices = [];
        state.selectedZones = [];
        state.selectedTextBoxes = [];
        state.selectedImages = [];
        state.selectedConnections = [];
        clearAnnotationSelection();
        // Kill EVERY in-flight interaction, not just plain drags - an undo
        // mid-resize/bend/connect otherwise keeps mutating an orphaned object
        // and re-renders a ghost over the restored one. Ditto a live inline
        // editor, whose deferred blur-commit would resurrect the undone text.
        cancelInlineEdit();
        state.dragging = null;
        state.resizingDevice = null;
        state.resizingZone = null;
        state.resizingImage = null;
        state.draggingBend = null;
        state.draggingWaypoint = null;
        state.draggingEndpoint = null;
        state.draggingAnnotation = null;
        state.connecting = null;
        state.marquee = null;
        preDragSnapshot = null;
        ['temp-connection', 'marquee-rect'].forEach(tid => {
            const el = document.getElementById(tid);
            if (el) el.remove();
        });
        renderAll();
        PROP_PANEL_IDS.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        if (prevSel.device && state.devices.some(d => d.id === prevSel.device)) selectDevice(prevSel.device);
        else if (prevSel.zone && state.zones.some(z => z.id === prevSel.zone)) selectZone(prevSel.zone);
        else if (prevSel.conn && state.connections.some(c => c.id === prevSel.conn)) selectConnection(prevSel.conn);
        else if (prevSel.textBox && state.textBoxes.some(t => t.id === prevSel.textBox)) selectTextBox(prevSel.textBox);
        else if (prevSel.image && state.images.some(i => i.id === prevSel.image)) selectImage(prevSel.image);
        else if (state.tool === 'connect') document.getElementById('connection-panel').style.display = 'block';
        updateUndoRedoButtons();
    }

    function undo() {
        // Flush a pending debounced edit first so it becomes the step being
        // undone (typing then Ctrl+Z within 500ms must revert the typing).
        flushDebouncedUndo();
        if (undoStack.length === 0) return;
        redoStack.push(snapshotState());
        restoreSnapshot(undoStack.pop());
    }

    function redo() {
        // A pending debounced edit after an undo is a new branch - flushing
        // clears the redo stack, so this correctly becomes a no-op.
        flushDebouncedUndo();
        if (redoStack.length === 0) return;
        undoStack.push(snapshotState());
        restoreSnapshot(redoStack.pop());
    }

    function updateUndoRedoButtons() {
        const undoOpacity = undoStack.length ? '1' : '0.4';
        const redoOpacity = redoStack.length ? '1' : '0.4';
        ['btn-undo', 'tbar-undo'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.opacity = undoOpacity;
        });
        ['btn-redo', 'tbar-redo'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.opacity = redoOpacity;
        });
    }

    let preDragSnapshot = null;
    let undoDebounceTimer = null;
    let undoDebounceSnapshot = null;
    function commitDebouncedSnapshot() {
        if (undoDebounceSnapshot) {
            undoStack.push(undoDebounceSnapshot);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
            redoStack.length = 0;
            gcSnapshotIntern();
            updateUndoRedoButtons();
            setDirty(true);
        }
        undoDebounceTimer = null;
        undoDebounceSnapshot = null;
    }
    // Commit a pending debounced snapshot NOW (or no-op). pushUndo/undo/redo
    // call this so the 500ms timer can never land a stale snapshot on top of
    // later history.
    function flushDebouncedUndo() {
        if (!undoDebounceTimer) return;
        clearTimeout(undoDebounceTimer);
        commitDebouncedSnapshot();
    }
    function pushUndoDebounced() {
        if (!undoDebounceTimer) {
            undoDebounceSnapshot = snapshotState();
        } else {
            clearTimeout(undoDebounceTimer);
        }
        undoDebounceTimer = setTimeout(commitDebouncedSnapshot, 500);
    }

    // Commit the pre-drag snapshot to the undo stack, but only if the gesture
    // actually changed something (a click that never moved must not create an
    // undo step). One place instead of the four copies the mouseup handler
    // used to carry.
    function commitPreDragUndo() {
        if (preDragSnapshot && preDragSnapshot !== snapshotState()) {
            undoStack.push(preDragSnapshot);
            if (undoStack.length > MAX_UNDO) undoStack.shift();
            redoStack.length = 0;
            gcSnapshotIntern();
            updateUndoRedoButtons();
            setDirty(true);
        }
        preDragSnapshot = null;
    }

    // Drag fast path: node groups position everything in local coordinates,
    // so moving one only needs a new translate. Rebuilding the group per
    // mousemove (including its multi-KB data-URI <image>) is what made large
    // diagrams stutter under drag.
    function moveNodeElement(node) {
        const el = document.getElementById(node.id);
        if (el) el.setAttribute('transform', `translate(${node.x}, ${node.y})`);
    }

    // Marquee fast path: rubber-banding only changes selection membership, so
    // toggle the selection classes on existing elements instead of tearing
    // down all four layers per mousemove (~thousands of elements at import
    // scale). Marquee-start already cleared singular selections, so touching
    // 'multi-selected' (and 'selected' on connection paths) is safe.
    function refreshMarqueeSelectionClasses() {
        const devs = new Set(state.selectedDevices);
        const zones = new Set(state.selectedZones);
        const imgs = new Set(state.selectedImages);
        const tbs = new Set(state.selectedTextBoxes);
        const conns = new Set(state.selectedConnections);
        for (const g of devicesLayer.children) {
            const set = g.classList.contains('textbox-node') ? tbs : devs;
            g.classList.toggle('multi-selected', set.has(g.id));
        }
        for (const g of zonesLayer.children) g.classList.toggle('multi-selected', zones.has(g.id));
        for (const g of imagesLayer.children) g.classList.toggle('multi-selected', imgs.has(g.id));
        connectionsLayer.querySelectorAll('path.connection-line').forEach(p =>
            p.classList.toggle('selected', conns.has(p.dataset.connId)));
    }

    function renderAll() {
        renderAllZones();
        renderAllImages();
        renderAllConnections();
        renderAllDevices();
        updateCanvasSize();
    }

    function updateCanvasSize() {
        const container = document.getElementById('canvas-container');
        const z = state.zoom;
        const padding = 200;
        // Work in user (content) units; the viewBox maps them to zoomed pixels.
        let needW = container.clientWidth / z;
        let needH = container.clientHeight / z;

        state.devices.forEach(d => {
            needW = Math.max(needW, d.x + d.w + padding);
            needH = Math.max(needH, d.y + d.h + padding);
        });
        state.zones.forEach(z2 => {
            needW = Math.max(needW, z2.x + z2.w + padding);
            needH = Math.max(needH, z2.y + z2.h + padding);
        });
        state.textBoxes.forEach(tb => {
            const r = textBoxRect(tb);
            needW = Math.max(needW, tb.x + r.w + padding);
            needH = Math.max(needH, tb.y + r.h + padding);
        });
        state.images.forEach(img => {
            needW = Math.max(needW, img.x + img.w + padding);
            needH = Math.max(needH, img.y + img.h + padding);
        });

        canvas.setAttribute('viewBox', `0 0 ${needW} ${needH}`);
        canvas.setAttribute('preserveAspectRatio', 'xMinYMin meet');
        canvas.style.width = (needW * z) + 'px';
        canvas.style.height = (needH * z) + 'px';
    }

    function updateZoomLabel() {
        const el = document.getElementById('zoom-level');
        if (el) el.textContent = Math.round(state.zoom * 100) + '%';
    }

    // Set zoom, keeping the content point under (anchorClientX, anchorClientY)
    // fixed on screen. Anchor defaults to the viewport center.
    function setZoom(newZoom, anchorClientX, anchorClientY) {
        const container = document.getElementById('canvas-container');
        newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
        if (Math.abs(newZoom - state.zoom) < 0.0001) return;
        const cRect = container.getBoundingClientRect();
        if (anchorClientX == null) {
            anchorClientX = cRect.left + container.clientWidth / 2;
            anchorClientY = cRect.top + container.clientHeight / 2;
        }
        const svgRect = canvas.getBoundingClientRect();
        const ux = (anchorClientX - svgRect.left) / state.zoom;
        const uy = (anchorClientY - svgRect.top) / state.zoom;
        state.zoom = newZoom;
        updateCanvasSize();
        container.scrollLeft = ux * newZoom - (anchorClientX - cRect.left);
        container.scrollTop = uy * newZoom - (anchorClientY - cRect.top);
        updateZoomLabel();
    }

    const canvas = document.getElementById('canvas');
    const devicesLayer = document.getElementById('devices-layer');
    const connectionsLayer = document.getElementById('connections-layer');
    const zonesLayer = document.getElementById('zones-layer');
    const imagesLayer = document.getElementById('images-layer');
    const overlayLayer = document.getElementById('overlay-layer');

    // --- Canvas tiers (Layers menu): per-tier visibility & lock ---
    // View/interaction state, deliberately NOT part of the document: it isn't
    // saved, isn't in undo snapshots, and resets when a diagram is loaded,
    // created or imported. Hidden = not rendered, not selectable, excluded
    // from raster exports (WYSIWYG). Locked = visible but inert: clicks pass
    // through (e.g. marquee inside a zone without grabbing it), no selection.
    const TIER_LAYER_EL = { devices: devicesLayer, connections: connectionsLayer, images: imagesLayer, zones: zonesLayer };
    const tierState = {
        devices: { hidden: false, locked: false },
        connections: { hidden: false, locked: false },
        images: { hidden: false, locked: false },
        zones: { hidden: false, locked: false }
    };
    const tierHidden = (t) => tierState[t].hidden;
    const tierBlocked = (t) => tierState[t].hidden || tierState[t].locked;   // not selectable

    function applyTierState() {
        Object.keys(tierState).forEach(t => {
            TIER_LAYER_EL[t].style.display = tierState[t].hidden ? 'none' : '';
            TIER_LAYER_EL[t].style.pointerEvents = tierState[t].locked ? 'none' : '';
        });
        document.querySelectorAll('.tier-row').forEach(row => {
            const t = row.dataset.tier;
            row.classList.toggle('tier-hidden', tierState[t].hidden);
            row.classList.toggle('tier-locked', tierState[t].locked);
            row.querySelector('.tier-lock').textContent = tierState[t].locked ? '🔒' : '🔓';
        });
    }

    // Drop any selection living in a tier that just became hidden or locked.
    function deselectTier(t) {
        if (t === 'devices') {
            state.selectedDevices = []; state.selectedTextBoxes = [];
            if (state.selectedDevice) selectDevice(null);
            if (state.selectedTextBox) selectTextBox(null);
        } else if (t === 'zones') {
            state.selectedZones = [];
            if (state.selectedZone) selectZone(null);
        } else if (t === 'images') {
            state.selectedImages = [];
            if (state.selectedImage) selectImage(null);
        } else if (t === 'connections') {
            state.selectedConnections = [];
            if (state.selectedConnection) selectConnection(null);
            clearAnnotationSelection();
        }
        renderAllZones(); renderAllImages(); renderAllDevices(); renderAllConnections();
        refreshBatchPanel();
    }

    function resetTiers() {
        Object.keys(tierState).forEach(t => { tierState[t].hidden = false; tierState[t].locked = false; });
        applyTierState();
    }

    // A hidden tier would swallow newly created content invisibly - auto-show.
    function ensureTierVisible(t) {
        if (tierState[t].hidden) {
            tierState[t].hidden = false;
            applyTierState();
        }
    }

    document.querySelectorAll('.tier-row').forEach(row => {
        const t = row.dataset.tier;
        // stopPropagation: the document-level click handler closes menus, but
        // toggling tiers is exploratory - keep the menu open.
        row.querySelector('.tier-eye').addEventListener('click', (e) => {
            e.stopPropagation();
            tierState[t].hidden = !tierState[t].hidden;
            if (tierState[t].hidden) deselectTier(t);
            applyTierState();
        });
        row.querySelector('.tier-lock').addEventListener('click', (e) => {
            e.stopPropagation();
            tierState[t].locked = !tierState[t].locked;
            if (tierState[t].locked) deselectTier(t);
            applyTierState();
        });
    });
    const deviceList = document.getElementById('device-list');

    // --- Collapsible sidebar sections ---
    function refreshSectionHeight(contentEl) {
        if (!contentEl.classList.contains('collapsed')) {
            contentEl.style.maxHeight = contentEl.scrollHeight + 'px';
        }
    }

    // Only the sidebar sections carry data-target - the device panel's
    // collapse headers share the CLASS for looks but wire their own toggles
    document.querySelectorAll('.section-header[data-target]').forEach(header => {
        const content = document.getElementById(header.dataset.target);
        // Sections marked collapsed in the HTML start closed (Default Settings)
        content.style.maxHeight = content.classList.contains('collapsed') ? '0' : content.scrollHeight + 'px';
        header.addEventListener('click', () => {
            header.classList.toggle('collapsed');
            content.classList.toggle('collapsed');
            if (content.classList.contains('collapsed')) {
                content.style.maxHeight = '0';
            } else {
                content.style.maxHeight = content.scrollHeight + 'px';
            }
        });
    });

    // --- Utility ---
    function isSVGDataURL(url) {
        return url && url.startsWith('data:image/svg');
    }

    function isSafeImageURL(url) {
        return typeof url === 'string' && url.startsWith('data:image/');
    }

    function parseColorToRGB(str) {
        str = str.trim().toLowerCase();
        const hexMatch = str.match(/^#([0-9a-f]{3,8})$/);
        if (hexMatch) {
            let hex = hexMatch[1];
            if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
            return [parseInt(hex.slice(0,2),16), parseInt(hex.slice(2,4),16), parseInt(hex.slice(4,6),16)];
        }
        const rgbMatch = str.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
        if (rgbMatch) return [+rgbMatch[1], +rgbMatch[2], +rgbMatch[3]];
        const named = { white:[255,255,255], black:[0,0,0], red:[255,0,0], green:[0,128,0], blue:[0,0,255], yellow:[255,255,0], gray:[128,128,128], grey:[128,128,128] };
        if (named[str]) return named[str];
        return null;
    }

    function isChromatic(r, g, b) {
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        const lum = (max + min) / 2;
        if (lum > 230 || lum < 25) return false;
        const range = max - min;
        return range > 30;
    }

    // Imported SVG stencils from icon sets (Lucide, Tabler, …) are usually
    // monochrome line art: stroke="currentColor" or plain black/dark gray,
    // fill none. currentColor resolves to BLACK inside an <image>, and
    // tintSVG deliberately preserves neutrals - so the icon renders black
    // and Device Color appears to do nothing. Normalize at import time: when
    // the art carries no chromatic color of its own, currentColor and dark
    // neutrals become the stencil blue - matching the bundled set's look AND
    // making the icon chromatic (= tintable) from then on. Real multi-color
    // artwork is left untouched.
    function normalizeImportedSVG(dataURL) {
        if (!isSVGDataURL(dataURL)) return dataURL;
        try {
            const base64 = dataURL.split(',')[1];
            let svg = decodeURIComponent(escape(atob(base64)));
            let chromatic = false;
            svg.replace(/(?:fill|stroke)\s*[:=]\s*"?\s*([^";}<]+)/gi, (m2, val) => {
                const rgb = parseColorToRGB(val.replace(/"$/, ''));
                if (rgb && isChromatic(rgb[0], rgb[1], rgb[2])) chromatic = true;
                return m2;
            });
            if (chromatic) return dataURL;
            const BLUE = 'rgb(45,103,185)';
            const swap = (m2, prefix, val, suffix) => {
                const v = val.trim().toLowerCase();
                if (v === 'currentcolor') return prefix + BLUE + suffix;
                const rgb = parseColorToRGB(v);
                if (rgb && !isChromatic(rgb[0], rgb[1], rgb[2]) &&
                    (rgb[0] + rgb[1] + rgb[2]) < 384) return prefix + BLUE + suffix;
                return m2;
            };
            svg = svg.replace(/(fill\s*=\s*")(?!none|transparent)([^"]*?)(")/gi, swap);
            svg = svg.replace(/(stroke\s*=\s*")(?!none|transparent)([^"]*?)(")/gi, swap);
            svg = svg.replace(/(fill\s*:\s*)(?!none|transparent)([^;"}<]+)()/gi, swap);
            svg = svg.replace(/(stroke\s*:\s*)(?!none|transparent)([^;"}<]+)()/gi, swap);
            // Icons that rely on the DEFAULT fill (no fill/stroke anywhere)
            // render black too - give the root the blue so paths inherit it
            if (!svg.includes(BLUE) && !/(?:fill|stroke)\s*[:=]/i.test(svg)) {
                svg = svg.replace(/<svg\b/i, '<svg fill="' + BLUE + '"');
            }
            return svgToDataURL(svg);
        } catch (e) {
            return dataURL;
        }
    }

    function tintSVG(dataURL, color) {
        try {
            const base64 = dataURL.split(',')[1];
            let svg = decodeURIComponent(escape(atob(base64)));

            function replaceIfChromatic(match, prefix, colorVal, suffix) {
                const rgb = parseColorToRGB(colorVal);
                if (!rgb || !isChromatic(rgb[0], rgb[1], rgb[2])) return match;
                return prefix + color + suffix;
            }

            svg = svg.replace(/(fill\s*=\s*")(?!none|transparent)([^"]*?)(")/gi, replaceIfChromatic);
            svg = svg.replace(/(stroke\s*=\s*")(?!none|transparent)([^"]*?)(")/gi, replaceIfChromatic);
            svg = svg.replace(/(fill\s*:\s*)(?!none|transparent)(rgb\([^)]*\))()/gi, replaceIfChromatic);
            svg = svg.replace(/(fill\s*:\s*)(?!none|transparent)(#[0-9a-f]{3,8})()/gi, replaceIfChromatic);
            svg = svg.replace(/(stroke\s*:\s*)(?!none|transparent)(rgb\([^)]*\))()/gi, replaceIfChromatic);
            svg = svg.replace(/(stroke\s*:\s*)(?!none|transparent)(#[0-9a-f]{3,8})()/gi, replaceIfChromatic);

            return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
        } catch (e) {
            return dataURL;
        }
    }

    // The one blob-download ritual (10+ call sites): objectURL → anchor
    // click → revoke. Centralized so a browser quirk fix lands everywhere.
    function triggerDownload(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function snapToGrid(val, step) {
        const s = step || GRID_SIZE;
        return Math.round(val / s) * s;
    }

    // Hold Alt while moving/resizing a zone to snap at half-grid (5px)
    // increments instead of the full grid - handy for centering port-channel
    // ellipses over closely-spaced connections.
    function snapStepFor(e) {
        return (e && e.altKey) ? GRID_SIZE / 2 : GRID_SIZE;
    }

    function getSVGPoint(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: (e.clientX - rect.left) / state.zoom, y: (e.clientY - rect.top) / state.zoom };
    }

    function genId() {
        return 'd' + (state.nextId++);
    }

    // Diagram title reduced to a safe download filename base.
    function sanitizedTitle() {
        return ((state.diagramTitle || 'network-diagram').replace(/[^a-zA-Z0-9_\-. ]/g, '_') || 'network-diagram');
    }

    // --- Attachment Points ---
    // Corner-anchored distribution: every corner always gets a point, and the
    // remaining points spread evenly along each side between the corners. (A
    // plain perimeter walk only landed on corners for squares - on rectangles
    // the points drifted off the corners.) Emission order matches the classic
    // 8-point layout (top-center first, clockwise, top-left last) so count 8
    // reproduces it index-for-index and resizes never remap connections.
    function distributeAttachmentPoints(w, h, count) {
        if (count < 4) {
            // Legacy counts from the old +/- buttons: plain perimeter walk.
            const perimeter = 2 * (w + h);
            const points = [];
            for (let i = 0; i < count; i++) {
                const dist = (i / count) * perimeter;
                let rx, ry;
                if (dist < w) {
                    rx = dist; ry = 0;
                } else if (dist < w + h) {
                    rx = w; ry = dist - w;
                } else if (dist < 2 * w + h) {
                    rx = w - (dist - w - h); ry = h;
                } else {
                    rx = 0; ry = h - (dist - 2 * w - h);
                }
                points.push({ rx, ry });
            }
            return points;
        }
        // Side points per side; when the count isn't a multiple of 4 the
        // longest sides take the extras (stable sort: top/right win ties).
        const sides = [
            { key: 'top', len: w }, { key: 'right', len: h },
            { key: 'bottom', len: w }, { key: 'left', len: h }
        ];
        const base = Math.floor((count - 4) / 4);
        sides.forEach(s => { s.n = base; });
        [...sides].sort((a, b) => b.len - a.len)
            .slice(0, (count - 4) % 4)
            .forEach(s => { s.n++; });
        const n = {};
        sides.forEach(s => { n[s.key] = s.n; });
        const along = (len, i, total) => (i + 1) * (len / (total + 1));

        const pts = [];
        for (let i = 0; i < n.top; i++) pts.push({ rx: along(w, i, n.top), ry: 0 });
        pts.push({ rx: w, ry: 0 });                                       // top-right
        for (let i = 0; i < n.right; i++) pts.push({ rx: w, ry: along(h, i, n.right) });
        pts.push({ rx: w, ry: h });                                       // bottom-right
        for (let i = 0; i < n.bottom; i++) pts.push({ rx: w - along(w, i, n.bottom), ry: h });
        pts.push({ rx: 0, ry: h });                                       // bottom-left
        for (let i = 0; i < n.left; i++) pts.push({ rx: 0, ry: h - along(h, i, n.left) });
        pts.push({ rx: 0, ry: 0 });                                       // top-left
        return pts;
    }

    function getDefaultAttachmentPoints(w, h) {
        return distributeAttachmentPoints(w, h, 8);
    }

    // Attachment points for a newly created node, honoring the Attachment
    // Points slider. Applies to interactively created devices, zones and
    // pasted images - imports keep 8 for fidelity with the source file.
    function defaultAPsFor(w, h) {
        return distributeAttachmentPoints(w, h, DEFAULT_AP_COUNT);
    }

    // The ONE themed-device literal: everything a freshly created device
    // takes from the active theme / Default Settings - tint (via the palette
    // cache), label ink, font family, icon background, attachment points.
    // All four creation paths (palette drop, inventory import, both sample
    // builders) build on this; as separate literals they had already drifted
    // field by field. opts: w/h, labelPosition, labelVAlign, fontSize, aps
    // (samples pass a fixed-8 layout - their connections use AP indices).
    function makeThemedDevice(template, label, x, y, opts) {
        const o = opts || {};
        const w = o.w || DEVICE_SIZE, h = o.h || w;
        const lines = String(label || '').split('\n');
        const d = {
            id: genId(),
            templateId: template ? template.id : null,
            image: template ? paletteImageFor(template) : TEMPLATE_ICON,
            originalImage: template ? template.image : TEMPLATE_ICON,
            x: x, y: y, w: w, h: h,
            label: label, labelPosition: o.labelPosition || 'bottom',
            fontSize: o.fontSize || DEFAULT_FONT_SIZE,
            fontColor: DEFAULT_FONT_COLOR,
            fontFamily: DEFAULT_FONT_FAMILY || undefined,
            iconBg: DEFAULT_ICON_BG || undefined,
            lineFormats: lines.map(() => ({ bold: false, italic: false })),
            spans: lines.map(ln => [{ text: ln, bold: false, italic: false }]),
            tintColor: DEFAULT_DEVICE_TINT,
            attachmentPoints: o.aps || defaultAPsFor(w, h)
        };
        if (o.labelVAlign) d.labelVAlign = o.labelVAlign;
        return d;
    }

    // Scale attachment points WITH the node instead of regenerating an even
    // distribution: for standard layouts the result is identical (the
    // corner-anchored walk is proportional), and imported exact-anchor APs
    // keep their contact fractions - a resize must not tear connections off
    // their anchors. setNodeAPCount is the explicit regenerate path.
    function redistributeAPs(node, oldW, oldH) {
        const sx = oldW > 0 ? node.w / oldW : 1;
        const sy = oldH > 0 ? node.h / oldH : 1;
        if (sx === 1 && sy === 1) return;
        node.attachmentPoints = (node.attachmentPoints || []).map(ap =>
            ({ rx: ap.rx * sx, ry: ap.ry * sy }));
    }

    // Change a node's attachment-point count while keeping existing connections
    // visually anchored: record each endpoint's position, redistribute, then snap
    // each connection to whichever new AP is closest to where it was.
    function setNodeAPCount(node, newCount) {
        const recorded = [];
        state.connections.forEach(c => {
            if (c.fromDevice === node.id) recorded.push({ conn: c, end: 'from', pos: getAbsoluteAP(node, c.fromAP) });
            if (c.toDevice === node.id) recorded.push({ conn: c, end: 'to', pos: getAbsoluteAP(node, c.toAP) });
        });
        node.attachmentPoints = distributeAttachmentPoints(node.w, node.h, newCount);
        recorded.forEach(rec => {
            let bestIdx = 0, bestDist = Infinity;
            node.attachmentPoints.forEach((ap, i) => {
                const dx = (node.x + ap.rx) - rec.pos.x, dy = (node.y + ap.ry) - rec.pos.y;
                const d = dx * dx + dy * dy;
                if (d < bestDist) { bestDist = d; bestIdx = i; }
            });
            if (rec.end === 'from') rec.conn.fromAP = bestIdx;
            else rec.conn.toAP = bestIdx;
        });
    }

    function findNode(id) {
        return state.devices.find(d => d.id === id) || state.zones.find(z => z.id === id) || state.images.find(i => i.id === id);
    }

    function getAbsoluteAP(node, apIndex) {
        if (!node || !node.attachmentPoints || !node.attachmentPoints[apIndex]) return { x: 0, y: 0 };
        const ap = node.attachmentPoints[apIndex];
        return { x: node.x + ap.rx, y: node.y + ap.ry };
    }

    // Index of the node's attachment point closest to (x, y).
    function nearestAPIndex(node, x, y) {
        let best = 0, bd = Infinity;
        (node.attachmentPoints || []).forEach((ap, i) => {
            const d = (node.x + ap.rx - x) ** 2 + (node.y + ap.ry - y) ** 2;
            if (d < bd) { bd = d; best = i; }
        });
        return best;
    }

    // Exact-anchor resolution for imports (px/py are fractions of the node
    // box): reuse an attachment point within 2px of the contact point, else
    // inject one at the precise spot - source files are the ground truth for
    // where lines touch, and nearest-of-8 snapping collapsed parallel lines
    // onto a shared AP (bowties). Injected APs serialize like any others.
    function mapToAP(px, py, attachmentPoints, w, h) {
        const targetRx = px * w;
        const targetRy = py * h;
        let bestIdx = -1, bestDist = Infinity;
        attachmentPoints.forEach((ap, i) => {
            const dx = ap.rx - targetRx;
            const dy = ap.ry - targetRy;
            const dist = dx * dx + dy * dy;
            if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        });
        if (bestIdx >= 0 && bestDist <= 4) return bestIdx;   // within 2px
        attachmentPoints.push({ rx: targetRx, ry: targetRy });
        return attachmentPoints.length - 1;
    }

    // A connection end is either anchored to a node attachment point
    // (fromDevice/fromAP) or free-floating (fromPoint). Resolve to an absolute
    // {x,y}, or null if it can't be resolved (deleted node and no point).
    function resolveConnEndpoint(conn, end) {
        const devId = end === 'from' ? conn.fromDevice : conn.toDevice;
        const apIdx = end === 'from' ? conn.fromAP : conn.toAP;
        const pt = end === 'from' ? conn.fromPoint : conn.toPoint;
        if (devId) {
            const node = findNode(devId);
            if (node) return getAbsoluteAP(node, apIdx);
        }
        return pt ? { x: pt.x, y: pt.y } : null;
    }

    // A connection with at least one free end is drawn as a straight line
    // (orthogonal routing needs a node's geometry to pick exit directions).
    function connIsFreeEnded(conn) {
        return !conn.fromDevice || !conn.toDevice;
    }

    // Resolve the start of an in-progress connection (node AP or free point).
    function connectingStartPoint() {
        if (!state.connecting) return null;
        if (state.connecting.fromDevice) {
            const n = findNode(state.connecting.fromDevice);
            return n ? getAbsoluteAP(n, state.connecting.fromAP) : null;
        }
        return state.connecting.fromPoint || null;
    }

    // --- Label Positioning ---
    function getLabelAnchor(pos, w, h, fs) {
        switch (pos) {
            case 'top':          return { x: w / 2, y: -fs / 2, anchor: 'middle' };
            case 'left':         return { x: -6, y: h / 2 + fs / 3, anchor: 'end' };
            case 'right':        return { x: w + 6, y: h / 2 + fs / 3, anchor: 'start' };
            case 'center':       return { x: w / 2, y: h / 2 + fs / 3, anchor: 'middle' };
            case 'top-inside':   return { x: w / 2, y: fs + 4, anchor: 'middle' };
            case 'bottom-inside':return { x: w / 2, y: h - 6, anchor: 'middle' };
            default:             return { x: w / 2, y: h + fs + 3, anchor: 'middle' };
        }
    }

    function getVAlignOffset(valign, lineCount, lineHeight) {
        const totalH = (lineCount - 1) * lineHeight;
        if (valign === 'bottom') return -totalH;
        if (valign === 'center') return -totalH / 2;
        return 0;
    }

    // Vertical layout of a multi-line label. Inside positions self-anchor;
    // otherwise an EXPLICIT valign wins, and the default grows the block AWAY
    // from the node - top labels stack upward, everything else downward - so
    // a multi-line top label never spills into its own device. (Old files
    // carry an explicit 'top' from creation and keep their behavior.)
    function effectiveVAlign(pos, valign) {
        if (pos === 'top-inside') return 'top';
        if (pos === 'bottom-inside') return 'bottom';
        if (valign) return valign;
        if (pos === 'top') return 'bottom';       // grow away from the node
        if (pos === 'center') return 'center';    // stay centered in the node
        return 'top';
    }

    // Multi-line justification implied by a label position (what its anchor
    // does anyway): side labels justify toward the node, the rest center.
    function impliedLabelAlign(pos) {
        if (pos === 'left') return 'right';
        if (pos === 'right') return 'left';
        return 'center';
    }

    // Setting a whole-label color deliberately clears per-span colors -
    // otherwise an imported multi-color label (e.g. a Gliffy legend) would
    // silently ignore the color control.
    function clearSpanColors(obj) {
        (obj.spans || []).forEach(line => line.forEach(s => { delete s.color; }));
    }

    // labelAlign is an explicit override; 'auto' (the default) follows the
    // position, so existing diagrams render unchanged.
    function effectiveLabelAlign(obj) {
        const a = obj.labelAlign;
        return (a && a !== 'auto') ? a : impliedLabelAlign(obj.labelPosition || 'bottom');
    }

    // Widest rendered line of a spans block at font size fs (SVG measurement).
    // Cached: each getBBox forces a synchronous layout of the whole SVG, and
    // this runs per keystroke while editing and per mousemove while dragging
    // labeled/justified text - same content must not re-measure.
    const spanWidthCache = new Map();
    function measureSpansWidth(spans, fs, family) {
        const cacheKey = fs + '|' + (family || '') + '|' + JSON.stringify(spans);
        const cached = spanWidthCache.get(cacheKey);
        if (cached !== undefined) return cached;
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('font-size', fs);
        if (family) t.setAttribute('font-family', family);
        canvas.appendChild(t);
        let maxW = 0;
        spans.forEach(lineSpans => {
            let w = 0;
            lineSpans.forEach(span => {
                t.setAttribute('font-weight', span.bold ? 'bold' : 'normal');
                t.setAttribute('font-style', span.italic ? 'italic' : 'normal');
                t.textContent = span.text || ' ';
                w += t.getBBox().width;
            });
            maxW = Math.max(maxW, w);
        });
        canvas.removeChild(t);
        if (spanWidthCache.size > 500) spanWidthCache.clear();   // crude cap
        spanWidthCache.set(cacheKey, maxW);
        return maxW;
    }

    // x/anchor that justifies lines inside the label block without moving the
    // block itself off its position anchor.
    function justifiedLine(align, baseX, baseAnchor, maxW) {
        const left = baseAnchor === 'middle' ? baseX - maxW / 2 :
                     baseAnchor === 'end' ? baseX - maxW : baseX;
        if (align === 'left') return { x: left, anchor: 'start' };
        if (align === 'right') return { x: left + maxW, anchor: 'end' };
        return { x: left + maxW / 2, anchor: 'middle' };
    }

    // True for black / near-black grayscale colors (every channel dark). Used so
    // dark mode can flip black device labels to white without touching real colors.
    function isDark(color) {
        if (!color) return false;
        let r, g, b;
        let c = color.trim().toLowerCase();
        if (c[0] === '#') {
            if (c.length === 4) c = '#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3];
            if (c.length !== 7) return false;
            r = parseInt(c.slice(1, 3), 16);
            g = parseInt(c.slice(3, 5), 16);
            b = parseInt(c.slice(5, 7), 16);
        } else {
            const m = c.match(/rgba?\(([^)]+)\)/);
            if (!m) return false;
            [r, g, b] = m[1].split(',').map(n => parseInt(n, 10));
        }
        if ([r, g, b].some(v => isNaN(v))) return false;
        return r < 96 && g < 96 && b < 96;
    }

    // What actually sits behind a canvas point: the dark canvas, tinted by
    // every zone whose box contains the point (blended by fill-opacity, in
    // stacking order). The dark-mode adaptive flips key off this - flipping
    // near-black to white only helps when the surface behind is dark, and
    // imported diagrams lay their own LIGHT zone fills over the canvas
    // (white-on-pale is as unreadable as black-on-dark).
    function surfaceIsDarkAt(x, y) {
        if (!document.body.classList.contains('dark-mode')) return false;
        let r = 42, g = 42, b = 62;                     // #2a2a3e dark canvas
        state.zones.forEach(z => {
            if (x < z.x || x > z.x + z.w || y < z.y || y > z.y + z.h) return;
            const rgb = parseColorToRGB(z.fill || '#e8f4fd');
            if (!rgb) return;
            const a = z.opacity != null ? z.opacity : 1;
            r = rgb[0] * a + r * (1 - a);
            g = rgb[1] * a + g * (1 - a);
            b = rgb[2] * a + b * (1 - a);
        });
        return (0.299 * r + 0.587 * g + 0.114 * b) < 140;
    }

    // Shade a #rrggbb color toward black by factor f (0..1). Used to derive a
    // zone border from a custom default fill so the pair stays related.
    function darkenHex(hex, f) {
        const n = parseInt(hex.slice(1), 16);
        if (isNaN(n)) return hex;
        const ch = (v) => Math.max(0, Math.round(v * (1 - f)));
        const r = ch((n >> 16) & 255), g = ch((n >> 8) & 255), b = ch(n & 255);
        return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
    }

    function renderMultiLineLabel(group, obj, w, h, colorFallback, adaptiveDark) {
        const label = obj.label || '';
        if (!label) return;
        const spans = obj.spans || [[{ text: label, bold: false, italic: false }]];
        const fs = obj.fontSize || 20;
        const lineHeight = fs * 1.3;
        const pos = obj.labelPosition || 'bottom';
        const anchor = getLabelAnchor(pos, w, h, fs);
        const fillColor = obj.fontColor || colorFallback || '#333';
        const valign = effectiveVAlign(pos, obj.labelVAlign);
        const vOffset = getVAlignOffset(valign, spans.length, lineHeight);
        const adaptive = adaptiveDark && isDark(fillColor) &&
            surfaceIsDarkAt((obj.x || 0) + anchor.x, (obj.y || 0) + anchor.y);

        // Explicit justification re-anchors lines inside the block; only worth
        // measuring for multi-line labels (a single line can't be justified).
        const ff = fontStackOf(obj);
        let lineX = anchor.x, lineAnchor = anchor.anchor;
        if (obj.labelAlign && obj.labelAlign !== 'auto' && spans.length > 1) {
            const j = justifiedLine(obj.labelAlign, anchor.x, anchor.anchor, measureSpansWidth(spans, fs, ff));
            lineX = j.x; lineAnchor = j.anchor;
        }

        spans.forEach((lineSpans, i) => {
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', lineX);
            text.setAttribute('y', anchor.y + i * lineHeight + vOffset);
            text.setAttribute('text-anchor', lineAnchor);
            text.setAttribute('font-size', fs);
            if (ff) text.setAttribute('font-family', ff);
            text.setAttribute('fill', fillColor);
            if (adaptive) text.classList.add('device-label-adaptive');
            if (obj.fillOpacity != null) text.setAttribute('fill-opacity', obj.fillOpacity);
            lineSpans.forEach(span => {
                const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
                tspan.textContent = span.text;
                if (span.bold) tspan.setAttribute('font-weight', 'bold');
                if (span.italic) tspan.setAttribute('font-style', 'italic');
                if (span.color && isSafeCSSColor(span.color)) tspan.setAttribute('fill', span.color);
                text.appendChild(tspan);
            });
            group.appendChild(text);
        });
    }

    // --- Device Rendering ---
    function renderDevice(device) {
        let group = document.getElementById(device.id);
        if (group) group.remove();

        group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.id = device.id;
        group.classList.add('device-node');
        group.setAttribute('transform', `translate(${device.x}, ${device.y})`);

        if (state.selectedDevice === device.id) {
            group.classList.add('selected');
        }
        if (state.selectedDevices.includes(device.id)) {
            group.classList.add('multi-selected');
        }

        // App-drawn stencil frame (the bundled icons are borderless glyphs):
        // reproduces the set's baked frame - white face, blue rounded border,
        // 16/300 stroke, 30/300 radius - but stretches with non-square
        // devices, recolors directly from tintColor, and takes an optional
        // iconBg face color. Inset by half the stroke so the painted frame
        // stays inside the device bounds (APs sit on the true edges).
        const frameW = Math.max(1.5, Math.min(device.w, device.h) * 16 / 300);
        const frameR = Math.max(2, Math.min(device.w, device.h) * 30 / 300 - frameW / 2);
        const border = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        border.classList.add('device-border');
        border.setAttribute('x', frameW / 2);
        border.setAttribute('y', frameW / 2);
        border.setAttribute('width', device.w - frameW);
        border.setAttribute('height', device.h - frameW);
        border.setAttribute('fill', device.iconBg || 'rgb(255,254,254)');
        border.setAttribute('stroke', device.tintColor || STENCIL_FRAME_BLUE);
        border.setAttribute('stroke-width', frameW);
        border.setAttribute('rx', frameR);
        group.appendChild(border);

        const img = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        img.setAttribute('href', device.image);
        img.setAttribute('x', '0');
        img.setAttribute('y', '0');
        img.setAttribute('width', device.w);
        img.setAttribute('height', device.h);
        img.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        group.appendChild(img);

        // Selection indicator: a separate dashed outline OUTSIDE the frame.
        // (Restyling the frame rect on selection used to swallow the thick
        // stencil border, glaringly on scaled-up devices.) Always present,
        // shown via CSS - the marquee fast path only toggles classes.
        const selOutline = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        selOutline.classList.add('device-selection-outline');
        selOutline.setAttribute('x', -3);
        selOutline.setAttribute('y', -3);
        selOutline.setAttribute('width', device.w + 6);
        selOutline.setAttribute('height', device.h + 6);
        selOutline.setAttribute('rx', frameR + 3);
        selOutline.setAttribute('fill', 'none');
        group.appendChild(selOutline);

        if (device.label) {
            renderMultiLineLabel(group, device, device.w, device.h, '#333', true);
        }

        device.attachmentPoints.forEach((ap, i) => {
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.classList.add('attachment-point');
            circle.setAttribute('cx', ap.rx);
            circle.setAttribute('cy', ap.ry);
            circle.setAttribute('r', AP_RADIUS);
            circle.dataset.deviceId = device.id;
            circle.dataset.apIndex = i;
            group.appendChild(circle);
        });

        // Resize handles - zone-style: corner (both axes) plus per-edge, so
        // devices resize freely and non-square imported footprints stay
        // editable (the app-drawn frame stretches with them). The offset
        // clears the attachment-point circles (r=6 on the edge): handles at
        // +2 used to eclipse the edge-midpoint APs, making connection starts
        // a pixel hunt.
        const hs = 10, ho = AP_RADIUS + 4;
        [
            { x: device.w + ho, y: device.h + ho, axis: 'both', cursor: 'nwse-resize' },
            { x: device.w + ho, y: device.h / 2 - hs / 2, axis: 'r', cursor: 'ew-resize' },
            { x: device.w / 2 - hs / 2, y: device.h + ho, axis: 'b', cursor: 'ns-resize' },
            { x: -ho - hs, y: device.h / 2 - hs / 2, axis: 'l', cursor: 'ew-resize' },
            { x: device.w / 2 - hs / 2, y: -ho - hs, axis: 't', cursor: 'ns-resize' }
        ].forEach(hd => {
            const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            handle.classList.add('device-resize-handle');
            handle.setAttribute('x', hd.x);
            handle.setAttribute('y', hd.y);
            handle.setAttribute('width', hs);
            handle.setAttribute('height', hs);
            handle.setAttribute('rx', '2');
            handle.dataset.deviceId = device.id;
            handle.dataset.axis = hd.axis;
            handle.dataset.role = 'resize';
            handle.style.cursor = hd.cursor;
            group.appendChild(handle);
        });

        devicesLayer.appendChild(group);
    }

    function renderAllDevices() {
        devicesLayer.innerHTML = '';
        // Interleave devices and text boxes by their shared stacking order -
        // rendering all devices then all text boxes would pin every text box
        // above every device and silently defeat Bring to Front between them.
        const devSet = new Set(state.devices);
        deviceLayerStack().forEach(o => devSet.has(o) ? renderDevice(o) : renderTextBox(o));
        updateGroupOutlines();
    }

    // A text box's rendered size - the box hugs the measured text (there is
    // no stored w/h). One source of truth for EVERY consumer of the box:
    // render, dragging, guide targets, align/distribute, group outlines,
    // marquee hit-testing, canvas sizing, and the embed contentBounds hook.
    // Memoized per object (keyed on content) so the hot paths - alignment
    // guides and marquee run this for all text boxes per mousemove - cost a
    // Map lookup, not a text measurement, and never lean on the shared
    // 500-entry spanWidthCache that big imported boards can thrash.
    const textBoxRectCache = new WeakMap();
    function textBoxRect(tb) {
        const spans = tb.spans || [[{ text: tb.text || '', bold: false, italic: false }]];
        const fs = tb.fontSize || 20;
        const key = fs + '|' + fontStackOf(tb) + '|' + JSON.stringify(spans);
        const hit = textBoxRectCache.get(tb);
        if (hit && hit.key === key) return hit.rect;
        const rect = { w: measureSpansWidth(spans, fs, fontStackOf(tb)) + 16,
                       h: spans.length * fs * 1.3 + 8 };
        textBoxRectCache.set(tb, { key, rect });
        return rect;
    }

    function renderTextBox(tb) {
        let existing = document.getElementById(tb.id);
        if (existing) existing.remove();

        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.id = tb.id;
        group.classList.add('textbox-node');

        if (state.selectedTextBox === tb.id) group.classList.add('selected');
        if (state.selectedTextBoxes && state.selectedTextBoxes.includes(tb.id)) group.classList.add('multi-selected');

        const spans = tb.spans || [[{ text: tb.text || '', bold: false, italic: false }]];
        const fs = tb.fontSize || 20;
        const lineHeight = fs * 1.3;

        const tbff = fontStackOf(tb);
        const padX = 8, padY = 4;
        const { w: boxW, h: boxH } = textBoxRect(tb);
        const align = tb.textAlign || 'left';

        const border = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        border.setAttribute('x', tb.x);
        border.setAttribute('y', tb.y);
        border.setAttribute('width', boxW);
        border.setAttribute('height', boxH);
        border.setAttribute('fill', 'transparent');
        border.setAttribute('stroke', 'transparent');
        border.setAttribute('stroke-width', '1');
        border.classList.add('textbox-border');
        group.appendChild(border);

        // Dark mode: near-black text flips to white when the box sits on
        // dark surface (text boxes never flipped before - invisible on the
        // dark canvas). Colored text and boxes on light zones keep their ink.
        const tbColor = tb.fontColor || '#333333';
        const tbFill = (isDark(tbColor) &&
            surfaceIsDarkAt(tb.x + boxW / 2, tb.y + boxH / 2)) ? '#ffffff' : tbColor;

        spans.forEach((lineSpans, i) => {
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            let tx;
            if (align === 'center') tx = tb.x + boxW / 2;
            else if (align === 'right') tx = tb.x + boxW - padX;
            else tx = tb.x + padX;
            text.setAttribute('x', tx);
            text.setAttribute('y', tb.y + padY + fs + i * lineHeight);
            text.setAttribute('font-size', fs);
            if (tbff) text.setAttribute('font-family', tbff);
            text.setAttribute('fill', tbFill);
            text.setAttribute('text-anchor', align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start');
            text.style.pointerEvents = 'none';
            lineSpans.forEach(span => {
                const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
                tspan.textContent = span.text;
                if (span.bold) tspan.setAttribute('font-weight', 'bold');
                if (span.italic) tspan.setAttribute('font-style', 'italic');
                if (span.color && isSafeCSSColor(span.color)) tspan.setAttribute('fill', span.color);
                text.appendChild(tspan);
            });
            group.appendChild(text);
        });

        devicesLayer.appendChild(group);
    }

    // --- Connection Routing ---
    function getDashArray(style, thickness) {
        switch (style) {
            case 'dash-sm': return `${thickness * 3} ${thickness * 2}`;
            case 'dash-md': return `${thickness * 5} ${thickness * 3}`;
            case 'dash-lg': return `${thickness * 8} ${thickness * 4}`;
            case 'dot': return `${thickness} ${thickness * 2}`;
            case 'dash-dot': return `${thickness * 5} ${thickness * 2} ${thickness} ${thickness * 2}`;
            default: return 'none';
        }
    }

    function rectsOverlap(r1, r2) {
        return !(r1.right <= r2.left || r1.left >= r2.right || r1.bottom <= r2.top || r1.top >= r2.bottom);
    }

    function routeOrthogonal(start, end, conn) {
        // Resolve endpoint nodes from the connection itself so routing is
        // deterministic - never from transient state or positional lookup
        const startNode = (conn && findNode(conn.fromDevice)) || findNodeForPoint(start);
        const endNode = (conn && findNode(conn.toDevice)) || findNodeForPoint(end);

        const startDir = getAPDirection(start, startNode, end);
        const endDir = getAPDirection(end, endNode, start);

        const points = [start];
        points.push(...generateWaypoints(start, end, startDir, endDir));
        points.push(end);
        return points;
    }

    // Full route polyline for a connection between resolved endpoints:
    // manual waypoints (imported hand-routed paths) win outright; free-ended
    // or straight connections run direct; otherwise orthogonal auto-routing
    // with any manual bends applied. Every consumer of a connection's shape
    // (render, export, hit-testing, annotation placement) goes through this
    // so they can never disagree.
    function connRoutePoints(conn, start, end) {
        if (conn.waypoints && conn.waypoints.length) {
            return [start, ...conn.waypoints.map(w => ({ x: w.x, y: w.y })), end];
        }
        if (conn.routing === 'straight' || connIsFreeEnded(conn)) return [start, end];
        const pts = routeOrthogonal(start, end, conn);
        applyManualBends(pts, conn);
        return pts;
    }

    // Segment orientations of the PRISTINE natural route. Bends must key off
    // these, not the array being mutated: an earlier bend can collapse the
    // next segment to zero length, and a zero-length segment reads as
    // vertical regardless of what the natural route said - an adjacent-bend
    // pair could then apply an x value to a y axis.
    function naturalSegmentOrientations(points) {
        const isVert = [];
        for (let i = 0; i < points.length - 1; i++) {
            isVert.push(Math.abs(points[i].x - points[i + 1].x) <=
                        Math.abs(points[i].y - points[i + 1].y));
        }
        return isVert;
    }

    function applyManualBends(points, conn) {
        if (!conn.bends || points.length < 4) return points;
        const isVert = naturalSegmentOrientations(points);
        for (const [idx, val] of Object.entries(conn.bends)) {
            const i = parseInt(idx);
            if (i < 1 || i >= points.length - 2) continue;
            const p1 = points[i], p2 = points[i + 1];
            if (isVert[i]) { p1.x = val; p2.x = val; }
            else { p1.y = val; p2.y = val; }
        }
        return points;
    }

    // Capture the manual-bend orientations of every connection accepted by
    // `filter`, against PRE-move geometry - the reusable half of "translate
    // bends when both endpoints move" (multi-select drag, merge's whole-
    // document translation). Pair with applyBendShifts below.
    function captureBendShifts(filter) {
        const shifts = [];
        state.connections.forEach(conn => {
            if (!conn.bends || !filter(conn)) return;
            const fromNode = findNode(conn.fromDevice);
            const toNode = findNode(conn.toDevice);
            if (!fromNode || !toNode) return;
            const pts = routeOrthogonal(getAbsoluteAP(fromNode, conn.fromAP),
                                        getAbsoluteAP(toNode, conn.toAP), conn);
            const entries = captureBendOrientations(conn, pts);
            if (entries.length) shifts.push({ conn, entries });
        });
        return shifts;
    }
    // Re-express each captured bend at its ORIGINAL value + (dx,dy) along the
    // axis its segment rides; `snap` optionally grid-snaps (the drag path
    // passes one, merge translation doesn't).
    function applyBendShifts(shifts, dx, dy, snap) {
        shifts.forEach(bs => bs.entries.forEach(en => {
            const v = en.val + (en.isVert ? dx : dy);
            bs.conn.bends[en.idx] = snap ? snap(v) : v;
        }));
    }

    // Capture each manual bend's segment orientation against the connection's
    // current natural path, so bends can be translated when both endpoints move.
    // Mirrors applyManualBends' iteration order and orientation logic.
    function captureBendOrientations(conn, points) {
        const entries = [];
        if (!conn.bends || points.length < 4) return entries;
        const isVert = naturalSegmentOrientations(points);
        for (const [idx, val] of Object.entries(conn.bends)) {
            const i = parseInt(idx);
            if (i < 1 || i >= points.length - 2) continue;
            const p1 = points[i], p2 = points[i + 1];
            if (isVert[i]) { p1.x = val; p2.x = val; }
            else { p1.y = val; p2.y = val; }
            entries.push({ idx, val, isVert: isVert[i] });
        }
        return entries;
    }

    // --- Imported-route conversion (waypoints → native bends) ---
    // Imported hand-routed lines arrive as absolute waypoints: faithful, but
    // frozen - no bend handles, and moving one endpoint stretches the first
    // segment diagonally. When the imported polyline can be reproduced
    // EXACTLY as the natural route plus per-segment bends, convert it; the
    // connection then behaves like a native one (bend handles per inner
    // segment, orthogonal re-routing when a device moves). The candidate is
    // dry-run through connRoutePoints itself, so a conversion can never
    // change the drawn path - routes that don't fit the native shape keep
    // their waypoints (and waypoint drag handles).
    const ROUTE_EPS = 0.75;

    function normalizeRoute(pts) {
        const out = [];
        for (const p of pts) {
            const last = out[out.length - 1];
            if (last && Math.abs(p.x - last.x) < ROUTE_EPS &&
                Math.abs(p.y - last.y) < ROUTE_EPS) continue;
            out.push({ x: p.x, y: p.y });
        }
        // Merge collinear middles - monotone runs only; a genuine double-back
        // is geometry, not noise.
        for (let i = out.length - 2; i >= 1; i--) {
            const a = out[i - 1], b = out[i], c = out[i + 1];
            const vAB = Math.abs(a.x - b.x) < ROUTE_EPS, vBC = Math.abs(b.x - c.x) < ROUTE_EPS;
            const hAB = Math.abs(a.y - b.y) < ROUTE_EPS, hBC = Math.abs(b.y - c.y) < ROUTE_EPS;
            if ((vAB && vBC && (b.y - a.y) * (c.y - b.y) >= 0) ||
                (hAB && hBC && (b.x - a.x) * (c.x - b.x) >= 0)) out.splice(i, 1);
        }
        return out;
    }

    function routesEqual(a, b) {
        return a.length === b.length && a.every((p, i) =>
            Math.abs(p.x - b[i].x) < ROUTE_EPS && Math.abs(p.y - b[i].y) < ROUTE_EPS);
    }

    function convertWaypointsToBends(conn) {
        if (!conn.waypoints || !conn.waypoints.length) return false;
        if (conn.routing === 'straight' || connIsFreeEnded(conn)) return false;
        const start = resolveConnEndpoint(conn, 'from');
        const end = resolveConnEndpoint(conn, 'to');
        if (!start || !end) return false;
        const imported = normalizeRoute([start, ...conn.waypoints, end]);
        // Only orthogonal polylines can live on the native rails
        for (let i = 0; i < imported.length - 1; i++) {
            if (Math.abs(imported[i].x - imported[i + 1].x) >= ROUTE_EPS &&
                Math.abs(imported[i].y - imported[i + 1].y) >= ROUTE_EPS) return false;
        }
        const natural = routeOrthogonal(start, end, conn);
        const nOr = naturalSegmentOrientations(natural);
        const iOr = naturalSegmentOrientations(imported);
        const n = nOr.length, k = iOr.length;
        // Only routes whose SHAPE matches the natural template convert: same
        // segment count, same orientations (both alternate, so matching
        // counts + first segments means they all line up). Forcing a shorter
        // route onto a longer template - collapsing leftover segments to
        // zero length - draws the right path but leaves PHANTOM segments in
        // the model: stacked bend handles on one corner, and hidden
        // zero-length legs that unfold into jogs when dragged or when an
        // endpoint later moves. Routes that don't fit keep their waypoints
        // (the honest representation, with waypoint drag handles).
        if (k !== n || nOr[0] !== iOr[0]) return false;
        const iCross = j => iOr[j] ? imported[j].x : imported[j].y;
        const bends = {};
        for (let i = 1; i <= n - 2; i++) bends[i] = iCross(i);
        // Dry-run through the app's own router: convert only on an exact match
        const savedWaypoints = conn.waypoints, savedBends = conn.bends;
        conn.waypoints = null;
        conn.bends = bends;
        const got = normalizeRoute(connRoutePoints(conn, start, end));
        if (routesEqual(got, imported)) {
            delete conn.waypoints;
            // Bends sitting exactly on the natural rail are no-ops - prune
            // them so the connection is as native as possible (an import
            // matching the auto-route converts to a plain routed connection)
            for (const [idx, val] of Object.entries(conn.bends)) {
                const i = parseInt(idx);
                const nat = nOr[i] ? natural[i].x : natural[i].y;
                if (Math.abs(val - nat) < ROUTE_EPS) delete conn.bends[idx];
            }
            if (!Object.keys(conn.bends).length) delete conn.bends;
            return true;
        }
        conn.waypoints = savedWaypoints;
        conn.bends = savedBends;
        return false;
    }

    function findNodeForPoint(point) {
        const containing = n => point.x >= n.x && point.x <= n.x + n.w &&
                                point.y >= n.y && point.y <= n.y + n.h;
        const onAP = n => n.attachmentPoints && n.attachmentPoints.some(ap =>
            Math.abs(n.x + ap.rx - point.x) < 1 && Math.abs(n.y + ap.ry - point.y) < 1);
        // Hidden/locked tiers are inert: a connection drop must not glue to
        // an invisible node or one the user locked against interaction.
        const devs = tierBlocked('devices') ? [] : state.devices;
        const zs = tierBlocked('zones') ? [] : state.zones;
        const imgs = tierBlocked('images') ? [] : state.images;
        return devs.find(containing) || zs.find(containing) || imgs.find(containing) ||
               devs.find(onAP) || zs.find(onAP) || imgs.find(onAP);
    }

    function getAPDirection(point, device, toward) {
        if (!device) return { dx: 0, dy: -1 };
        // Corner APs can exit along either edge; pick the outward axis that
        // faces the other endpoint instead of always launching vertically.
        const eps = 1.5;
        const rx = point.x - device.x;
        const ry = point.y - device.y;
        const onLeft = rx < eps, onRight = Math.abs(rx - device.w) < eps;
        const onTop = ry < eps, onBottom = Math.abs(ry - device.h) < eps;
        if ((onLeft || onRight) && (onTop || onBottom) && toward) {
            const hDir = { dx: onRight ? 1 : -1, dy: 0 };
            const vDir = { dx: 0, dy: onBottom ? 1 : -1 };
            const hDot = hDir.dx * (toward.x - point.x);
            const vDot = vDir.dy * (toward.y - point.y);
            return hDot >= vDot ? hDir : vDir;
        }
        const cx = device.x + device.w / 2;
        const cy = device.y + device.h / 2;
        const dx = point.x - cx;
        const dy = point.y - cy;
        if (Math.abs(dx) > Math.abs(dy)) {
            return { dx: dx > 0 ? 1 : -1, dy: 0 };
        }
        return { dx: 0, dy: dy > 0 ? 1 : -1 };
    }

    function generateWaypoints(start, end, startDir, endDir) {
        const offset = 30;
        const waypoints = [];

        let s1 = { x: start.x + startDir.dx * offset, y: start.y + startDir.dy * offset };
        let e1 = { x: end.x + endDir.dx * offset, y: end.y + endDir.dy * offset };

        if (startDir.dx !== 0 && endDir.dx !== 0) {
            const facing = startDir.dx === -endDir.dx && Math.sign(end.x - start.x) === startDir.dx;
            if (facing && Math.abs(end.x - start.x) <= offset * 2 + 5) {
                // Facing APs closer than the two exit stubs: the stubs would
                // overshoot past each other and the path would double back
                // through both devices. Use a single rail at the midpoint of
                // the gap instead (collinear → straight when the APs align).
                const midX = (start.x + end.x) / 2;
                waypoints.push({ x: midX, y: start.y });
                waypoints.push({ x: midX, y: end.y });
            } else if (Math.abs(s1.x - e1.x) < 5) {
                waypoints.push(s1);
                waypoints.push(e1);
            } else {
                // Same-direction exits on the same horizontal would run through
                // the far endpoint and double back; bulge the rail out instead.
                const sameDir = startDir.dx === endDir.dx;
                const my = (sameDir && Math.abs(s1.y - e1.y) < 5)
                    ? Math.max(start.y, end.y) + offset
                    : (s1.y + e1.y) / 2;
                waypoints.push(s1);
                waypoints.push({ x: s1.x, y: my });
                waypoints.push({ x: e1.x, y: my });
                waypoints.push(e1);
            }
        } else if (startDir.dy !== 0 && endDir.dy !== 0) {
            const facing = startDir.dy === -endDir.dy && Math.sign(end.y - start.y) === startDir.dy;
            if (facing && Math.abs(end.y - start.y) <= offset * 2 + 5) {
                // Mirror of the horizontal facing-close case above.
                const midY = (start.y + end.y) / 2;
                waypoints.push({ x: start.x, y: midY });
                waypoints.push({ x: end.x, y: midY });
            } else if (Math.abs(s1.y - e1.y) < 5) {
                waypoints.push(s1);
                waypoints.push(e1);
            } else {
                const sameDir = startDir.dy === endDir.dy;
                const mx = (sameDir && Math.abs(s1.x - e1.x) < 5)
                    ? Math.max(start.x, end.x) + offset
                    : (s1.x + e1.x) / 2;
                waypoints.push(s1);
                waypoints.push({ x: mx, y: s1.y });
                waypoints.push({ x: mx, y: e1.y });
                waypoints.push(e1);
            }
        } else {
            waypoints.push(s1);
            if (startDir.dx !== 0) {
                waypoints.push({ x: s1.x, y: e1.y });
            } else {
                waypoints.push({ x: e1.x, y: s1.y });
            }
            waypoints.push(e1);
        }

        return waypoints;
    }

    function buildPathString(points, routing) {
        if (points.length < 2) return '';

        if (routing === 'straight') {
            return `M ${points[0].x} ${points[0].y} L ${points[points.length - 1].x} ${points[points.length - 1].y}`;
        }

        if (routing === 'rounded') {
            const cleaned = [points[0]];
            for (let i = 1; i < points.length; i++) {
                const prev = cleaned[cleaned.length - 1];
                if (Math.abs(points[i].x - prev.x) > 0.5 || Math.abs(points[i].y - prev.y) > 0.5) {
                    cleaned.push(points[i]);
                }
            }
            if (cleaned.length < 2) cleaned.push(points[points.length - 1]);

            let d = `M ${cleaned[0].x} ${cleaned[0].y}`;
            const radius = 10;
            for (let i = 1; i < cleaned.length - 1; i++) {
                const prev = cleaned[i - 1];
                const curr = cleaned[i];
                const next = cleaned[i + 1];

                const d1x = curr.x - prev.x;
                const d1y = curr.y - prev.y;
                const d2x = next.x - curr.x;
                const d2y = next.y - curr.y;

                const len1 = Math.sqrt(d1x * d1x + d1y * d1y);
                const len2 = Math.sqrt(d2x * d2x + d2y * d2y);

                if (len1 < 0.5 || len2 < 0.5) {
                    d += ` L ${curr.x} ${curr.y}`;
                    continue;
                }

                const cross = d1x * d2y - d1y * d2x;
                if (Math.abs(cross) < 0.1) {
                    d += ` L ${curr.x} ${curr.y}`;
                    continue;
                }

                const r = Math.min(radius, len1 / 2, len2 / 2);

                const startX = curr.x - (d1x / len1) * r;
                const startY = curr.y - (d1y / len1) * r;
                const endX = curr.x + (d2x / len2) * r;
                const endY = curr.y + (d2y / len2) * r;

                d += ` L ${startX} ${startY}`;
                d += ` Q ${curr.x} ${curr.y} ${endX} ${endY}`;
            }
            d += ` L ${cleaned[cleaned.length - 1].x} ${cleaned[cleaned.length - 1].y}`;
            return d;
        }

        // orthogonal - skip consecutive duplicate points when emitting. This is
        // render-only (the points array keeps its shape for bend indices);
        // coincident trailing points would break the arrow markers' auto
        // orientation, which SVG derives from the path's end direction.
        let d = `M ${points[0].x} ${points[0].y}`;
        let prev = points[0];
        for (let i = 1; i < points.length; i++) {
            const p = points[i];
            if (Math.abs(p.x - prev.x) < 0.01 && Math.abs(p.y - prev.y) < 0.01) continue;
            d += ` L ${p.x} ${p.y}`;
            prev = p;
        }
        return d;
    }

    // --- Arrow Marker Defs ---
    // Marker length in px: grows with line thickness, times the connection's
    // Arrow Size multiplier (conn.arrowScale). Circles render a bit smaller
    // than arrowheads so the two read at a similar visual weight.
    function arrowSizeFor(conn, type) {
        const base = (10 + (conn.thickness || 2) * 3) * (conn.arrowScale || 1);
        return Math.max(6, Math.round(type === 'circle' ? base * 0.8 : base));
    }

    // Created-marker registry: skips two DOM queries per connection render -
    // the defs list only grows (markers are tiny and shared), so a Set lookup
    // replaces a linear scan that ran hundreds of times per marquee mousemove.
    const markerIdsCreated = new Set();
    let markerDefsEl = null;
    function ensureMarkerDefs(markerType, color, isStart, size) {
        if (markerType === 'none') return null;
        // The color becomes part of an element id - strip everything that
        // isn't selector-safe, or a loaded file with "rgb(51,51,51)" colors
        // throws SyntaxError in querySelector and kills the render pass.
        const safeColor = String(color).replace(/[^a-zA-Z0-9]/g, '_');
        const direction = isStart ? 'start' : 'end';
        const markerId = `marker-${markerType}-${safeColor}-${size}-${direction}`;
        if (markerIdsCreated.has(markerId)) return markerId;
        if (!markerDefsEl) {
            markerDefsEl = canvas.querySelector('defs');
            if (!markerDefsEl) {
                markerDefsEl = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
                canvas.insertBefore(markerDefsEl, canvas.firstChild);
            }
        }
        const defs = markerDefsEl;
        markerIdsCreated.add(markerId);

        const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
        marker.setAttribute('id', markerId);
        // Use userSpaceOnUse so marker size is exactly `size` canvas px -
        // thickness scaling is baked into the size by arrowSizeFor.
        marker.setAttribute('markerUnits', 'userSpaceOnUse');
        marker.setAttribute('orient', isStart ? 'auto-start-reverse' : 'auto');
        marker.setAttribute('refX', '0');

        // refX=0 for all markers - path endpoints are trimmed by marker length
        // so the marker body extends outward from the trimmed endpoint toward
        // the original attachment point.
        if (markerType === 'arrow' || markerType === 'open-arrow') {
            // Equilateral: tip-to-base length is `size`, so base width is 2/√3 × size
            const h = size * 2 / Math.sqrt(3);
            marker.setAttribute('markerWidth', size);
            marker.setAttribute('markerHeight', h);
            marker.setAttribute('refY', h / 2);
            if (markerType === 'arrow') {
                const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                polygon.setAttribute('points', `0 0, ${size} ${h / 2}, 0 ${h}`);
                polygon.setAttribute('fill', color);
                marker.appendChild(polygon);
            } else {
                const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
                polyline.setAttribute('points', `0 0, ${size} ${h / 2}, 0 ${h}`);
                polyline.setAttribute('fill', 'none');
                polyline.setAttribute('stroke', color);
                polyline.setAttribute('stroke-width', Math.max(1.5, size / 9));
                marker.appendChild(polyline);
            }
        } else if (markerType === 'diamond') {
            marker.setAttribute('markerWidth', size);
            marker.setAttribute('markerHeight', size);
            marker.setAttribute('refY', size / 2);
            const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            polygon.setAttribute('points', `0 ${size / 2}, ${size / 2} 0, ${size} ${size / 2}, ${size / 2} ${size}`);
            polygon.setAttribute('fill', color);
            marker.appendChild(polygon);
        } else if (markerType === 'circle') {
            marker.setAttribute('markerWidth', size);
            marker.setAttribute('markerHeight', size);
            marker.setAttribute('refY', size / 2);
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', size / 2);
            circle.setAttribute('cy', size / 2);
            circle.setAttribute('r', size / 2 - 0.5);
            circle.setAttribute('fill', color);
            marker.appendChild(circle);
        }

        defs.appendChild(marker);
        return markerId;
    }

    // Trim `dist` px off one end of a polyline so an arrow marker can occupy
    // the gap, consuming whole segments when the end segment is shorter than
    // the marker (the old single-segment shorten skipped that case, leaving the
    // marker overshooting into the node). Point COUNT is preserved - consumed
    // points collapse onto the trim position - so manual-bend segment indices
    // keyed against the natural route stay valid.
    // Returns the distance actually trimmed (capped near half the path length
    // so tiny connections keep a visible line) - the marker is drawn at that
    // size, so arrowheads shrink to fit instead of overshooting into the node.
    function trimPointsForMarker(points, dist, fromStart) {
        let total = 0;
        for (let i = 1; i < points.length; i++) {
            total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
        }
        const trimmed = Math.min(dist, Math.max(0, total / 2 - 1));
        let remaining = trimmed;
        if (remaining <= 0) return 0;
        const n = points.length;
        const idx = k => fromStart ? k : n - 1 - k;
        for (let k = 0; k < n - 1; k++) {
            const a = points[idx(k)], b = points[idx(k + 1)];
            const segLen = Math.hypot(b.x - a.x, b.y - a.y);
            if (segLen > remaining) {
                const t = remaining / segLen;
                const nx = a.x + (b.x - a.x) * t, ny = a.y + (b.y - a.y) * t;
                for (let j = 0; j <= k; j++) { points[idx(j)].x = nx; points[idx(j)].y = ny; }
                return trimmed;
            }
            remaining -= segLen;
        }
        return trimmed;
    }

    // --- Path Geometry Helpers for Annotations ---
    function getPointAlongPath(points, t) {
        if (!points || points.length < 2) return { x: 0, y: 0 };
        if (t <= 0) return { x: points[0].x, y: points[0].y };
        if (t >= 1) return { x: points[points.length - 1].x, y: points[points.length - 1].y };

        // Calculate total length
        let totalLen = 0;
        const segLens = [];
        for (let i = 1; i < points.length; i++) {
            const dx = points[i].x - points[i - 1].x;
            const dy = points[i].y - points[i - 1].y;
            const len = Math.sqrt(dx * dx + dy * dy);
            segLens.push(len);
            totalLen += len;
        }
        if (totalLen === 0) return { x: points[0].x, y: points[0].y };

        let targetDist = t * totalLen;
        let accum = 0;
        for (let i = 0; i < segLens.length; i++) {
            if (accum + segLens[i] >= targetDist) {
                const frac = (targetDist - accum) / segLens[i];
                return {
                    x: points[i].x + (points[i + 1].x - points[i].x) * frac,
                    y: points[i].y + (points[i + 1].y - points[i].y) * frac
                };
            }
            accum += segLens[i];
        }
        return { x: points[points.length - 1].x, y: points[points.length - 1].y };
    }

    function getNearestT(points, px, py) {
        if (!points || points.length < 2) return { t: 0, distance: Infinity };

        let totalLen = 0;
        const segLens = [];
        for (let i = 1; i < points.length; i++) {
            const dx = points[i].x - points[i - 1].x;
            const dy = points[i].y - points[i - 1].y;
            segLens.push(Math.sqrt(dx * dx + dy * dy));
            totalLen += segLens[segLens.length - 1];
        }
        if (totalLen === 0) return { t: 0, distance: Math.sqrt((px - points[0].x) ** 2 + (py - points[0].y) ** 2) };

        let bestDist = Infinity;
        let bestAccum = 0;
        let accum = 0;

        for (let i = 0; i < segLens.length; i++) {
            const ax = points[i].x, ay = points[i].y;
            const bx = points[i + 1].x, by = points[i + 1].y;
            const dx = bx - ax, dy = by - ay;
            const lenSq = dx * dx + dy * dy;
            let proj = lenSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
            proj = Math.max(0, Math.min(1, proj));
            const cx = ax + proj * dx;
            const cy = ay + proj * dy;
            const dist = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
            if (dist < bestDist) {
                bestDist = dist;
                bestAccum = accum + proj * segLens[i];
            }
            accum += segLens[i];
        }

        return { t: bestAccum / totalLen, distance: bestDist };
    }

    // --- Connection Rendering ---
    function renderConnection(conn) {
        let existing = document.getElementById(conn.id);
        if (existing) existing.remove();

        const start = resolveConnEndpoint(conn, 'from');
        const end = resolveConnEndpoint(conn, 'to');
        if (!start || !end) return;

        const points = connRoutePoints(conn, start, end);

        // Trim path ends so arrow markers extend outward from attachment points;
        // the marker takes the actually-trimmed size so it never overshoots.
        const startArrow = conn.startArrow || 'none';
        const endArrow = conn.endArrow || 'none';
        let startMarkerSize = 0, endMarkerSize = 0;
        if (startArrow !== 'none' && points.length >= 2) {
            startMarkerSize = Math.round(trimPointsForMarker(points, arrowSizeFor(conn, startArrow), true));
        }
        if (endArrow !== 'none' && points.length >= 2) {
            endMarkerSize = Math.round(trimPointsForMarker(points, arrowSizeFor(conn, endArrow), false));
        }

        const pathStr = buildPathString(points, conn.routing);

        // Dark-mode flip is surface-aware: a near-black line goes white only
        // when most of its route runs over dark surface (sampled at the two
        // ends and the midpoint) - a white line INSIDE a light zone vanishes.
        let strokeColor = conn.color;
        if (document.body.classList.contains('dark-mode') && isDark(conn.color) && points.length >= 2) {
            const mid = points[Math.floor(points.length / 2)];
            const darkVotes = [points[0], mid, points[points.length - 1]]
                .filter(p => surfaceIsDarkAt(p.x, p.y)).length;
            if (darkVotes >= 2) strokeColor = '#ffffff';
        }

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.classList.add('connection-line');
        path.setAttribute('d', pathStr);
        path.setAttribute('stroke', strokeColor);
        path.setAttribute('stroke-width', conn.thickness);
        const dash = getDashArray(conn.dash, conn.thickness);
        if (dash !== 'none') path.setAttribute('stroke-dasharray', dash);
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');

        // Arrow markers
        if (startArrow !== 'none' && startMarkerSize > 2) {
            const markerId = ensureMarkerDefs(startArrow, strokeColor, true, startMarkerSize);
            if (markerId) path.setAttribute('marker-start', `url(#${markerId})`);
        }
        if (endArrow !== 'none' && endMarkerSize > 2) {
            const markerId = ensureMarkerDefs(endArrow, strokeColor, false, endMarkerSize);
            if (markerId) path.setAttribute('marker-end', `url(#${markerId})`);
        }

        if (state.selectedConnection === conn.id ||
            (state.selectedConnections && state.selectedConnections.includes(conn.id))) {
            path.classList.add('selected');
        }

        path.dataset.connId = conn.id;

        const connGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        connGroup.id = conn.id;
        connGroup.appendChild(path);

        if (conn.label) {
            const mid = Math.floor(points.length / 2);
            let mx, my;
            if (points.length % 2 === 0) {
                mx = (points[mid - 1].x + points[mid].x) / 2;
                my = (points[mid - 1].y + points[mid].y) / 2;
            } else {
                mx = points[mid].x;
                my = points[mid].y;
            }

            const fs = conn.fontSize || 20;
            const connSpans = conn.spans || [[{ text: conn.label, bold: false, italic: false }]];
            const lineHeight = fs * 1.3;
            const lp = conn.labelPosition || 'top';
            let tx = mx, ty = my, anchor = 'middle';
            switch (lp) {
                case 'top':    ty = my - fs / 2 - 4; break;
                case 'bottom': ty = my + fs + 4; break;
                case 'left':   tx = mx - 8; anchor = 'end'; ty = my + fs / 3; break;
                case 'right':  tx = mx + 8; anchor = 'start'; ty = my + fs / 3; break;
                case 'center': ty = my + fs / 3; break;
            }

            const totalH = connSpans.length * lineHeight;
            const valign = conn.labelVAlign || 'top';
            const verticalOffset = -getVAlignOffset(valign, connSpans.length, lineHeight);

            const padding = 3;
            // Measure the real text width (cached) - the old chars×fs×0.6
            // estimate drew a different-sized white box than the export's
            // measured one, a visible WYSIWYG mismatch.
            const textW = measureSpansWidth(connSpans, fs, fontStackOf(conn));
            let bgX, bgY;
            if (anchor === 'end') { bgX = tx - textW - padding; }
            else if (anchor === 'start') { bgX = tx - padding; }
            else { bgX = tx - textW / 2 - padding; }
            bgY = ty - fs - padding + 2 - verticalOffset;
            const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            bg.setAttribute('x', bgX);
            bg.setAttribute('y', bgY);
            bg.setAttribute('width', textW + padding * 2);
            bg.setAttribute('height', totalH + padding * 2 + 2);
            bg.setAttribute('fill', 'white');
            bg.setAttribute('fill-opacity', '0.85');
            bg.setAttribute('rx', '2');
            bg.classList.add('connection-label-bg');
            connGroup.appendChild(bg);

            const cff = fontStackOf(conn);
            let lineTx = tx, lineAnchor = anchor;
            if (conn.labelAlign && conn.labelAlign !== 'auto' && connSpans.length > 1) {
                const j = justifiedLine(conn.labelAlign, tx, anchor, measureSpansWidth(connSpans, fs, cff));
                lineTx = j.x; lineAnchor = j.anchor;
            }
            connSpans.forEach((lineSpans, i) => {
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', lineTx);
                text.setAttribute('y', ty + i * lineHeight - verticalOffset);
                text.setAttribute('text-anchor', lineAnchor);
                text.setAttribute('font-size', fs);
                if (cff) text.setAttribute('font-family', cff);
                text.setAttribute('fill', conn.fontColor || conn.color);
                text.classList.add('connection-label');
                lineSpans.forEach(span => {
                    const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
                    tspan.textContent = span.text;
                    if (span.bold) tspan.setAttribute('font-weight', 'bold');
                    if (span.italic) tspan.setAttribute('font-style', 'italic');
                    if (span.color && isSafeCSSColor(span.color)) tspan.setAttribute('fill', span.color);
                    text.appendChild(tspan);
                });
                connGroup.appendChild(text);
            });
        }

        // Bend handles apply to auto-routed segments only - waypoint paths
        // (imported hand-routed lines) keep their fixed geometry.
        if ((conn.routing === 'orthogonal' || conn.routing === 'rounded') &&
            !(conn.waypoints && conn.waypoints.length) &&
            state.selectedConnection === conn.id && points.length >= 4) {
            for (let i = 1; i < points.length - 2; i++) {
                const p1 = points[i], p2 = points[i + 1];
                const isVert = Math.abs(p1.x - p2.x) <= Math.abs(p1.y - p2.y);
                const hx = (p1.x + p2.x) / 2, hy = (p1.y + p2.y) / 2;
                const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                const size = 10;
                handle.setAttribute('x', hx - size / 2);
                handle.setAttribute('y', hy - size / 2);
                handle.setAttribute('width', size);
                handle.setAttribute('height', size);
                handle.setAttribute('rx', 2);
                handle.classList.add('conn-bend-handle');
                handle.dataset.connId = conn.id;
                handle.dataset.segIndex = String(i);
                handle.dataset.isVertical = isVert ? '1' : '0';
                handle.style.cursor = isVert ? 'ew-resize' : 'ns-resize';
                connGroup.appendChild(handle);
            }
        }

        // Waypoint handles - imported hand-routed paths get a draggable
        // handle per waypoint (bend handles don't apply: waypoints are
        // absolute points, not offsets from an auto route)
        if (conn.waypoints && conn.waypoints.length && state.selectedConnection === conn.id) {
            conn.waypoints.forEach((wp, i) => {
                const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                const size = 10;
                handle.setAttribute('x', wp.x - size / 2);
                handle.setAttribute('y', wp.y - size / 2);
                handle.setAttribute('width', size);
                handle.setAttribute('height', size);
                handle.setAttribute('rx', 2);
                handle.classList.add('conn-bend-handle', 'conn-waypoint-handle');
                handle.dataset.connId = conn.id;
                handle.dataset.wpIndex = String(i);
                handle.style.cursor = 'move';
                connGroup.appendChild(handle);
            });
        }

        // Endpoint handles - drag to re-attach the connection to a different AP
        if (state.selectedConnection === conn.id) {
            [{ which: 'from', p: start }, { which: 'to', p: end }].forEach(ep => {
                const handle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                handle.setAttribute('cx', ep.p.x);
                handle.setAttribute('cy', ep.p.y);
                handle.setAttribute('r', 7);
                handle.classList.add('conn-endpoint-handle');
                handle.dataset.connId = conn.id;
                handle.dataset.end = ep.which;
                connGroup.appendChild(handle);
            });
        }

        // Render annotations
        if (conn.annotations && conn.annotations.length > 0) {
            conn.annotations.forEach(ann => {
                const annPos = getPointAlongPath(points, ann.position);
                const annFs = ann.fontSize || DEFAULT_FONT_SIZE;
                const annSpans = ann.spans || [[{ text: ann.text || '', bold: false, italic: false }]];
                const annLineHeight = annFs * 1.3;
                const annTotalH = annSpans.length * annLineHeight;

                // Background rect (real measured width - matches the export)
                const padding = 3;
                const annTextW = Math.max(measureSpansWidth(annSpans, annFs, fontStackOf(ann)), 20);
                const isSelAnn = state.selectedAnnotation &&
                    state.selectedAnnotation.connId === conn.id && state.selectedAnnotation.annId === ann.id;
                const annColor = ann.fontColor || conn.fontColor || conn.color;
                const annBg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                annBg.setAttribute('x', annPos.x - annTextW / 2 - padding);
                annBg.setAttribute('y', annPos.y - annFs - padding);
                annBg.setAttribute('width', annTextW + padding * 2);
                annBg.setAttribute('height', annTotalH + padding * 2 + 2);
                annBg.setAttribute('fill', 'white');
                annBg.setAttribute('fill-opacity', '0.85');
                annBg.setAttribute('rx', '2');
                if (isSelAnn) {
                    annBg.setAttribute('stroke', '#0066cc');
                    annBg.setAttribute('stroke-width', '1.5');
                    annBg.setAttribute('stroke-dasharray', '4 2');
                }
                annBg.classList.add('connection-annotation-bg');
                annBg.dataset.annId = ann.id;
                connGroup.appendChild(annBg);

                const aff = fontStackOf(ann);
                let annX = annPos.x, annAnchor = 'middle';
                if (ann.align && ann.align !== 'center' && annSpans.length > 1) {
                    const j = justifiedLine(ann.align, annPos.x, 'middle', measureSpansWidth(annSpans, annFs, aff));
                    annX = j.x; annAnchor = j.anchor;
                }
                annSpans.forEach((lineSpans, i) => {
                    const annText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                    annText.setAttribute('x', annX);
                    annText.setAttribute('y', annPos.y + i * annLineHeight);
                    annText.setAttribute('text-anchor', annAnchor);
                    annText.setAttribute('font-size', annFs);
                    if (aff) annText.setAttribute('font-family', aff);
                    annText.setAttribute('fill', annColor);
                    annText.classList.add('connection-annotation');
                    annText.dataset.annId = ann.id;
                    lineSpans.forEach(span => {
                        const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
                        tspan.textContent = span.text;
                        if (span.bold) tspan.setAttribute('font-weight', 'bold');
                        if (span.italic) tspan.setAttribute('font-style', 'italic');
                        if (span.color && isSafeCSSColor(span.color)) tspan.setAttribute('fill', span.color);
                        annText.appendChild(tspan);
                    });
                    connGroup.appendChild(annText);
                });
            });
        }

        connectionsLayer.appendChild(connGroup);
    }

    function renderAllConnections() {
        connectionsLayer.innerHTML = '';
        state.connections.forEach(renderConnection);
    }

    // --- Device Templates & Import ---
    function addDeviceTemplate(imageData, name, isDefault, category) {
        const template = { id: genId(), image: imageData, name: name || 'Device', isDefault: !!isDefault };
        if (typeof category === 'string' && category) template.category = category;
        state.deviceTemplates.push(template);
        renderDeviceList();
        if (!isDefault) saveImportedTemplates();
    }

    function saveImportedTemplates() {
        const imported = state.deviceTemplates.filter(t => !t.isDefault && !t.isBundled);
        try {
            localStorage.setItem('networkDiagram_importedTemplates', JSON.stringify(imported));
        } catch (e) { }
    }

    function loadImportedTemplates() {
        try {
            const data = localStorage.getItem('networkDiagram_importedTemplates');
            if (data) {
                const imported = JSON.parse(data);
                imported.forEach(t => {
                    if (!isSafeImageURL(t.image)) return;
                    t.id = genId();
                    t.isDefault = false;
                    state.deviceTemplates.push(t);
                });
            }
        } catch (e) { }
    }

    function loadBundledTemplates() {
        // devices.js supplies the base bundle; an optional customdevices.js
        // (a team/site stencil layer dropped next to index.html) is merged
        // after it. Both are script-tag globals because file:// blocks fetch()
        // of local JSON - a <script src> is the only universal loader.
        //
        // A customdevices.js stencil whose name matches a base one (bundled or
        // built-in default) REPLACES its art IN PLACE - same name, so saved
        // boards that reference it by @name pick up the new icon automatically.
        // Custom outranks the base, matching how a user's imported stencil
        // outranks the bundled set (see customImportTemplate). devices.js
        // entries still base-win among THEMSELVES (first definition kept), so a
        // duplicate name inside the bundle is a no-op.
        const byName = new Map(state.deviceTemplates.map(t => [t.name, t]));
        const merge = (src, isOverrideLayer) => {
            if (!src || !Array.isArray(src)) return;
            src.forEach(t => {
                if (!isSafeImageURL(t.image)) return;
                const existing = byName.get(t.name);
                if (existing) {
                    // Replace base art with the override layer's; leave a
                    // user-imported stencil (neither bundled nor default) alone.
                    if (isOverrideLayer && (existing.isBundled || existing.isDefault)) {
                        existing.image = t.image;
                        if (typeof t.category === 'string' && t.category) { existing.category = t.category; }
                    }
                    return;
                }
                const tpl = { id: genId(), image: t.image, name: t.name, isDefault: false, isBundled: true };
                if (typeof t.category === 'string' && t.category) { tpl.category = t.category; }
                state.deviceTemplates.push(tpl);
                byName.set(t.name, tpl);
            });
        };
        merge(window.BUNDLED_DEVICES, false);
        merge(window.CUSTOM_DEVICES, true);
        renderDeviceList();
    }

    // Export the user's imported stencils as a customdevices.js layer. The one
    // artifact serves two consumption paths: host it next to index.html (teams
    // get it automatically at startup) or hand it to someone who clicks Import
    // Device Library.
    function exportDeviceLibrary() {
        const custom = state.deviceTemplates.filter(t => !t.isDefault && !t.isBundled);
        if (custom.length === 0) { alert('No imported devices to export.\n\nImport device images first - the bundled library ships with the app.'); return; }
        const data = custom.map(t => ({ name: t.name, image: t.image, category: t.category }));
        const js = 'window.CUSTOM_DEVICES = ' + JSON.stringify(data, null, 2) + ';\n';
        triggerDownload(new Blob([js], { type: 'application/javascript' }), 'customdevices.js');
    }

    // Import a device-library file: a customdevices.js/devices.js script
    // wrapper (window.X = [...]) or a raw JSON array of {name, image}.
    function importDeviceLibrary(text) {
        let payload = String(text).trim();
        const wrapper = payload.match(/=\s*(\[[\s\S]*\])\s*;?\s*$/);
        if (wrapper) payload = wrapper[1];
        let list;
        try { list = JSON.parse(payload); } catch (e) {
            alert('Not a device library file (expected a devices/customdevices .js export or a JSON array).');
            return;
        }
        if (!Array.isArray(list)) { alert('Not a device library file (expected an array of devices).'); return; }
        const existingNames = new Set(state.deviceTemplates.map(t => t.name));
        let added = 0, skipped = 0, unsafe = 0;
        list.forEach(t => {
            if (!t || typeof t.name !== 'string' || !t.name) return;
            if (existingNames.has(t.name)) { skipped++; return; }
            if (!isSafeImageURL(t.image)) { unsafe++; return; }
            addDeviceTemplate(t.image, t.name, false,    // imported: deletable, persisted
                typeof t.category === 'string' ? t.category : undefined);
            existingNames.add(t.name);
            added++;
        });
        let msg = `Added: ${added}`;
        if (skipped) msg += `\nSkipped (name already in your palette): ${skipped}`;
        if (unsafe) msg += `\nSkipped (unsupported image data): ${unsafe}`;
        showDialog({ title: 'Device library import complete', body: msg });
    }

    function deleteDeviceTemplate(templateId) {
        const template = state.deviceTemplates.find(t => t.id === templateId);
        if (!template || template.isDefault || template.isBundled) return;
        if (!confirm(`Delete "${template.name}" from device templates?`)) return;
        state.deviceTemplates = state.deviceTemplates.filter(t => t.id !== templateId);
        saveImportedTemplates();
        renderDeviceList();
    }

    // Palette preview for the default device tint: thumbnails render tinted
    // while a Default Settings tint is active (cached per template - tintSVG
    // regexes a ~40KB SVG each time). The templates themselves are never
    // modified, so Reset instantly restores the stencil set's own colors.
    const thumbTintCache = new Map();
    function paletteImageFor(t) {
        if (!DEFAULT_DEVICE_TINT) return t.image;
        let v = thumbTintCache.get(t.id);
        if (!v) { v = tintSVG(t.image, DEFAULT_DEVICE_TINT); thumbTintCache.set(t.id, v); }
        return v;
    }

    // The default zone border matches the device frame blue so devices and
    // zones read as one family; a custom Zone Color derives its border unless
    // the user picked an explicit Zone Border Color (which always wins).
    // The blue an UNTINTED stencil actually renders in - the device frame
    // stroke (renderDevice: `device.tintColor || 'rgb(45,103,185)'`) and the
    // matching default zone border. Shared so the Device Color field can show
    // this real color for a null-tint device instead of the lighter default
    // tint pick (#4a90d9), which never matches what's on the canvas.
    const STENCIL_FRAME_BLUE = '#2d67b9';   // = rgb(45,103,185)
    function defaultZoneBorder() {
        if (DEFAULT_ZONE_BORDER) return DEFAULT_ZONE_BORDER;
        return DEFAULT_ZONE_FILL ? darkenHex(DEFAULT_ZONE_FILL, 0.35) : STENCIL_FRAME_BLUE;
    }

    // Palette preview for the default zone colors - restyles the sidebar shape
    // thumbnails in place (they all use the default fill/border pair), and
    // their BUTTON borders too (the user reads those as part of the family:
    // devices show the frame in their thumb art; zones/text get it from CSS).
    function refreshZoneThumbs() {
        const fill = DEFAULT_ZONE_FILL || '#e8f4fd';
        const stroke = defaultZoneBorder();
        document.querySelectorAll('.shape-thumb').forEach(btn => {
            btn.style.borderColor = stroke === STENCIL_FRAME_BLUE ? '' : stroke;
        });
        document.querySelectorAll('.shape-thumb[data-shape] svg *').forEach(el => {
            const f = el.getAttribute('fill');
            if (f && f !== 'none') el.setAttribute('fill', fill);
            if (el.getAttribute('stroke')) el.setAttribute('stroke', stroke);
        });
        // The Text thumb is part of the same family: zone fill for the box,
        // zone border for the dashes and lettering (chrome vars go dark on
        // dark-chrome themes; the zone palette is always canvas-light).
        document.querySelectorAll('.shape-thumb[data-tool="textbox"] svg rect').forEach(el => {
            el.setAttribute('fill', fill);
            el.setAttribute('stroke', stroke);
        });
        document.querySelectorAll('.shape-thumb[data-tool="textbox"] svg text').forEach(el => {
            el.setAttribute('fill', stroke);
        });
    }

    // Ordering for every device-template menu (palette + icon dropdowns):
    // real stencils alphabetical, then default fallbacks, then the generic
    // "Blank" stencil dead last - it's rarely chosen and reads oddly up top.
    function deviceTemplateSort(a, b) {
        const rank = t => t.name === 'Blank' ? 2 : (t.isDefault ? 1 : 0);
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
    }

    // Stencil categories. Bundled sets carry a category field (devices.js /
    // customdevices.js); user-imported stencils land under "Imported" and
    // anything uncategorized under "Other" - so pre-category library exports
    // and saved diagrams keep working unchanged. Unknown category names from
    // a custom layer sort after the bundled groups, before Imported/Other.
    const STENCIL_CATEGORY_ORDER = ['Network', 'Endpoints', 'Servers & Storage',
                                    'Security', 'OT / IoT', 'Telecom',
                                    'Places & People', 'General', 'Imported', 'Other'];
    function templateCategory(t) {
        if (t.category) return t.category;
        return (t.isBundled || t.isDefault) ? 'Other' : 'Imported';
    }
    function stencilCategoryRank(c) {
        const i = STENCIL_CATEGORY_ORDER.indexOf(c);
        return i === -1 ? STENCIL_CATEGORY_ORDER.indexOf('Imported') - 0.5 : i;
    }
    function stencilCategorySort(a, b) {
        return stencilCategoryRank(a) - stencilCategoryRank(b) || a.localeCompare(b);
    }
    // Group templates for a menu/grid: Map(category -> templates), categories
    // in canonical order, templates deviceTemplateSort'ed within each.
    function templatesByCategory(templates) {
        const groups = new Map();
        [...templates].sort(deviceTemplateSort).forEach(t => {
            const c = templateCategory(t);
            if (!groups.has(c)) groups.set(c, []);
            groups.get(c).push(t);
        });
        return new Map([...groups.entries()].sort((a, b) => stencilCategorySort(a[0], b[0])));
    }
    // Shared builder for the icon-swap <select>s (device panel + Batch Edit):
    // one <optgroup> per category. `filter` narrows with the same name+alias
    // matching as the palette search; empty categories drop out.
    function populateTemplateSelect(sel, selectedId, filter) {
        const f = (filter || '').trim().toLowerCase();
        templatesByCategory(state.deviceTemplates).forEach((templates, cat) => {
            const shown = f ? templates.filter(t => matchesDeviceSearch(t, f)) : templates;
            if (!shown.length) return;
            const og = document.createElement('optgroup');
            og.label = cat;
            shown.forEach(t => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = t.name;
                if (t.id === selectedId) opt.selected = true;
                og.appendChild(opt);
            });
            sel.appendChild(og);
        });
    }
    // The one icon-swap <select> rebuild, shared by the device panel and
    // Batch Edit (their initial populate AND their filter inputs). sentinel
    // prepends Batch Edit's "- keep -" row.
    function rebuildSwapSelect(sel, opts) {
        const o = opts || {};
        sel.innerHTML = o.sentinel ? '<option value="" selected>- keep -</option>' : '';
        populateTemplateSelect(sel, o.selectedId || null, o.filter);
        // When the current icon doesn't survive the filter, the browser
        // auto-selects the first visible option - and picking an option
        // that's already selected fires no 'change', so with exactly one
        // match the swap was unreachable. No sentinel to absorb that here
        // (Batch Edit's "keep" row does), so show no selection instead:
        // every option stays one click away.
        if (!o.sentinel && sel.value !== (o.selectedId || '')) sel.selectedIndex = -1;
    }
    // The filter inputs above both icon selects rebuild them live. The
    // device-panel select keeps the current icon selected when it survives
    // the filter; the batch select keeps its "keep" sentinel row.
    document.getElementById('device-template-filter').addEventListener('input', (e) => {
        const dev = state.devices.find(d => d.id === state.selectedDevice);
        rebuildSwapSelect(document.getElementById('device-template-swap'),
            { selectedId: dev ? dev.templateId : null, filter: e.target.value });
    });
    document.getElementById('batch-device-filter').addEventListener('input', (e) => {
        rebuildSwapSelect(document.getElementById('batch-device-swap'),
            { sentinel: true, filter: e.target.value });
    });

    // A palette search matches on the stencil's own name or any of its
    // synonyms (STENCIL_ALIASES), so terse canonical names still surface for
    // everyday terms ("pc"/"computer" -> Client, "phone" -> VOIPPhone).
    function matchesDeviceSearch(t, filter) {
        if (t.name.toLowerCase().includes(filter)) return true;
        const aliases = STENCIL_ALIASES.get(t.name.toLowerCase());
        return !!aliases && aliases.some(a => a.includes(filter));
    }

    // Collapsed palette categories persist like the other UI prefs.
    function loadCollapsedStencilCats() {
        try {
            const v = JSON.parse(localStorage.getItem('crosscanvas-stencil-collapsed'));
            return new Set(Array.isArray(v) ? v : []);
        } catch (e) { return new Set(); }
    }
    function saveCollapsedStencilCats(set) {
        try { localStorage.setItem('crosscanvas-stencil-collapsed', JSON.stringify([...set])); } catch (e) { }
    }

    function makeDeviceThumb(t) {
        const wrapper = document.createElement('div');
        wrapper.className = 'device-thumb-wrapper';

        const thumb = document.createElement('div');
        thumb.className = 'device-thumb';
        thumb.draggable = true;
        thumb.dataset.templateId = t.id;
        thumb.title = t.name;
        // Default tint/background previews color the thumb's app-drawn frame
        if (DEFAULT_DEVICE_TINT) thumb.style.borderColor = DEFAULT_DEVICE_TINT;
        if (DEFAULT_ICON_BG) thumb.style.background = DEFAULT_ICON_BG;

        const img = document.createElement('img');
        img.src = paletteImageFor(t);
        img.alt = t.name;
        thumb.appendChild(img);

        thumb.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('templateId', t.id);
            e.dataTransfer.effectAllowed = 'copy';
        });

        wrapper.appendChild(thumb);

        if (!t.isDefault && !t.isBundled) {
            const delBtn = document.createElement('button');
            delBtn.className = 'device-delete-btn';
            delBtn.title = 'Remove ' + t.name;
            delBtn.textContent = '×';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteDeviceTemplate(t.id);
            });
            wrapper.appendChild(delBtn);
        }
        return wrapper;
    }

    function renderDeviceList() {
        deviceList.innerHTML = '';
        const filter = (document.getElementById('device-search')?.value || '').toLowerCase().trim();

        if (filter) {
            // Search stays global and flat - matches from every category,
            // own-name hits ahead of alias-only hits.
            const sorted = state.deviceTemplates.filter(t => matchesDeviceSearch(t, filter))
                .sort((a, b) => {
                    const ra = a.name.toLowerCase().includes(filter) ? 0 : 1;
                    const rb = b.name.toLowerCase().includes(filter) ? 0 : 1;
                    return ra - rb || deviceTemplateSort(a, b);
                });
            sorted.forEach(t => deviceList.appendChild(makeDeviceThumb(t)));
            refreshSectionHeight(document.getElementById('devices-content'));
            return;
        }

        const collapsed = loadCollapsedStencilCats();
        templatesByCategory(state.deviceTemplates).forEach((templates, cat) => {
            const group = document.createElement('div');
            group.className = 'stencil-cat';

            const header = document.createElement('div');
            header.className = 'stencil-cat-header' + (collapsed.has(cat) ? ' collapsed' : '');
            header.innerHTML = '<span class="collapse-arrow">&#9660;</span> ';
            header.appendChild(document.createTextNode(cat));

            const grid = document.createElement('div');
            grid.className = 'stencil-cat-grid';
            if (collapsed.has(cat)) grid.style.display = 'none';
            templates.forEach(t => grid.appendChild(makeDeviceThumb(t)));

            header.addEventListener('click', () => {
                const set = loadCollapsedStencilCats();
                const nowCollapsed = !set.has(cat);
                if (nowCollapsed) set.add(cat); else set.delete(cat);
                saveCollapsedStencilCats(set);
                header.classList.toggle('collapsed', nowCollapsed);
                grid.style.display = nowCollapsed ? 'none' : '';
                refreshSectionHeight(document.getElementById('devices-content'));
            });

            group.appendChild(header);
            group.appendChild(grid);
            deviceList.appendChild(group);
        });
        refreshSectionHeight(document.getElementById('devices-content'));
    }

    document.getElementById('device-search').addEventListener('input', () => {
        renderDeviceList();
    });

    document.getElementById('btn-import-device').addEventListener('click', () => {
        document.getElementById('file-import').click();
    });

    document.getElementById('btn-export-library').addEventListener('click', exportDeviceLibrary);

    document.getElementById('btn-import-library').addEventListener('click', () => {
        document.getElementById('file-import-library').click();
    });
    document.getElementById('file-import-library').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => importDeviceLibrary(ev.target.result);
        reader.readAsText(file);
        e.target.value = '';
    });

    document.getElementById('file-import-inventory').addEventListener('change', (e) => {
        const files = Array.from(e.target.files || []);
        if (!files.length) return;
        if (state.dirty && !confirm('You have unsaved changes. Discard them and import this inventory?')) {
            e.target.value = '';
            return;
        }
        Promise.all(files.map(f => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (ev) => resolve({ name: f.name, text: ev.target.result });
            reader.onerror = reject;
            reader.readAsText(f);
        }))).then(importInventoryFiles);
        e.target.value = '';
    });

    document.getElementById('file-import').addEventListener('change', (e) => {
        Array.from(e.target.files).forEach(file => {
            const reader = new FileReader();
            reader.onload = (ev) => {
                // Monochrome icon-set SVGs normalize to the stencil blue
                // (and become tintable); colored artwork imports as-is
                addDeviceTemplate(normalizeImportedSVG(ev.target.result), file.name.replace(/\.[^.]+$/, ''));
            };
            reader.readAsDataURL(file);
        });
        e.target.value = '';
    });

    // --- Canvas Drop ---
    const canvasContainer = document.getElementById('canvas-container');

    canvasContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    });

    canvasContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const dropX = (e.clientX - rect.left) / state.zoom;
        const dropY = (e.clientY - rect.top) / state.zoom;

        // Handle zone shape drops
        const shapeType = e.dataTransfer.getData('shapeType');
        if (shapeType) {
            // Flowchart shapes get flowchart-friendly proportions, a centered
            // label (text lives inside the shape) and a conventional default
            // name; rect/ellipse zones keep their bold top label.
            const flow = {
                diamond: { w: 140, h: 100, label: 'Decision' },
                parallelogram: { w: 160, h: 80, label: 'Data' },
                pill: { w: 160, h: 60, label: 'Start' },
                document: { w: 160, h: 100, label: 'Document' },
                cylinder: { w: 120, h: 140, label: 'Database' }
            }[shapeType];
            const zw = flow ? flow.w : 160, zh = flow ? flow.h : 120;
            const zLabel = flow ? flow.label : 'Zone';
            const x = snapToGrid(dropX - zw / 2);
            const y = snapToGrid(dropY - zh / 2);
            const zone = {
                id: genId(),
                shape: shapeType,
                x: x,
                y: y,
                w: zw,
                h: zh,
                label: zLabel,
                labelPosition: flow ? 'center' : 'top',
                fontSize: DEFAULT_FONT_SIZE,
                fontColor: DEFAULT_FONT_COLOR,
                fontFamily: DEFAULT_FONT_FAMILY || undefined,
                lineFormats: [{ bold: !flow, italic: false }],
                spans: [[{ text: zLabel, bold: !flow, italic: false }]],
                fill: DEFAULT_ZONE_FILL || '#e8f4fd',
                borderColor: defaultZoneBorder(),
                opacity: 1,
                attachmentPoints: defaultAPsFor(zw, zh)
            };
            pushUndo();
            ensureTierVisible('zones');
            state.zones.push(zone);
            clearMultiSelect();
            selectDevice(null);
            selectZone(zone.id);
            updateCanvasSize();
            return;
        }

        // Handle text box drops
        const toolType = e.dataTransfer.getData('toolType');
        if (toolType === 'textbox') {
            const textBox = {
                id: genId(),
                x: 0, y: 0,
                text: 'Text',
                fontSize: DEFAULT_FONT_SIZE,
                fontColor: DEFAULT_FONT_COLOR,
                fontFamily: DEFAULT_FONT_FAMILY || undefined,
                textAlign: 'left',
                lineFormats: [{ bold: false, italic: false }],
                spans: [[{ text: 'Text', bold: false, italic: false }]]
            };
            // Center the box on the cursor using its REAL measured size, not a
            // 120x40 guess (the default 'Text' box is ~55x34, so the old
            // -60/-20 dropped it well off-center).
            const r = textBoxRect(textBox);
            textBox.x = snapToGrid(dropX - r.w / 2);
            textBox.y = snapToGrid(dropY - r.h / 2);
            pushUndo();
            ensureTierVisible('devices');
            state.textBoxes.push(textBox);
            clearMultiSelect();
            selectDevice(null);
            selectZone(null);
            selectConnection(null);
            selectTextBox(textBox.id);
            updateCanvasSize();
            return;
        }

        // Handle device drops
        const templateId = e.dataTransfer.getData('templateId');
        if (!templateId) return;

        const template = state.deviceTemplates.find(t => t.id === templateId);
        if (!template) return;

        const x = snapToGrid(dropX - DEVICE_SIZE / 2);
        const y = snapToGrid(dropY - DEVICE_SIZE / 2);

        const device = makeThemedDevice(template, template.name, x, y);

        pushUndo();
        ensureTierVisible('devices');
        state.devices.push(device);
        clearMultiSelect();
        selectZone(null);
        selectDevice(device.id);
        updateCanvasSize();
    });

    // --- Tool Selection ---
    // The Text button arms a one-shot placement tool (Gliffy-style): the next
    // canvas click drops a ready-to-type text box at the cursor, then the
    // tool returns to Select. Esc disarms.
    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.id === 'btn-select') setTool('select');
            else if (btn.id === 'btn-connect') setTool('connect');
            else if (btn.id === 'btn-pan') setTool('pan');
            else if (btn.id === 'btn-add-text') setTool('text');
        });
    });

    // --- Zoom controls ---
    const zoomLabelEl = document.getElementById('zoom-level');
    if (zoomLabelEl) zoomLabelEl.addEventListener('click', () => setZoom(1));
    document.getElementById('btn-zoom-out').addEventListener('click', () => setZoom(state.zoom / 1.2));
    document.getElementById('btn-zoom-in').addEventListener('click', () => setZoom(state.zoom * 1.2));
    const container = document.getElementById('canvas-container');
    // Ctrl+wheel zooms to cursor anywhere; plain wheel zooms while the Pan tool
    // is active (otherwise it scrolls normally).
    container.addEventListener('wheel', (e) => {
        if (e.ctrlKey || state.tool === 'pan') {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
            setZoom(state.zoom * factor, e.clientX, e.clientY);
        }
    }, { passive: false });

    // --- Grid show/hide ---
    function applyGrid(on) {
        state.showGrid = on;
        document.getElementById('grid-overlay').style.display = on ? '' : 'none';
        document.getElementById('btn-grid').classList.toggle('active', on);
        try { localStorage.setItem('crosscanvas-grid', on ? '1' : '0'); } catch (e) { /* ignore */ }
    }
    document.getElementById('btn-grid').addEventListener('click', () => applyGrid(!state.showGrid));
    try {
        if (localStorage.getItem('crosscanvas-grid') === '0') applyGrid(false);
    } catch (e) { /* ignore */ }

    // --- Alignment guides (opt-in, persisted; Alt bypasses while dragging) ---
    const GUIDE_SNAP = 6;

    // Compare the dragged rect's edges/centers against every other node's and
    // snap each axis to the nearest match within GUIDE_SNAP. Returns the
    // adjusted position plus guide-line geometry for rendering.
    function applyAlignmentGuides(x, y, w, h, excludeId) {
        let bx = null, bdx = GUIDE_SNAP + 0.5, vg = null;
        let by = null, bdy = GUIDE_SNAP + 0.5, hg = null;
        const consider = (o, ow, oh) => {
            if (o.id === excludeId) return;
            for (const off of [0, w / 2, w]) {
                for (const ox of [o.x, o.x + ow / 2, o.x + ow]) {
                    const d = Math.abs((x + off) - ox);
                    if (d < bdx) {
                        bdx = d; bx = ox - off;
                        vg = { x: ox, y1: Math.min(y, o.y) - 8, y2: Math.max(y + h, o.y + oh) + 8 };
                    }
                }
            }
            for (const off of [0, h / 2, h]) {
                for (const oy of [o.y, o.y + oh / 2, o.y + oh]) {
                    const d = Math.abs((y + off) - oy);
                    if (d < bdy) {
                        bdy = d; by = oy - off;
                        hg = { y: oy, x1: Math.min(x, o.x) - 8, x2: Math.max(x + w, o.x + ow) + 8 };
                    }
                }
            }
        };
        // Invisible objects must not attract alignment snaps (locked ones are
        // still visible, so they remain legitimate guides).
        if (!tierHidden('devices')) state.devices.forEach(d => consider(d, d.w, d.h));
        if (!tierHidden('zones')) state.zones.forEach(z => consider(z, z.w, z.h));
        if (!tierHidden('images')) state.images.forEach(i => consider(i, i.w, i.h));
        // Text boxes have no stored w/h - measure the real rendered box.
        // (They ride the devices tier in the Layers menu.)
        if (!tierHidden('devices')) state.textBoxes.forEach(t => {
            const r = textBoxRect(t);
            consider(t, r.w, r.h);
        });
        return { x: bx !== null ? bx : x, y: by !== null ? by : y, vg, hg };
    }

    function clearGuideLines() {
        ['align-guide-v', 'align-guide-h'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });
    }

    function showGuideLines(vg, hg) {
        clearGuideLines();
        const mk = (id, x1, y1, x2, y2) => {
            const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            l.id = id;
            l.setAttribute('x1', x1); l.setAttribute('y1', y1);
            l.setAttribute('x2', x2); l.setAttribute('y2', y2);
            l.classList.add('align-guide');
            overlayLayer.appendChild(l);
        };
        if (vg) mk('align-guide-v', vg.x, vg.y1, vg.x, vg.y2);
        if (hg) mk('align-guide-h', hg.x1, hg.y, hg.x2, hg.y);
    }

    // Apply guide snapping to a single-object drag's proposed position.
    // Alt suppresses guides (Alt already means "precise" via fine-snap).
    function guideAdjust(e, id, x, y, w, h) {
        if (!state.showGuides || e.altKey) { clearGuideLines(); return { x, y }; }
        const g = applyAlignmentGuides(x, y, w, h, id);
        showGuideLines(g.vg, g.hg);
        return { x: g.x, y: g.y };
    }

    function applyGuides(on) {
        state.showGuides = on;
        document.getElementById('btn-guides').classList.toggle('active', on);
        if (!on) clearGuideLines();
        try { localStorage.setItem('crosscanvas-guides', on ? '1' : '0'); } catch (e) { /* ignore */ }
    }
    document.getElementById('btn-guides').addEventListener('click', () => applyGuides(!state.showGuides));
    // Guides default ON (like the grid); '0' preserves a user's opt-out.
    try {
        if (localStorage.getItem('crosscanvas-guides') === '0') applyGuides(false);
    } catch (e) { /* ignore */ }

    // --- Toolbar quick-action buttons (mirror Edit menu) ---
    const toolbarActions = {
        'undo': () => undo(),
        'redo': () => redo(),
        'copy': () => copySelection(),
        'paste': () => pasteClipboard(),
        'delete': () => deleteSelected(),
        'arrange-front': () => arrangeSelected('front'),
        'arrange-forward': () => arrangeSelected('forward'),
        'arrange-backward': () => arrangeSelected('backward'),
        'arrange-back': () => arrangeSelected('back')
    };
    document.querySelectorAll('#toolbar [data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
            const fn = toolbarActions[btn.dataset.action];
            if (fn) fn();
        });
    });

    // --- Menu bar: dropdowns, submenus, and actions ---
    const menubar = document.getElementById('menubar');
    const menuItems = Array.from(menubar.querySelectorAll('.menu-item'));

    function closeMenus() {
        menuItems.forEach(mi => mi.classList.remove('open'));
    }

    menuItems.forEach(mi => {
        const label = mi.querySelector('.menu-label');
        label.addEventListener('click', (e) => {
            e.stopPropagation();
            const wasOpen = mi.classList.contains('open');
            closeMenus();
            if (!wasOpen) {
                mi.classList.add('open');
                // The Open Recent flyout reflects localStorage at open time
                if (mi.dataset.menu === 'file') rebuildRecentFlyout();
            }
        });
        // Once a menu is open, hovering a sibling switches to it (menu-bar feel)
        mi.addEventListener('mouseenter', () => {
            if (menuItems.some(m => m.classList.contains('open'))) {
                closeMenus();
                mi.classList.add('open');
            }
        });
    });

    document.addEventListener('click', (e) => {
        if (!menubar.contains(e.target)) closeMenus();
    });

    const menuActions = {
        'new': () => newDiagram(),
        'open': () => {
            if (state.dirty && !confirm('You have unsaved changes. Discard them and load a new diagram?')) return;
            document.getElementById('file-load').click();
        },
        // Merge adds to the canvas rather than replacing it, so no discard prompt
        'merge': () => document.getElementById('file-merge').click(),
        'load-sample': () => loadSampleDiagram(),
        'load-complex-sample': () => loadComplexSampleDiagram(),
        'save': () => saveDiagram(),
        'save-embedded': () => saveDiagram(true),
        'export-nogrid-png':  () => exportRaster('png',  false),
        'export-nogrid-png-transparent': () => exportRaster('png', false, true),
        'export-nogrid-jpeg': () => exportRaster('jpeg', false),
        'export-nogrid-pdf':  () => exportRaster('pdf',  false),
        'export-grid-png':    () => exportRaster('png',  true),
        'export-grid-jpeg':   () => exportRaster('jpeg', true),
        'export-grid-pdf':    () => exportRaster('pdf',  true),
        'export-csv':         () => exportCSV(),
        'export-nogrid-svg':  () => exportSVG(false),
        'export-grid-svg':    () => exportSVG(true),
        'import-inventory':   () => document.getElementById('file-import-inventory').click(),
        'paste-inventory':    () => openInventoryPaste(),
        'convert-diagrams':   () => {
            if (state.dirty && !confirm('You have unsaved changes. Discard them and batch-convert diagrams?')) return;
            document.getElementById('file-convert-diagrams').click();
        },
        'export-drawio':      () => exportDrawio(),
        'undo': () => undo(),
        'redo': () => redo(),
        'copy': () => copySelection(),
        'paste': () => pasteClipboard(),
        'delete': () => deleteSelected(),
        'arrange-front': () => arrangeSelected('front'),
        'arrange-forward': () => arrangeSelected('forward'),
        'arrange-backward': () => arrangeSelected('backward'),
        'arrange-back': () => arrangeSelected('back'),
        'align-left': () => alignSelected('left'),
        'align-hcenter': () => alignSelected('hcenter'),
        'align-right': () => alignSelected('right'),
        'align-top': () => alignSelected('top'),
        'align-vcenter': () => alignSelected('vcenter'),
        'align-bottom': () => alignSelected('bottom'),
        'distribute-h': () => distributeSelected('h'),
        'distribute-v': () => distributeSelected('v'),
        'bulk-devices': () => bulkEdit('devices'),
        'bulk-connections': () => bulkEdit('connections'),
        'bulk-zones': () => bulkEdit('zones'),
        'bulk-textboxes': () => bulkEdit('textboxes'),
        'bulk-images': () => bulkEdit('images'),
        'bulk-everything': () => bulkEdit('everything'),
        'recolor-to-theme': async () => { const opts = await recolorScopeDialog(); if (opts) recolorAllToTheme(opts); },
        'map-details-to-label': () => mapDetailsToLabel(),
        'map-label-to-details': () => mapLabelToDetails(),
        'help-quickstart': () => showHelp('quickStart', 'Quick Start'),
        'help-shortcuts': () => showHelp('shortcuts', 'Keyboard Shortcuts'),
        'help-guide': () => showHelp('guide', 'User Guide'),
        'help-inventory': () => showInventoryFormatHelp(),
        'help-about': () => showHelp('about', 'About CrossCanvas'),
        'download-offline': () => downloadOfflineCopy(),
        'export-scale': () => cycleExportScale()
    };

    // --- Download Offline Copy (Help menu) ---------------------------------
    // The app zips ITSELF: fetch our own files from whatever host is serving
    // us and hand back a zip that runs from a local folder - for anyone
    // (rightly) hesitant to load their network diagrams into a website.
    // Store-only ZIP written by hand: the container format is ~60 lines and
    // this keeps the zero-dependency story intact.
    function crc32(bytes) {
        let table = crc32.table;
        if (!table) {
            table = crc32.table = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                table[n] = c >>> 0;
            }
        }
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function buildZip(entries) {   // entries: [{name, bytes}]
        const enc = new TextEncoder();
        const now = new Date();
        const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
        const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
        const chunks = [], central = [];
        let offset = 0;
        const u16 = (v) => new Uint8Array([v & 0xFF, (v >> 8) & 0xFF]);
        const u32 = (v) => new Uint8Array([v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF, (v >>> 24) & 0xFF]);
        entries.forEach(({ name, bytes }) => {
            const nameB = enc.encode(name);
            const crc = crc32(bytes);
            const header = [u32(0x04034B50), u16(20), u16(0x0800 /* UTF-8 names */), u16(0 /* store */),
                u16(dosTime), u16(dosDate), u32(crc), u32(bytes.length), u32(bytes.length),
                u16(nameB.length), u16(0)];
            const localOffset = offset;
            header.forEach(b => { chunks.push(b); offset += b.length; });
            chunks.push(nameB); offset += nameB.length;
            chunks.push(bytes); offset += bytes.length;
            central.push({ nameB, crc, size: bytes.length, localOffset });
        });
        const cdStart = offset;
        // One timestamp for the whole archive (dosTime/dosDate above) - both
        // directories must agree, so it deliberately isn't per-entry state.
        central.forEach(({ nameB, crc, size, localOffset }) => {
            [u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate),
             u32(crc), u32(size), u32(size), u16(nameB.length), u16(0), u16(0),
             u16(0), u16(0), u32(0), u32(localOffset)].forEach(b => { chunks.push(b); offset += b.length; });
            chunks.push(nameB); offset += nameB.length;
        });
        [u32(0x06054B50), u16(0), u16(0), u16(central.length), u16(central.length),
         u32(offset - cdStart), u32(cdStart), u16(0)].forEach(b => chunks.push(b));
        return new Blob(chunks, { type: 'application/zip' });
    }
    async function downloadOfflineCopy() {
        if (location.protocol === 'file:') {
            showDialog({ title: 'Offline copy', body: 'You are already running from a local copy - the files in this folder are the whole app.' });
            return;
        }
        const FILES = ['index.html', 'app.js', 'devices.js', 'style.css', 'favicon.svg'];
        const OPTIONAL = ['customdevices.js'];   // team stencil layer, when the host has one
        try {
            const entries = [];
            for (const f of FILES) {
                const r = await fetch(f, { cache: 'no-store' });
                if (!r.ok) throw new Error(f + ': HTTP ' + r.status);
                entries.push({ name: f, bytes: new Uint8Array(await r.arrayBuffer()) });
            }
            for (const f of OPTIONAL) {
                const r = await fetch(f, { cache: 'no-store' }).catch(() => null);
                if (r && r.ok) entries.push({ name: f, bytes: new Uint8Array(await r.arrayBuffer()) });
            }
            entries.push({
                name: 'README.txt',
                bytes: new TextEncoder().encode(
                    'CrossCanvas - offline copy\r\n\r\n' +
                    'Open index.html in any modern browser. That\'s it - no install,\r\n' +
                    'no build, no network access needed or used. Your diagrams stay on\r\n' +
                    'this machine unless you export a file yourself.\r\n\r\n' +
                    'Downloaded from: ' + location.origin + location.pathname + '\r\n' +
                    'License: The Unlicense (public domain).\r\n')
            });
            triggerDownload(buildZip(entries), 'crosscanvas-offline.zip');
        } catch (err) {
            showDialog({ title: 'Offline copy', body: 'Could not assemble the download: ' + err.message });
        }
    }

    // Raster export resolution (PNG/JPEG/PDF): 1x for quick shares, 2x/4x for
    // print, video, and zooming. Persisted; SVG/CSV are unaffected (vector/data).
    let EXPORT_SCALE = 1;
    try { EXPORT_SCALE = [1, 2, 4].includes(parseInt(localStorage.getItem('crosscanvas-export-scale'), 10))
        ? parseInt(localStorage.getItem('crosscanvas-export-scale'), 10) : 1; } catch (e) { /* file:// */ }
    function updateExportScaleLabel() {
        const el = document.querySelector('#export-scale-btn span');
        if (el) el.innerHTML = 'Image Scale: ' + EXPORT_SCALE + '&times;';
    }
    function cycleExportScale() {
        EXPORT_SCALE = EXPORT_SCALE === 1 ? 2 : EXPORT_SCALE === 2 ? 4 : 1;
        try { localStorage.setItem('crosscanvas-export-scale', String(EXPORT_SCALE)); } catch (e) { /* file:// */ }
        updateExportScaleLabel();
    }
    updateExportScaleLabel();

    menubar.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            // The scale cycler stays open so 1x -> 2x -> 4x is three quick
            // clicks, not three menu trips.
            if (btn.dataset.action !== 'export-scale') closeMenus();
            const act = menuActions[btn.dataset.action];
            if (act) act();
        });
    });

    // --- Dark mode toggle (left sidebar + canvas) ---
    const darkBtn = document.getElementById('btn-dark-mode');
    function applyDarkMode(on) {
        document.body.classList.toggle('dark-mode', on);
        darkBtn.innerHTML = on ? '☀ Light' : '☾ Dark';
        try { localStorage.setItem('crosscanvas-dark', on ? '1' : '0'); } catch (e) { /* file:// */ }
        // The adaptive flips (connection strokes/arrows, device & image
        // labels, text boxes) are resolved at render time against the
        // surface behind them, so re-render everything that carries text
        // or lines when the mode changes.
        renderAllConnections();
        renderAllDevices();     // devices + text boxes (shared layer)
        renderAllImages();
    }
    darkBtn.addEventListener('click', () => {
        applyDarkMode(!document.body.classList.contains('dark-mode'));
    });
    try {
        if (localStorage.getItem('crosscanvas-dark') === '1') applyDarkMode(true);
    } catch (e) { /* localStorage unavailable */ }

    // --- Properties pane: left sidebar vs. right pane ---
    const propsHost = document.getElementById('properties-host');
    const rightPane = document.getElementById('right-pane');
    const leftSidebar = document.getElementById('sidebar');
    const propsSideBtn = document.getElementById('btn-props-side');
    const PROP_PANEL_IDS = ['device-panel', 'zone-panel', 'textbox-panel', 'connection-panel', 'image-panel', 'annotation-panel', 'batch-panel'];

    // --- Alignment segmented controls (shared across property panels) ---
    // Buttons are generated here so the icons live in one place; the HTML
    // carries empty .align-seg.halign / .align-seg.valign containers. This
    // block must run before any wireAlignSeg call below.
    const ALIGN_SEG_ICONS = {
        left:    '<svg width="14" height="12" viewBox="0 0 14 12"><path d="M1 2h12M1 6h8M1 10h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
        center:  '<svg width="14" height="12" viewBox="0 0 14 12"><path d="M1 2h12M3 6h8M2 10h10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
        right:   '<svg width="14" height="12" viewBox="0 0 14 12"><path d="M1 2h12M5 6h8M2 10h11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
        vtop:    '<svg width="14" height="12" viewBox="0 0 14 12"><path d="M1 1.5h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 5h6M4 8.5h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.6"/></svg>',
        vcenter: '<svg width="14" height="12" viewBox="0 0 14 12"><path d="M1 6h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 2h6M4 10h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.6"/></svg>',
        vbottom: '<svg width="14" height="12" viewBox="0 0 14 12"><path d="M1 10.5h12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 3.5h6M4 7h6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.6"/></svg>'
    };
    document.querySelectorAll('.align-seg.halign').forEach(seg => {
        seg.innerHTML =
            `<button type="button" data-val="left" title="Align left">${ALIGN_SEG_ICONS.left}</button>` +
            `<button type="button" data-val="center" title="Align center">${ALIGN_SEG_ICONS.center}</button>` +
            `<button type="button" data-val="right" title="Align right">${ALIGN_SEG_ICONS.right}</button>`;
    });
    document.querySelectorAll('.align-seg.valign').forEach(seg => {
        seg.innerHTML =
            `<button type="button" data-val="top" title="Align top">${ALIGN_SEG_ICONS.vtop}</button>` +
            `<button type="button" data-val="center" title="Align middle">${ALIGN_SEG_ICONS.vcenter}</button>` +
            `<button type="button" data-val="bottom" title="Align bottom">${ALIGN_SEG_ICONS.vbottom}</button>`;
    });

    function wireAlignSeg(segId, apply) {
        document.getElementById(segId).querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => apply(btn.dataset.val));
        });
    }
    function setSegActive(segId, val) {
        document.getElementById(segId).querySelectorAll('button').forEach(b =>
            b.classList.toggle('active', b.dataset.val === val));
    }

    // --- App modal (native <dialog>) ---
    // Promise-based replacement for alert()/prompt(): themed, dark-mode aware,
    // and able to hold real content (import summaries, the Visio page picker).
    // `body` is a string (newlines preserved), a DOM node, or a function
    // receiving close(value) for interactive bodies. Resolves with the clicked
    // button's value / the close(value) argument, or null on Esc.
    function showDialog(opts) {
        const dlg = document.getElementById('app-dialog');
        dlg.classList.toggle('wide', !!opts.wide);   // Help docs open wide/tall
        dlg.querySelector('.dialog-title').textContent = opts.title || '';
        const bodyEl = dlg.querySelector('.dialog-body');
        const btnEl = dlg.querySelector('.dialog-buttons');
        bodyEl.innerHTML = '';
        btnEl.innerHTML = '';

        let chosen = null;
        const close = (v) => { chosen = v; dlg.close(); };

        if (typeof opts.body === 'function') {
            bodyEl.appendChild(opts.body(close));
        } else if (typeof opts.body === 'string') {
            opts.body.split('\n').forEach(line => {
                const div = document.createElement('div');
                div.className = 'dialog-line';
                div.textContent = line;
                bodyEl.appendChild(div);
            });
        } else if (opts.body) {
            bodyEl.appendChild(opts.body);
        }

        (opts.buttons || [{ label: 'OK', value: true, primary: true }]).forEach(b => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'dialog-btn' + (b.primary ? ' primary' : '');
            btn.textContent = b.label;
            btn.addEventListener('click', () => close(b.value));
            btnEl.appendChild(btn);
        });

        return new Promise(resolve => {
            dlg.addEventListener('close', () => resolve(chosen), { once: true });
            dlg.showModal();
        });
    }

    // --- Help ----------------------------------------------------------
    // Embedded so Help travels with the hosted app (no fetch, works from
    // file://). Content mirrors USER_GUIDE.md / README - keep both in sync
    // when features change. Static, hardcoded HTML, so innerHTML is safe.
    const HELP = {
        about:
            '<h4>CrossCanvas ' + APP_VERSION + '</h4>' +
            '<p>A dependency-free, browser-based editor for network and application ' +
            'diagrams. Pure HTML/CSS/JS - no build step, no backend, and no outbound ' +
            'network calls. It runs straight from a file or any static host.</p>' +
            '<h4>Privacy</h4>' +
            '<p>CrossCanvas makes <strong>zero outbound network requests</strong> - no fonts, ' +
            'CDNs, telemetry, or uploads. Diagrams never leave this machine unless you ' +
            'export or share a file yourself. Imported images are gated to inert ' +
            '<code>data:</code> URIs, and untrusted values are escaped on every export path.</p>' +
            '<h4>Formats</h4>' +
            '<p><strong>Import:</strong> CrossCanvas (.xcanvas), Gliffy (.gliffy), Visio ' +
            '(.vsdx / .vsdm), draw.io (.drawio), Inventory (CSV / lease files / text dumps).<br>' +
            '<strong>Export:</strong> PNG (incl. transparent), JPEG, PDF, SVG, draw.io ' +
            '(.drawio), CSV.</p>' +
            '<h4>Credits</h4>' +
            '<p>The bundled stencil art derives from the <strong>Affinity</strong> network ' +
            'symbol set by ecceman (github.com/ecceman/affinity, released under The ' +
            'Unlicense) - much of CrossCanvas’s visual style is inspired by it. ' +
            'Several infrastructure stencils derive from <strong>Tabler Icons</strong> ' +
            '(github.com/tabler/tabler-icons, MIT License, © Paweł Kuna).</p>',
        quickStart:
            '<h4>Quick Start</h4>' +
            '<ol>' +
            '<li><strong>Drag a stencil</strong> from the Devices palette onto the canvas.</li>' +
            '<li><strong>Connect two devices</strong> - switch to the Connect tool (or hover a ' +
            'device edge) and drag from one attachment point to another.</li>' +
            '<li><strong>Add a zone</strong> - drag a shape from the Zones / Text section to group or ' +
            'label an area; it sits behind your devices.</li>' +
            '<li><strong>Label anything</strong> - double-click a device, zone, or connection to ' +
            'edit its label inline.</li>' +
            '<li><strong>Save</strong> - File → Save writes a .xcanvas file; File → Open / Import Diagram or Open ' +
            'Recent loads one back.</li>' +
            '</ol>' +
            '<p class="help-lead">Everything is undoable (<kbd>Ctrl</kbd>+<kbd>Z</kbd>) and snaps ' +
            'to the grid. Hold <kbd>Alt</kbd> while moving or resizing for fine precision. ' +
            '<kbd>Ctrl</kbd>+<kbd>F</kbd> opens a search bar that finds devices by label, hostname, ' +
            'or IP - <kbd>Enter</kbd> steps through the matches. Try ' +
            'File → Load Sample for a finished diagram. See the full <strong>User Guide</strong> ' +
            'in this menu for everything else.</p>',
        shortcuts:
            '<h4>Keyboard Shortcuts</h4>' +
            '<table><thead><tr><th>Action</th><th>Shortcut</th></tr></thead><tbody>' +
            '<tr><td>Undo / Redo</td><td><kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd></td></tr>' +
            '<tr><td>Copy / Paste</td><td><kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd></td></tr>' +
            '<tr><td>Select all</td><td><kbd>Ctrl</kbd>+<kbd>A</kbd></td></tr>' +
            '<tr><td>Duplicate selection</td><td><kbd>Ctrl</kbd>+<kbd>D</kbd></td></tr>' +
            '<tr><td>Find on canvas (label / hostname / IP)</td><td><kbd>Ctrl</kbd>+<kbd>F</kbd>, <kbd>Enter</kbd> / <kbd>Shift</kbd>+<kbd>Enter</kbd> to cycle</td></tr>' +
            '<tr><td>Open</td><td><kbd>Ctrl</kbd>+<kbd>O</kbd></td></tr>' +
            '<tr><td>Delete selection</td><td><kbd>Delete</kbd></td></tr>' +
            '<tr><td>Multi-select</td><td><kbd>Ctrl</kbd>-click (add or remove), <kbd>Shift</kbd>-click (add), or drag a marquee</td></tr>' +
            '<tr><td>Sub-select one group member</td><td><kbd>Ctrl</kbd>-click</td></tr>' +
            '<tr><td>Marquee inside a parent zone</td><td><kbd>Alt</kbd>+drag starting on the zone</td></tr>' +
            '<tr><td>Fine move/resize, bypass guides</td><td>hold <kbd>Alt</kbd> while dragging a device/bend/endpoint - pressing Alt after the drag starts works too</td></tr>' +
            '<tr><td>Proportional resize (keep W:H)</td><td>hold <kbd>Shift</kbd> while dragging a corner handle - mid-drag works too</td></tr>' +
            '<tr><td>Bold / italic in a label editor</td><td><kbd>Ctrl</kbd>+<kbd>B</kbd> / <kbd>Ctrl</kbd>+<kbd>I</kbd></td></tr>' +
            '<tr><td>Cancel text placement</td><td><kbd>Esc</kbd></td></tr>' +
            '<tr><td>Open this shortcuts list</td><td><kbd>?</kbd></td></tr>' +
            '</tbody></table>' +
            '<p class="help-lead">On macOS, use <kbd>Cmd</kbd> in place of <kbd>Ctrl</kbd> throughout.</p>',
        guide:
            '<h4>The workspace</h4>' +
            '<ul>' +
            '<li><strong>Menu bar</strong> - File, Export, Edit, Layers, Align, Bulk Actions, Help, ' +
            'plus the theme picker and dark-mode toggle on the right.</li>' +
            '<li><strong>Toolbar</strong> - select, connect, text, pan, zoom, undo/redo, copy/paste, ' +
            'delete, arrange (z-order), grid and snap toggles.</li>' +
            '<li><strong>Left sidebar</strong> - collapsible sections: Default Settings, ' +
            'Zones / Text, Devices (palette + search), and Device Library (import/export).</li>' +
            '<li><strong>Properties panel</strong> - appears when an object is selected; dock it ' +
            'left or right via the menu bar.</li>' +
            '</ul>' +
            '<h4>Devices &amp; stencils</h4>' +
            '<ul>' +
            '<li><strong>Place</strong> by dragging from the palette; <strong>search</strong> ' +
            'narrows the list. Search matches each stencil\'s name <em>and</em> common ' +
            'synonyms, so you don\'t need to know the exact stencil name - ' +
            '&ldquo;pc&rdquo; or &ldquo;computer&rdquo; find <em>Client</em>, ' +
            '&ldquo;phone&rdquo; finds <em>VOIPPhone</em>, and ' +
            '&ldquo;wifi&rdquo; or &ldquo;access point&rdquo; find <em>WifiAP</em>. ' +
            'Exact-name matches are listed first.</li>' +
            '<li>Select a device to set its label, font, size, <strong>Device Color</strong> (icon ' +
            'tint), <strong>Device Background</strong>, and attachment-point count.</li>' +
            '<li><strong>Swap the icon</strong> with the Icon dropdown - handy after an import ' +
            'leaves a device as the generic Blank stencil.</li>' +
            '<li><strong>Resize freely</strong> - drag handles for non-square devices, or type exact ' +
            'W&times;H. Hold <kbd>Shift</kbd> on the corner handle to keep the W:H ratio ' +
            '(squares stay square).</li>' +
            '<li><strong>Add your own icons</strong> via Device Library → Import Device Image / SVG. ' +
            'Monochrome SVGs are recolored to match the set and stay recolorable.</li>' +
            '</ul>' +
            '<h4>Zones</h4>' +
            '<p>Labeled background regions (VLANs, buildings, trust boundaries). Drag a shape from ' +
            'the Zones / Text section - rectangle, ellipse, diamond, parallelogram, pill, document, or ' +
            'cylinder. Set Fill, Border Color, Opacity, and the label position. Zones render behind ' +
            'devices, so a device dropped inside stays on top.</p>' +
            '<h4>Connections</h4>' +
            '<ul>' +
            '<li><strong>Draw</strong> by dragging from a device edge to another device; drop on ' +
            'empty canvas for a free-floating endpoint.</li>' +
            '<li><strong>Routing</strong> - Straight, Rounded, or Orthogonal per connection.</li>' +
            '<li><strong>Reshape</strong> - selected connections show bend handles (auto-routed) or ' +
            'waypoint handles (imported routes). A bend dropped on its natural line removes itself.</li>' +
            '<li><strong>Style</strong> - color, thickness, dash pattern, and independent start/end ' +
            'arrowheads. Add a label, or double-click the line for a draggable inline annotation.</li>' +
            '</ul>' +
            '<h4>Text &amp; labels</h4>' +
            '<p>Click the <strong>T</strong> toolbar button, then click the canvas to drop a text ' +
            'box (<kbd>Esc</kbd> cancels). Labels and text boxes support multiple lines, per-character ' +
            'bold / italic and color, curated fonts, and full horizontal / vertical alignment.</p>' +
            '<h4>Device data fields</h4>' +
            '<p>Every device has a collapsible <strong>Device Details</strong> section for inventory ' +
            'data: Hostname, IP-Address, Serial-Number, Asset-Tag, Description, Location, plus any ' +
            'custom field. Hostname falls back to the label if blank. The data saves with the diagram ' +
            'and exports to CSV - so a diagram doubles as lightweight inventory. Devices that carry ' +
            'an IP-Address are also monitoring-ready: the sister app <strong>PingCanvas</strong> ' +
            'turns a saved board into a live status wall, recoloring each device by reachability.</p>' +
            '<h4>Arranging &amp; aligning</h4>' +
            '<ul>' +
            '<li><strong>Alignment guides</strong> snap objects to each other as you drag; hold ' +
            '<kbd>Alt</kbd> to bypass.</li>' +
            '<li><strong>Align menu</strong> - align or evenly distribute a multi-selection.</li>' +
            '<li><strong>Arrange</strong> - bring to front / send to back / step forward / backward.</li>' +
            '<li><strong>Layers menu</strong> - show/hide or lock each tier (Zones, Connections, ' +
            'Images, Devices &amp; Text). Locking Zones lets you marquee the devices inside one ' +
            'without grabbing the zone.</li>' +
            '</ul>' +
            '<h4>Styling &amp; themes</h4>' +
            '<ul>' +
            '<li><strong>Default Settings</strong> (top of the sidebar) sets the colors new objects ' +
            'get; each has a Reset that restores the active theme\'s value.</li>' +
            '<li><strong>Themes</strong> - the picker by the dark-mode toggle offers 17 looks: Classic ' +
            '(the default) plus a spread of color themes, including a material family inspired by ' +
            'the canvas name (Canvas, Blueprint, Ink, Gesso). A theme ' +
            'recolors the app chrome and seeds the default object colors (device tint, zone ' +
            'fill/border, label font color), leaving existing objects untouched. An imported ' +
            'inventory is built in the active theme; imported diagrams keep their source styling.</li>' +
            '<li><strong>Recolor to Theme</strong> (Bulk Actions) retroactively snaps objects to the ' +
            'current theme - a popup picks which kinds (devices, zones, connections, text boxes), so ' +
            'you can keep, say, link-speed color coding or hand-tuned zones. Undoable, handy after an ' +
            'import.</li>' +
            '<li><strong>Map Details to Label</strong> (Bulk Actions) stacks chosen Device Details ' +
            '(Hostname + IP by default) into every device label, one per line - undoable.</li>' +
            '<li><strong>Map Label to Details</strong> (Bulk Actions) does the reverse: pulls an ' +
            'IPv4 address out of each device label into its IP-Address field - a quick way to ready ' +
            'an existing diagram for monitoring. Undoable; skips devices that already have an IP.</li>' +
            '<li><strong>Dark mode</strong> is surface-aware: labels and lines flip to stay legible.</li>' +
            '</ul>' +
            '<h4>Saving &amp; opening</h4>' +
            '<ul>' +
            '<li><strong>File → Save</strong> writes a .xcanvas file (plain JSON); the title drives ' +
            'the filename and the version auto-increments.</li>' +
            '<li><strong>Save with Embedded Images</strong> is self-contained - opens with full icons ' +
            'on any install.</li>' +
            '<li><strong>Open / Import Diagram</strong> loads .xcanvas (and legacy .json); <strong>Open Recent</strong> ' +
            'lists the last diagrams. Autosave offers to restore on the next launch.</li>' +
            '</ul>' +
            '<h4>Importing diagrams</h4>' +
            '<p>File → Open / Import Diagram also accepts <strong>Gliffy</strong> (.gliffy), <strong>Visio</strong> ' +
            '(.vsdx / .vsdm), and <strong>draw.io</strong> (.drawio, compressed or not) - all parsed in-browser. ' +
            'Device icons map to the bundled stencils, container shapes become zones, connector routes and ' +
            'arrowheads are imported, and embedded images come across as pasted images. Multi-page files ' +
            'prompt for a page. Unrecognized icons import as Blank and are listed in the summary - ' +
            'swap them afterwards with the Icon dropdown (its filter finds the right stencil fast). ' +
            'CrossCanvas’s own draw.io exports round-trip: device icons and Device Details come back intact. ' +
            'Your own stencils outrank the bundled set: if a Device Library import’s name matches a ' +
            'shape (an imported “Cisco Switch” icon vs. incoming switch shapes), imports use yours.</p>' +
            '<p><strong>Import &amp; Merge</strong> adds a diagram to the current canvas instead of ' +
            'replacing it - the incoming content lands to the right of what’s there, with fresh ids, ' +
            'and the canvas keeps its own title. Merge as many files as you like (any mix of formats) ' +
            'to marry diagrams together; one undo removes the last merge.</p>' +
            '<p><strong>Convert Diagrams</strong> batch-converts a multi-selection of .gliffy and ' +
            '.drawio files to .xcanvas - same importers, same fidelity as opening each by hand ' +
            '(multi-page draw.io files take their busiest page, noted in the roll-up). On Chrome/Edge ' +
            'it writes into a folder you pick; elsewhere each file downloads. A prompt offers to keep ' +
            'each file’s source colors (the default idiom) or apply <strong>Recolor to Theme</strong> ' +
            '(with the same per-kind picker) to every converted diagram in one pass. The last converted diagram stays on the canvas ' +
            'for spot-checking, and failures are listed in the roll-up.</p>' +
            '<h4>Exporting</h4>' +
            '<ul>' +
            '<li><strong>Images</strong> - PNG, JPEG, or PDF, each with or without the grid; a ' +
            'transparent-PNG option omits the background.</li>' +
            '<li><strong>SVG</strong> - a scalable vector file that opens in browsers and Visio.</li>' +
            '<li><strong>draw.io</strong> - opens directly in diagrams.net (which can re-export to ' +
            'Visio). Device Details ride along as shape data. For sensitive diagrams, the ' +
            'open-source draw.io Desktop app does the same Visio conversion fully offline.</li>' +
            '<li><strong>CSV</strong> - one row per object; human-readable columns first, geometry and ' +
            'styling after. Round-trips back through Import Inventory.</li>' +
            '</ul>' +
            '<h4>Inventory import</h4>' +
            '<p>File → Import Inventory turns a device inventory into a laid-out starting diagram ' +
            '(no connections drawn). Needs a header row; <code>label</code> (or Hostname) is the only ' +
            'near-required column. <code>stencil</code> picks an icon (fuzzy-matched); the six standing ' +
            'fields map to Device Details; <code>x</code>/<code>y</code> place explicitly; any other ' +
            'column becomes a custom field. <strong>Location</strong> drives grouping - a ' +
            '<code>/</code>- or <code>|</code>-delimited path nests devices into zones.</p>' +
            '<p><strong>Cisco Catalyst Center and ISE exports are auto-detected</strong> and mapped ' +
            'with no cleanup - the device inventory, the wired-client export (groups clients under ' +
            'their switch by itself), and ISE endpoints. Select a CC device export and an ISE export ' +
            '<strong>together</strong> for a hybrid that nests each client in a zone named for the ' +
            'switch it authenticated through. <strong>NetBox</strong> device exports are auto-detected ' +
            'too - the Site / Location / Rack hierarchy lands as nested zones. Windows DNS zone ' +
            'exports, DHCP lease exports, and raw ' +
            '<code>arp -a</code> output (.txt) round out the auto-detected set - quick homelab onboarding. ' +
            'See <em>Help → Inventory Import Formats</em> for the plain column spec and an example ' +
            'download.</p>',
        inventoryFormat:
            '<h4>Inventory import</h4>' +
            '<p><strong>File → Import Inventory</strong> turns a device list into a laid-out ' +
            'starting diagram - devices grouped into zones by their Location, ready to arrange. No ' +
            'connections are drawn. The vendor exports and command dumps below are detected ' +
            'automatically; any other CSV opens a column mapper so you can assign the columns ' +
            'yourself.</p>' +
            '<h4>The plain CSV template</h4>' +
            '<p>A header row is required; column names are case-insensitive.</p>' +
            '<table><thead><tr><th>Column</th><th>Purpose</th></tr></thead><tbody>' +
            '<tr><td><code>label</code></td><td>Device label - the only near-required column ' +
            '(falls back to <code>Hostname</code>).</td></tr>' +
            '<tr><td><code>stencil</code></td><td>Icon name, fuzzy-matched to the library; ' +
            'unknown &rarr; Blank.</td></tr>' +
            '<tr><td><code>Hostname</code>, <code>IP-Address</code>, <code>Serial-Number</code>, ' +
            '<code>Asset-Tag</code>, <code>Description</code>, <code>Location</code></td>' +
            '<td>The standing Device Details fields.</td></tr>' +
            '<tr><td><code>x</code>, <code>y</code></td><td>Optional exact pixel placement ' +
            '(skips auto-layout).</td></tr>' +
            '<tr><td><em>any other column</em></td><td>Becomes a custom data field named by its ' +
            'header.</td></tr>' +
            '</tbody></table>' +
            '<p><strong>Location drives grouping.</strong> A <code>/</code>- or <code>|</code>-' +
            'delimited path nests devices into zones - e.g. <code>HQ / Floor 1 / MDF</code> places ' +
            'the device three zones deep. Devices with no Location land in a loose grid.</p>' +
            '<p>The CSV <em>export</em> produces columns that re-import cleanly, so a diagram can ' +
            'round-trip through a spreadsheet. Cisco Catalyst Center, ISE, and NetBox device ' +
            'exports are auto-detected and need no manual formatting (NetBox: the stock Devices ' +
            'list export, default or All Data - Site / Location / Rack becomes the zone nesting, ' +
            'Role and Type pick the stencil).</p>' +
            '<p><strong>Homelab sources are auto-detected too</strong> - a fast way to seed a board ' +
            'from what your network already knows about itself. Drop any of these in (CSV, or ' +
            '<code>.txt</code> for the command dumps):</p>' +
            '<ul>' +
            '<li><strong>Windows DNS zone</strong> Export List CSV - Host (A) records become ' +
            'devices; zone plumbing (<code>_msdcs</code>, NS/SOA/CNAME, AAAA) is skipped.</li>' +
            '<li><strong>DHCP leases</strong> - Windows <em>Address Leases</em> export; ISC ' +
            '<strong>Kea</strong> <code>kea-leases4.csv</code> (pfSense\'s <code>dhcp4.leases</code>); ' +
            'the classic <strong>ISC dhcpd</strong> <code>dhcpd.leases</code> format (older pfSense / ' +
            'OPNsense, isc-dhcp-server); and <strong>dnsmasq</strong> lease files (Pi-hole, OpenWrt, ' +
            'routers). Active leases only.</li>' +
            '<li><strong>ARP / neighbour tables</strong> pasted as text - Windows <code>arp -a</code>, ' +
            'Cisco <code>show ip arp</code>, Linux <code>ip neigh</code>, and net-tools / macOS ' +
            '<code>arp -a</code>.</li>' +
            '<li><strong>nmap</strong> ping scan (<code>nmap -sn</code>) - the MAC-vendor name rides ' +
            'along as the Description. This is the universal fallback: it needs no access to the ' +
            'DHCP or DNS servers, just a shell on the right segment. Tip: add ' +
            '<code>-R --dns-servers &lt;your DNS&gt;</code> to get named results even where the ' +
            'scanning machine\'s own DNS can\'t resolve them.</li>' +
            '<li><strong>Ansible INI inventory</strong> (the <code>hosts</code> file) - each ' +
            '<code>[group]</code> becomes a Location zone, the host line\'s first token is the ' +
            'label, <code>ansible_host</code> supplies the IP, and any custom host var ' +
            '(<code>role=</code>, <code>rack=</code>) becomes a data field. Connection vars ' +
            '(<code>ansible_user</code> etc.) and <code>:vars</code> / <code>:children</code> ' +
            'sections are skipped.</li>' +
            '</ul>' +
            '<p>Across all of them, MACs normalize to <code>AA:BB:CC:DD:EE:FF</code> and ' +
            'multicast/broadcast/incomplete entries are dropped.</p>' +
            '<h4>Column mapper and pasting</h4>' +
            '<p>A CSV whose headers match nothing above opens the <strong>column mapper</strong>: ' +
            'over a preview of your data, tell it which column is the Label, the Location, and ' +
            'so on - everything else rides along as custom fields. A confirmed mapping is ' +
            'remembered, so the next export with the same headers imports in one click.</p>' +
            '<p><strong>File → Paste Inventory</strong> is the same importer without a file: ' +
            'paste a cell range copied straight out of Excel, LibreOffice, or Google Sheets ' +
            '(tab-separated paste is understood), CSV text, or any of the command dumps above. ' +
            'Untick <em>First row is headers</em> when you copied data without its header row.</p>' +
            '<p>Have an export we don\'t auto-detect? The mapper handles most shapes, and if ' +
            'you send a sample via a GitHub issue, it may just get supported directly.</p>',
    };
    // One Help system, five pages: every page opens with the same nav row up
    // top, so readers move between pages without a round-trip through the
    // Help menu. The shared #app-dialog can't nest, so a nav click closes
    // the current page and opens the target.
    const HELP_PAGES = [
        ['quickStart',      'Quick Start'],
        ['shortcuts',       'Keyboard Shortcuts'],
        ['guide',           'User Guide'],
        ['inventoryFormat', 'Inventory Import Formats'],
        ['about',           'About CrossCanvas'],
    ];
    function helpNav(currentKey) {
        const nav = document.createElement('div');
        nav.className = 'help-nav';
        HELP_PAGES.forEach(([key, title]) => {
            if (key === currentKey) {
                const cur = document.createElement('span');
                cur.textContent = title;
                nav.appendChild(cur);
            } else {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = title;
                btn.addEventListener('click', () => {
                    document.getElementById('app-dialog').close();
                    if (key === 'inventoryFormat') showInventoryFormatHelp();
                    else showHelp(key, title);
                });
                nav.appendChild(btn);
            }
        });
        return nav;
    }
    function showHelp(key, title) {
        const el = document.createElement('div');
        el.className = 'help-doc';
        el.innerHTML = HELP[key];
        el.prepend(helpNav(key));
        showDialog({ title: title, body: el, wide: true,
            buttons: [{ label: 'Close', value: true, primary: true }] });
    }

    // A ready-to-fill example of the generic inventory format. Embedded (not
    // fetched) so the download works offline / from file://. The Location
    // column shows the /-nesting; the trailing "Firmware" column demonstrates
    // that any extra header becomes a custom field.
    const INVENTORY_TEMPLATE_CSV =
        'label,stencil,Hostname,IP-Address,Serial-Number,Asset-Tag,Description,Location,Firmware\n' +
        'Core-SW-01,switch,core-sw-01,10.0.0.2,FDO2419A1B,AST-0001,Primary core switch,HQ / Floor 1 / MDF,17.9.4a\n' +
        'Edge-FW,firewall,edge-fw-01,10.0.0.1,FGT60F0001,AST-0003,Perimeter firewall,HQ / Floor 1 / MDF,7.2.8\n' +
        'AP-Lobby,access point,,10.0.10.11,KWC2234001,AST-0010,Ceiling access point,HQ / Floor 1,\n' +
        'File-Server,server,files,10.0.20.5,SGH123XYZ,AST-0020,SMB file server,HQ / Floor 2,\n';
    function downloadInventoryTemplate() {
        triggerDownload(new Blob([INVENTORY_TEMPLATE_CSV], { type: 'text/csv' }),
            'crosscanvas-inventory-template.csv');
    }
    function showInventoryFormatHelp() {
        const el = document.createElement('div');
        el.className = 'help-doc';
        el.innerHTML = HELP.inventoryFormat;
        el.prepend(helpNav('inventoryFormat'));
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'dialog-btn primary';
        btn.textContent = 'Download example CSV';
        btn.style.marginTop = '4px';
        btn.addEventListener('click', downloadInventoryTemplate);
        el.appendChild(btn);
        showDialog({ title: 'Inventory Import Formats', body: el, wide: true,
            buttons: [{ label: 'Close', value: true }] });
    }

    // --- Font families ---
    // Curated system font stacks only: the zero-outbound-network posture rules
    // out webfonts. Objects store the short key as fontFamily; absent means
    // the historical default (canvas inherits the app font, exports draw
    // generic sans-serif).
    const FONT_STACKS = {
        segoe:    '"Segoe UI", system-ui, sans-serif',
        arial:    'Arial, Helvetica, sans-serif',
        verdana:  'Verdana, Geneva, sans-serif',
        georgia:  'Georgia, serif',
        times:    '"Times New Roman", Times, serif',
        consolas: 'Consolas, "Courier New", monospace',
        courier:  '"Courier New", Courier, monospace'
    };
    const FONT_FAMILY_OPTIONS = [
        ['', 'Default'], ['segoe', 'Segoe UI'], ['arial', 'Arial'],
        ['verdana', 'Verdana'], ['georgia', 'Georgia'], ['times', 'Times New Roman'],
        ['consolas', 'Consolas'], ['courier', 'Courier New']
    ];
    const fontStackOf = (obj) => (obj && FONT_STACKS[obj.fontFamily]) || null;

    document.querySelectorAll('.font-family-select').forEach(sel => {
        // Batch variant (data-keep): a leading "- keep -" option, and the
        // Default face gets the sentinel value 'default' since '' means keep.
        const keep = sel.dataset.keep === '1';
        if (keep) {
            const k = document.createElement('option');
            k.value = '';
            k.textContent = '- keep -';
            k.selected = true;
            sel.appendChild(k);
        }
        FONT_FAMILY_OPTIONS.forEach(([key, label]) => {
            const opt = document.createElement('option');
            opt.value = keep && key === '' ? 'default' : key;
            opt.textContent = label;
            // Each option previews its own face
            if (FONT_STACKS[key]) opt.style.fontFamily = FONT_STACKS[key];
            sel.appendChild(opt);
        });
    });

    function anyPropPanelVisible() {
        return PROP_PANEL_IDS.some(id => {
            const el = document.getElementById(id);
            return el && el.style.display !== 'none' && el.style.display !== '';
        });
    }

    // Three modes: 'right' opens the pane on selection (canvas reflows when
    // it appears), 'right-locked' keeps the pane open permanently so
    // selecting an object never shifts the layout out from under the cursor,
    // 'left' docks the panels at the bottom of the left sidebar.
    let propsSideMode = 'right';
    const rightPaneHint = document.createElement('div');
    rightPaneHint.id = 'right-pane-hint';
    rightPaneHint.textContent = 'Select an object to edit its properties.';
    rightPane.appendChild(rightPaneHint);

    // Show the right pane while properties live on the right AND something is
    // selected - or always, when locked.
    function updateRightPaneVisibility() {
        const onRight = document.body.classList.contains('props-right');
        const hasPanel = anyPropPanelVisible();
        const show = onRight && (propsSideMode === 'right-locked' || hasPanel);
        rightPane.classList.toggle('visible', show);
        document.body.classList.toggle('right-pane-open', show);
        rightPaneHint.style.display = (show && !hasPanel) ? '' : 'none';
    }

    function setPropsSide(mode) {
        propsSideMode = mode;
        const right = mode !== 'left';
        document.body.classList.toggle('props-right', right);
        if (right) {
            rightPane.appendChild(propsHost);
        } else {
            leftSidebar.appendChild(propsHost); // back to the bottom of the left sidebar
        }
        // The padlock stands in for "(Locked)" - the text form wrapped the
        // button onto a second row and pushed it out of the menu bar.
        propsSideBtn.textContent = mode === 'right-locked' ? 'Properties: Right \u{1F512}'
            : right ? 'Properties: Right' : 'Properties: Left';
        try { localStorage.setItem('crosscanvas-props-side', mode); } catch (e) { /* ignore */ }
        updateRightPaneVisibility();
    }

    propsSideBtn.addEventListener('click', () => {
        setPropsSide(propsSideMode === 'right' ? 'right-locked'
            : propsSideMode === 'right-locked' ? 'left' : 'right');
    });

    // Panels are shown/hidden via inline style.display by the select* functions;
    // observe those changes to drive the right pane's visibility.
    const propsObserver = new MutationObserver(updateRightPaneVisibility);
    PROP_PANEL_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) propsObserver.observe(el, { attributes: true, attributeFilter: ['style'] });
    });

    let propsSidePref = 'right';
    try { propsSidePref = localStorage.getItem('crosscanvas-props-side') || 'right'; } catch (e) { /* ignore */ }
    if (!['right', 'right-locked', 'left'].includes(propsSidePref)) propsSidePref = 'right';
    setPropsSide(propsSidePref);

    // --- Batch edit (multi-selection + canvas-wide "Bulk" menu) ---------------
    // One panel drives both paths: editing a control applies to every target of
    // that type at once. Controls default to "keep"/blank so opening the panel
    // changes nothing - a value is written only when the user sets it, and each
    // change is a single undo step. Annotations follow their connections so a
    // batch font change covers them too.
    let batchTargets = { devices: [], connections: [], zones: [], textBoxes: [], images: [], annotations: [] };

    function hideBatchPanel() {
        const el = document.getElementById('batch-panel');
        if (el) el.style.display = 'none';
    }

    function openBatchEdit(targets) {
        const conns = targets.connections || [];
        const annotations = [];
        conns.forEach(c => (c.annotations || []).forEach(a => annotations.push(a)));
        batchTargets = {
            devices: targets.devices || [], connections: conns,
            zones: targets.zones || [], textBoxes: targets.textBoxes || [],
            images: targets.images || [], annotations: annotations
        };

        ['device-panel', 'connection-panel', 'zone-panel', 'textbox-panel', 'image-panel', 'annotation-panel']
            .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

        const t = batchTargets;
        const hasText = t.devices.length || t.zones.length || t.connections.length || t.textBoxes.length || t.images.length || t.annotations.length;
        const show = (id, on) => { document.getElementById(id).style.display = on ? '' : 'none'; };
        show('batch-text-group', !!hasText);
        show('batch-device-group', t.devices.length > 0);
        show('batch-conn-group', t.connections.length > 0);
        show('batch-zone-group', t.zones.length > 0);
        show('batch-textbox-group', t.textBoxes.length > 0);
        show('batch-image-group', t.images.length > 0);
        document.getElementById('batch-device-count').textContent = t.devices.length;
        document.getElementById('batch-conn-count').textContent = t.connections.length;
        document.getElementById('batch-zone-count').textContent = t.zones.length;
        document.getElementById('batch-textbox-count').textContent = t.textBoxes.length;
        document.getElementById('batch-image-count').textContent = t.images.length;

        // Reset controls so merely opening the panel never mutates anything.
        ['batch-font-size', 'batch-font-family', 'batch-device-w', 'batch-device-h', 'batch-conn-thickness', 'batch-conn-dash',
            'batch-conn-routing', 'batch-conn-arrow-scale', 'batch-zone-opacity', 'batch-textbox-align', 'batch-image-width',
            'batch-device-labelpos', 'batch-zone-labelpos']
            .forEach(id => { document.getElementById(id).value = ''; });

        // Color inputs can't sit blank like the "keep" fields above, so seed
        // them from the CURRENT Default Settings (i.e. the active theme) on
        // every open - their HTML values are the classic palette and go stale
        // the moment a theme seeds different defaults. A pick made while the
        // panel is open still sticks for that session.
        document.getElementById('batch-device-color').value = DEFAULT_DEVICE_TINT || '#4a90d9';
        document.getElementById('batch-device-bg').value = DEFAULT_ICON_BG || '#fffefe';
        document.getElementById('batch-font-color').value = DEFAULT_FONT_COLOR || '#333333';
        document.getElementById('batch-zone-fill').value = DEFAULT_ZONE_FILL || '#e8f4fd';
        document.getElementById('batch-zone-border').value = defaultZoneBorder();
        document.getElementById('batch-conn-color').value = DEFAULT_CONN_COLOR;

        // Populate the icon-swap dropdown (optgroup per category, alphabetized
        // within - like the single-device panel) with a leading "keep" option.
        document.getElementById('batch-device-filter').value = '';
        rebuildSwapSelect(document.getElementById('batch-device-swap'), { sentinel: true });

        const parts = [];
        if (t.devices.length) parts.push(t.devices.length + ' device(s)');
        if (t.connections.length) parts.push(t.connections.length + ' connection(s)');
        if (t.zones.length) parts.push(t.zones.length + ' zone(s)');
        if (t.textBoxes.length) parts.push(t.textBoxes.length + ' text box(es)');
        if (t.images.length) parts.push(t.images.length + ' image(s)');
        document.getElementById('batch-summary').textContent = parts.length ? ('Editing ' + parts.join(', ')) : 'Nothing selected';

        document.getElementById('batch-panel').style.display = 'block';
    }

    function selectionTargets() {
        const byId = (arr, ids) => (ids || []).map(id => arr.find(o => o.id === id)).filter(Boolean);
        return {
            devices: byId(state.devices, state.selectedDevices),
            connections: byId(state.connections, state.selectedConnections),
            zones: byId(state.zones, state.selectedZones),
            textBoxes: byId(state.textBoxes, state.selectedTextBoxes),
            images: byId(state.images, state.selectedImages)
        };
    }
    function selectionCount() {
        return state.selectedDevices.length + state.selectedZones.length + state.selectedTextBoxes.length +
            state.selectedImages.length + state.selectedConnections.length;
    }
    // After a marquee/ctrl/shift selection settles, show the batch panel when more
    // than one element is selected; otherwise leave it hidden.
    function refreshBatchPanel() {
        const count = selectionCount();
        if (count > 1) { openBatchEdit(selectionTargets()); return; }
        hideBatchPanel();
        // A marquee/ctrl selection that lands on exactly one object becomes a
        // normal single selection so its Properties panel opens.
        if (count === 1) {
            if (state.selectedDevices.length === 1) { const id = state.selectedDevices[0]; clearMultiSelect(); selectDevice(id); }
            else if (state.selectedZones.length === 1) { const id = state.selectedZones[0]; clearMultiSelect(); selectZone(id); }
            else if (state.selectedImages.length === 1) { const id = state.selectedImages[0]; clearMultiSelect(); selectImage(id); }
            else if (state.selectedTextBoxes.length === 1) { const id = state.selectedTextBoxes[0]; clearMultiSelect(); selectTextBox(id); }
            else if (state.selectedConnections.length === 1) { const id = state.selectedConnections[0]; clearMultiSelect(); selectConnection(id); }
        }
    }

    function batchRerender() {
        renderAllZones(); renderAllImages(); renderAllDevices(); renderAllConnections();
    }

    // Devices
    // W and H apply independently (blank = keep), matching the single-device
    // panel - the old single Size field forced every device square, a relic of
    // the squares-only era that mangled non-square imports.
    const batchDeviceDim = (dim) => (e) => {
        const v = parseInt(e.target.value, 10);
        // Same 20px floor as the single-device panel - typed values bypass the
        // input's min attribute, and GRID_SIZE alone halved this to 10 unnoticed.
        if (!v || v < GRID_SIZE * 2) return;
        pushUndo();
        batchTargets.devices.forEach(d => {
            const ow = d.w, oh = d.h;
            d[dim] = v;
            redistributeAPs(d, ow, oh);
        });
        batchRerender(); setDirty(true);
    };
    document.getElementById('batch-device-w').addEventListener('change', batchDeviceDim('w'));
    document.getElementById('batch-device-h').addEventListener('change', batchDeviceDim('h'));
    document.getElementById('batch-device-color').addEventListener('change', (e) => {
        const c = e.target.value;
        pushUndo();
        batchTargets.devices.forEach(d => {
            const src = d.originalImage || d.image;
            if (!isSVGDataURL(src)) return;
            if (!d.originalImage) d.originalImage = d.image;
            d.tintColor = c; d.image = tintSVG(d.originalImage, c);
        });
        renderAllDevices(); setDirty(true);
    });
    document.getElementById('batch-device-swap').addEventListener('change', (e) => {
        if (!e.target.value) return;
        const template = state.deviceTemplates.find(t => t.id === e.target.value);
        if (!template) return;
        pushUndo();
        // A fresh icon arrives like a newly PLACED device: wearing the theme's
        // Device Color. tintColor=null (untinted stencil blue) is right only
        // when no theme tint is set - under a theme it read as "swap recolored
        // everything to blue".
        const swapTint = (DEFAULT_DEVICE_TINT && isSVGDataURL(template.image)) ? DEFAULT_DEVICE_TINT : null;
        batchTargets.devices.forEach(d => {
            d.templateId = template.id;
            d.originalImage = template.image;
            d.tintColor = swapTint;
            d.image = swapTint ? tintSVG(template.image, swapTint) : template.image;
        });
        renderAllDevices(); setDirty(true);
        e.target.value = '';   // back to "keep" so re-opening the same option re-applies
    });
    document.getElementById('batch-device-bg').addEventListener('change', (e) => {
        pushUndo();
        batchTargets.devices.forEach(d => { d.iconBg = e.target.value; });
        renderAllDevices(); setDirty(true);
    });
    document.getElementById('batch-device-labelpos').addEventListener('change', (e) => {
        if (!e.target.value) return;
        pushUndo();
        batchTargets.devices.forEach(d => { d.labelPosition = e.target.value; });
        renderAllDevices(); setDirty(true);
        e.target.value = '';   // back to "keep"
    });
    // Batch Resets = "as newly placed", applied to the whole selection (a
    // selection-scoped Recolor All to Theme). Device Color needs its own
    // handler because "untinted" (Classic) can't be expressed through the
    // color input; Device Background because "follow the default" is
    // undefined, not a hex.
    document.getElementById('batch-reset-device-color').addEventListener('click', () => {
        pushUndo();
        batchTargets.devices.forEach(d => {
            const src = d.originalImage || d.image;
            if (!isSVGDataURL(src)) return;
            if (!d.originalImage) d.originalImage = d.image;
            const tint = DEFAULT_DEVICE_TINT || null;
            d.tintColor = tint;
            d.image = tint ? tintSVG(d.originalImage, tint) : d.originalImage;
        });
        document.getElementById('batch-device-color').value = DEFAULT_DEVICE_TINT || '#4a90d9';
        renderAllDevices(); setDirty(true);
    });
    document.getElementById('batch-reset-device-bg').addEventListener('click', () => {
        pushUndo();
        batchTargets.devices.forEach(d => { d.iconBg = DEFAULT_ICON_BG || undefined; });
        document.getElementById('batch-device-bg').value = DEFAULT_ICON_BG || '#fffefe';
        renderAllDevices(); setDirty(true);
    });
    // The remaining batch Resets drive their input with the theme default
    // and let the existing change handler apply it to the selection.
    [['batch-reset-font-color', 'batch-font-color', () => DEFAULT_FONT_COLOR || '#333333'],
     ['batch-reset-conn-color', 'batch-conn-color', () => DEFAULT_CONN_COLOR],
     ['batch-reset-zone-fill', 'batch-zone-fill', () => DEFAULT_ZONE_FILL || '#e8f4fd'],
     ['batch-reset-zone-border', 'batch-zone-border', () => defaultZoneBorder()]
    ].forEach(([btn, input, val]) => {
        document.getElementById(btn).addEventListener('click', () => {
            const el = document.getElementById(input);
            el.value = val();
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });

    // Connections
    document.getElementById('batch-conn-thickness').addEventListener('change', (e) => {
        if (!e.target.value) return;
        pushUndo();
        const v = parseInt(e.target.value, 10);
        batchTargets.connections.forEach(c => { c.thickness = v; });
        renderAllConnections(); setDirty(true);
    });
    document.getElementById('batch-conn-color').addEventListener('change', (e) => {
        pushUndo();
        batchTargets.connections.forEach(c => { c.color = e.target.value; });
        renderAllConnections(); setDirty(true);
    });
    document.getElementById('batch-conn-dash').addEventListener('change', (e) => {
        if (!e.target.value) return;
        pushUndo();
        batchTargets.connections.forEach(c => { c.dash = e.target.value; });
        renderAllConnections(); setDirty(true);
    });
    document.getElementById('batch-conn-routing').addEventListener('change', (e) => {
        if (!e.target.value) return;
        pushUndo();
        batchTargets.connections.forEach(c => {
            if (e.target.value === 'straight') { delete c.bends; delete c.waypoints; }
            c.routing = e.target.value;
        });
        renderAllConnections(); setDirty(true);
    });
    document.getElementById('batch-conn-arrow-scale').addEventListener('change', (e) => {
        if (!e.target.value) return;
        pushUndo();
        const scale = parseFloat(e.target.value) || 1;
        batchTargets.connections.forEach(c => { c.arrowScale = scale; });
        renderAllConnections(); setDirty(true);
    });

    // Zones
    document.getElementById('batch-zone-fill').addEventListener('change', (e) => {
        pushUndo();
        batchTargets.zones.forEach(z => { z.fill = e.target.value; });
        renderAllZones(); setDirty(true);
    });
    document.getElementById('batch-zone-border').addEventListener('change', (e) => {
        pushUndo();
        batchTargets.zones.forEach(z => { z.borderColor = e.target.value; });
        renderAllZones(); setDirty(true);
    });
    document.getElementById('batch-zone-labelpos').addEventListener('change', (e) => {
        if (!e.target.value) return;
        pushUndo();
        batchTargets.zones.forEach(z => { z.labelPosition = e.target.value; });
        renderAllZones(); setDirty(true);
        e.target.value = '';   // back to "keep"
    });
    document.getElementById('batch-zone-opacity').addEventListener('change', (e) => {
        const v = parseFloat(e.target.value);
        if (isNaN(v)) return;
        pushUndo();
        const op = Math.max(0, Math.min(1, v));
        batchTargets.zones.forEach(z => { z.opacity = op; });
        renderAllZones(); setDirty(true);
    });

    // Text boxes (rendered alongside devices)
    document.getElementById('batch-textbox-align').addEventListener('change', (e) => {
        if (!e.target.value) return;
        pushUndo();
        batchTargets.textBoxes.forEach(tb => { tb.textAlign = e.target.value; });
        renderAllDevices(); setDirty(true);
    });

    // Images - set width, preserving each image's aspect ratio.
    document.getElementById('batch-image-width').addEventListener('change', (e) => {
        const v = parseInt(e.target.value, 10);
        if (!v || v < GRID_SIZE) return;
        pushUndo();
        batchTargets.images.forEach(img => {
            const ratio = (img.w > 0) ? (img.h / img.w) : 1;
            const ow = img.w, oh = img.h;
            img.w = v;
            img.h = Math.max(GRID_SIZE, Math.round(v * ratio));
            redistributeAPs(img, ow, oh);
            rerouteConnectionsForDevice(img.id);
        });
        renderAllImages(); renderAllConnections(); setDirty(true);
    });

    // Fonts - span every targeted label, annotation and text box at once.
    document.getElementById('batch-font-size').addEventListener('change', (e) => {
        if (!e.target.value) return;
        const size = parseInt(e.target.value, 10);
        pushUndo();
        const t = batchTargets;
        [...t.devices, ...t.zones, ...t.connections, ...t.textBoxes, ...t.images].forEach(o => { o.fontSize = size; });
        t.annotations.forEach(a => { a.fontSize = size; });
        batchRerender(); setDirty(true);
    });
    document.getElementById('batch-font-color').addEventListener('change', (e) => {
        const color = e.target.value;
        pushUndo();
        const t = batchTargets;
        [...t.devices, ...t.zones, ...t.connections, ...t.textBoxes, ...t.images].forEach(o => { o.fontColor = color; clearSpanColors(o); });
        t.annotations.forEach(a => { a.fontColor = color; clearSpanColors(a); });
        batchRerender(); setDirty(true);
    });
    document.getElementById('batch-font-family').addEventListener('change', (e) => {
        if (!e.target.value) return;   // '' = keep
        const key = e.target.value === 'default' ? undefined : e.target.value;
        pushUndo();
        const t = batchTargets;
        [...t.devices, ...t.zones, ...t.connections, ...t.textBoxes, ...t.images].forEach(o => { o.fontFamily = key; });
        t.annotations.forEach(a => { a.fontFamily = key; });
        batchRerender(); setDirty(true);
    });

    // Canvas-wide "Bulk" menu - same panel, scoped to every object of a type.
    function bulkEdit(kind) {
        if (kind === 'devices') {
            if (!state.devices.length) { alert('There are no devices to edit.'); return; }
            openBatchEdit({ devices: state.devices.slice() });
        } else if (kind === 'connections') {
            if (!state.connections.length) { alert('There are no connections to edit.'); return; }
            openBatchEdit({ connections: state.connections.slice() });
        } else if (kind === 'zones') {
            if (!state.zones.length) { alert('There are no zones to edit.'); return; }
            openBatchEdit({ zones: state.zones.slice() });
        } else if (kind === 'textboxes') {
            if (!state.textBoxes.length) { alert('There are no text boxes to edit.'); return; }
            openBatchEdit({ textBoxes: state.textBoxes.slice() });
        } else if (kind === 'images') {
            if (!state.images.length) { alert('There are no images to edit.'); return; }
            openBatchEdit({ images: state.images.slice() });
        } else if (kind === 'everything') {
            const any = state.devices.length || state.connections.length || state.zones.length || state.textBoxes.length || state.images.length;
            if (!any) { alert('There is nothing on the canvas to edit.'); return; }
            openBatchEdit({
                devices: state.devices.slice(), connections: state.connections.slice(),
                zones: state.zones.slice(), textBoxes: state.textBoxes.slice(), images: state.images.slice()
            });
        }
    }

    // --- Right-click context menu --------------------------------------------
    // A floating menu built from the current selection; reuses the same actions
    // as the menu bar (copy/paste/delete, layer order, align/distribute, batch).
    const ctxMenu = document.createElement('div');
    ctxMenu.className = 'context-menu';
    ctxMenu.style.display = 'none';
    document.body.appendChild(ctxMenu);

    function hideContextMenu() { ctxMenu.style.display = 'none'; ctxMenu.innerHTML = ''; }

    function buildContextMenu(container, items) {
        items.forEach(item => {
            if (item.sep) { const s = document.createElement('div'); s.className = 'context-sep'; container.appendChild(s); return; }
            const el = document.createElement('div');
            el.className = 'context-item' + (item.disabled ? ' disabled' : '') + (item.submenu ? ' has-sub' : '');
            const label = document.createElement('span'); label.textContent = item.label; el.appendChild(label);
            if (item.submenu) {
                const arrow = document.createElement('span'); arrow.className = 'context-arrow'; arrow.textContent = '›'; el.appendChild(arrow);
                const fly = document.createElement('div'); fly.className = 'context-flyout';
                buildContextMenu(fly, item.submenu); el.appendChild(fly);
            } else {
                if (item.key) { const k = document.createElement('span'); k.className = 'context-key'; k.textContent = item.key; el.appendChild(k); }
                if (!item.disabled) el.addEventListener('click', (ev) => { ev.stopPropagation(); hideContextMenu(); item.action(); });
            }
            container.appendChild(el);
        });
    }

    function showContextMenu(clientX, clientY, items) {
        ctxMenu.innerHTML = '';
        buildContextMenu(ctxMenu, items);
        ctxMenu.style.display = 'block';
        ctxMenu.style.left = '0px'; ctxMenu.style.top = '0px';
        const r = ctxMenu.getBoundingClientRect();   // measure, then keep on-screen
        let x = clientX, y = clientY;
        if (x + r.width > window.innerWidth) x = Math.max(4, window.innerWidth - r.width - 4);
        if (y + r.height > window.innerHeight) y = Math.max(4, window.innerHeight - r.height - 4);
        ctxMenu.style.left = x + 'px'; ctxMenu.style.top = y + 'px';
    }

    function contextItemsForSelection() {
        const multi = selectionCount();
        const single = state.selectedDevice || state.selectedZone || state.selectedTextBox || state.selectedImage || state.selectedConnection;
        const anySel = multi > 0 || !!single;
        const items = [];
        items.push({ label: 'Undo', key: 'Ctrl+Z', disabled: undoStack.length === 0, action: () => undo() });
        items.push({ label: 'Redo', key: 'Ctrl+Y', disabled: redoStack.length === 0, action: () => redo() });
        items.push({ sep: true });
        if (anySel) {
            items.push({ label: 'Copy', key: 'Ctrl+C', action: () => copySelection() });
        }
        items.push({ label: 'Paste', key: 'Ctrl+V', disabled: !state.clipboard, action: () => pasteClipboard() });
        if (anySel) {
            items.push({ sep: true });
            items.push({ label: 'Delete', key: 'Del', action: () => deleteSelected() });
            items.push({ sep: true });
            items.push({ label: 'Bring to Front', action: () => arrangeSelected('front') });
            items.push({ label: 'Bring Forward', action: () => arrangeSelected('forward') });
            items.push({ label: 'Send Backward', action: () => arrangeSelected('backward') });
            items.push({ label: 'Send to Back', action: () => arrangeSelected('back') });
        }
        if (multi >= 2) {
            items.push({ sep: true });
            items.push({
                label: 'Align / Distribute', submenu: [
                    { label: 'Align Left', action: () => alignSelected('left') },
                    { label: 'Align Center', action: () => alignSelected('hcenter') },
                    { label: 'Align Right', action: () => alignSelected('right') },
                    { sep: true },
                    { label: 'Align Top', action: () => alignSelected('top') },
                    { label: 'Align Middle', action: () => alignSelected('vcenter') },
                    { label: 'Align Bottom', action: () => alignSelected('bottom') },
                    { sep: true },
                    { label: 'Distribute Horizontally', disabled: multi < 3, action: () => distributeSelected('h') },
                    { label: 'Distribute Vertically', disabled: multi < 3, action: () => distributeSelected('v') }
                ]
            });
        }
        // Group / Ungroup - group needs 2+ groupable nodes selected; ungroup
        // shows whenever the selection touches an existing group.
        const groupable = state.selectedDevices.length + state.selectedZones.length +
            state.selectedTextBoxes.length + state.selectedImages.length;
        const selIds = new Set([...state.selectedDevices, ...state.selectedZones,
            ...state.selectedTextBoxes, ...state.selectedImages]);
        if (state.selectedDevice) selIds.add(state.selectedDevice);
        if (state.selectedZone) selIds.add(state.selectedZone);
        if (state.selectedTextBox) selIds.add(state.selectedTextBox);
        if (state.selectedImage) selIds.add(state.selectedImage);
        const touchesGroup = state.groups.some(g => g.members.some(m => selIds.has(m)));
        if (groupable >= 2 || touchesGroup) {
            items.push({ sep: true });
            if (groupable >= 2) items.push({ label: 'Group', key: 'Ctrl+G', action: () => groupSelection() });
            if (touchesGroup) items.push({ label: 'Ungroup', key: 'Ctrl+Shift+G', action: () => ungroupSelection() });
        }
        if (!anySel) {
            items.push({ sep: true });
            items.push({ label: 'Select All', key: 'Ctrl+A', action: () => selectAll() });
        }
        return items;
    }

    canvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (state.tool !== 'select') { hideContextMenu(); return; }
        const deviceEl = e.target.closest('.device-node');
        const imageEl = !deviceEl ? e.target.closest('.image-node') : null;
        const textboxEl = !deviceEl && !imageEl ? e.target.closest('.textbox-node') : null;
        const zoneEl = !deviceEl && !imageEl && !textboxEl ? e.target.closest('.zone-node') : null;
        const connEl = !deviceEl && !imageEl && !textboxEl && !zoneEl ? e.target.closest('.connection-line') : null;
        const targetId = (deviceEl && deviceEl.id) || (imageEl && imageEl.id) || (textboxEl && textboxEl.id) ||
            (zoneEl && zoneEl.id) || (connEl && connEl.dataset.connId) || null;

        const inSelection = targetId && (
            state.selectedDevices.includes(targetId) || state.selectedZones.includes(targetId) ||
            state.selectedTextBoxes.includes(targetId) || state.selectedImages.includes(targetId) ||
            state.selectedConnections.includes(targetId) ||
            state.selectedDevice === targetId || state.selectedZone === targetId || state.selectedTextBox === targetId ||
            state.selectedImage === targetId || state.selectedConnection === targetId);

        // Right-clicking an unselected object selects just it; right-clicking
        // inside the current selection keeps it (so the menu acts on all of it);
        // right-clicking empty canvas clears the selection.
        if (targetId && !inSelection) {
            const grp = !connEl ? findGroupFor(targetId) : null;
            if (grp) {
                // A grouped member selects its whole group, matching left-click
                selectGroupMembers(grp, false);
            } else {
                clearMultiSelect();
                if (deviceEl) selectDevice(deviceEl.id);
                else if (imageEl) selectImage(imageEl.id);
                else if (textboxEl) selectTextBox(textboxEl.id);
                else if (zoneEl) selectZone(zoneEl.id);
                else if (connEl) selectConnection(connEl.dataset.connId);
            }
        } else if (!targetId) {
            deselectAll();
        }
        showContextMenu(e.clientX, e.clientY, contextItemsForSelection());
    });

    document.addEventListener('mousedown', (e) => {
        if (ctxMenu.style.display !== 'none' && !ctxMenu.contains(e.target)) hideContextMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
    document.addEventListener('scroll', hideContextMenu, true);
    window.addEventListener('blur', hideContextMenu);
    window.addEventListener('resize', hideContextMenu);

    // --- Diagram Title / Version fields ---
    document.getElementById('diagram-title').addEventListener('input', (e) => {
        state.diagramTitle = e.target.value || 'network-diagram';
    });
    document.getElementById('diagram-version').addEventListener('input', (e) => {
        state.diagramVersion = Math.max(1, parseInt(e.target.value) || 1);
    });

    function updateTitleVersionUI() {
        document.getElementById('diagram-title').value = state.diagramTitle;
        document.getElementById('diagram-version').value = state.diagramVersion;
    }

    function setDirty(dirty) {
        state.dirty = dirty;
        document.getElementById('dirty-indicator').classList.toggle('visible', dirty);
        if (dirty && typeof scheduleAutosave === 'function') scheduleAutosave();
    }

    function setTool(tool) {
        state.tool = tool;
        // Only the mode-tool buttons share the 'active' highlight; btn-grid is an
        // independent toggle that manages its own active state, so don't clear it.
        ['btn-select', 'btn-connect', 'btn-pan', 'btn-add-text'].forEach(id => document.getElementById(id).classList.remove('active'));
        if (tool === 'select') document.getElementById('btn-select').classList.add('active');
        else if (tool === 'connect') document.getElementById('btn-connect').classList.add('active');
        else if (tool === 'pan') document.getElementById('btn-pan').classList.add('active');
        else if (tool === 'text') document.getElementById('btn-add-text').classList.add('active');

        document.getElementById('canvas-container').classList.toggle('pan-mode', tool === 'pan');
        document.getElementById('canvas-container').classList.toggle('text-mode', tool === 'text');
        document.getElementById('canvas-container').classList.toggle('connect-mode', tool === 'connect');

        if (tool === 'connect') {
            document.getElementById('connection-panel').style.display = 'block';
            selectDevice(null);
            selectConnection(null);
        }
    }

    // --- Canvas Interaction ---
    function hasMultiSelection() {
        return state.selectedDevices.length > 0 || state.selectedZones.length > 0 ||
               state.selectedTextBoxes.length > 0 || state.selectedImages.length > 0;
    }

    // Track double-click manually since mousedown→selectDevice→renderAllDevices
    // destroys DOM elements, preventing the browser from firing native dblclick
    let lastMousedownInfo = { time: 0, x: 0, y: 0 };

    canvas.addEventListener('mousedown', (e) => {
        // Only the left button drives selection/drag/marquee; right-click is for
        // the context menu (handled separately) and must not start a marquee.
        if (e.button !== 0) return;
        // Pan tool: drag to scroll the canvas
        if (state.tool === 'pan') {
            const container = document.getElementById('canvas-container');
            state.panning = { startX: e.clientX, startY: e.clientY, scrollLeft: container.scrollLeft, scrollTop: container.scrollTop };
            container.classList.add('panning');
            e.preventDefault();
            return;
        }

        // Text tool (one-shot): place a ready-to-type text box at the click
        // point, then return to Select - Gliffy-style.
        if (state.tool === 'text') {
            const p = getSVGPoint(e);
            const textBox = {
                id: genId(), x: snapToGrid(p.x), y: snapToGrid(p.y), text: 'Text',
                fontSize: DEFAULT_FONT_SIZE, fontColor: DEFAULT_FONT_COLOR,
                fontFamily: DEFAULT_FONT_FAMILY || undefined, textAlign: 'left',
                lineFormats: [{ bold: false, italic: false }],
                spans: [[{ text: 'Text', bold: false, italic: false }]]
            };
            pushUndo();
            ensureTierVisible('devices');
            state.textBoxes.push(textBox);
            clearMultiSelect();
            selectDevice(null);
            selectZone(null);
            selectConnection(null);
            selectTextBox(textBox.id);
            updateCanvasSize();
            setTool('select');
            // Defer so the editor opens after mouseup/click finish, preventing
            // the mouseup from immediately blurring it (same as double-click)
            setTimeout(() => startInlineEdit('textbox', textBox.id, textBox, 'text', textBox.x, textBox.y, DEFAULT_FONT_SIZE, 'left'), 0);
            e.preventDefault();
            return;
        }

        if (state.inlineEditing) {
            // Clicking on the inline editor itself should not commit
            if (state.inlineEditing.element.contains(e.target)) return;
            commitInlineEdit();
            return;
        }

        // Detect double-click manually: second mousedown within 400ms and 5px
        const now = Date.now();
        const point = getSVGPoint(e);
        const dx = point.x - lastMousedownInfo.x;
        const dy = point.y - lastMousedownInfo.y;
        const dt = now - lastMousedownInfo.time;
        lastMousedownInfo = { time: now, x: point.x, y: point.y };

        if (dt < 400 && Math.abs(dx) < 5 && Math.abs(dy) < 5) {
            // This is a double-click - fire inline edit logic
            // Clear any drag state set by the first mousedown
            state.dragging = null;
            state.draggingAnnotation = null;
            preDragSnapshot = null;
            // Defer so the editor opens after mouseup/click finish,
            // preventing the mouseup from immediately blurring the editor
            setTimeout(() => handleCanvasDblClick(point), 0);
            lastMousedownInfo = { time: 0, x: 0, y: 0 }; // reset to prevent triple-fire
            return;
        }

        const epHandle = e.target.closest('.conn-endpoint-handle');
        if (epHandle) {
            const conn = state.connections.find(c => c.id === epHandle.dataset.connId);
            if (conn) {
                preDragSnapshot = snapshotState();
                state.draggingEndpoint = { conn, end: epHandle.dataset.end };
            }
            return;
        }

        // Waypoint handles (imported hand-routed paths) - checked before the
        // generic bend-handle branch since they share the base class
        const wpHandle = e.target.closest('.conn-waypoint-handle');
        if (wpHandle) {
            const conn = state.connections.find(c => c.id === wpHandle.dataset.connId);
            if (conn && conn.waypoints) {
                preDragSnapshot = snapshotState();
                state.draggingWaypoint = { conn, idx: parseInt(wpHandle.dataset.wpIndex, 10) };
            }
            return;
        }

        const bendHandle = e.target.closest('.conn-bend-handle');
        if (bendHandle) {
            const conn = state.connections.find(c => c.id === bendHandle.dataset.connId);
            if (conn) {
                preDragSnapshot = snapshotState();
                // The natural rail position for this segment (route without
                // manual bends). Bend dragging snaps RELATIVE to it: rails sit
                // off-grid by the 30px AP stub, so absolute grid stops could
                // never land back on the natural position - the release
                // cleanup then swallowed the first stop on either side, which
                // read as "one interval snaps back".
                const isVertical = bendHandle.dataset.isVertical === '1';
                let naturalVal = null;
                const fromNode = findNode(conn.fromDevice);
                const toNode = findNode(conn.toDevice);
                if (fromNode && toNode) {
                    const naturalPoints = routeOrthogonal(
                        getAbsoluteAP(fromNode, conn.fromAP), getAbsoluteAP(toNode, conn.toAP), conn);
                    const i = parseInt(bendHandle.dataset.segIndex);
                    if (i >= 1 && i < naturalPoints.length - 1) {
                        naturalVal = isVertical ? naturalPoints[i].x : naturalPoints[i].y;
                    }
                }
                state.draggingBend = {
                    conn,
                    segIndex: bendHandle.dataset.segIndex,
                    isVertical,
                    naturalVal
                };
            }
            return;
        }

        if (state.tool === 'select') {
            const apEl = e.target.closest('.attachment-point');
            if (apEl) {
                const deviceId = apEl.dataset.deviceId;
                const apIndex = parseInt(apEl.dataset.apIndex);
                // If the selected connection has an endpoint on this AP, pick it
                // up for re-attachment instead of starting a new connection
                if (state.selectedConnection) {
                    const sc = state.connections.find(c => c.id === state.selectedConnection);
                    if (sc && sc.fromDevice === deviceId && sc.fromAP === apIndex) {
                        preDragSnapshot = snapshotState();
                        state.draggingEndpoint = { conn: sc, end: 'from' };
                        return;
                    }
                    if (sc && sc.toDevice === deviceId && sc.toAP === apIndex) {
                        preDragSnapshot = snapshotState();
                        state.draggingEndpoint = { conn: sc, end: 'to' };
                        return;
                    }
                }
                setTool('connect');
                state.connecting = { fromDevice: deviceId, fromAP: apIndex };
                return;
            }

            // Check for image resize handle
            const imgResizeEl = e.target.closest('.image-resize-handle');
            if (imgResizeEl) {
                const img = state.images.find(i => i.id === imgResizeEl.dataset.imageId);
                if (img) {
                    preDragSnapshot = snapshotState();
                    state.resizingImage = { image: img, startX: point.x, startY: point.y, origW: img.w, origH: img.h, aspect: img.w / img.h };
                    selectImage(img.id);
                }
                return;
            }

            // Check for zone resize handle
            const resizeEl = e.target.closest('.zone-resize-handle');
            if (resizeEl) {
                const zone = state.zones.find(z => z.id === resizeEl.dataset.zoneId);
                if (zone) {
                    preDragSnapshot = snapshotState();
                    state.resizingZone = { zone, startX: point.x, startY: point.y, origX: zone.x, origY: zone.y, origW: zone.w, origH: zone.h, axis: resizeEl.dataset.axis || 'both' };
                }
                return;
            }

            // Check for device resize handle
            const devResizeEl = e.target.closest('.device-resize-handle');
            if (devResizeEl) {
                const device = state.devices.find(d => d.id === devResizeEl.dataset.deviceId);
                if (device) {
                    preDragSnapshot = snapshotState();
                    state.resizingDevice = { device, startX: point.x, startY: point.y, origX: device.x, origY: device.y, origW: device.w, origH: device.h, axis: devResizeEl.dataset.axis || 'both' };
                    selectDevice(device.id);
                }
                return;
            }

            // Check for annotation drag
            const annEl = e.target.closest('.connection-annotation, .connection-annotation-bg');
            if (annEl && annEl.dataset.annId) {
                const connGroup = annEl.closest('g[id]');
                if (connGroup) {
                    const conn = state.connections.find(c => c.id === connGroup.id);
                    if (conn && conn.annotations) {
                        const ann = conn.annotations.find(a => a.id === annEl.dataset.annId);
                        if (ann) {
                            preDragSnapshot = snapshotState();
                            state.draggingAnnotation = { conn, ann, startPos: ann.position };
                            selectAnnotation(conn.id, ann.id);
                            return;
                        }
                    }
                }
            }

            const deviceEl = e.target.closest('.device-node');
            const imageEl = !deviceEl ? e.target.closest('.image-node') : null;
            const textboxEl = !deviceEl && !imageEl ? e.target.closest('.textbox-node') : null;
            const zoneEl = !deviceEl && !imageEl && !textboxEl ? e.target.closest('.zone-node') : null;

            // Alt + drag starting on a ZONE forces a marquee - rubber-band the
            // child zones and their contents without the parent under the cursor
            // hijacking the drag. Scoped to zones so Alt+drag on a device still
            // does its existing fine-move / bypass-guides thing (Alt is read
            // per-frame during the drag, so a device drag is untouched).
            if (e.altKey && zoneEl) {
                selectDevice(null); selectConnection(null); selectZone(null);
                selectTextBox(null); selectImage(null);
                clearMultiSelect();
                state.marquee = { startX: point.x, startY: point.y };
                e.preventDefault();
                return;
            }

            // Groups: clicking any member selects the whole group so it drags as
            // a unit (Shift adds the group to the current selection). Ctrl+click
            // drills into the single member instead ("subselect").
            const clickedNodeId = (deviceEl && deviceEl.id) || (imageEl && imageEl.id) ||
                (textboxEl && textboxEl.id) || (zoneEl && zoneEl.id) || null;
            const clickedGroup = clickedNodeId ? findGroupFor(clickedNodeId) : null;
            if (clickedGroup) {
                if (e.ctrlKey || e.metaKey) {
                    preDragSnapshot = snapshotState();
                    clearMultiSelect();
                    if (deviceEl) {
                        const d = state.devices.find(x => x.id === clickedNodeId);
                        selectDevice(d.id);
                        state.dragging = { device: d, offsetX: point.x - d.x, offsetY: point.y - d.y };
                    } else if (imageEl) {
                        const im = state.images.find(x => x.id === clickedNodeId);
                        selectImage(im.id);
                        state.dragging = { image: im, offsetX: point.x - im.x, offsetY: point.y - im.y };
                    } else if (textboxEl) {
                        const tb = state.textBoxes.find(x => x.id === clickedNodeId);
                        selectDevice(null); selectZone(null);
                        selectTextBox(tb.id);
                        state.dragging = { textBox: tb, offsetX: point.x - tb.x, offsetY: point.y - tb.y };
                    } else if (zoneEl) {
                        const z = state.zones.find(x => x.id === clickedNodeId);
                        selectDevice(null);
                        selectZone(z.id);
                        state.dragging = { zone: z, offsetX: point.x - z.x, offsetY: point.y - z.y };
                    }
                    return;
                }
                selectGroupMembers(clickedGroup, e.shiftKey);
                // Fall through: the member is now in the multi-selection, so the
                // standard multi-drag entry below picks the drag up.
            }

            // If clicking on something that's already in the multi-selection, start multi-drag
            if (hasMultiSelection()) {
                const clickedDeviceId = deviceEl ? deviceEl.id : null;
                const clickedZoneId = zoneEl ? zoneEl.id : null;
                const clickedTextBoxId = textboxEl ? textboxEl.id : null;
                const clickedImageId = imageEl ? imageEl.id : null;
                const inSelection = (clickedDeviceId && state.selectedDevices.includes(clickedDeviceId)) ||
                                    (clickedZoneId && state.selectedZones.includes(clickedZoneId)) ||
                                    (clickedTextBoxId && state.selectedTextBoxes.includes(clickedTextBoxId)) ||
                                    (clickedImageId && state.selectedImages.includes(clickedImageId));
                // A plain click on an already-selected item starts a multi-drag.
                // A Ctrl/Shift click means "modify the selection" - let it fall
                // through to the per-object toggle/add logic (otherwise you can
                // never Ctrl-click to REMOVE an item that's already selected).
                if (inSelection && !(e.ctrlKey || e.metaKey || e.shiftKey)) {
                    // Build snapshot of original positions for multi-drag
                    const origins = {};
                    state.selectedDevices.forEach(id => {
                        const d = state.devices.find(dd => dd.id === id);
                        if (d) origins[id] = { x: d.x, y: d.y };
                    });
                    state.selectedZones.forEach(id => {
                        const z = state.zones.find(zz => zz.id === id);
                        if (z) origins[id] = { x: z.x, y: z.y };
                    });
                    state.selectedTextBoxes.forEach(id => {
                        const tb = state.textBoxes.find(t => t.id === id);
                        if (tb) origins[id] = { x: tb.x, y: tb.y };
                    });
                    state.selectedImages.forEach(id => {
                        const img = state.images.find(i => i.id === id);
                        if (img) origins[id] = { x: img.x, y: img.y };
                    });
                    // Manual bends are stored as absolute coordinates; when both
                    // endpoints move together the bends must translate too
                    const movedIds = new Set([...state.selectedDevices, ...state.selectedZones]);
                    // A selected connection with a free-floating end carries its
                    // own coordinates - nothing else moves them - so snapshot
                    // those endpoints alongside the node origins. Only when the
                    // WHOLE connection travels though: a free end is carried, a
                    // device end only if that device is moving too. Otherwise
                    // Ctrl-clicking a mixed connection elsewhere on the canvas
                    // and dragging an unrelated cluster would drag its free end
                    // away from its own device, silently reshaping it.
                    const endTravels = (devId, pt) => !!pt || movedIds.has(devId);
                    const freeConnSel = new Set();
                    state.selectedConnections.forEach(id => {
                        const c = state.connections.find(cc => cc.id === id);
                        if (!c || (!c.fromPoint && !c.toPoint)) return;
                        if (!endTravels(c.fromDevice, c.fromPoint) ||
                            !endTravels(c.toDevice, c.toPoint)) return;
                        freeConnSel.add(c.id);
                        origins['conn:' + c.id] = {
                            from: c.fromPoint ? { x: c.fromPoint.x, y: c.fromPoint.y } : null,
                            to: c.toPoint ? { x: c.toPoint.x, y: c.toPoint.y } : null
                        };
                    });
                    const bendShifts = captureBendShifts(conn =>
                        movedIds.has(conn.fromDevice) && movedIds.has(conn.toDevice));
                    // Manual waypoints are absolute too - translate them when
                    // both endpoints move together, like bends (or when the
                    // connection is a selected free-floating one, which moves
                    // as a whole).
                    const waypointShifts = [];
                    state.connections.forEach(conn => {
                        if (!conn.waypoints || !conn.waypoints.length) return;
                        const bothNodesMove = movedIds.has(conn.fromDevice) && movedIds.has(conn.toDevice);
                        if (!bothNodesMove && !freeConnSel.has(conn.id)) return;
                        waypointShifts.push({ conn, orig: conn.waypoints.map(w => ({ x: w.x, y: w.y })) });
                    });
                    preDragSnapshot = snapshotState();
                    state.dragging = { multi: true, startX: point.x, startY: point.y, origins, bendShifts, waypointShifts };
                    return;
                }
            }

            if (deviceEl) {
                const device = state.devices.find(d => d.id === deviceEl.id);
                if (device) {
                    preDragSnapshot = snapshotState();
                    if (e.ctrlKey || e.metaKey) {
                        if (state.selectedDevice && !state.selectedDevices.includes(state.selectedDevice)) {
                            state.selectedDevices.push(state.selectedDevice);
                        }
                        selectConnection(null);
                        selectDevice(null);
                        selectZone(null);
                        const idx = state.selectedDevices.indexOf(device.id);
                        if (idx >= 0) {
                            state.selectedDevices.splice(idx, 1);
                        } else {
                            state.selectedDevices.push(device.id);
                        }
                        renderAllDevices();
                        renderAllZones();
                        refreshBatchPanel();
                    } else if (e.shiftKey) {
                        if (state.selectedDevice && !state.selectedDevices.includes(state.selectedDevice)) {
                            state.selectedDevices.push(state.selectedDevice);
                        }
                        selectConnection(null);
                        selectDevice(null);
                        selectZone(null);
                        if (!state.selectedDevices.includes(device.id)) {
                            state.selectedDevices.push(device.id);
                        }
                        renderAllDevices();
                        renderAllZones();
                        refreshBatchPanel();
                    } else {
                        clearMultiSelect();
                        selectZone(null);
                        selectDevice(device.id);
                        state.dragging = {
                            device: device,
                            offsetX: point.x - device.x,
                            offsetY: point.y - device.y
                        };
                    }
                }
            } else if (imageEl) {
                const img = state.images.find(i => i.id === imageEl.id);
                if (img) {
                    preDragSnapshot = snapshotState();
                    if (e.ctrlKey || e.metaKey || e.shiftKey) {
                        if (state.selectedImage && !state.selectedImages.includes(state.selectedImage)) {
                            state.selectedImages.push(state.selectedImage);
                        }
                        selectConnection(null); selectDevice(null); selectZone(null); selectTextBox(null); selectImage(null);
                        const idx = state.selectedImages.indexOf(img.id);
                        if (e.shiftKey && !(e.ctrlKey || e.metaKey)) {
                            if (idx < 0) state.selectedImages.push(img.id);
                        } else if (idx >= 0) {
                            state.selectedImages.splice(idx, 1);
                        } else {
                            state.selectedImages.push(img.id);
                        }
                        renderAllImages();
                        refreshBatchPanel();
                    } else {
                        clearMultiSelect();
                        selectImage(img.id);
                        state.dragging = {
                            image: img,
                            offsetX: point.x - img.x,
                            offsetY: point.y - img.y
                        };
                    }
                }
            } else if (textboxEl) {
                const tb = state.textBoxes.find(t => t.id === textboxEl.id);
                if (tb) {
                    preDragSnapshot = snapshotState();
                    if (e.ctrlKey || e.metaKey || e.shiftKey) {
                        if (state.selectedTextBox && !state.selectedTextBoxes.includes(state.selectedTextBox)) {
                            state.selectedTextBoxes.push(state.selectedTextBox);
                        }
                        selectConnection(null); selectDevice(null); selectZone(null); selectTextBox(null); selectImage(null);
                        const idx = state.selectedTextBoxes.indexOf(tb.id);
                        if (e.shiftKey && !(e.ctrlKey || e.metaKey)) {
                            if (idx < 0) state.selectedTextBoxes.push(tb.id);
                        } else if (idx >= 0) {
                            state.selectedTextBoxes.splice(idx, 1);
                        } else {
                            state.selectedTextBoxes.push(tb.id);
                        }
                        renderAllDevices();   // text boxes render alongside devices
                        refreshBatchPanel();
                    } else {
                        clearMultiSelect();
                        selectDevice(null);
                        selectZone(null);
                        selectTextBox(tb.id);
                        state.dragging = {
                            textBox: tb,
                            offsetX: point.x - tb.x,
                            offsetY: point.y - tb.y
                        };
                    }
                }
            } else if (zoneEl) {
                const zone = state.zones.find(z => z.id === zoneEl.id);
                if (zone) {
                    preDragSnapshot = snapshotState();
                    if (e.ctrlKey || e.metaKey) {
                        if (state.selectedZone && !state.selectedZones.includes(state.selectedZone)) {
                            state.selectedZones.push(state.selectedZone);
                        }
                        selectConnection(null);
                        selectDevice(null);
                        selectZone(null);
                        const idx = state.selectedZones.indexOf(zone.id);
                        if (idx >= 0) {
                            state.selectedZones.splice(idx, 1);
                        } else {
                            state.selectedZones.push(zone.id);
                        }
                        renderAllDevices();
                        renderAllZones();
                        refreshBatchPanel();
                    } else if (e.shiftKey) {
                        if (state.selectedZone && !state.selectedZones.includes(state.selectedZone)) {
                            state.selectedZones.push(state.selectedZone);
                        }
                        selectConnection(null);
                        selectDevice(null);
                        selectZone(null);
                        if (!state.selectedZones.includes(zone.id)) {
                            state.selectedZones.push(zone.id);
                        }
                        renderAllDevices();
                        renderAllZones();
                        refreshBatchPanel();
                    } else {
                        clearMultiSelect();
                        selectDevice(null);
                        selectZone(zone.id);
                        state.dragging = {
                            zone: zone,
                            offsetX: point.x - zone.x,
                            offsetY: point.y - zone.y
                        };
                    }
                }
            } else {
                const connEl = e.target.closest('.connection-line');
                if (connEl) {
                    const cid = connEl.dataset.connId;
                    if (e.ctrlKey || e.metaKey || e.shiftKey) {
                        if (state.selectedConnection && !state.selectedConnections.includes(state.selectedConnection)) {
                            state.selectedConnections.push(state.selectedConnection);
                        }
                        selectConnection(null); selectDevice(null); selectZone(null); selectTextBox(null); selectImage(null);
                        const idx = state.selectedConnections.indexOf(cid);
                        if (e.shiftKey && !(e.ctrlKey || e.metaKey)) {
                            if (idx < 0) state.selectedConnections.push(cid);
                        } else if (idx >= 0) {
                            state.selectedConnections.splice(idx, 1);
                        } else {
                            state.selectedConnections.push(cid);
                        }
                        renderAllConnections();
                        refreshBatchPanel();
                    } else {
                        clearMultiSelect();
                        selectZone(null);
                        selectConnection(cid);
                    }
                } else {
                    selectDevice(null);
                    selectConnection(null);
                    selectZone(null);
                    selectImage(null);
                    clearMultiSelect();
                    state.marquee = { startX: point.x, startY: point.y };
                }
            }
        } else if (state.tool === 'connect') {
            const apEl = e.target.closest('.attachment-point');
            if (apEl) {
                const deviceId = apEl.dataset.deviceId;
                const apIndex = parseInt(apEl.dataset.apIndex);
                state.connecting = { fromDevice: deviceId, fromAP: apIndex };
                return;
            }

            // DRAGGING from a device/zone BODY starts a connection from its
            // nearest AP (no need to land on the small AP dots - the drop end
            // already snaps the same way). A plain CLICK keeps the old behavior:
            // exit to select mode with the node selected. Disambiguated on
            // mouseup by pointer travel (viaBody + downX/downY).
            const deviceEl = e.target.closest('.device-node');
            const zoneEl = !deviceEl ? e.target.closest('.zone-node') : null;
            if (deviceEl) {
                const dev = state.devices.find(d => d.id === deviceEl.id);
                if (dev) state.connecting = { fromDevice: dev.id, fromAP: nearestAPIndex(dev, point.x, point.y),
                                              viaBody: true, downX: e.clientX, downY: e.clientY };
                return;
            } else if (zoneEl) {
                const zone = state.zones.find(z => z.id === zoneEl.id);
                if (zone) state.connecting = { fromDevice: zone.id, fromAP: nearestAPIndex(zone, point.x, point.y),
                                               viaBody: true, downX: e.clientX, downY: e.clientY };
                return;
            } else {
                const connEl = e.target.closest('.connection-line') || e.target.closest('.connection-label') || e.target.closest('.connection-label-bg');
                if (connEl) {
                    const connId = connEl.dataset.connId || connEl.closest('g')?.id;
                    if (connId) {
                        setTool('select');
                        clearMultiSelect();
                        selectZone(null);
                        selectConnection(connId);
                    }
                } else {
                    // Empty canvas in connect mode: begin a free-floating connection.
                    // A plain click (no drag) is treated as "exit to select" on mouseup.
                    const fs = snapStepFor(e);
                    state.connecting = { fromPoint: { x: snapToGrid(point.x, fs), y: snapToGrid(point.y, fs) }, startedEmpty: true };
                }
            }
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        if (state.panning) {
            const container = document.getElementById('canvas-container');
            container.scrollLeft = state.panning.scrollLeft - (e.clientX - state.panning.startX);
            container.scrollTop = state.panning.scrollTop - (e.clientY - state.panning.startY);
            return;
        }
        const point = getSVGPoint(e);
        // Hold Alt while dragging/resizing any object to snap at half-grid (5px)
        const fineStep = snapStepFor(e);

        if (state.draggingWaypoint) {
            const dw = state.draggingWaypoint;
            dw.conn.waypoints[dw.idx] = {
                x: snapToGrid(point.x, fineStep),
                y: snapToGrid(point.y, fineStep)
            };
            renderConnection(dw.conn);
        }

        if (state.draggingBend) {
            const { conn, segIndex, isVertical, naturalVal } = state.draggingBend;
            const raw = isVertical ? point.x : point.y;
            // Snap relative to the natural rail so whole-step offsets from it
            // (including zero - back to natural) are reachable; see mousedown.
            const newVal = naturalVal != null
                ? naturalVal + snapToGrid(raw - naturalVal, fineStep)
                : snapToGrid(raw, fineStep);
            if (!conn.bends) conn.bends = {};
            conn.bends[segIndex] = newVal;
            renderConnection(conn);
            return;
        }

        if (state.resizingImage) {
            const ri = state.resizingImage;
            const dx = point.x - ri.startX;
            const dy = point.y - ri.startY;
            const delta = Math.max(dx, dy);
            const newW = Math.max(GRID_SIZE * 2, snapToGrid(ri.origW + delta, fineStep));
            const iw0 = ri.image.w, ih0 = ri.image.h;
            ri.image.w = newW;
            ri.image.h = Math.max(GRID_SIZE * 2, snapToGrid(newW / ri.aspect, fineStep));
            if (ri.image.attachmentPoints) redistributeAPs(ri.image, iw0, ih0);
            renderImage(ri.image);
            rerouteConnectionsForDevice(ri.image.id);
        }

        if (state.resizingZone) {
            const rz = state.resizingZone;
            const dx = point.x - rz.startX;
            const dy = point.y - rz.startY;
            const zg = fineStep;
            const minSize = GRID_SIZE; // allow smaller, finer zones
            const axis = rz.axis;
            const zw0 = rz.zone.w, zh0 = rz.zone.h;
            // Shift at the corner = proportional (same rule as devices)
            if (axis === 'both' && e.shiftKey) {
                const s = Math.abs(dx) >= Math.abs(dy)
                    ? (rz.origW + dx) / rz.origW
                    : (rz.origH + dy) / rz.origH;
                let w = Math.max(minSize, snapToGrid(rz.origW * s, zg));
                let h = Math.round(w * rz.origH / rz.origW);
                if (h < minSize) { h = minSize; w = Math.max(minSize, Math.round(h * rz.origW / rz.origH)); }
                rz.zone.w = w;
                rz.zone.h = h;
            }
            // Right / bottom-right: grow width rightward
            if (axis === 'r' || (axis === 'both' && !e.shiftKey)) {
                rz.zone.w = Math.max(minSize, snapToGrid(rz.origW + dx, zg));
            }
            // Bottom / bottom-right: grow height downward
            if (axis === 'b' || (axis === 'both' && !e.shiftKey)) {
                rz.zone.h = Math.max(minSize, snapToGrid(rz.origH + dy, zg));
            }
            // Left / top edges: snap the MOVING edge and derive the size from
            // the FIXED opposite edge, so it never drifts (snapping origin and
            // size independently jumped the fixed edge a grid at half-steps).
            if (axis === 'l') {
                const right = rz.origX + rz.origW;
                const newX = snapToGrid(rz.origX + dx, zg);
                if (right - newX >= minSize) {
                    rz.zone.x = newX;
                    rz.zone.w = right - newX;
                }
            }
            if (axis === 't') {
                const bottom = rz.origY + rz.origH;
                const newY = snapToGrid(rz.origY + dy, zg);
                if (bottom - newY >= minSize) {
                    rz.zone.y = newY;
                    rz.zone.h = bottom - newY;
                }
            }
            if (rz.zone.attachmentPoints) {
                redistributeAPs(rz.zone, zw0, zh0);
            }
            renderZone(rz.zone);
            rerouteConnectionsForDevice(rz.zone.id);
        }

        if (state.draggingEndpoint) {
            const de = state.draggingEndpoint;
            const fixed = resolveConnEndpoint(de.conn, de.end === 'from' ? 'to' : 'from');
            if (fixed) {
                let tempLine = document.getElementById('temp-endpoint-drag');
                if (!tempLine) {
                    tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    tempLine.id = 'temp-endpoint-drag';
                    tempLine.classList.add('temp-line');
                    overlayLayer.appendChild(tempLine);
                }
                tempLine.setAttribute('x1', fixed.x);
                tempLine.setAttribute('y1', fixed.y);
                tempLine.setAttribute('x2', point.x);
                tempLine.setAttribute('y2', point.y);
            }
            return;
        }

        if (state.draggingAnnotation) {
            const da = state.draggingAnnotation;
            const start = resolveConnEndpoint(da.conn, 'from');
            const end = resolveConnEndpoint(da.conn, 'to');
            if (start && end) {
                const cPoints = connRoutePoints(da.conn, start, end);
                const nearest = getNearestT(cPoints, point.x, point.y);
                da.ann.position = Math.max(0.01, Math.min(0.99, nearest.t));
                renderConnection(da.conn);
            }
        }

        if (state.resizingDevice) {
            // Zone-style free resize: each axis independent, so devices can be
            // non-square (imported Gliffy footprints stay editable; the
            // app-drawn frame stretches with them)
            const rd = state.resizingDevice;
            const dx = point.x - rd.startX;
            const dy = point.y - rd.startY;
            const minSize = GRID_SIZE * 2;
            const axis = rd.axis;
            const dw0 = rd.device.w, dh0 = rd.device.h;
            if (axis === 'both' && e.shiftKey) {
                // Shift = proportional: the dominant drag axis drives one
                // scale factor and the other dimension follows the ORIGINAL
                // W:H, so squares stay square through the fine grid. Only W
                // snaps; H derives exactly (snapping both would drift the
                // ratio a pixel per step).
                const s = Math.abs(dx) >= Math.abs(dy)
                    ? (rd.origW + dx) / rd.origW
                    : (rd.origH + dy) / rd.origH;
                let w = Math.max(minSize, snapToGrid(rd.origW * s, fineStep));
                let h = Math.round(w * rd.origH / rd.origW);
                if (h < minSize) { h = minSize; w = Math.max(minSize, Math.round(h * rd.origW / rd.origH)); }
                rd.device.w = w;
                rd.device.h = h;
            }
            if (axis === 'r' || (axis === 'both' && !e.shiftKey)) {
                rd.device.w = Math.max(minSize, snapToGrid(rd.origW + dx, fineStep));
            }
            if (axis === 'b' || (axis === 'both' && !e.shiftKey)) {
                rd.device.h = Math.max(minSize, snapToGrid(rd.origH + dy, fineStep));
            }
            // Left/top edges: snap the MOVING edge, then derive the dimension
            // from the FIXED (opposite) edge - snapping both position and size
            // independently made the fixed edge jump a whole grid at half-grid
            // points (the upward-resize stutter where the bottom crept).
            if (axis === 'l') {
                const right = rd.origX + rd.origW;   // fixed edge stays put
                const newX = snapToGrid(rd.origX + dx, fineStep);
                if (right - newX >= minSize) {
                    rd.device.x = newX;
                    rd.device.w = right - newX;
                }
            }
            if (axis === 't') {
                const bottom = rd.origY + rd.origH;   // fixed edge stays put
                const newY = snapToGrid(rd.origY + dy, fineStep);
                if (bottom - newY >= minSize) {
                    rd.device.y = newY;
                    rd.device.h = bottom - newY;
                }
            }
            redistributeAPs(rd.device, dw0, dh0);
            renderDevice(rd.device);
            state.connections
                .filter(c => c.fromDevice === rd.device.id || c.toDevice === rd.device.id)
                .forEach(renderConnection);
            document.getElementById('device-w-input').value = rd.device.w;
            document.getElementById('device-h-input').value = rd.device.h;
        }

        if (state.dragging) {
            if (state.dragging.multi) {
                // Snap the movement DELTA once, then apply that same offset to
                // every selected object. Snapping each object's absolute
                // position instead (the old way) rounded any half-grid item to
                // the full grid and let items with different sub-grid offsets
                // land on different grids - so relative spacing distorted as
                // you dragged (the "caterpillar") and half-grid bends/handles
                // were lost on drop. A snapped delta preserves every offset.
                const dx = snapToGrid(point.x - state.dragging.startX, fineStep);
                const dy = snapToGrid(point.y - state.dragging.startY, fineStep);
                const affectedIds = new Set();
                state.selectedDevices.forEach(id => {
                    const d = state.devices.find(dd => dd.id === id);
                    if (d && state.dragging.origins[id]) {
                        d.x = state.dragging.origins[id].x + dx;
                        d.y = state.dragging.origins[id].y + dy;
                        affectedIds.add(id);
                        moveNodeElement(d);
                    }
                });
                state.selectedZones.forEach(id => {
                    const z = state.zones.find(zz => zz.id === id);
                    if (z && state.dragging.origins[id]) {
                        z.x = state.dragging.origins[id].x + dx;
                        z.y = state.dragging.origins[id].y + dy;
                        affectedIds.add(id);
                        moveNodeElement(z);
                    }
                });
                state.selectedTextBoxes.forEach(id => {
                    const tb = state.textBoxes.find(t => t.id === id);
                    if (tb && state.dragging.origins[id]) {
                        tb.x = state.dragging.origins[id].x + dx;
                        tb.y = state.dragging.origins[id].y + dy;
                        renderTextBox(tb);
                    }
                });
                state.selectedImages.forEach(id => {
                    const img = state.images.find(i => i.id === id);
                    if (img && state.dragging.origins[id]) {
                        img.x = state.dragging.origins[id].x + dx;
                        img.y = state.dragging.origins[id].y + dy;
                        affectedIds.add(id);
                        moveNodeElement(img);
                    }
                });
                // Free-floating endpoints move with the same snapped delta -
                // nothing else carries them, since they are anchored to no node.
                const freeMoved = [];
                state.selectedConnections.forEach(id => {
                    const o = state.dragging.origins['conn:' + id];
                    if (!o) return;
                    const c = state.connections.find(cc => cc.id === id);
                    if (!c) return;
                    if (o.from && c.fromPoint) { c.fromPoint.x = o.from.x + dx; c.fromPoint.y = o.from.y + dy; }
                    if (o.to && c.toPoint) { c.toPoint.x = o.to.x + dx; c.toPoint.y = o.to.y + dy; }
                    freeMoved.push(c);
                });
                // Delta already snapped - shift bends/waypoints by it raw, so
                // their sub-grid positions ride along untouched.
                applyBendShifts(state.dragging.bendShifts || [], dx, dy, null);
                (state.dragging.waypointShifts || []).forEach(ws => {
                    ws.conn.waypoints = ws.orig.map(w => ({ x: w.x + dx, y: w.y + dy }));
                });
                const rendered = new Set();
                state.connections
                    .filter(c => affectedIds.has(c.fromDevice) || affectedIds.has(c.toDevice))
                    .forEach(c => { rendered.add(c.id); renderConnection(c); });
                freeMoved.forEach(c => { if (!rendered.has(c.id)) renderConnection(c); });
                updateGroupOutlines();   // keep group outlines tracking the drag
            } else if (state.dragging.zone) {
                const zone = state.dragging.zone;
                const zp = guideAdjust(e, zone.id,
                    snapToGrid(point.x - state.dragging.offsetX, fineStep),
                    snapToGrid(point.y - state.dragging.offsetY, fineStep), zone.w, zone.h);
                zone.x = zp.x;
                zone.y = zp.y;
                moveNodeElement(zone);
                rerouteConnectionsForDevice(zone.id);
            } else if (state.dragging.device) {
                const device = state.dragging.device;
                const dp = guideAdjust(e, device.id,
                    snapToGrid(point.x - state.dragging.offsetX, fineStep),
                    snapToGrid(point.y - state.dragging.offsetY, fineStep), device.w, device.h);
                device.x = dp.x;
                device.y = dp.y;
                moveNodeElement(device);
                state.connections
                    .filter(c => c.fromDevice === device.id || c.toDevice === device.id)
                    .forEach(renderConnection);
            } else if (state.dragging.image) {
                const img = state.dragging.image;
                const ip = guideAdjust(e, img.id,
                    snapToGrid(point.x - state.dragging.offsetX, fineStep),
                    snapToGrid(point.y - state.dragging.offsetY, fineStep), img.w, img.h);
                img.x = ip.x;
                img.y = ip.y;
                moveNodeElement(img);
                rerouteConnectionsForDevice(img.id);
            } else if (state.dragging.textBox) {
                const tb = state.dragging.textBox;
                // Real rendered size, not a guess - guides centered a fictional
                // 120x40 box, which put long text visibly off-center on snap.
                const tr = textBoxRect(tb);
                const tp = guideAdjust(e, tb.id,
                    snapToGrid(point.x - state.dragging.offsetX, fineStep),
                    snapToGrid(point.y - state.dragging.offsetY, fineStep), tr.w, tr.h);
                tb.x = tp.x;
                tb.y = tp.y;
                renderTextBox(tb);
            }
        }

        if (state.marquee) {
            const mx = Math.min(state.marquee.startX, point.x);
            const my = Math.min(state.marquee.startY, point.y);
            const mw = Math.abs(point.x - state.marquee.startX);
            const mh = Math.abs(point.y - state.marquee.startY);

            let marqueeRect = document.getElementById('marquee-rect');
            if (!marqueeRect) {
                marqueeRect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                marqueeRect.id = 'marquee-rect';
                marqueeRect.classList.add('marquee-rect');
                overlayLayer.appendChild(marqueeRect);
            }
            marqueeRect.setAttribute('x', mx);
            marqueeRect.setAttribute('y', my);
            marqueeRect.setAttribute('width', mw);
            marqueeRect.setAttribute('height', mh);

            // Hidden/locked tiers are exempt from rubber-band selection - the
            // marquee tests geometry, not the DOM, so it would otherwise grab
            // invisible or locked objects.
            const selRect = { left: mx, top: my, right: mx + mw, bottom: my + mh };
            const deviceHits = (tierBlocked('devices') ? [] : state.devices).filter(d => {
                const dr = { left: d.x, top: d.y, right: d.x + d.w, bottom: d.y + d.h };
                return rectsOverlap(selRect, dr);
            }).map(d => d.id);
            const zoneHits = (tierBlocked('zones') ? [] : state.zones).filter(z => {
                const zr = { left: z.x, top: z.y, right: z.x + z.w, bottom: z.y + z.h };
                return rectsOverlap(selRect, zr);
            }).map(z => z.id);
            const imageHits = (tierBlocked('images') ? [] : state.images).filter(i => {
                const ir = { left: i.x, top: i.y, right: i.x + i.w, bottom: i.y + i.h };
                return rectsOverlap(selRect, ir);
            }).map(i => i.id);

            const textBoxHits = (tierBlocked('devices') ? [] : state.textBoxes).filter(tb => {
                const r = textBoxRect(tb);
                const tr = { left: tb.x, top: tb.y, right: tb.x + r.w, bottom: tb.y + r.h };
                return rectsOverlap(selRect, tr);
            }).map(tb => tb.id);

            // A marquee touching any group member selects the whole group, so
            // groups keep behaving as units under rubber-band selection.
            if (state.groups.length) {
                const hitSet = new Set([...deviceHits, ...zoneHits, ...imageHits, ...textBoxHits]);
                state.groups.forEach(g => {
                    if (!g.members.some(m => hitSet.has(m))) return;
                    g.members.forEach(m => {
                        if (hitSet.has(m)) return;
                        hitSet.add(m);
                        if (!tierBlocked('devices') && state.devices.some(d => d.id === m)) deviceHits.push(m);
                        else if (!tierBlocked('zones') && state.zones.some(z => z.id === m)) zoneHits.push(m);
                        else if (!tierBlocked('images') && state.images.some(i => i.id === m)) imageHits.push(m);
                        else if (!tierBlocked('devices') && state.textBoxes.some(t => t.id === m)) textBoxHits.push(m);
                    });
                });
            }

            // A connection is included when BOTH its ends are captured, so
            // dragging over a cluster grabs its internal links too. An end is
            // captured when its device is in the marquee, or - for a
            // free-floating end (fromPoint/toPoint, no device) - when the point
            // itself is inside the marquee. Free connections are first-class:
            // imports use them for route arrows and hand-drawn keys/legends, and
            // requiring a device at both ends made those unselectable, so they
            // silently stayed behind when a region was moved.
            const devSet = new Set(deviceHits);
            const endCaptured = (devId, pt) => devId
                ? devSet.has(devId)
                : !!pt && pt.x >= selRect.left && pt.x <= selRect.right &&
                          pt.y >= selRect.top && pt.y <= selRect.bottom;
            const connHits = (tierBlocked('connections') ? [] : state.connections).filter(c =>
                (c.fromDevice || c.fromPoint) && (c.toDevice || c.toPoint) &&
                endCaptured(c.fromDevice, c.fromPoint) && endCaptured(c.toDevice, c.toPoint)
            ).map(c => c.id);

            state.selectedDevices = deviceHits;
            state.selectedZones = zoneHits;
            state.selectedImages = imageHits;
            state.selectedTextBoxes = textBoxHits;
            state.selectedConnections = connHits;
            refreshMarqueeSelectionClasses();
        }

        if (state.connecting) {
            let tempLine = document.getElementById('temp-connection');
            if (!tempLine) {
                tempLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                tempLine.id = 'temp-connection';
                tempLine.classList.add('temp-line');
                overlayLayer.appendChild(tempLine);
            }
            const start = connectingStartPoint();
            if (start) {
                tempLine.setAttribute('x1', start.x);
                tempLine.setAttribute('y1', start.y);
                tempLine.setAttribute('x2', point.x);
                tempLine.setAttribute('y2', point.y);
            }
        }
    });

    // Listen on window, not the canvas, so a drag/connection always ends even
    // when the mouse is released over the Properties pane, sidebar, or off-window.
    window.addEventListener('mouseup', (e) => {
        if (state.panning) {
            state.panning = null;
            document.getElementById('canvas-container').classList.remove('panning');
            return;
        }
        const point = getSVGPoint(e);
        const fineStep = snapStepFor(e);
        if (state.draggingWaypoint) {
            commitPreDragUndo();
            state.draggingWaypoint = null;
            return;
        }

        if (state.draggingBend) {
            const { conn, segIndex, naturalVal } = state.draggingBend;
            // In fine mode (Alt) keep the bend exactly where placed; otherwise a
            // bend dropped back on its natural rail removes itself. Dragging
            // snaps relative to the rail, so the only non-Alt stop inside this
            // threshold is the natural position itself - deliberate one-step
            // offsets survive (endpoints can't move mid-drag, so the value
            // captured at mousedown is still current).
            if (!e.altKey && conn.bends && conn.bends[segIndex] !== undefined && naturalVal != null) {
                if (Math.abs(conn.bends[segIndex] - naturalVal) < GRID_SIZE / 2) {
                    delete conn.bends[segIndex];
                    if (Object.keys(conn.bends).length === 0) delete conn.bends;
                    renderConnection(conn);
                }
            }
            commitPreDragUndo();
            state.draggingBend = null;
            return;
        }
        if (state.draggingEndpoint) {
            const de = state.draggingEndpoint;
            const conn = de.conn;
            const apEl = e.target.closest('.attachment-point');
            // An AP dot under the cursor wins; otherwise a node body attaches
            // to its nearest AP (same behavior as drawing a new connection).
            let devId = null, apIdx = null;
            if (apEl) {
                devId = apEl.dataset.deviceId;
                apIdx = parseInt(apEl.dataset.apIndex);
            } else {
                const bodyNode = findNodeForPoint(point);
                if (bodyNode) {
                    devId = bodyNode.id;
                    apIdx = nearestAPIndex(bodyNode, point.x, point.y);
                }
            }
            if (devId != null) {
                const otherDevice = de.end === 'from' ? conn.toDevice : conn.fromDevice;
                const otherAP = de.end === 'from' ? conn.toAP : conn.fromAP;
                // Don't allow both endpoints on the same AP
                if (!(devId === otherDevice && apIdx === otherAP)) {
                    if (de.end === 'from') {
                        conn.fromDevice = devId; conn.fromAP = apIdx; conn.fromPoint = null;
                    } else {
                        conn.toDevice = devId; conn.toAP = apIdx; conn.toPoint = null;
                    }
                    delete conn.bends; // manual bends/waypoints were placed for the old geometry
                    delete conn.waypoints;
                    renderConnection(conn);
                }
            } else {
                // Dropped in empty space: detach this end into a free-floating point
                const p = { x: snapToGrid(point.x, fineStep), y: snapToGrid(point.y, fineStep) };
                if (de.end === 'from') {
                    conn.fromDevice = null; conn.fromAP = null; conn.fromPoint = p;
                } else {
                    conn.toDevice = null; conn.toAP = null; conn.toPoint = p;
                }
                delete conn.bends;
                delete conn.waypoints;
                renderConnection(conn);
            }
            const tempLine = document.getElementById('temp-endpoint-drag');
            if (tempLine) tempLine.remove();
            commitPreDragUndo();
            state.draggingEndpoint = null;
            return;
        }

        if (state.draggingAnnotation) {
            commitPreDragUndo();
            state.draggingAnnotation = null;
            return;
        }
        if (state.dragging || state.resizingZone || state.resizingDevice || state.resizingImage) {
            commitPreDragUndo();
        }
        if (state.dragging) {
            state.dragging = null;
            clearGuideLines();
            updateCanvasSize();
        }
        if (state.resizingZone) {
            state.resizingZone = null;
            updateCanvasSize();
        }
        if (state.resizingDevice) {
            state.resizingDevice = null;
            updateCanvasSize();
        }
        if (state.resizingImage) {
            state.resizingImage = null;
            updateCanvasSize();
        }

        if (state.marquee) {
            const marqueeRect = document.getElementById('marquee-rect');
            if (marqueeRect) marqueeRect.remove();
            state.marquee = null;
            refreshBatchPanel();
        }

        if (state.connecting) {
            const conn0 = state.connecting;

            // A body-started gesture that barely moved is a CLICK, not a drag:
            // fall back to the old connect-mode behavior - switch to select and
            // select the node - instead of drawing a zero-length connection.
            if (conn0.viaBody) {
                const moved = Math.hypot(e.clientX - conn0.downX, e.clientY - conn0.downY);
                if (moved < 5) {
                    const tl = document.getElementById('temp-connection');
                    if (tl) tl.remove();
                    state.connecting = null;
                    setTool('select');
                    clearMultiSelect();
                    const dev = state.devices.find(d => d.id === conn0.fromDevice);
                    if (dev) { selectZone(null); selectDevice(conn0.fromDevice); }
                    else { selectDevice(null); selectZone(conn0.fromDevice); }
                    return;
                }
            }

            const apEl = e.target.closest('.attachment-point');

            // Resolve the "to" end: an attachment point under the cursor, else a
            // node body (snap to its nearest AP, so drops don't have to land on
            // the small dots), else a free-floating point in empty space.
            let toDevice = null, toAP = null, toPoint = null;
            if (apEl) {
                toDevice = apEl.dataset.deviceId;
                toAP = parseInt(apEl.dataset.apIndex);
            } else {
                const bodyNode = findNodeForPoint(point);
                if (bodyNode) {
                    toDevice = bodyNode.id;
                    toAP = nearestAPIndex(bodyNode, point.x, point.y);
                } else {
                    toPoint = { x: snapToGrid(point.x, fineStep), y: snapToGrid(point.y, fineStep) };
                }
            }

            const startCoord = connectingStartPoint();
            const endCoord = toPoint || (toDevice ? getAbsoluteAP(findNode(toDevice), toAP) : null);

            let valid = !!(startCoord && endCoord);
            // Same attachment point on both ends isn't a connection
            if (valid && conn0.fromDevice && toDevice && conn0.fromDevice === toDevice && conn0.fromAP === toAP) valid = false;
            // A tiny free-ended drag (e.g. a plain click on empty canvas) is a cancel
            if (valid && (!conn0.fromDevice || !toDevice)) {
                if (Math.hypot(endCoord.x - startCoord.x, endCoord.y - startCoord.y) < GRID_SIZE) valid = false;
            }

            if (valid) {
                const conn = {
                    id: genId(),
                    fromDevice: conn0.fromDevice || null,
                    fromAP: conn0.fromDevice ? conn0.fromAP : null,
                    fromPoint: conn0.fromDevice ? null : conn0.fromPoint,
                    toDevice: toDevice,
                    toAP: toDevice ? toAP : null,
                    toPoint: toPoint,
                    color: document.getElementById('conn-color').value,
                    thickness: parseInt(document.getElementById('conn-thickness').value),
                    dash: document.getElementById('conn-dash').value,
                    routing: document.getElementById('conn-routing').value,
                    label: '',
                    labelPosition: 'top',
                    fontSize: DEFAULT_FONT_SIZE,
                    fontColor: DEFAULT_FONT_COLOR,
                    fontFamily: DEFAULT_FONT_FAMILY || undefined,
                    lineFormats: [],
                    spans: [],
                    startArrow: document.getElementById('conn-start-arrow').value,
                    endArrow: document.getElementById('conn-end-arrow').value,
                    arrowScale: parseFloat(document.getElementById('conn-arrow-scale').value) || 1,
                    annotations: []
                };
                pushUndo();
                ensureTierVisible('connections');
                state.connections.push(conn);
                selectDevice(null);
                selectZone(null);
                selectConnection(conn.id);
            } else if (conn0.startedEmpty) {
                // Plain click on empty canvas in connect mode: exit to select
                setTool('select');
            }

            const tempLine = document.getElementById('temp-connection');
            if (tempLine) tempLine.remove();
            state.connecting = null;
        }
    });

    function clearMultiSelect() {
        state.selectedDevices = [];
        state.selectedZones = [];
        state.selectedTextBoxes = [];
        state.selectedImages = [];
        state.selectedConnections = [];
        hideBatchPanel();
        renderAllDevices();
        renderAllZones();
        renderAllImages();
        renderAllConnections();
    }

    // --- Groups (persistent multi-selections) ---
    // A group is a set of node ids that select and move as a unit. Selecting a
    // group just populates the regular multi-selection arrays, so drag, align,
    // batch edit, copy and delete all work on groups with no extra code paths.
    function findGroupFor(objId) {
        return state.groups.find(g => g.members.includes(objId));
    }

    // Select every member of a group. With additive=true the group joins the
    // current multi-selection (Shift-click); otherwise it replaces it.
    function selectGroupMembers(group, additive) {
        if (additive) {
            // Fold any singular selection into the multi arrays first
            if (state.selectedDevice && !state.selectedDevices.includes(state.selectedDevice)) state.selectedDevices.push(state.selectedDevice);
            if (state.selectedZone && !state.selectedZones.includes(state.selectedZone)) state.selectedZones.push(state.selectedZone);
            if (state.selectedTextBox && !state.selectedTextBoxes.includes(state.selectedTextBox)) state.selectedTextBoxes.push(state.selectedTextBox);
            if (state.selectedImage && !state.selectedImages.includes(state.selectedImage)) state.selectedImages.push(state.selectedImage);
        } else {
            state.selectedDevices = [];
            state.selectedZones = [];
            state.selectedTextBoxes = [];
            state.selectedImages = [];
            state.selectedConnections = [];
        }
        state.selectedDevice = null;
        state.selectedZone = null;
        state.selectedTextBox = null;
        state.selectedImage = null;
        state.selectedConnection = null;
        clearAnnotationSelection();
        ['device-panel', 'zone-panel', 'textbox-panel', 'image-panel', 'connection-panel'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = 'none';
        });
        group.members.forEach(id => {
            if (state.devices.some(d => d.id === id)) { if (!state.selectedDevices.includes(id)) state.selectedDevices.push(id); }
            else if (state.zones.some(z => z.id === id)) { if (!state.selectedZones.includes(id)) state.selectedZones.push(id); }
            else if (state.textBoxes.some(t => t.id === id)) { if (!state.selectedTextBoxes.includes(id)) state.selectedTextBoxes.push(id); }
            else if (state.images.some(i => i.id === id)) { if (!state.selectedImages.includes(id)) state.selectedImages.push(id); }
        });
        renderAllDevices();
        renderAllZones();
        renderAllImages();
        renderAllConnections();
        refreshBatchPanel();
    }

    // Group the current multi-selection. An object belongs to at most one
    // group, so members are pulled out of any prior group first.
    function groupSelection() {
        const ids = [...state.selectedDevices, ...state.selectedZones, ...state.selectedTextBoxes, ...state.selectedImages];
        if (ids.length < 2) return;
        pushUndo();
        state.groups.forEach(g => { g.members = g.members.filter(m => !ids.includes(m)); });
        state.groups = state.groups.filter(g => g.members.length >= 2);
        state.groups.push({ id: genId(), members: ids.slice() });
        setDirty(true);
        renderAllDevices();   // refreshes the group outline
    }

    // Dissolve every group that has a member in the current selection.
    function ungroupSelection() {
        const ids = new Set([...state.selectedDevices, ...state.selectedZones, ...state.selectedTextBoxes, ...state.selectedImages]);
        if (state.selectedDevice) ids.add(state.selectedDevice);
        if (state.selectedZone) ids.add(state.selectedZone);
        if (state.selectedTextBox) ids.add(state.selectedTextBox);
        if (state.selectedImage) ids.add(state.selectedImage);
        const affected = state.groups.filter(g => g.members.some(m => ids.has(m)));
        if (!affected.length) return;
        pushUndo();
        state.groups = state.groups.filter(g => !affected.includes(g));
        setDirty(true);
        renderAllDevices();
    }

    // Drop members that no longer exist; a group needs at least two.
    function pruneGroups() {
        if (!state.groups.length) return;
        const exists = id => state.devices.some(d => d.id === id) || state.zones.some(z => z.id === id) ||
            state.textBoxes.some(t => t.id === id) || state.images.some(i => i.id === id);
        state.groups.forEach(g => { g.members = g.members.filter(exists); });
        state.groups = state.groups.filter(g => g.members.length >= 2);
    }

    // Dashed outline around each fully-selected group so it reads as a unit.
    function updateGroupOutlines() {
        document.querySelectorAll('.group-outline').forEach(el => el.remove());
        if (!state.groups.length) return;
        const selected = new Set([...state.selectedDevices, ...state.selectedZones, ...state.selectedTextBoxes, ...state.selectedImages]);
        state.groups.forEach(g => {
            if (!g.members.length || !g.members.every(m => selected.has(m))) return;
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            g.members.forEach(id => {
                let o = state.devices.find(d => d.id === id) || state.zones.find(z => z.id === id) || state.images.find(i => i.id === id);
                let w, h;
                if (o) { w = o.w; h = o.h; }
                else { o = state.textBoxes.find(t => t.id === id); if (!o) return; ({ w, h } = textBoxRect(o)); }
                minX = Math.min(minX, o.x); minY = Math.min(minY, o.y);
                maxX = Math.max(maxX, o.x + w); maxY = Math.max(maxY, o.y + h);
            });
            if (minX === Infinity) return;
            const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            r.setAttribute('x', minX - 6);
            r.setAttribute('y', minY - 6);
            r.setAttribute('width', maxX - minX + 12);
            r.setAttribute('height', maxY - minY + 12);
            r.setAttribute('rx', 4);
            r.classList.add('group-outline');
            overlayLayer.appendChild(r);
        });
    }

    // --- Selection ---
    function selectDevice(deviceId) {
        clearAnnotationSelection();
        if (deviceId) hideBatchPanel();
        state.selectedDevice = deviceId;
        state.selectedConnection = null;
        state.selectedTextBox = null;
        state.selectedImage = null;
        renderAllDevices();
        renderAllConnections();

        document.getElementById('connection-panel').style.display = state.tool === 'connect' ? 'block' : 'none';
        const panel = document.getElementById('device-panel');
        document.getElementById('zone-panel').style.display = 'none';
        document.getElementById('textbox-panel').style.display = 'none';
        document.getElementById('image-panel').style.display = 'none';
        if (deviceId) {
            const device = state.devices.find(d => d.id === deviceId);
            panel.style.display = 'block';
            const dlabel = document.getElementById('device-label');
            dlabel.innerHTML = spansToHTML(device.spans || [[{ text: device.label || '', bold: false, italic: false }]]);
            document.getElementById('device-label-position').value = device.labelPosition || 'bottom';
            setSegActive('device-halign-seg', effectiveLabelAlign(device));
            setSegActive('device-valign-seg', effectiveVAlign(device.labelPosition || 'bottom', device.labelVAlign));
            document.getElementById('device-font-family').value = device.fontFamily || '';
            document.getElementById('device-iconbg-color').value = device.iconBg || '#fffefe';
            document.getElementById('device-ap-count').textContent = device.attachmentPoints.length;
            document.getElementById('device-ap-slider').value = device.attachmentPoints.length;
            document.getElementById('device-w-input').value = device.w;
            document.getElementById('device-h-input').value = device.h;
            populateDeviceDetails(device);
            // Populate icon swap dropdown (optgroup per category, alphabetized
            // within - like the device list); a fresh selection clears any
            // leftover icon filter
            document.getElementById('device-template-filter').value = '';
            rebuildSwapSelect(document.getElementById('device-template-swap'),
                { selectedId: device.templateId });
            document.getElementById('device-font-size').value = device.fontSize || 20;
            document.getElementById('device-font-color').value = device.fontColor || '#333333';
            const tintSection = document.getElementById('device-tint-section');
            if (isSVGDataURL(device.originalImage || device.image)) {
                tintSection.style.display = '';
                // Show the color the device ACTUALLY renders in: an untinted
                // stencil (tintColor null - all imports, and Classic-placed
                // devices) draws in the stencil frame blue, not the default
                // tint pick, so the field matches the canvas.
                document.getElementById('device-tint-color').value = device.tintColor || STENCIL_FRAME_BLUE;
            } else {
                tintSection.style.display = 'none';
            }
        } else {
            panel.style.display = 'none';
        }
    }

    function selectConnection(connId) {
        clearAnnotationSelection();
        if (connId) hideBatchPanel();
        const prevConn = state.selectedConnection;
        state.selectedConnection = connId;
        state.selectedDevice = null;
        state.selectedTextBox = null;
        state.selectedImage = null;
        renderAllConnections();
        renderAllDevices();

        document.getElementById('device-panel').style.display = 'none';
        document.getElementById('textbox-panel').style.display = 'none';
        document.getElementById('zone-panel').style.display = 'none';
        document.getElementById('image-panel').style.display = 'none';
        const panel = document.getElementById('connection-panel');
        if (connId) {
            const conn = state.connections.find(c => c.id === connId);
            panel.style.display = 'block';
            document.getElementById('conn-color').value = conn.color;
            document.getElementById('conn-thickness').value = conn.thickness;
            document.getElementById('conn-dash').value = conn.dash;
            document.getElementById('conn-routing').value = conn.routing;
            const clabel = document.getElementById('conn-label');
            clabel.innerHTML = spansToHTML(conn.spans || [[{ text: conn.label || '', bold: false, italic: false }]]);
            document.getElementById('conn-label-position').value = conn.labelPosition || 'top';
            setSegActive('conn-halign-seg', effectiveLabelAlign(conn));
            setSegActive('conn-valign-seg', conn.labelVAlign || 'top');
            document.getElementById('conn-font-family').value = conn.fontFamily || '';
            document.getElementById('conn-font-size').value = conn.fontSize || 20;
            document.getElementById('conn-font-color').value = conn.fontColor || conn.color;
            document.getElementById('conn-start-arrow').value = conn.startArrow || 'none';
            document.getElementById('conn-end-arrow').value = conn.endArrow || 'none';
            document.getElementById('conn-arrow-scale').value = String(conn.arrowScale || 1);
        } else if (state.tool !== 'connect') {
            panel.style.display = 'none';
        }
        // On deselect, stop mirroring the connection we just left: new
        // connections read this input as "the color to use next", and a
        // stale mirror leaks the last clicked connection's color into
        // every one drawn afterwards. Only on a true selected->deselected
        // transition (a repeat deselect must not wipe a color picked
        // deliberately before drawing), and direct .value (no event) -
        // there is no selection to restyle.
        if (!connId && prevConn) document.getElementById('conn-color').value = DEFAULT_CONN_COLOR;
    }

    // --- Connection annotation selection ---
    function getSelectedAnnotation() {
        if (!state.selectedAnnotation) return null;
        const conn = state.connections.find(c => c.id === state.selectedAnnotation.connId);
        if (!conn || !conn.annotations) return null;
        const ann = conn.annotations.find(a => a.id === state.selectedAnnotation.annId);
        return ann ? { conn, ann } : null;
    }

    function clearAnnotationSelection() {
        state.selectedAnnotation = null;
        const p = document.getElementById('annotation-panel');
        if (p) p.style.display = 'none';
    }

    function selectAnnotation(connId, annId) {
        hideBatchPanel();
        state.selectedAnnotation = { connId, annId };
        state.selectedDevice = null;
        state.selectedZone = null;
        state.selectedConnection = null;
        state.selectedTextBox = null;
        state.selectedImage = null;
        state.selectedDevices = []; state.selectedZones = []; state.selectedTextBoxes = []; state.selectedImages = [];
        ['device-panel', 'zone-panel', 'textbox-panel', 'image-panel', 'connection-panel'].forEach(id => {
            document.getElementById(id).style.display = 'none';
        });
        const sel = getSelectedAnnotation();
        const panel = document.getElementById('annotation-panel');
        if (sel) {
            panel.style.display = 'block';
            document.getElementById('annotation-font-size').value = sel.ann.fontSize || DEFAULT_FONT_SIZE;
            document.getElementById('annotation-font-color').value = sel.ann.fontColor || sel.conn.fontColor || sel.conn.color || '#333333';
            setSegActive('annotation-halign-seg', sel.ann.align || 'center');
            document.getElementById('annotation-font-family').value = sel.ann.fontFamily || '';
        } else {
            panel.style.display = 'none';
        }
        renderAllConnections();
        renderAllDevices();
        renderAllZones();
        renderAllImages();
    }

    document.getElementById('annotation-font-size').addEventListener('change', (e) => {
        const sel = getSelectedAnnotation();
        if (!sel) return;
        pushUndo();
        sel.ann.fontSize = parseInt(e.target.value);
        renderConnection(sel.conn);
    });

    document.getElementById('annotation-font-color').addEventListener('input', (e) => {
        const sel = getSelectedAnnotation();
        if (!sel) return;
        pushUndoDebounced();
        sel.ann.fontColor = e.target.value;
        clearSpanColors(sel.ann);
        renderConnection(sel.conn);
    });

    wireAlignSeg('annotation-halign-seg', (val) => {
        const sel = getSelectedAnnotation();
        if (!sel) return;
        pushUndo();
        sel.ann.align = val;
        renderConnection(sel.conn);
        setSegActive('annotation-halign-seg', val);
    });

    document.getElementById('annotation-font-family').addEventListener('change', (e) => {
        const sel = getSelectedAnnotation();
        if (!sel) return;
        pushUndo();
        sel.ann.fontFamily = e.target.value || undefined;
        renderConnection(sel.conn);
    });

    document.getElementById('annotation-delete-btn').addEventListener('click', () => {
        const sel = getSelectedAnnotation();
        if (!sel) return;
        pushUndo();
        sel.conn.annotations = sel.conn.annotations.filter(a => a.id !== sel.ann.id);
        clearAnnotationSelection();
        renderConnection(sel.conn);
    });

    // --- Device Properties ---
    document.getElementById('device-label').addEventListener('input', (e) => {
        if (!state.selectedDevice) return;
        pushUndoDebounced();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        device.spans = htmlToSpans(e.target.innerHTML);
        device.label = getPlainText(device.spans);
        device.lineFormats = device.spans.map(ls => ({
            bold: ls.every(s => s.bold), italic: ls.every(s => s.italic)
        }));
        renderDevice(device);
    });
    // Default device size slider
    document.getElementById('default-device-size').addEventListener('input', (e) => {
        DEVICE_SIZE = parseInt(e.target.value);
        document.getElementById('default-size-label').textContent = DEVICE_SIZE + 'px';
    });
    // Default attachment-point count for newly placed devices
    document.getElementById('default-ap-count').addEventListener('input', (e) => {
        DEFAULT_AP_COUNT = parseInt(e.target.value);
        document.getElementById('default-ap-label').textContent = DEFAULT_AP_COUNT;
    });
    // Inventory-CSV import spacing (applies to the NEXT import)
    document.getElementById('import-hspace').addEventListener('input', (e) => {
        IMPORT_HSPACE = parseInt(e.target.value) / 100;
        document.getElementById('import-hspace-label').textContent = e.target.value + '%';
    });
    document.getElementById('import-vspace').addEventListener('input', (e) => {
        IMPORT_VSPACE = parseInt(e.target.value) / 100;
        document.getElementById('import-vspace-label').textContent = e.target.value + '%';
    });
    document.getElementById('import-sort').addEventListener('change', (e) => {
        IMPORT_SORT = e.target.value;
    });
    // Default font (family / size / color) for newly created objects -
    // imports keep their own conventions for fidelity with the source file.
    document.getElementById('default-font-family').addEventListener('change', (e) => {
        DEFAULT_FONT_FAMILY = e.target.value;
    });
    document.getElementById('default-font-size').addEventListener('change', (e) => {
        DEFAULT_FONT_SIZE = parseInt(e.target.value);
    });
    document.getElementById('default-font-color').addEventListener('input', (e) => {
        DEFAULT_FONT_COLOR = e.target.value;
    });
    // Default device tint (null = keep stencil colors) and zone fill
    // (null = classic blue pair; a custom fill derives its border by shading).
    // Both live-preview in the sidebar palette. The device-list re-render is
    // debounced: the native color picker streams input events while dragging,
    // and re-tinting every bundled stencil per sample would stutter.
    let tintPreviewTimer = null;
    document.getElementById('default-device-tint').addEventListener('input', (e) => {
        DEFAULT_DEVICE_TINT = e.target.value;
        // The UI accent (sliders, selection handles, attachment points, focus
        // outlines) tracks the Device Color so they fit the theme - via a theme
        // seeding this control, or a manual pick. Cleared on Reset → classic blue.
        document.documentElement.style.setProperty('--se-tint', e.target.value);
        clearTimeout(tintPreviewTimer);
        // Clear the cache NOW (O(1)) - paletteImageFor consumers (sample
        // builders, palette drops) must never see the previous tint; only
        // the expensive palette re-render is debounced.
        thumbTintCache.clear();
        tintPreviewTimer = setTimeout(() => {
            renderDeviceList();
        }, 120);
    });
    document.getElementById('default-device-tint-reset').addEventListener('click', () => {
        // Reset = back to the ACTIVE theme's seed; untinted stencil colors
        // only when the theme sets no tint (i.e. Classic).
        if (activeThemeSeed && activeThemeSeed.tint) {
            seedInput('default-device-tint', activeThemeSeed.tint);
            return;
        }
        DEFAULT_DEVICE_TINT = null;
        document.getElementById('default-device-tint').value = '#4a90d9';
        document.documentElement.style.removeProperty('--se-tint');   // back to the :root blue
        clearTimeout(tintPreviewTimer);
        thumbTintCache.clear();
        renderDeviceList();
    });
    document.getElementById('default-device-bg').addEventListener('input', (e) => {
        DEFAULT_ICON_BG = e.target.value;
        document.querySelectorAll('#device-list .device-thumb').forEach(t => { t.style.background = DEFAULT_ICON_BG; });
    });
    document.getElementById('default-device-bg-reset').addEventListener('click', () => {
        DEFAULT_ICON_BG = null;
        document.getElementById('default-device-bg').value = '#fffefe';
        document.querySelectorAll('#device-list .device-thumb').forEach(t => { t.style.background = ''; });
    });
    // While the border is on auto, its swatch tracks the effective color
    // (device blue, or the derivation from a custom fill)
    function syncZoneBorderSwatch() {
        if (!DEFAULT_ZONE_BORDER) {
            document.getElementById('default-zone-border').value = defaultZoneBorder();
        }
    }
    document.getElementById('default-zone-fill').addEventListener('input', (e) => {
        DEFAULT_ZONE_FILL = e.target.value;
        syncZoneBorderSwatch();
        refreshZoneThumbs();
    });
    document.getElementById('default-zone-fill-reset').addEventListener('click', () => {
        if (activeThemeSeed && activeThemeSeed.zoneFill) {
            seedInput('default-zone-fill', activeThemeSeed.zoneFill);
            return;
        }
        DEFAULT_ZONE_FILL = null;
        document.getElementById('default-zone-fill').value = '#e8f4fd';
        syncZoneBorderSwatch();
        refreshZoneThumbs();
    });
    document.getElementById('default-zone-border').addEventListener('input', (e) => {
        DEFAULT_ZONE_BORDER = e.target.value;
        refreshZoneThumbs();
    });
    document.getElementById('default-zone-border-reset').addEventListener('click', () => {
        if (activeThemeSeed && activeThemeSeed.zoneBorder) {
            seedInput('default-zone-border', activeThemeSeed.zoneBorder);
            return;
        }
        DEFAULT_ZONE_BORDER = null;
        syncZoneBorderSwatch();
        refreshZoneThumbs();
    });

    // --- Themes ---------------------------------------------------------
    // A theme is two coordinated layers: the top-chrome palette (CSS
    // variables - menu bar, toolbar, this picker) and a SEED for the color
    // defaults, applied through the same Default Settings controls the user
    // can reach by hand. Every per-control Reset restores the ACTIVE theme's
    // seed (classic values only under Classic), imports keep their source
    // colors, existing objects are never touched - only newly created
    // objects arrive themed. The
    // choice persists in localStorage; Classic clears everything. Chrome
    // themes are independent of dark mode (the chrome is dark by design;
    // dark mode governs the sidebar, panels and canvas).
    const THEME_VARS = ['--se-panel', '--se-panel-2', '--se-input', '--se-border',
                        '--se-txt', '--se-txt-dim', '--se-accent', '--se-active',
                        '--se-canvas-dark', '--se-grid-dark',
                        // Dark-mode surface overrides - every LIGHT-chrome theme
                        // (Canvas, Gesso, Parchment, Sage, Glacier) sets all
                        // six; dark-chrome themes' dark-mode rules fall
                        // back to their chrome palette. In THEME_VARS so a switch
                        // to a dark-chrome theme clears them.
                        '--se-dk-panel', '--se-dk-panel-2', '--se-dk-input',
                        '--se-dk-border', '--se-dk-txt', '--se-dk-txt-dim',
                        // Menu-bar mark port colors - the warm themes swap the
                        // brand blue/green for tan pairs from their own palette.
                        '--se-logo-a', '--se-logo-b'];
    const THEMES = {
        // Canvas - raw-canvas ecru with umber accents. Part of the material
        // family (Canvas/Blueprint/Ink/Gesso) inspired by the app's name -
        // warm paper, not the cool dark slate every tool defaults to.
        // Light chrome, so it carries --se-dk-* overrides like Glacier.
        canvas: {
            label: 'Canvas',
            chrome: { '--se-panel': '#ece5d3', '--se-panel-2': '#e0d7c0', '--se-input': '#f8f4e9',
                      '--se-border': '#c9bda0', '--se-txt': '#3d362a', '--se-txt-dim': '#83795f',
                      '--se-accent': '#8a5a2b', '--se-active': '#8a5a2b',
                      '--se-canvas-dark': '#181510', '--se-grid-dark': '#292418',
                      '--se-dk-panel': '#262218', '--se-dk-panel-2': '#302a1d',
                      '--se-dk-input': '#1b1811', '--se-dk-border': '#463e2b',
                      '--se-dk-txt': '#ece5d3', '--se-dk-txt-dim': '#aa9f83',
                      '--se-logo-a': '#c49b5f', '--se-logo-b': '#8f6a38' },
            canvas: { tint: '#8a5a2b', zoneFill: '#f2ecdb', zoneBorder: '#a08050', fontColor: '#463e2f' }
        },
        // Gesso - the painter's primer: warm-white minimal. The light-minimal
        // slot with a warm cast (Glacier keeps the cool-silver one). Light
        // chrome, so it carries --se-dk-* overrides.
        gesso: {
            label: 'Gesso',
            chrome: { '--se-panel': '#f4f1ea', '--se-panel-2': '#eae6db', '--se-input': '#fbf9f4',
                      '--se-border': '#d8d2c2', '--se-txt': '#45403a', '--se-txt-dim': '#948d7c',
                      '--se-accent': '#b07040', '--se-active': '#96603a',
                      '--se-canvas-dark': '#17150f', '--se-grid-dark': '#2b2820',
                      '--se-dk-panel': '#28251f', '--se-dk-panel-2': '#322e26',
                      '--se-dk-input': '#1c1a15', '--se-dk-border': '#474234',
                      '--se-dk-txt': '#efece4', '--se-dk-txt-dim': '#aba290',
                      '--se-logo-a': '#c9a06a', '--se-logo-b': '#96754a' },
            canvas: { tint: '#6d6459', zoneFill: '#f7f4ec', zoneBorder: '#b3ab9a', fontColor: '#4a453d' }
        },
        parchment: {
            label: 'Parchment',
            chrome: { '--se-panel': '#f0e9dc', '--se-panel-2': '#e6dcc9', '--se-input': '#fffdf8',
                      '--se-border': '#d8cbb2', '--se-txt': '#4a3f2f', '--se-txt-dim': '#7d6f58',
                      '--se-accent': '#b5732e', '--se-active': '#b5732e',
                      '--se-canvas-dark': '#211d16', '--se-grid-dark': '#322c22',
                      '--se-dk-panel': '#2a2620', '--se-dk-panel-2': '#342f27',
                      '--se-dk-input': '#1a1712', '--se-dk-border': '#453f34',
                      '--se-dk-txt': '#ece6da', '--se-dk-txt-dim': '#b3a891',
                      '--se-logo-a': '#c99e5e', '--se-logo-b': '#94703f' },
            canvas: { tint: '#9c6b30', zoneFill: '#f3ecde', zoneBorder: '#9c6b30', fontColor: '#4a3f2f' }
        },
        // Blueprint - cyanotype drafting paper: Prussian-blue chrome, pale-cyan
        // accents, seeds that make new diagrams read as engineering drawings.
        blueprint: {
            label: 'Blueprint',
            chrome: { '--se-panel': '#142c47', '--se-panel-2': '#1a3a5c', '--se-input': '#0e2136',
                      '--se-border': '#2a4d73', '--se-txt': '#dfe9f5', '--se-txt-dim': '#93aecb',
                      '--se-accent': '#7fd4ff', '--se-active': '#2e6da4',
                      '--se-canvas-dark': '#0a1929', '--se-grid-dark': '#173049',
                      '--se-logo-a': '#dcc296', '--se-logo-b': '#b3945f' },
            canvas: { tint: '#2e5f8f', zoneFill: '#e9f1f8', zoneBorder: '#2e5f8f', fontColor: '#25405c' }
        },
        // Ink - india-ink warm near-black, sepia accents: Parchment's dark
        // counterpart (a THEMED dark, independent of the dark-mode toggle).
        ink: {
            label: 'Ink',
            chrome: { '--se-panel': '#211d1a', '--se-panel-2': '#2a2521', '--se-input': '#161311',
                      '--se-border': '#3d362f', '--se-txt': '#ede7dc', '--se-txt-dim': '#a89e8f',
                      '--se-accent': '#c98f4e', '--se-active': '#96683a',
                      '--se-canvas-dark': '#131110', '--se-grid-dark': '#262220',
                      '--se-logo-a': '#d3a866', '--se-logo-b': '#9c7847' },
            canvas: { tint: '#5a4d3d', zoneFill: '#f1ece2', zoneBorder: '#6b5d4a', fontColor: '#3a332b' }
        },
        garnet: {
            label: 'Garnet',
            chrome: { '--se-panel': '#33141d', '--se-panel-2': '#401a25', '--se-input': '#240d14',
                      '--se-border': '#592433', '--se-txt': '#f2e6e9', '--se-txt-dim': '#c39aa5',
                      '--se-accent': '#d9556e', '--se-active': '#a52238',
                      '--se-canvas-dark': '#1c0a10', '--se-grid-dark': '#301522' },
            canvas: { tint: '#a52238', zoneFill: '#f7e9ec', zoneBorder: '#a52238', fontColor: '#5a2e37' }
        },
        ember: {
            label: 'Ember',
            chrome: { '--se-panel': '#1a1a1c', '--se-panel-2': '#242427', '--se-input': '#101012',
                      '--se-border': '#3a3a3e', '--se-txt': '#ecebe9', '--se-txt-dim': '#a09d99',
                      '--se-accent': '#ff8c1a', '--se-active': '#d97528',
                      '--se-canvas-dark': '#0e0e10', '--se-grid-dark': '#1f1f23' },
            canvas: { tint: '#d97528', zoneFill: '#fdf1e2', zoneBorder: '#c9762a', fontColor: '#43342a' }
        },
        crimsonNavy: {
            label: 'Crimson Navy',
            // crimson accent: blue channel kept above green so it reads red,
            // not orange (#e04848 had equal g/b and drifted warm)
            chrome: { '--se-panel': '#152a52', '--se-panel-2': '#1c3766', '--se-input': '#0e1d3a',
                      '--se-border': '#2a4576', '--se-txt': '#e8ecf5', '--se-txt-dim': '#9fadc9',
                      '--se-accent': '#dc2743', '--se-active': '#dc2743',
                      '--se-canvas-dark': '#0b172e', '--se-grid-dark': '#182c4e' },
            // device navy lifted from near-black #1e3a68 to a readable blue;
            // zone border split between the muted old red and the loud accent
            canvas: { tint: '#2f5aa0', zoneFill: '#e9eef8', zoneBorder: '#c62c48', fontColor: '#233a5c' }
        },
        rose: {
            label: 'Rose',
            chrome: { '--se-panel': '#2e2129', '--se-panel-2': '#3b2b35', '--se-input': '#211820',
                      '--se-border': '#4d3a45', '--se-txt': '#f2e8ee', '--se-txt-dim': '#c3a3b4',
                      '--se-accent': '#e08aa4', '--se-active': '#c25f7f',
                      '--se-canvas-dark': '#1c1419', '--se-grid-dark': '#33262e' },
            canvas: { tint: '#b05070', zoneFill: '#f9ecf1', zoneBorder: '#b05070', fontColor: '#5a3341' }
        },
        // Sage - calm pale-green LIGHT theme; dark mode goes green-charcoal.
        sage: {
            label: 'Sage',
            chrome: { '--se-panel': '#e4ebe1', '--se-panel-2': '#d6e0d1', '--se-input': '#fbfdfa',
                      '--se-border': '#c0cdba', '--se-txt': '#2f3a2e', '--se-txt-dim': '#5f6d5b',
                      '--se-accent': '#5b8c4f', '--se-active': '#4e7a44',
                      '--se-canvas-dark': '#161a14', '--se-grid-dark': '#262c23',
                      '--se-dk-panel': '#22271f', '--se-dk-panel-2': '#2b3127',
                      '--se-dk-input': '#161a14', '--se-dk-border': '#3b4235',
                      '--se-dk-txt': '#e7ede4', '--se-dk-txt-dim': '#9db096' },
            canvas: { tint: '#4f7a45', zoneFill: '#ecf2e8', zoneBorder: '#4f7a45', fontColor: '#2f3a2e' }
        },
        evergreen: {
            label: 'Evergreen',
            chrome: { '--se-panel': '#173726', '--se-panel-2': '#1f4a33', '--se-input': '#10281c',
                      '--se-border': '#2c5c40', '--se-txt': '#e7efe9', '--se-txt-dim': '#9db8a7',
                      '--se-accent': '#58b380', '--se-active': '#2d7a4f',
                      '--se-canvas-dark': '#0c2015', '--se-grid-dark': '#1a3626' },
            canvas: { tint: '#2d6a4a', zoneFill: '#e9f4ec', zoneBorder: '#2d6a4a', fontColor: '#26402f' }
        },
        lagoon: {
            label: 'Lagoon',
            chrome: { '--se-panel': '#0f3a38', '--se-panel-2': '#144a47', '--se-input': '#0a2827',
                      '--se-border': '#1f5c58', '--se-txt': '#e4efee', '--se-txt-dim': '#93b5b2',
                      '--se-accent': '#2dd4bf', '--se-active': '#0f766e',
                      '--se-canvas-dark': '#071f1e', '--se-grid-dark': '#123c39' },
            canvas: { tint: '#0f766e', zoneFill: '#e6f4f2', zoneBorder: '#0f766e', fontColor: '#164542' }
        },
        glacier: {
            label: 'Glacier',
            chrome: { '--se-panel': '#e9edf2', '--se-panel-2': '#dbe1ea', '--se-input': '#ffffff',
                      '--se-border': '#c3ccd8', '--se-txt': '#1f2a37', '--se-txt-dim': '#5c6672',
                      '--se-accent': '#2f6fd0', '--se-active': '#2f6fd0',
                      '--se-canvas-dark': '#1b1f27', '--se-grid-dark': '#2b303a',
                      '--se-dk-panel': '#23272e', '--se-dk-panel-2': '#2c313a',
                      '--se-dk-input': '#171a1f', '--se-dk-border': '#3a4048',
                      '--se-dk-txt': '#e6e9ef', '--se-dk-txt-dim': '#9aa3b2' },
            canvas: { tint: '#3a6ea5', zoneFill: '#eaf1f8', zoneBorder: '#3a6ea5', fontColor: '#1f2a37' }
        },
        slate: {
            label: 'Slate',
            chrome: { '--se-panel': '#23272b', '--se-panel-2': '#2c3136', '--se-input': '#17191c',
                      '--se-border': '#3d4349', '--se-txt': '#e8eaec', '--se-txt-dim': '#9aa1a8',
                      '--se-accent': '#7d97ad', '--se-active': '#546a7e',
                      '--se-canvas-dark': '#121417', '--se-grid-dark': '#24272c' },
            canvas: { tint: '#4a5f72', zoneFill: '#edf1f4', zoneBorder: '#4a5f72', fontColor: '#38424c' }
        },
        midnight: {
            label: 'Midnight',
            chrome: { '--se-panel': '#1e1b3a', '--se-panel-2': '#272248', '--se-input': '#141126',
                      '--se-border': '#383163', '--se-txt': '#eae8f4', '--se-txt-dim': '#a29cc4',
                      '--se-accent': '#8b7cf8', '--se-active': '#5b4bc4',
                      '--se-canvas-dark': '#100d1f', '--se-grid-dark': '#201a38' },
            canvas: { tint: '#4c3f9e', zoneFill: '#eeecf8', zoneBorder: '#4c3f9e', fontColor: '#312a55' }
        },
        // Synthwave - neon magenta over deep purple-black (dark), loud.
        synthwave: {
            label: 'Synthwave',
            chrome: { '--se-panel': '#1a1030', '--se-panel-2': '#251643', '--se-input': '#120a24',
                      '--se-border': '#3a2560', '--se-txt': '#ece6ff', '--se-txt-dim': '#a596c9',
                      '--se-accent': '#ff4d8d', '--se-active': '#d6337a',
                      '--se-canvas-dark': '#0f0820', '--se-grid-dark': '#241640' },
            canvas: { tint: '#7b52d0', zoneFill: '#efe9fb', zoneBorder: '#7b52d0', fontColor: '#3a2758' }
        },
        // --- Editor & terminal palettes (2026-07-16). Dev-scheme colors are
        // the source palettes' own hex; names are evocative (colours aren't
        // copyrightable, names kept ours). Dark-chrome = 10 vars; light-chrome
        // (Solar Light / Graphite / Mono / Sakura) add the 6 --se-dk-* set. ---
        arctic: {   // Nord - calm arctic blue-grays
            label: 'Arctic',
            chrome: { '--se-panel': '#2e3440', '--se-panel-2': '#3b4252', '--se-input': '#272c36',
                      '--se-border': '#434c5e', '--se-txt': '#eceff4', '--se-txt-dim': '#9aa5b8',
                      '--se-accent': '#88c0d0', '--se-active': '#5e81ac',
                      '--se-canvas-dark': '#232831', '--se-grid-dark': '#333b49' },
            canvas: { tint: '#5e81ac', zoneFill: '#eaeff4', zoneBorder: '#5e81ac', fontColor: '#2e3440' }
        },
        nocturne: {   // Dracula - dark violet with pink/green pops
            label: 'Nocturne',
            chrome: { '--se-panel': '#282a36', '--se-panel-2': '#343746', '--se-input': '#1e1f29',
                      '--se-border': '#44475a', '--se-txt': '#f8f8f2', '--se-txt-dim': '#a3a9c9',
                      '--se-accent': '#bd93f9', '--se-active': '#ff79c6',
                      '--se-canvas-dark': '#21222c', '--se-grid-dark': '#323442' },
            canvas: { tint: '#7c5cbf', zoneFill: '#efe9fb', zoneBorder: '#7c5cbf', fontColor: '#3d3556' }
        },
        retro: {   // Gruvbox - warm retro dark
            label: 'Retro',
            chrome: { '--se-panel': '#282828', '--se-panel-2': '#3c3836', '--se-input': '#1d2021',
                      '--se-border': '#504945', '--se-txt': '#ebdbb2', '--se-txt-dim': '#a89984',
                      '--se-accent': '#fe8019', '--se-active': '#d65d0e',
                      '--se-canvas-dark': '#1d2021', '--se-grid-dark': '#32302f' },
            canvas: { tint: '#af3a03', zoneFill: '#f2e5bc', zoneBorder: '#b57614', fontColor: '#3c3836' }
        },
        solarDark: {   // Solarized - precise dark base
            label: 'Solar Dark',
            chrome: { '--se-panel': '#002b36', '--se-panel-2': '#073642', '--se-input': '#00212b',
                      '--se-border': '#0d4a58', '--se-txt': '#93a1a1', '--se-txt-dim': '#5f7883',
                      '--se-accent': '#2aa198', '--se-active': '#268bd2',
                      '--se-canvas-dark': '#002028', '--se-grid-dark': '#0a3843' },
            canvas: { tint: '#268bd2', zoneFill: '#e8efe6', zoneBorder: '#2aa198', fontColor: '#073642' }
        },
        solarLight: {   // Solarized - cream light base
            label: 'Solar Light',
            chrome: { '--se-panel': '#eee8d5', '--se-panel-2': '#e3dcc4', '--se-input': '#fdf6e3',
                      '--se-border': '#cfc8b0', '--se-txt': '#586e75', '--se-txt-dim': '#93a1a1',
                      '--se-accent': '#268bd2', '--se-active': '#2aa198',
                      '--se-canvas-dark': '#002028', '--se-grid-dark': '#0a3843',
                      '--se-dk-panel': '#073642', '--se-dk-panel-2': '#0d4a58',
                      '--se-dk-input': '#00212b', '--se-dk-border': '#1a5c6a',
                      '--se-dk-txt': '#93a1a1', '--se-dk-txt-dim': '#5f7883' },
            canvas: { tint: '#268bd2', zoneFill: '#eef4ec', zoneBorder: '#2aa198', fontColor: '#586e75' }
        },
        tokyoNight: {   // deep indigo with blue/purple neon
            label: 'Tokyo Night',
            chrome: { '--se-panel': '#1a1b26', '--se-panel-2': '#24283b', '--se-input': '#16161e',
                      '--se-border': '#2f334d', '--se-txt': '#c0caf5', '--se-txt-dim': '#7f88b3',
                      '--se-accent': '#7aa2f7', '--se-active': '#bb9af7',
                      '--se-canvas-dark': '#16161e', '--se-grid-dark': '#292e42' },
            canvas: { tint: '#5a7fd6', zoneFill: '#eaeefb', zoneBorder: '#7aa2f7', fontColor: '#2b2f44' }
        },
        phosphor: {   // green-on-black CRT terminal
            label: 'Phosphor',
            chrome: { '--se-panel': '#0d1a0d', '--se-panel-2': '#12240f', '--se-input': '#071007',
                      '--se-border': '#1e3a1a', '--se-txt': '#a8f0a0', '--se-txt-dim': '#5c9e57',
                      '--se-accent': '#39ff14', '--se-active': '#2bcc10',
                      '--se-canvas-dark': '#030803', '--se-grid-dark': '#0f1f0d' },
            canvas: { tint: '#178a2a', zoneFill: '#e4f6e2', zoneBorder: '#178a2a', fontColor: '#133a17' }
        },
        amber: {   // amber monochrome CRT terminal
            label: 'Amber',
            chrome: { '--se-panel': '#1a1206', '--se-panel-2': '#241a0a', '--se-input': '#100b04',
                      '--se-border': '#3a2a12', '--se-txt': '#ffcc66', '--se-txt-dim': '#a8813c',
                      '--se-accent': '#ffb000', '--se-active': '#cc8c00',
                      '--se-canvas-dark': '#0a0703', '--se-grid-dark': '#201808' },
            canvas: { tint: '#b5730f', zoneFill: '#f7ecd6', zoneBorder: '#b5730f', fontColor: '#4a3312' }
        },
        chalk: {   // dark chalkboard with pastel chalk
            label: 'Chalk',
            chrome: { '--se-panel': '#2b3230', '--se-panel-2': '#353d3a', '--se-input': '#232928',
                      '--se-border': '#45504c', '--se-txt': '#eef0ec', '--se-txt-dim': '#a7b0ab',
                      '--se-accent': '#f7c948', '--se-active': '#d9a92f',
                      '--se-canvas-dark': '#1e2422', '--se-grid-dark': '#313a37' },
            canvas: { tint: '#5a8c9e', zoneFill: '#eaf0f2', zoneBorder: '#5a8c9e', fontColor: '#3a4448' }
        },
        graphite: {   // pencil grays, minimal
            label: 'Graphite',
            chrome: { '--se-panel': '#e8e8ea', '--se-panel-2': '#dcdce0', '--se-input': '#f6f6f7',
                      '--se-border': '#c4c4c9', '--se-txt': '#3a3a3e', '--se-txt-dim': '#86868c',
                      '--se-accent': '#5a5a62', '--se-active': '#46464c',
                      '--se-canvas-dark': '#17171a', '--se-grid-dark': '#2a2a2e',
                      '--se-dk-panel': '#26262a', '--se-dk-panel-2': '#303035',
                      '--se-dk-input': '#1b1b1e', '--se-dk-border': '#45454c',
                      '--se-dk-txt': '#e8e8ea', '--se-dk-txt-dim': '#a0a0a8' },
            canvas: { tint: '#5a5a62', zoneFill: '#eeeef0', zoneBorder: '#7a7a82', fontColor: '#333338' }
        },
        mono: {   // pure grayscale for print / formal exports
            label: 'Mono',
            chrome: { '--se-panel': '#efefef', '--se-panel-2': '#e4e4e4', '--se-input': '#fafafa',
                      '--se-border': '#cccccc', '--se-txt': '#222222', '--se-txt-dim': '#777777',
                      '--se-accent': '#333333', '--se-active': '#000000',
                      '--se-canvas-dark': '#141414', '--se-grid-dark': '#2a2a2a',
                      '--se-dk-panel': '#242424', '--se-dk-panel-2': '#2e2e2e',
                      '--se-dk-input': '#191919', '--se-dk-border': '#444444',
                      '--se-dk-txt': '#eeeeee', '--se-dk-txt-dim': '#9a9a9a' },
            canvas: { tint: '#444444', zoneFill: '#eeeeee', zoneBorder: '#888888', fontColor: '#222222' }
        },
        sakura: {   // soft cherry-blossom pink
            label: 'Sakura',
            chrome: { '--se-panel': '#fbeef2', '--se-panel-2': '#f6e0e8', '--se-input': '#fef8fa',
                      '--se-border': '#eecdd8', '--se-txt': '#4a3540', '--se-txt-dim': '#9a7c88',
                      '--se-accent': '#e58aab', '--se-active': '#d06b90',
                      '--se-canvas-dark': '#1f1418', '--se-grid-dark': '#33222a',
                      '--se-dk-panel': '#2a1e23', '--se-dk-panel-2': '#34262c',
                      '--se-dk-input': '#1c1418', '--se-dk-border': '#4a343d',
                      '--se-dk-txt': '#f7e6ec', '--se-dk-txt-dim': '#c39dab' },
            canvas: { tint: '#d97fa3', zoneFill: '#fbe9f0', zoneBorder: '#d97fa3', fontColor: '#5a3a48' }
        },
        storm: {   // moody blue-gray
            label: 'Storm',
            chrome: { '--se-panel': '#1e2530', '--se-panel-2': '#28313f', '--se-input': '#161c25',
                      '--se-border': '#37414f', '--se-txt': '#d5dce6', '--se-txt-dim': '#8593a5',
                      '--se-accent': '#6fa8dc', '--se-active': '#4a80b8',
                      '--se-canvas-dark': '#141a22', '--se-grid-dark': '#262f3b' },
            canvas: { tint: '#4a80b8', zoneFill: '#e9eff5', zoneBorder: '#4a80b8', fontColor: '#2a3542' }
        },
        // The untinted original, and the default. The key 'classic' is also
        // the clears-everything sentinel; neither the key nor the name moves.
        // (The picker sorts by label, so table order here is thematic.)
        classic: { label: 'Classic' }
    };
    // Picker organisation: the flat list got long, so group by vibe into
    // <optgroup>s (native, zero-dep, still arrow-key-scrollable end to end).
    // Classic sits first, ungrouped, as the default/reset. Any theme key not
    // listed here still shows - it falls into a trailing "More" group - so a
    // new theme is never hidden by forgetting to slot it.
    const THEME_GROUPS = [
        ['Paper', ['canvas', 'gesso', 'parchment', 'chalk', 'graphite', 'mono']],
        ['Warm', ['garnet', 'ember', 'rose', 'sakura', 'retro']],
        ['Cool', ['blueprint', 'sage', 'evergreen', 'lagoon', 'glacier', 'slate', 'storm', 'arctic', 'solarLight']],
        ['Night', ['ink', 'midnight', 'crimsonNavy', 'synthwave', 'nocturne', 'tokyoNight', 'solarDark']],
        ['Screen', ['phosphor', 'amber']]
    ];
    // Drive a Default Settings control as if the user set it by hand - the
    // input handler runs, so live previews fire. Shared by theme seeding and
    // the theme-aware Reset buttons.
    function seedInput(id, v) {
        const el = document.getElementById(id);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // Preset swatches for every color input (input list= -> one shared
    // <datalist>): the native pickers show them - Chromium as a swatch grid
    // up front, Firefox as a row above its panel. Zero dependencies; the
    // set is the active theme's palette plus a derived light/dark pair of
    // the tint and the two staples.
    function refreshThemeSwatches() {
        const dl = document.getElementById('theme-swatches');
        if (!dl) return;
        const tint = DEFAULT_DEVICE_TINT || '#4a90d9';
        // The theme's signature CHROME accent (Synthwave's pink, Ember's
        // orange...) defines its look but isn't a canvas-seed color - pull it
        // (and its pressed shade) from the live CSS vars so the picker offers
        // the colour a user actually associates with the theme. Only hex values
        // qualify (a color input's datalist can't use rgb()/named).
        const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
        const accent = cssVar('--se-accent'), active = cssVar('--se-active');
        const isHex = (c) => /^#[0-9a-fA-F]{3,8}$/.test(c);
        const set = [
            tint,
            DEFAULT_ZONE_FILL || '#e8f4fd',
            defaultZoneBorder(),
            DEFAULT_FONT_COLOR || '#333333',
            DEFAULT_CONN_COLOR,
            isHex(accent) ? accent : null,
            isHex(active) ? active : null,
            lightenHex(tint, 0.45),
            darkenHex(tint, 0.3),
            '#ffffff', '#333333'
        ].filter(Boolean);
        dl.innerHTML = '';
        [...new Set(set.map(c => String(c).toLowerCase()))].forEach(c => {
            const o = document.createElement('option');
            o.value = c;
            dl.appendChild(o);
        });
    }
    function applyTheme(key, persist = true) {
        const t = THEMES[key] || THEMES.classic;
        // Recorded FIRST: the per-control Reset buttons restore the ACTIVE
        // theme's seed (classic values only when the seed is null), so the
        // classic branch below can safely reuse the reset buttons.
        activeThemeSeed = t.canvas || null;
        const rs = document.documentElement.style;
        THEME_VARS.forEach(k => rs.removeProperty(k));
        if (t.chrome) Object.entries(t.chrome).forEach(([k, v]) => rs.setProperty(k, v));
        if (t.canvas) {
            seedInput('default-device-tint', t.canvas.tint);
            seedInput('default-zone-fill', t.canvas.zoneFill);
            seedInput('default-zone-border', t.canvas.zoneBorder);
            seedInput('default-font-color', t.canvas.fontColor || '#333333');
        } else {
            document.getElementById('default-device-tint-reset').click();
            document.getElementById('default-zone-fill-reset').click();
            document.getElementById('default-zone-border-reset').click();
            seedInput('default-font-color', '#333333');   // Classic label color
        }
        // New connections take the theme's ink color too (connColor override,
        // else the label color). Set directly - dispatching 'input' would
        // restyle whichever connection happens to be selected. And when a
        // connection IS selected, the input is currently mirroring THAT
        // connection - leave it showing the truth, or the next unrelated
        // property edit (updateConnectionStyle re-reads every input) would
        // silently recolor the connection to the theme ink.
        DEFAULT_CONN_COLOR = t.canvas ? (t.canvas.connColor || t.canvas.fontColor || '#333333') : '#333333';
        const selConn = state.connections.find(cn => cn.id === state.selectedConnection);
        document.getElementById('conn-color').value = selConn ? selConn.color : DEFAULT_CONN_COLOR;
        const sel = document.getElementById('theme-select');
        sel.value = THEMES[key] ? key : 'classic';
        if (persist) { try { localStorage.setItem('crosscanvas-theme', sel.value); } catch (e) { /* unavailable */ } }
        refreshThemeSwatches();
    }

    // Retroactively snap every existing device and zone to the CURRENT
    // Default Settings colors (which a theme seeds) - Device Color, Zone
    // Color, Zone Border. Themes normally only affect newly created objects;
    // this is the "apply it to what's already here" escape hatch (undoable).
    // Device Background and zone opacity are left alone (not theme-seeded).
    // opts = { devices, zones, connections, textBoxes } - each defaults TRUE, so
    // recolorAllToTheme() with no args stays "recolor everything" (the ?recolor=1
    // demo-link path and any headless caller are unchanged). The interactive
    // Bulk Actions button and batch convert pass a subset so a user can keep,
    // say, link-speed color coding or hand-tuned zone colors (recolorScopeDialog).
    // opts.silent: skip the undo snapshot and dirty flag. For read-only
    // embedders (the kiosk rotates themes on a timer) where there is no user
    // to undo for and nothing is ever saved - snapshotting a whole board every
    // few minutes is pure churn on a low-powered wall display.
    function recolorAllToTheme(opts) {
        opts = opts || {};
        const doDev = opts.devices !== false, doZone = opts.zones !== false;
        const doConn = opts.connections !== false, doText = opts.textBoxes !== false;
        if (!doDev && !doZone && !doConn && !doText) return;
        if (!state.devices.length && !state.zones.length &&
            !state.connections.length && !state.textBoxes.length) return;
        if (!opts.silent) pushUndo();
        if (doDev) {
            const tint = DEFAULT_DEVICE_TINT;   // null = the theme's untinted look
            state.devices.forEach(d => {
                d.fontColor = DEFAULT_FONT_COLOR;   // label color follows the theme (all devices)
                const src = d.originalImage || d.image;
                if (!isSVGDataURL(src)) return;   // raster/pasted icons can't retint the glyph
                if (!d.originalImage) d.originalImage = d.image;
                if (tint) { d.tintColor = tint; d.image = tintSVG(d.originalImage, tint); }
                else { d.tintColor = null; d.image = d.originalImage; }
            });
        }
        if (doZone) {
            const zLeaf = DEFAULT_ZONE_FILL || '#e8f4fd';
            const zParent = lightenHex(zLeaf, PARENT_ZONE_LIGHTEN);   // enclosing zones a shade lighter
            const zBorder = defaultZoneBorder();
            // A zone that geometrically contains another is a "parent" and takes the
            // lighter fill so nesting reads (imports have no parent/child metadata by
            // recolor time, so detect it from geometry). fontColor/border themed too
            // - the label color was the one thing recolor never updated ("blue for
            // everything").
            const encloses = (o, i) => i.x >= o.x - 2 && i.y >= o.y - 2 &&
                i.x + i.w <= o.x + o.w + 2 && i.y + i.h <= o.y + o.h + 2 &&
                (i.w < o.w || i.h < o.h);
            state.zones.forEach(z => {
                const isParent = state.zones.some(o => o !== z && encloses(z, o));
                z.fill = isParent ? zParent : zLeaf;
                z.borderColor = zBorder;
                z.fontColor = zBorder;
            });
        }
        // Connections snap to the theme ink; text boxes to the theme label color.
        if (doConn) state.connections.forEach(c => { c.color = DEFAULT_CONN_COLOR; });
        if (doText) state.textBoxes.forEach(tb => { tb.fontColor = DEFAULT_FONT_COLOR; });
        renderAllDevices();   // also re-renders text boxes (shared device layer)
        renderAllZones();
        renderAllConnections();
        if (!opts.silent) setDirty(true);
    }

    // The per-kind opt-out picker shared by the Bulk Actions button and batch
    // convert. Resolves to an opts object for recolorAllToTheme, or null if the
    // user cancels. All boxes start checked, so the default is "recolor all".
    function recolorScopeDialog() {
        const cats = [
            ['devices', 'Devices', 'icon color and labels'],
            ['zones', 'Zones', 'fill, border and labels'],
            ['connections', 'Connections', 'line color'],
            ['textBoxes', 'Text boxes', 'label color']
        ];
        return showDialog({
            title: 'Recolor to theme',
            buttons: [],
            body: (close) => {
                const box = document.createElement('div');
                const intro = document.createElement('div');
                intro.className = 'dialog-line';
                intro.textContent = 'Snap the checked kinds of object to the current theme colors. ' +
                    'Custom colors on unchecked kinds are left alone. Undoable.';
                box.appendChild(intro);
                const cbs = {};
                cats.forEach(([key, label, note]) => {
                    const row = document.createElement('label');
                    row.className = 'recolor-scope-row';
                    const cb = document.createElement('input');
                    cb.type = 'checkbox'; cb.checked = true;
                    cbs[key] = cb;
                    const name = document.createElement('span'); name.textContent = label;
                    const sub = document.createElement('span');
                    sub.className = 'dialog-item-note'; sub.textContent = ' - ' + note;
                    row.append(cb, name, sub);
                    box.appendChild(row);
                });
                const foot = document.createElement('div');
                foot.className = 'inv-map-foot';
                const cancel = document.createElement('button');
                cancel.type = 'button'; cancel.className = 'dialog-btn'; cancel.textContent = 'Cancel';
                cancel.addEventListener('click', () => close(null));
                const go = document.createElement('button');
                go.type = 'button'; go.className = 'dialog-btn primary'; go.textContent = 'Recolor';
                go.addEventListener('click', () => close({
                    devices: cbs.devices.checked, zones: cbs.zones.checked,
                    connections: cbs.connections.checked, textBoxes: cbs.textBoxes.checked
                }));
                foot.append(cancel, go);
                box.appendChild(foot);
                return box;
            }
        });
    }

    // Set a device's label to a list of lines (rebuilds the label string,
    // per-line formats, and spans in one shot - the three must stay in sync).
    function setDeviceLabelLines(device, lines) {
        device.label = lines.join('\n');
        device.lineFormats = lines.map(() => ({ bold: false, italic: false }));
        device.spans = lines.map(ln => [{ text: ln, bold: false, italic: false }]);
    }

    // Bulk: stack chosen Device Details fields into every device's label, one
    // per line (Hostname + IP-Address by default). Hostname falls back to the
    // device's current first label line when the field is empty, so a device
    // named by its label but lacking a Hostname field still keeps its name.
    // A device with none of the chosen fields keeps its existing label.
    async function mapDetailsToLabel() {
        if (!state.devices.length) {
            showDialog({ title: 'Map Details to Label', body: 'There are no devices to update.' });
            return;
        }
        const present = new Set(['Hostname']);   // always offered (label fallback)
        state.devices.forEach(d => {
            if (d.fields) Object.keys(d.fields).forEach(k => { if (d.fields[k]) present.add(k); });
        });
        const ordered = [];
        FIXED_DEVICE_FIELDS.forEach(f => { if (present.has(f)) ordered.push(f); });
        [...present].forEach(f => { if (!ordered.includes(f)) ordered.push(f); });
        const defaults = new Set(['Hostname', 'IP-Address']);

        const body = document.createElement('div');
        body.innerHTML = '<div class="dialog-line">Stack these Device Details into every ' +
            'device label, one per line:</div>';
        const boxes = [];
        ordered.forEach(f => {
            const row = document.createElement('label');
            row.style.cssText = 'display:block; margin:4px 0; cursor:pointer';
            const cb = document.createElement('input');
            cb.type = 'checkbox'; cb.checked = defaults.has(f); cb.dataset.field = f;
            cb.style.marginRight = '7px';
            row.appendChild(cb);
            row.appendChild(document.createTextNode(f));
            body.appendChild(row);
            boxes.push(cb);
        });

        const ok = await showDialog({
            title: 'Map Details to Label', body: body,
            buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }]
        });
        if (!ok) return;
        const chosen = boxes.filter(cb => cb.checked).map(cb => cb.dataset.field);
        if (!chosen.length) return;

        const valueOf = (d, f) => {
            // Hostname shortens to match the import's clean-label convention
            // (the full FQDN stays in the Hostname field - this only affects
            // what lands on the canvas label).
            if (f === 'Hostname') return shortHostname((d.fields && d.fields.Hostname) || (d.label || '').split('\n')[0] || '');
            return (d.fields && d.fields[f]) || '';
        };
        pushUndo();
        state.devices.forEach(d => {
            const lines = chosen.map(f => valueOf(d, f)).filter(v => v);
            if (lines.length) setDeviceLabelLines(d, lines);
        });
        renderAllDevices();
        setDirty(true);
    }

    // Reverse of Map Details to Label: pull an IPv4 out of each device's label
    // into its IP-Address field, to adapt existing diagrams for monitoring
    // without hand-entering IPs. Octet-validated match, taken anywhere in the
    // label (any line); by default only fills devices that lack an IP-Address.
    async function mapLabelToDetails() {
        if (!state.devices.length) {
            showDialog({ title: 'Map Label to Details', body: 'There are no devices to update.' });
            return;
        }
        const IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;
        const scan = state.devices.map(d => {
            const m = (d.label || '').match(IPV4);
            return { d, ip: m ? m[0] : null };
        });
        const withIp = scan.filter(s => s.ip);
        const alreadySet = withIp.filter(s => s.d.fields && s.d.fields['IP-Address']).length;

        if (!withIp.length) {
            showDialog({ title: 'Map Label to Details',
                body: 'No IPv4 addresses were found in any device label.' });
            return;
        }

        const body = document.createElement('div');
        const info = document.createElement('div');
        info.className = 'dialog-line';
        info.textContent = 'Found an IPv4 address in ' + withIp.length + ' of ' +
            state.devices.length + ' device labels. Copy each into its IP-Address field?';
        body.appendChild(info);
        const ovRow = document.createElement('label');
        ovRow.style.cssText = 'display:block; margin:8px 0; cursor:pointer';
        const ov = document.createElement('input');
        ov.type = 'checkbox'; ov.style.marginRight = '7px';
        ovRow.appendChild(ov);
        ovRow.appendChild(document.createTextNode(
            'Overwrite devices that already have an IP-Address (' + alreadySet + ')'));
        body.appendChild(ovRow);

        const ok = await showDialog({
            title: 'Map Label to Details', body: body,
            buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }]
        });
        if (!ok) return;

        const overwrite = ov.checked;
        let updated = 0, skipped = 0;
        pushUndo();
        withIp.forEach(s => {
            if (!s.d.fields) s.d.fields = {};
            if (s.d.fields['IP-Address'] && !overwrite) { skipped++; return; }
            s.d.fields['IP-Address'] = s.ip;
            updated++;
        });
        if (updated) {
            setDirty(true);
            const sel = state.selectedDevice && state.devices.find(d => d.id === state.selectedDevice);
            if (sel) populateDeviceDetails(sel);   // reflect the new IP in an open panel
        }
        showDialog({ title: 'Map Label to Details',
            body: 'Set IP-Address on ' + updated + ' device' + (updated === 1 ? '' : 's') +
                  (skipped ? (', skipped ' + skipped + ' that already had one.') : '.') });
    }

    (() => {
        const sel = document.getElementById('theme-select');
        const opt = (k) => { const o = document.createElement('option'); o.value = k; o.textContent = THEMES[k].label; return o; };
        // Classic first, ungrouped (the default / clear-everything choice).
        sel.appendChild(opt('classic'));
        const grouped = new Set(['classic']);
        THEME_GROUPS.forEach(([label, keys]) => {
            const og = document.createElement('optgroup');
            og.label = label;
            keys.filter(k => THEMES[k]).sort((a, b) => THEMES[a].label.localeCompare(THEMES[b].label))
                .forEach(k => { grouped.add(k); og.appendChild(opt(k)); });
            if (og.children.length) sel.appendChild(og);
        });
        // Any theme not slotted into a group (a newly added one) still appears.
        const leftovers = Object.keys(THEMES).filter(k => !grouped.has(k))
            .sort((a, b) => THEMES[a].label.localeCompare(THEMES[b].label));
        if (leftovers.length) {
            const og = document.createElement('optgroup');
            og.label = 'More';
            leftovers.forEach(k => og.appendChild(opt(k)));
            sel.appendChild(og);
        }
        sel.addEventListener('change', () => applyTheme(sel.value));
        let saved = null;
        try { saved = localStorage.getItem('crosscanvas-theme'); } catch (e) { /* unavailable */ }
        if (saved && THEMES[saved]) {
            // An explicit choice always wins - including Classic (= no theme).
            // Classic applies nothing but must still SHOW in the picker: it
            // doesn't sit first in the (alphabetized) list, so the display
            // needs setting.
            if (saved !== 'classic') applyTheme(saved);
            else sel.value = 'classic';
        } else {
            // Fresh install: Classic - the untinted original is the default;
            // the themed looks are one picker click away.
            sel.value = 'classic';
        }
        // Classic boots never pass through applyTheme - seed the picker
        // swatches here (idempotent when a theme already did).
        refreshThemeSwatches();
    })();

    // --- Small screens: viewing-first (editing stays a desktop feature) ----
    // The media query hides the sidebar so the canvas gets the full width;
    // this button (visible only there) slides it over the canvas.
    document.getElementById('btn-mobile-sidebar').addEventListener('click', () => {
        document.body.classList.toggle('mobile-sidebar-open');
    });
    // One-time notice for phone-sized visitors (most arrive from the demo
    // link to look around). Dismiss is remembered; the kiosk never shows it.
    if (!EMBED && window.matchMedia('(max-width: 700px)').matches) {
        let seen = false;
        try { seen = !!localStorage.getItem('crosscanvas-mobile-notice'); } catch (e) { /* unavailable */ }
        if (!seen) {
            const n = document.createElement('div');
            n.className = 'mobile-notice';
            const txt = document.createElement('div');
            txt.className = 'mobile-notice-text';
            // Two deliberate lines (real-device wrapping made one sentence
            // break mid-thought), dismiss button in flow so text can't
            // crowd it off the edge.
            ['CrossCanvas is a desktop tool - browse here, edit on a PC.',
             'The ☰ button shows the stencil sidebar.'].forEach(t => {
                const line = document.createElement('div');
                line.textContent = t;
                txt.appendChild(line);
            });
            n.appendChild(txt);
            const x = document.createElement('button');
            x.type = 'button';
            x.textContent = '×';
            x.title = 'Dismiss';
            x.addEventListener('click', () => {
                n.remove();
                try { localStorage.setItem('crosscanvas-mobile-notice', '1'); } catch (e) { /* unavailable */ }
            });
            n.appendChild(x);
            document.body.appendChild(n);
        }
    }

    // Add Ctrl+B/I formatting shortcuts to all sidebar rich label editors
    ['device-label', 'conn-label', 'zone-label', 'textbox-text'].forEach(editorId => {
        document.getElementById(editorId).addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault();
                e.stopPropagation();
                document.execCommand('bold');
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
                e.preventDefault();
                e.stopPropagation();
                document.execCommand('italic');
            }
        });
    });

    document.getElementById('device-ap-slider').addEventListener('input', (e) => {
        if (!state.selectedDevice) return;
        pushUndoDebounced();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        setNodeAPCount(device, parseInt(e.target.value));
        document.getElementById('device-ap-count').textContent = device.attachmentPoints.length;
        renderDevice(device);
        rerouteConnectionsForDevice(device.id);
    });

    function rerouteConnectionsForDevice(deviceId) {
        state.connections
            .filter(c => c.fromDevice === deviceId || c.toDevice === deviceId)
            .forEach(renderConnection);
    }

    // --- Device Scaling ---
    function setDeviceDims(device, w, h) {
        const ow = device.w, oh = device.h;
        device.w = Math.max(GRID_SIZE * 2, Math.round(w));
        device.h = Math.max(GRID_SIZE * 2, Math.round(h));
        redistributeAPs(device, ow, oh);
        document.getElementById('device-w-input').value = device.w;
        document.getElementById('device-h-input').value = device.h;
        renderDevice(device);
        rerouteConnectionsForDevice(device.id);
    }

    // +/- buttons scale proportionally, preserving a non-square aspect
    function scaleDevice(delta) {
        if (!state.selectedDevice) return;
        pushUndo();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        const newW = Math.max(GRID_SIZE * 2, device.w + delta);
        setDeviceDims(device, newW, device.h * (newW / device.w));
    }

    document.getElementById('btn-scale-up').addEventListener('click', () => scaleDevice(GRID_SIZE));
    document.getElementById('btn-scale-down').addEventListener('click', () => scaleDevice(-GRID_SIZE));

    document.getElementById('device-w-input').addEventListener('change', (e) => {
        if (!state.selectedDevice) return;
        const device = state.devices.find(d => d.id === state.selectedDevice);
        if (!device) return;
        const newW = Math.max(GRID_SIZE * 2, parseInt(e.target.value) || device.w);
        if (newW === device.w) { e.target.value = device.w; return; }
        pushUndo();
        setDeviceDims(device, newW, device.h);
    });

    document.getElementById('device-h-input').addEventListener('change', (e) => {
        if (!state.selectedDevice) return;
        const device = state.devices.find(d => d.id === state.selectedDevice);
        if (!device) return;
        const newH = Math.max(GRID_SIZE * 2, parseInt(e.target.value) || device.h);
        if (newH === device.h) { e.target.value = device.h; return; }
        pushUndo();
        setDeviceDims(device, device.w, newH);
    });

    // --- Device Details (free-form data fields) ---
    // device.fields is an ordered key→value object that rides through
    // save/load/copy untouched (serializeDiagram copies devices wholesale).
    // hostname is a fixed first row that DERIVES from the label's first line
    // unless set explicitly (the derivation shows as the placeholder). The
    // editor rows are the source of truth and collect back into the object
    // on every change.
    // The standing inventory fields every device offers (values store only
    // when filled, so files stay slim); anything else is a custom row.
    const FIXED_DEVICE_FIELDS = ['Hostname', 'IP-Address', 'Serial-Number',
                                 'Asset-Tag', 'Description', 'Location'];
    const deviceFieldsRowsEl = () => document.getElementById('device-fields-rows');
    const deviceFixedFieldsEl = () => document.getElementById('device-fixed-fields');
    function deviceFieldRow(k, v) {
        const row = document.createElement('div');
        row.className = 'font-row device-field-row';
        const key = document.createElement('input');
        key.type = 'text'; key.className = 'device-field-key'; key.placeholder = 'field'; key.value = k;
        const val = document.createElement('input');
        val.type = 'text'; val.className = 'device-field-value'; val.placeholder = 'value'; val.value = v;
        const rm = document.createElement('button');
        rm.className = 'device-field-remove'; rm.title = 'Remove field'; rm.textContent = '✕';
        rm.addEventListener('click', () => { row.remove(); collectDeviceFields(); });
        key.addEventListener('input', collectDeviceFields);
        val.addEventListener('input', collectDeviceFields);
        row.append(key, val, rm);
        return row;
    }
    function populateDeviceDetails(device) {
        const f = device.fields || {};
        const fixed = deviceFixedFieldsEl();
        fixed.innerHTML = '';
        FIXED_DEVICE_FIELDS.forEach(name => {
            const row = document.createElement('div');
            row.className = 'font-row device-field-row';
            const label = document.createElement('span');
            label.className = 'device-field-name';
            label.textContent = name;
            const val = document.createElement('input');
            val.type = 'text';
            val.className = 'device-field-value';
            val.dataset.key = name;
            val.value = f[name] || '';
            if (name === 'Hostname') {
                val.placeholder = (device.label || '').split('\n')[0] || '';
                val.title = 'Falls back to the first label line';
            }
            val.addEventListener('input', collectDeviceFields);
            row.append(label, val);
            fixed.appendChild(row);
        });
        const rows = deviceFieldsRowsEl();
        rows.innerHTML = '';
        Object.entries(f).forEach(([k, v]) => {
            if (FIXED_DEVICE_FIELDS.includes(k)) return;
            rows.appendChild(deviceFieldRow(k, v));
        });
    }
    function collectDeviceFields() {
        if (!state.selectedDevice) return;
        const device = state.devices.find(d => d.id === state.selectedDevice);
        if (!device) return;
        pushUndoDebounced();
        const f = {};
        deviceFixedFieldsEl().querySelectorAll('.device-field-value').forEach(inp => {
            const v = inp.value.trim();
            if (v) f[inp.dataset.key] = v;
        });
        deviceFieldsRowsEl().querySelectorAll('.device-field-row').forEach(row => {
            const k = row.querySelector('.device-field-key').value.trim();
            if (k && !FIXED_DEVICE_FIELDS.includes(k)) {
                f[k] = row.querySelector('.device-field-value').value;
            }
        });
        if (Object.keys(f).length) device.fields = f;
        else delete device.fields;
        setDirty(true);
    }
    document.getElementById('btn-add-device-field').addEventListener('click', () => {
        deviceFieldsRowsEl().appendChild(deviceFieldRow('', ''));
        const keys = deviceFieldsRowsEl().querySelectorAll('.device-field-key');
        keys[keys.length - 1].focus();
    });
    // Collapsible panel halves, wearing the sidebar section-header look
    // (arrow rotates via the shared .collapsed class); persisted. Details
    // starts collapsed - it's reference data, not everyday controls.
    [['device-props-header', 'device-props-body', 'crosscanvas-collapse-devprops', false],
     ['device-details-header', 'device-details-body', 'crosscanvas-collapse-devdetails', true]]
        .forEach(([hdrId, bodyId, storeKey, defCollapsed]) => {
            const h = document.getElementById(hdrId), b = document.getElementById(bodyId);
            let collapsed = defCollapsed;
            try {
                const s = localStorage.getItem(storeKey);
                if (s != null) collapsed = s === '1';
            } catch (e) { /* unavailable */ }
            const apply = () => {
                b.style.display = collapsed ? 'none' : '';
                h.classList.toggle('collapsed', collapsed);
            };
            apply();
            h.addEventListener('click', () => {
                collapsed = !collapsed;
                try { localStorage.setItem(storeKey, collapsed ? '1' : '0'); } catch (e) { /* unavailable */ }
                apply();
            });
        });

    document.getElementById('device-template-swap').addEventListener('change', (e) => {
        if (!state.selectedDevice) return;
        const device = state.devices.find(d => d.id === state.selectedDevice);
        if (!device) return;
        const template = state.deviceTemplates.find(t => t.id === e.target.value);
        if (!template) return;
        pushUndo();
        // Same rule as the batch swap: a fresh icon arrives like a newly
        // placed device, wearing the theme's Device Color (untinted only
        // when no theme tint is set).
        const swapTint = (DEFAULT_DEVICE_TINT && isSVGDataURL(template.image)) ? DEFAULT_DEVICE_TINT : null;
        device.templateId = template.id;
        device.originalImage = template.image;
        device.tintColor = swapTint;
        device.image = swapTint ? tintSVG(template.image, swapTint) : template.image;
        renderDevice(device);
        // Refresh tint section visibility
        const tintSection = document.getElementById('device-tint-section');
        if (isSVGDataURL(template.image)) {
            tintSection.style.display = '';
            document.getElementById('device-tint-color').value = swapTint || STENCIL_FRAME_BLUE;
        } else {
            tintSection.style.display = 'none';
        }
        setDirty(true);
    });

    // --- Font & Label Controls (Device) ---
    document.getElementById('device-label-position').addEventListener('change', (e) => {
        if (!state.selectedDevice) return;
        pushUndo();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        device.labelPosition = e.target.value;
        renderDevice(device);
        setSegActive('device-halign-seg', effectiveLabelAlign(device));
        setSegActive('device-valign-seg', effectiveVAlign(device.labelPosition, device.labelVAlign));
    });

    wireAlignSeg('device-halign-seg', (val) => {
        if (!state.selectedDevice) return;
        const device = state.devices.find(d => d.id === state.selectedDevice);
        pushUndo();
        // Clicking the active explicit value returns to auto (position-implied)
        device.labelAlign = device.labelAlign === val ? 'auto' : val;
        renderDevice(device);
        setSegActive('device-halign-seg', effectiveLabelAlign(device));
    });

    wireAlignSeg('device-valign-seg', (val) => {
        if (!state.selectedDevice) return;
        const device = state.devices.find(d => d.id === state.selectedDevice);
        pushUndo();
        device.labelVAlign = val;
        renderDevice(device);
        setSegActive('device-valign-seg', val);
    });

    document.getElementById('device-font-size').addEventListener('change', (e) => {
        if (!state.selectedDevice) return;
        pushUndo();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        device.fontSize = parseInt(e.target.value);
        renderDevice(device);
    });

    document.getElementById('device-font-family').addEventListener('change', (e) => {
        if (!state.selectedDevice) return;
        pushUndo();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        device.fontFamily = e.target.value || undefined;
        renderDevice(device);
    });

    document.getElementById('device-font-color').addEventListener('input', (e) => {
        if (!state.selectedDevice) return;
        pushUndoDebounced();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        device.fontColor = e.target.value;
        clearSpanColors(device);
        renderDevice(device);
    });

    // Icon Background: face color inside the app-drawn stencil frame
    document.getElementById('device-iconbg-color').addEventListener('input', (e) => {
        if (!state.selectedDevice) return;
        pushUndoDebounced();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        device.iconBg = e.target.value;
        renderDevice(device);
    });

    document.getElementById('btn-reset-iconbg').addEventListener('click', () => {
        if (!state.selectedDevice) return;
        pushUndo();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        // "As newly placed": devices copy the default background at creation.
        device.iconBg = DEFAULT_ICON_BG || undefined;
        document.getElementById('device-iconbg-color').value = DEFAULT_ICON_BG || '#fffefe';
        renderDevice(device);
    });

    // --- Image property panel ---
    function updateSelectedImage(mutator, debounced) {
        if (!state.selectedImage) return;
        const img = state.images.find(i => i.id === state.selectedImage);
        if (!img) return;
        (debounced ? pushUndoDebounced : pushUndo)();
        mutator(img);
        renderImage(img);
    }

    document.getElementById('image-label').addEventListener('input', (e) => {
        updateSelectedImage(img => {
            img.spans = htmlToSpans(e.target.innerHTML);
            img.label = getPlainText(img.spans);
            img.lineFormats = img.spans.map(ls => ({ bold: ls.every(s => s.bold), italic: ls.every(s => s.italic) }));
        }, true);
    });

    document.getElementById('image-label-position').addEventListener('change', (e) => {
        updateSelectedImage(img => {
            img.labelPosition = e.target.value;
            setSegActive('image-halign-seg', effectiveLabelAlign(img));
            setSegActive('image-valign-seg', effectiveVAlign(img.labelPosition, img.labelVAlign));
        });
    });

    wireAlignSeg('image-halign-seg', (val) => {
        updateSelectedImage(img => {
            img.labelAlign = img.labelAlign === val ? 'auto' : val;
            setSegActive('image-halign-seg', effectiveLabelAlign(img));
        });
    });

    wireAlignSeg('image-valign-seg', (val) => {
        updateSelectedImage(img => {
            img.labelVAlign = val;
            setSegActive('image-valign-seg', val);
        });
    });

    document.getElementById('image-font-size').addEventListener('change', (e) => {
        updateSelectedImage(img => { img.fontSize = parseInt(e.target.value); });
    });

    document.getElementById('image-font-family').addEventListener('change', (e) => {
        updateSelectedImage(img => { img.fontFamily = e.target.value || undefined; });
    });

    document.getElementById('image-font-color').addEventListener('input', (e) => {
        updateSelectedImage(img => { img.fontColor = e.target.value; clearSpanColors(img); }, true);
    });

    document.getElementById('image-ap-slider').addEventListener('input', (e) => {
        if (!state.selectedImage) return;
        pushUndoDebounced();
        const img = state.images.find(i => i.id === state.selectedImage);
        if (!img.attachmentPoints) img.attachmentPoints = [];
        setNodeAPCount(img, parseInt(e.target.value));
        document.getElementById('image-ap-count').textContent = img.attachmentPoints.length;
        renderImage(img);
        rerouteConnectionsForDevice(img.id);
    });

    document.getElementById('device-tint-color').addEventListener('input', (e) => {
        if (!state.selectedDevice) return;
        pushUndoDebounced();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        if (!device.originalImage) device.originalImage = device.image;
        device.tintColor = e.target.value;
        device.image = tintSVG(device.originalImage, device.tintColor);
        renderDevice(device);
    });

    document.getElementById('btn-reset-tint').addEventListener('click', () => {
        if (!state.selectedDevice) return;
        pushUndo();
        const device = state.devices.find(d => d.id === state.selectedDevice);
        if (device.originalImage) {
            // "As newly placed": the default Device Color (theme-seeded or
            // user-set) when there is one, the stencil's own colors otherwise.
            const tint = (DEFAULT_DEVICE_TINT && isSVGDataURL(device.originalImage)) ? DEFAULT_DEVICE_TINT : null;
            device.tintColor = tint;
            device.image = tint ? tintSVG(device.originalImage, tint) : device.originalImage;
            renderDevice(device);
            document.getElementById('device-tint-color').value = tint || STENCIL_FRAME_BLUE;
        }
    });

    // The other properties-panel color Resets - "as newly placed": drive the
    // input with the theme default and let its existing 'input' handler
    // apply it to the selected object.
    [['btn-reset-device-font', 'device-font-color', () => DEFAULT_FONT_COLOR || '#333333'],
     ['btn-reset-zone-fill', 'zone-fill', () => DEFAULT_ZONE_FILL || '#e8f4fd'],
     ['btn-reset-zone-border', 'zone-border-color', () => defaultZoneBorder()],
     ['btn-reset-zone-font', 'zone-font-color', () => DEFAULT_FONT_COLOR || '#333333'],
     ['btn-reset-textbox-font', 'textbox-font-color', () => DEFAULT_FONT_COLOR || '#333333']
    ].forEach(([btn, input, val]) => {
        document.getElementById(btn).addEventListener('click', () => seedInput(input, val()));
    });

    // --- Zones (background shapes) ---
    // Horizontal skew of a parallelogram zone, shared by render and export.
    function parallelogramSkew(w) {
        return Math.min(w * 0.25, 40);
    }
    // Wave depth of a document zone's bottom edge.
    function documentWave(h) {
        return Math.min(h * 0.3, 30);
    }
    // Half-height of a cylinder zone's elliptical caps.
    function cylinderCap(h) {
        return Math.min(h * 0.15, 16);
    }

    function renderZone(zone) {
        let group = document.getElementById(zone.id);
        if (group) group.remove();

        group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.id = zone.id;
        group.classList.add('zone-node');
        group.setAttribute('transform', `translate(${zone.x}, ${zone.y})`);

        if (state.selectedZone === zone.id) {
            group.classList.add('selected');
        }
        if (state.selectedZones.includes(zone.id)) {
            group.classList.add('multi-selected');
        }

        let shape;
        if (zone.shape === 'ellipse') {
            shape = document.createElementNS('http://www.w3.org/2000/svg', 'ellipse');
            shape.setAttribute('cx', zone.w / 2);
            shape.setAttribute('cy', zone.h / 2);
            shape.setAttribute('rx', zone.w / 2);
            shape.setAttribute('ry', zone.h / 2);
        } else if (zone.shape === 'diamond') {
            shape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            shape.setAttribute('points', `${zone.w / 2},0 ${zone.w},${zone.h / 2} ${zone.w / 2},${zone.h} 0,${zone.h / 2}`);
        } else if (zone.shape === 'parallelogram') {
            const k = parallelogramSkew(zone.w);
            shape = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            shape.setAttribute('points', `${k},0 ${zone.w},0 ${zone.w - k},${zone.h} 0,${zone.h}`);
        } else if (zone.shape === 'pill') {
            shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            shape.setAttribute('width', zone.w);
            shape.setAttribute('height', zone.h);
            shape.setAttribute('rx', zone.h / 2);
            shape.setAttribute('ry', zone.h / 2);
        } else if (zone.shape === 'document') {
            // Straight top/sides, S-wave bottom (right half raised, left half dipped)
            const dy = documentWave(zone.h);
            shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            shape.setAttribute('d',
                `M 0 0 L ${zone.w} 0 L ${zone.w} ${zone.h - dy / 2}` +
                ` Q ${zone.w * 0.75} ${zone.h - dy} ${zone.w / 2} ${zone.h - dy / 2}` +
                ` Q ${zone.w * 0.25} ${zone.h} 0 ${zone.h - dy / 2} Z`);
        } else if (zone.shape === 'cylinder') {
            // Elliptical caps top and bottom; the visible top-cap arc is added
            // as a stroke-only detail path below.
            const e2 = cylinderCap(zone.h);
            shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            shape.setAttribute('d',
                `M 0 ${e2} A ${zone.w / 2} ${e2} 0 0 1 ${zone.w} ${e2}` +
                ` L ${zone.w} ${zone.h - e2} A ${zone.w / 2} ${e2} 0 0 1 0 ${zone.h - e2} Z`);
        } else {
            shape = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            shape.setAttribute('width', zone.w);
            shape.setAttribute('height', zone.h);
            shape.setAttribute('rx', '0');
        }
        shape.classList.add('zone-shape');
        shape.setAttribute('fill', zone.fill);
        shape.setAttribute('fill-opacity', zone.opacity);
        shape.setAttribute('stroke', zone.borderColor);
        shape.setAttribute('stroke-width', '2');
        group.appendChild(shape);

        // Cylinder: stroke-only lower arc of the top cap (the "3D" rim line)
        if (zone.shape === 'cylinder') {
            const e2 = cylinderCap(zone.h);
            const cap = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            cap.setAttribute('d', `M 0 ${e2} A ${zone.w / 2} ${e2} 0 0 0 ${zone.w} ${e2}`);
            cap.setAttribute('fill', 'none');
            cap.setAttribute('stroke', zone.borderColor);
            cap.setAttribute('stroke-width', '2');
            cap.setAttribute('pointer-events', 'none');
            group.appendChild(cap);
        }

        if (zone.label) {
            const zoneObj = Object.assign({}, zone, {
                fillOpacity: !zone.fontColor ? Math.min(1, zone.opacity + 0.4) : undefined
            });
            renderMultiLineLabel(group, zoneObj, zone.w, zone.h, zone.borderColor);
        }

        if (zone.attachmentPoints) {
            zone.attachmentPoints.forEach((ap, i) => {
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.classList.add('attachment-point');
                circle.setAttribute('cx', ap.rx);
                circle.setAttribute('cy', ap.ry);
                circle.setAttribute('r', AP_RADIUS);
                circle.dataset.deviceId = zone.id;
                circle.dataset.apIndex = i;
                group.appendChild(circle);
            });
        }

        // Resize handles - offset outside the edges far enough to CLEAR the
        // attachment-point circles (r=6 on the edge), not just sit beside
        // them; +2 used to eclipse the edge-midpoint APs.
        const handleSize = 10;
        const handleOffset = AP_RADIUS + 4;
        const resizeHandles = [
            // Bottom-right corner (both axes)
            { x: zone.w + handleOffset, y: zone.h + handleOffset, axis: 'both', cursor: 'nwse-resize' },
            // Right edge middle (horizontal only - grows right)
            { x: zone.w + handleOffset, y: zone.h / 2 - handleSize / 2, axis: 'r', cursor: 'ew-resize' },
            // Bottom edge middle (vertical only - grows down)
            { x: zone.w / 2 - handleSize / 2, y: zone.h + handleOffset, axis: 'b', cursor: 'ns-resize' },
            // Left edge middle (horizontal only - moves origin)
            { x: -handleOffset - handleSize, y: zone.h / 2 - handleSize / 2, axis: 'l', cursor: 'ew-resize' },
            // Top edge middle (vertical only - moves origin)
            { x: zone.w / 2 - handleSize / 2, y: -handleOffset - handleSize, axis: 't', cursor: 'ns-resize' },
        ];
        resizeHandles.forEach(rh => {
            const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            handle.classList.add('zone-resize-handle');
            handle.setAttribute('x', rh.x);
            handle.setAttribute('y', rh.y);
            handle.setAttribute('width', handleSize);
            handle.setAttribute('height', handleSize);
            handle.setAttribute('rx', '2');
            handle.style.cursor = rh.cursor;
            handle.dataset.zoneId = zone.id;
            handle.dataset.axis = rh.axis;
            group.appendChild(handle);
        });

        zonesLayer.appendChild(group);
    }

    function renderAllZones() {
        zonesLayer.innerHTML = '';
        state.zones.forEach(renderZone);
    }

    // --- Pasted Images ---
    function renderImage(img) {
        let group = document.getElementById(img.id);
        if (group) group.remove();

        group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.id = img.id;
        group.classList.add('image-node');
        group.setAttribute('transform', `translate(${img.x}, ${img.y})`);

        if (state.selectedImage === img.id) group.classList.add('selected');
        if (state.selectedImages && state.selectedImages.includes(img.id)) group.classList.add('multi-selected');

        const border = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        border.classList.add('image-border');
        border.setAttribute('width', img.w);
        border.setAttribute('height', img.h);
        border.setAttribute('fill', 'none');
        border.setAttribute('stroke', 'transparent');
        border.setAttribute('stroke-width', '1');
        group.appendChild(border);

        const imgEl = document.createElementNS('http://www.w3.org/2000/svg', 'image');
        imgEl.setAttribute('href', img.dataURL);
        imgEl.setAttribute('width', img.w);
        imgEl.setAttribute('height', img.h);
        imgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        group.appendChild(imgEl);

        if (img.label) {
            renderMultiLineLabel(group, img, img.w, img.h, '#333', true);
        }

        if (img.attachmentPoints) {
            img.attachmentPoints.forEach((ap, i) => {
                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.classList.add('attachment-point');
                circle.setAttribute('cx', ap.rx);
                circle.setAttribute('cy', ap.ry);
                circle.setAttribute('r', AP_RADIUS);
                circle.dataset.deviceId = img.id;
                circle.dataset.apIndex = i;
                group.appendChild(circle);
            });
        }

        const handle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        handle.classList.add('image-resize-handle');
        handle.setAttribute('x', img.w + AP_RADIUS + 4);   // clear the corner AP
        handle.setAttribute('y', img.h + AP_RADIUS + 4);
        handle.setAttribute('width', 10);
        handle.setAttribute('height', 10);
        handle.setAttribute('rx', '2');
        handle.dataset.imageId = img.id;
        handle.dataset.role = 'resize';
        group.appendChild(handle);

        imagesLayer.appendChild(group);
    }

    function renderAllImages() {
        imagesLayer.innerHTML = '';
        state.images.forEach(renderImage);
    }

    function selectImage(imageId) {
        clearAnnotationSelection();
        if (imageId) hideBatchPanel();
        state.selectedImage = imageId;
        state.selectedDevice = null;
        state.selectedConnection = null;
        state.selectedZone = null;
        state.selectedTextBox = null;
        document.getElementById('device-panel').style.display = 'none';
        document.getElementById('zone-panel').style.display = 'none';
        document.getElementById('textbox-panel').style.display = 'none';
        document.getElementById('connection-panel').style.display = state.tool === 'connect' ? 'block' : 'none';
        const panel = document.getElementById('image-panel');
        if (imageId) {
            const img = state.images.find(i => i.id === imageId);
            panel.style.display = 'block';
            document.getElementById('image-label').innerHTML = spansToHTML(img.spans || [[{ text: img.label || '', bold: false, italic: false }]]);
            document.getElementById('image-label-position').value = img.labelPosition || 'bottom';
            setSegActive('image-halign-seg', effectiveLabelAlign(img));
            setSegActive('image-valign-seg', effectiveVAlign(img.labelPosition || 'bottom', img.labelVAlign));
            document.getElementById('image-font-family').value = img.fontFamily || '';
            document.getElementById('image-font-size').value = img.fontSize || 20;
            document.getElementById('image-font-color').value = img.fontColor || '#333333';
            document.getElementById('image-ap-count').textContent = img.attachmentPoints ? img.attachmentPoints.length : 0;
            document.getElementById('image-ap-slider').value = img.attachmentPoints ? img.attachmentPoints.length : 8;
        } else {
            panel.style.display = 'none';
        }
        renderAllImages();
    }

    function selectZone(zoneId) {
        clearAnnotationSelection();
        if (zoneId) hideBatchPanel();
        state.selectedZone = zoneId;
        state.selectedDevice = null;
        state.selectedConnection = null;
        state.selectedTextBox = null;
        state.selectedImage = null;
        renderAllZones();
        renderAllDevices();
        renderAllConnections();

        document.getElementById('device-panel').style.display = 'none';
        document.getElementById('textbox-panel').style.display = 'none';
        document.getElementById('image-panel').style.display = 'none';
        document.getElementById('connection-panel').style.display = state.tool === 'connect' ? 'block' : 'none';
        const panel = document.getElementById('zone-panel');
        if (zoneId) {
            const zone = state.zones.find(z => z.id === zoneId);
            panel.style.display = 'block';
            const zlabel = document.getElementById('zone-label');
            zlabel.innerHTML = spansToHTML(zone.spans || [[{ text: zone.label || '', bold: false, italic: false }]]);
            // Fallbacks below MIRROR renderZone/renderMultiLineLabel so the panel
            // reflects what a legacy/imported zone actually draws, not a guess:
            //  - label position defaults to 'bottom' (renderMultiLineLabel line ~1051)
            //  - a zone with no fontColor renders its label in the BORDER color
            //  - fill/border can be a non-hex string ('transparent'/'none' from an
            //    import) which a <input type=color> would show as solid black
            const zHex = (c, fallback) => /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
            document.getElementById('zone-label-position').value = zone.labelPosition || 'bottom';
            setSegActive('zone-halign-seg', effectiveLabelAlign(zone));
            setSegActive('zone-valign-seg', effectiveVAlign(zone.labelPosition || 'bottom', zone.labelVAlign));
            document.getElementById('zone-font-family').value = zone.fontFamily || '';
            document.getElementById('zone-font-size').value = zone.fontSize || 20;
            document.getElementById('zone-font-color').value = zHex(zone.fontColor, zHex(zone.borderColor, '#333333'));
            document.getElementById('zone-fill').value = zHex(zone.fill, DEFAULT_ZONE_FILL || '#e8f4fd');
            document.getElementById('zone-border-color').value = zHex(zone.borderColor, defaultZoneBorder());
            document.getElementById('zone-opacity').value = zone.opacity;
            // Imports and our own CSV round-trip store the rectangle shape as
            // 'rectangle'; the <select> option value is 'rect' (both render as a
            // rectangle) - normalize so the dropdown isn't left blank.
            document.getElementById('zone-shape-select').value = (zone.shape === 'rectangle' ? 'rect' : (zone.shape || 'rect'));
            document.getElementById('zone-ap-count').textContent = zone.attachmentPoints ? zone.attachmentPoints.length : 0;
            document.getElementById('zone-ap-slider').value = zone.attachmentPoints ? zone.attachmentPoints.length : 8;
        } else {
            panel.style.display = 'none';
        }
    }

    function migrateLineFormats(obj, labelField) {
        if (!obj.lineFormats) {
            const text = obj[labelField] || '';
            const lines = text.split('\n');
            obj.lineFormats = lines.map(() => ({
                bold: !!obj.fontBold,
                italic: !!obj.fontItalic
            }));
            delete obj.fontBold;
            delete obj.fontItalic;
        }
    }

    function migrateToSpans(obj, labelField) {
        if (obj.spans) return;
        const text = obj[labelField] || '';
        const lines = text.split('\n');
        const fmts = obj.lineFormats || [];
        obj.spans = lines.map((line, i) => {
            const fmt = fmts[i] || { bold: false, italic: false };
            return [{ text: line, bold: !!fmt.bold, italic: !!fmt.italic }];
        });
    }

    function getPlainText(spans) {
        if (!spans || !spans.length) return '';
        return spans.map(lineSpans => lineSpans.map(s => s.text).join('')).join('\n');
    }

    function migrateTextBox(tb) {
        migrateLineFormats(tb, 'text');
        if (!tb.textAlign) tb.textAlign = 'left';
        migrateToSpans(tb, 'text');
    }

    // Older diagrams stored images as plain pictures; give them the label and
    // attachment points so they behave like other connectable objects.
    function migrateImage(img) {
        if (img.label === undefined) img.label = '';
        if (!img.spans) img.spans = [[{ text: img.label || '', bold: false, italic: false }]];
        if (!img.labelPosition) img.labelPosition = 'bottom';
        if (!img.labelVAlign) img.labelVAlign = 'top';
        if (!img.fontSize) img.fontSize = DEFAULT_FONT_SIZE;
        if (!img.fontColor) img.fontColor = '#333333';
        if (!img.attachmentPoints) img.attachmentPoints = getDefaultAttachmentPoints(img.w, img.h);
    }

    function selectTextBox(tbId) {
        clearAnnotationSelection();
        if (tbId) hideBatchPanel();
        state.selectedTextBox = tbId;
        state.selectedDevice = null;
        state.selectedConnection = null;
        state.selectedZone = null;
        state.selectedImage = null;
        renderAllDevices();
        renderAllZones();
        renderAllConnections();

        document.getElementById('device-panel').style.display = 'none';
        document.getElementById('zone-panel').style.display = 'none';
        document.getElementById('image-panel').style.display = 'none';
        document.getElementById('connection-panel').style.display = state.tool === 'connect' ? 'block' : 'none';
        const panel = document.getElementById('textbox-panel');
        if (tbId) {
            const tb = state.textBoxes.find(t => t.id === tbId);
            panel.style.display = 'block';
            const textarea = document.getElementById('textbox-text');
            textarea.innerHTML = spansToHTML(tb.spans || [[{ text: tb.text || '', bold: false, italic: false }]]);
            document.getElementById('textbox-font-size').value = tb.fontSize || 20;
            document.getElementById('textbox-font-color').value = tb.fontColor || '#333333';
            setSegActive('textbox-halign-seg', tb.textAlign || 'left');
            document.getElementById('textbox-font-family').value = tb.fontFamily || '';
        } else {
            panel.style.display = 'none';
        }
    }

    // Text box property listeners
    document.getElementById('textbox-text').addEventListener('input', (e) => {
        if (!state.selectedTextBox) return;
        pushUndoDebounced();
        const tb = state.textBoxes.find(t => t.id === state.selectedTextBox);
        tb.spans = htmlToSpans(e.target.innerHTML);
        tb.text = getPlainText(tb.spans);
        tb.lineFormats = tb.spans.map(ls => ({
            bold: ls.every(s => s.bold), italic: ls.every(s => s.italic)
        }));
        renderTextBox(tb);
    });

    document.getElementById('textbox-font-size').addEventListener('change', (e) => {
        if (!state.selectedTextBox) return;
        pushUndo();
        const tb = state.textBoxes.find(t => t.id === state.selectedTextBox);
        tb.fontSize = parseInt(e.target.value);
        renderTextBox(tb);
    });

    document.getElementById('textbox-font-family').addEventListener('change', (e) => {
        if (!state.selectedTextBox) return;
        pushUndo();
        const tb = state.textBoxes.find(t => t.id === state.selectedTextBox);
        tb.fontFamily = e.target.value || undefined;
        renderTextBox(tb);
    });

    document.getElementById('textbox-font-color').addEventListener('input', (e) => {
        if (!state.selectedTextBox) return;
        pushUndoDebounced();
        const tb = state.textBoxes.find(t => t.id === state.selectedTextBox);
        tb.fontColor = e.target.value;
        clearSpanColors(tb);
        renderTextBox(tb);
    });

    wireAlignSeg('textbox-halign-seg', (val) => {
        if (!state.selectedTextBox) return;
        pushUndo();
        const tb = state.textBoxes.find(t => t.id === state.selectedTextBox);
        tb.textAlign = val;
        renderTextBox(tb);
        setSegActive('textbox-halign-seg', val);
    });

    // Zone property listeners
    document.getElementById('zone-label').addEventListener('input', (e) => {
        if (!state.selectedZone) return;
        pushUndoDebounced();
        const zone = state.zones.find(z => z.id === state.selectedZone);
        zone.spans = htmlToSpans(e.target.innerHTML);
        zone.label = getPlainText(zone.spans);
        zone.lineFormats = zone.spans.map(ls => ({
            bold: ls.every(s => s.bold), italic: ls.every(s => s.italic)
        }));
        renderZone(zone);
    });
    document.getElementById('zone-label-position').addEventListener('change', (e) => {
        if (!state.selectedZone) return;
        pushUndo();
        const zone = state.zones.find(z => z.id === state.selectedZone);
        zone.labelPosition = e.target.value;
        renderZone(zone);
        setSegActive('zone-halign-seg', effectiveLabelAlign(zone));
        setSegActive('zone-valign-seg', effectiveVAlign(zone.labelPosition, zone.labelVAlign));
    });

    wireAlignSeg('zone-halign-seg', (val) => {
        if (!state.selectedZone) return;
        const zone = state.zones.find(z => z.id === state.selectedZone);
        pushUndo();
        zone.labelAlign = zone.labelAlign === val ? 'auto' : val;
        renderZone(zone);
        setSegActive('zone-halign-seg', effectiveLabelAlign(zone));
    });

    wireAlignSeg('zone-valign-seg', (val) => {
        if (!state.selectedZone) return;
        const zone = state.zones.find(z => z.id === state.selectedZone);
        pushUndo();
        zone.labelVAlign = val;
        renderZone(zone);
        setSegActive('zone-valign-seg', val);
    });

    document.getElementById('zone-font-size').addEventListener('change', (e) => {
        if (!state.selectedZone) return;
        pushUndo();
        const zone = state.zones.find(z => z.id === state.selectedZone);
        zone.fontSize = parseInt(e.target.value);
        renderZone(zone);
    });

    document.getElementById('zone-font-family').addEventListener('change', (e) => {
        if (!state.selectedZone) return;
        pushUndo();
        const zone = state.zones.find(z => z.id === state.selectedZone);
        zone.fontFamily = e.target.value || undefined;
        renderZone(zone);
    });

    document.getElementById('zone-font-color').addEventListener('input', (e) => {
        if (!state.selectedZone) return;
        pushUndoDebounced();
        const zone = state.zones.find(z => z.id === state.selectedZone);
        zone.fontColor = e.target.value;
        clearSpanColors(zone);
        renderZone(zone);
    });

    ['zone-fill', 'zone-border-color', 'zone-opacity'].forEach(id => {
        document.getElementById(id).addEventListener('input', () => {
            if (!state.selectedZone) return;
            pushUndoDebounced();
            const zone = state.zones.find(z => z.id === state.selectedZone);
            zone.fill = document.getElementById('zone-fill').value;
            zone.borderColor = document.getElementById('zone-border-color').value;
            zone.opacity = parseFloat(document.getElementById('zone-opacity').value);
            renderZone(zone);
        });
    });

    // Shape swap keeps size, label and attachment points (APs sit on the
    // bounding box for every shape, so connections stay anchored).
    document.getElementById('zone-shape-select').addEventListener('change', (e) => {
        if (!state.selectedZone) return;
        pushUndo();
        const zone = state.zones.find(z => z.id === state.selectedZone);
        zone.shape = e.target.value;
        renderZone(zone);
        setDirty(true);
    });

    document.getElementById('zone-ap-slider').addEventListener('input', (e) => {
        if (!state.selectedZone) return;
        pushUndoDebounced();
        const zone = state.zones.find(z => z.id === state.selectedZone);
        if (!zone.attachmentPoints) zone.attachmentPoints = [];
        setNodeAPCount(zone, parseInt(e.target.value));
        document.getElementById('zone-ap-count').textContent = zone.attachmentPoints.length;
        renderZone(zone);
        rerouteConnectionsForDevice(zone.id);
    });

    // Shape drag-and-drop from sidebar
    document.querySelectorAll('.shape-thumb').forEach(thumb => {
        thumb.addEventListener('dragstart', (e) => {
            if (thumb.dataset.shape) {
                e.dataTransfer.setData('shapeType', thumb.dataset.shape);
            } else if (thumb.dataset.tool === 'textbox') {
                e.dataTransfer.setData('toolType', 'textbox');
            }
            e.dataTransfer.effectAllowed = 'copy';
        });
    });

    // --- Connection Properties (live update) ---
    function updateConnectionStyle() {
        if (!state.selectedConnection) return;
        pushUndoDebounced();
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        conn.color = document.getElementById('conn-color').value;
        conn.thickness = parseInt(document.getElementById('conn-thickness').value);
        conn.dash = document.getElementById('conn-dash').value;
        const newRouting = document.getElementById('conn-routing').value;
        if (newRouting === 'straight' && conn.routing !== 'straight') {
            delete conn.bends;
            delete conn.waypoints;   // straight paths ignore intermediate points
        }
        conn.routing = newRouting;
        conn.startArrow = document.getElementById('conn-start-arrow').value;
        conn.endArrow = document.getElementById('conn-end-arrow').value;
        renderConnection(conn);
    }
    ['conn-thickness', 'conn-dash', 'conn-routing'].forEach(id => {
        document.getElementById(id).addEventListener('change', updateConnectionStyle);
    });
    document.getElementById('conn-color').addEventListener('input', updateConnectionStyle);

    document.getElementById('conn-label').addEventListener('input', (e) => {
        if (!state.selectedConnection) return;
        pushUndoDebounced();
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        conn.spans = htmlToSpans(e.target.innerHTML);
        conn.label = getPlainText(conn.spans);
        conn.lineFormats = conn.spans.map(ls => ({
            bold: ls.every(s => s.bold), italic: ls.every(s => s.italic)
        }));
        renderConnection(conn);
    });
    document.getElementById('conn-font-size').addEventListener('change', (e) => {
        if (!state.selectedConnection) return;
        pushUndo();
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        conn.fontSize = parseInt(e.target.value);
        renderConnection(conn);
    });

    document.getElementById('conn-font-family').addEventListener('change', (e) => {
        if (!state.selectedConnection) return;
        pushUndo();
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        conn.fontFamily = e.target.value || undefined;
        renderConnection(conn);
    });

    document.getElementById('conn-label-position').addEventListener('change', (e) => {
        if (!state.selectedConnection) return;
        pushUndo();
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        conn.labelPosition = e.target.value;
        renderConnection(conn);
        setSegActive('conn-halign-seg', effectiveLabelAlign(conn));
    });

    wireAlignSeg('conn-halign-seg', (val) => {
        if (!state.selectedConnection) return;
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        pushUndo();
        conn.labelAlign = conn.labelAlign === val ? 'auto' : val;
        renderConnection(conn);
        setSegActive('conn-halign-seg', effectiveLabelAlign(conn));
    });

    wireAlignSeg('conn-valign-seg', (val) => {
        if (!state.selectedConnection) return;
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        pushUndo();
        conn.labelVAlign = val;
        renderConnection(conn);
        setSegActive('conn-valign-seg', val);
    });

    document.getElementById('conn-font-color').addEventListener('input', (e) => {
        if (!state.selectedConnection) return;
        pushUndoDebounced();
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        conn.fontColor = e.target.value;
        clearSpanColors(conn);
        renderConnection(conn);
    });

    document.getElementById('conn-start-arrow').addEventListener('change', (e) => {
        if (!state.selectedConnection) return;
        pushUndo();
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        conn.startArrow = e.target.value;
        renderConnection(conn);
    });

    document.getElementById('conn-end-arrow').addEventListener('change', (e) => {
        if (!state.selectedConnection) return;
        pushUndo();
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        conn.endArrow = e.target.value;
        renderConnection(conn);
    });

    document.getElementById('conn-arrow-scale').addEventListener('change', (e) => {
        if (!state.selectedConnection) return;
        pushUndo();
        const conn = state.connections.find(c => c.id === state.selectedConnection);
        conn.arrowScale = parseFloat(e.target.value) || 1;
        renderConnection(conn);
    });

    // --- Delete ---
    function selectAll() {
        selectDevice(null); selectZone(null); selectConnection(null); selectTextBox(null); selectImage(null);
        state.selectedDevices = tierBlocked('devices') ? [] : state.devices.map(d => d.id);
        state.selectedZones = tierBlocked('zones') ? [] : state.zones.map(z => z.id);
        state.selectedTextBoxes = tierBlocked('devices') ? [] : state.textBoxes.map(t => t.id);
        state.selectedImages = tierBlocked('images') ? [] : state.images.map(i => i.id);
        // Match the marquee's semantics: connections whose endpoints are both
        // selected join the selection, and the batch panel opens.
        const devSet = new Set(state.selectedDevices);
        state.selectedConnections = tierBlocked('connections') ? [] : state.connections
            .filter(c => c.fromDevice && c.toDevice && devSet.has(c.fromDevice) && devSet.has(c.toDevice))
            .map(c => c.id);
        renderAllZones(); renderAllImages(); renderAllDevices(); renderAllConnections();
        refreshBatchPanel();
    }

    function deselectAll() {
        clearMultiSelect();
        selectDevice(null); selectZone(null); selectConnection(null); selectTextBox(null); selectImage(null);
    }

    // Move every selected object (single or multi) by dx,dy. Returns false if
    // nothing is selected.
    function nudgeSelection(dx, dy) {
        const devIds = new Set(state.selectedDevices); if (state.selectedDevice) devIds.add(state.selectedDevice);
        const zoneIds = new Set(state.selectedZones); if (state.selectedZone) zoneIds.add(state.selectedZone);
        const tbIds = new Set(state.selectedTextBoxes); if (state.selectedTextBox) tbIds.add(state.selectedTextBox);
        const imgIds = new Set(state.selectedImages); if (state.selectedImage) imgIds.add(state.selectedImage);
        // Selected connections with a free-floating end move on their own -
        // no node carries them - so a selection of ONLY those is still a
        // nudgeable selection.
        const connIds = new Set(state.selectedConnections);
        if (state.selectedConnection) connIds.add(state.selectedConnection);
        // Same rule as the drag path: only nudge a connection whose WHOLE
        // geometry travels. A fully free-floating one does (both ends are
        // ours); a mixed one only when its device end is moving too, otherwise
        // arrow keys would stretch the free end away from its anchor and
        // distort the line rather than move it.
        const nudgedNodes = new Set([...devIds, ...zoneIds]);
        const endTravels = (devId, pt) => !!pt || nudgedNodes.has(devId);
        const freeConns = [...connIds]
            .map(id => state.connections.find(c => c.id === id))
            .filter(c => c && (c.fromPoint || c.toPoint) &&
                         endTravels(c.fromDevice, c.fromPoint) &&
                         endTravels(c.toDevice, c.toPoint));
        if (!devIds.size && !zoneIds.size && !tbIds.size && !imgIds.size && !freeConns.length) return false;
        pushUndoDebounced();
        const affected = new Set();
        devIds.forEach(id => { const d = state.devices.find(x => x.id === id); if (d) { d.x += dx; d.y += dy; affected.add(id); renderDevice(d); } });
        zoneIds.forEach(id => { const z = state.zones.find(x => x.id === id); if (z) { z.x += dx; z.y += dy; affected.add(id); renderZone(z); } });
        tbIds.forEach(id => { const t = state.textBoxes.find(x => x.id === id); if (t) { t.x += dx; t.y += dy; renderTextBox(t); } });
        imgIds.forEach(id => { const im = state.images.find(x => x.id === id); if (im) { im.x += dx; im.y += dy; affected.add(id); renderImage(im); } });
        freeConns.forEach(c => {
            if (c.fromPoint) { c.fromPoint.x += dx; c.fromPoint.y += dy; }
            if (c.toPoint) { c.toPoint.x += dx; c.toPoint.y += dy; }
            if (c.waypoints) c.waypoints.forEach(w => { w.x += dx; w.y += dy; });
        });
        const nudged = new Set();
        state.connections.filter(c => affected.has(c.fromDevice) || affected.has(c.toDevice))
            .forEach(c => { nudged.add(c.id); renderConnection(c); });
        freeConns.forEach(c => { if (!nudged.has(c.id)) renderConnection(c); });
        updateCanvasSize();
        return true;
    }

    // Collect selected objects with bounding boxes for align/distribute.
    function getSelectionEntries() {
        const entries = [];
        const devIds = new Set(state.selectedDevices); if (state.selectedDevice) devIds.add(state.selectedDevice);
        const zoneIds = new Set(state.selectedZones); if (state.selectedZone) zoneIds.add(state.selectedZone);
        const tbIds = new Set(state.selectedTextBoxes); if (state.selectedTextBox) tbIds.add(state.selectedTextBox);
        const imgIds = new Set(state.selectedImages); if (state.selectedImage) imgIds.add(state.selectedImage);
        devIds.forEach(id => { const d = state.devices.find(x => x.id === id); if (d) entries.push({ ref: d, w: d.w, h: d.h, render: renderDevice, connects: true }); });
        zoneIds.forEach(id => { const z = state.zones.find(x => x.id === id); if (z) entries.push({ ref: z, w: z.w, h: z.h, render: renderZone, connects: true }); });
        imgIds.forEach(id => { const im = state.images.find(x => x.id === id); if (im) entries.push({ ref: im, w: im.w, h: im.h, render: renderImage, connects: true }); });
        tbIds.forEach(id => { const t = state.textBoxes.find(x => x.id === id); if (t) { const r = textBoxRect(t); entries.push({ ref: t, w: r.w, h: r.h, render: renderTextBox, connects: false }); } });
        return entries;
    }

    function redrawEntries(entries) {
        const affected = new Set();
        entries.forEach(e => { e.render(e.ref); if (e.connects) affected.add(e.ref.id); });
        state.connections.filter(c => affected.has(c.fromDevice) || affected.has(c.toDevice)).forEach(renderConnection);
        updateCanvasSize();
    }

    function alignSelected(mode) {
        const entries = getSelectionEntries();
        if (entries.length < 2) return;
        pushUndo();
        const minL = Math.min(...entries.map(e => e.ref.x));
        const maxR = Math.max(...entries.map(e => e.ref.x + e.w));
        const minT = Math.min(...entries.map(e => e.ref.y));
        const maxB = Math.max(...entries.map(e => e.ref.y + e.h));
        const cx = (minL + maxR) / 2, cy = (minT + maxB) / 2;
        entries.forEach(e => {
            if (mode === 'left') e.ref.x = minL;
            else if (mode === 'right') e.ref.x = maxR - e.w;
            else if (mode === 'hcenter') e.ref.x = Math.round(cx - e.w / 2);
            else if (mode === 'top') e.ref.y = minT;
            else if (mode === 'bottom') e.ref.y = maxB - e.h;
            else if (mode === 'vcenter') e.ref.y = Math.round(cy - e.h / 2);
        });
        redrawEntries(entries);
    }

    // Even spacing of object centers between the first and last (by position).
    function distributeSelected(axis) {
        const entries = getSelectionEntries();
        if (entries.length < 3) return;
        pushUndo();
        const center = e => axis === 'h' ? e.ref.x + e.w / 2 : e.ref.y + e.h / 2;
        entries.sort((a, b) => center(a) - center(b));
        const first = center(entries[0]), last = center(entries[entries.length - 1]);
        const gap = (last - first) / (entries.length - 1);
        entries.forEach((e, i) => {
            const c = first + gap * i;
            if (axis === 'h') e.ref.x = Math.round(c - e.w / 2);
            else e.ref.y = Math.round(c - e.h / 2);
        });
        redrawEntries(entries);
    }

    function deleteSelected() {
        // A selected connection annotation deletes on its own, not the connection
        if (state.selectedAnnotation) {
            const sel = getSelectedAnnotation();
            if (sel) {
                pushUndo();
                sel.conn.annotations = sel.conn.annotations.filter(a => a.id !== sel.ann.id);
                renderConnection(sel.conn);
            }
            clearAnnotationSelection();
            return;
        }
        const hasSelection = state.selectedDevices.length > 0 || state.selectedZones.length > 0 ||
            state.selectedTextBoxes.length > 0 || state.selectedImages.length > 0 || state.selectedConnections.length > 0 ||
            state.selectedDevice || state.selectedZone || state.selectedConnection || state.selectedTextBox || state.selectedImage;
        if (hasSelection) pushUndo();
        if (state.selectedDevices.length > 0 || state.selectedZones.length > 0 || state.selectedTextBoxes.length > 0 || state.selectedImages.length > 0 || state.selectedConnections.length > 0) {
            const deviceIds = new Set(state.selectedDevices);
            const zoneIds = new Set(state.selectedZones);
            const tbIds = new Set(state.selectedTextBoxes);
            const imgIds = new Set(state.selectedImages);
            const connIds = new Set(state.selectedConnections);
            // Connections cascade with ANY deleted endpoint node - zones and
            // images are connectable too, and an orphaned endpoint id renders
            // as nothing but lives in every save forever.
            const nodeIds = new Set([...deviceIds, ...zoneIds, ...imgIds]);
            state.connections = state.connections.filter(
                c => !nodeIds.has(c.fromDevice) && !nodeIds.has(c.toDevice) && !connIds.has(c.id)
            );
            state.devices = state.devices.filter(d => !deviceIds.has(d.id));
            state.zones = state.zones.filter(z => !zoneIds.has(z.id));
            state.textBoxes = state.textBoxes.filter(t => !tbIds.has(t.id));
            state.images = state.images.filter(i => !imgIds.has(i.id));
            state.selectedDevices = [];
            state.selectedZones = [];
            state.selectedTextBoxes = [];
            state.selectedImages = [];
            state.selectedConnections = [];
            state.selectedDevice = null;
            state.selectedZone = null;
            state.selectedTextBox = null;
            state.selectedImage = null;
            hideBatchPanel();
            renderAllZones();
            renderAllImages();
            renderAllDevices();
            renderAllConnections();
            document.getElementById('device-panel').style.display = 'none';
            document.getElementById('zone-panel').style.display = 'none';
            document.getElementById('textbox-panel').style.display = 'none';
        } else if (state.selectedImage) {
            state.connections = state.connections.filter(
                c => c.fromDevice !== state.selectedImage && c.toDevice !== state.selectedImage
            );
            state.images = state.images.filter(i => i.id !== state.selectedImage);
            state.selectedImage = null;
            renderAllImages();
            renderAllConnections();
        } else if (state.selectedDevice) {
            state.connections = state.connections.filter(
                c => c.fromDevice !== state.selectedDevice && c.toDevice !== state.selectedDevice
            );
            state.devices = state.devices.filter(d => d.id !== state.selectedDevice);
            state.selectedDevice = null;
            renderAllDevices();
            renderAllConnections();
            document.getElementById('device-panel').style.display = 'none';
        } else if (state.selectedZone) {
            state.connections = state.connections.filter(
                c => c.fromDevice !== state.selectedZone && c.toDevice !== state.selectedZone
            );
            state.zones = state.zones.filter(z => z.id !== state.selectedZone);
            state.selectedZone = null;
            renderAllZones();
            renderAllConnections();
            document.getElementById('zone-panel').style.display = 'none';
        } else if (state.selectedTextBox) {
            state.textBoxes = state.textBoxes.filter(t => t.id !== state.selectedTextBox);
            state.selectedTextBox = null;
            renderAllDevices();
            document.getElementById('textbox-panel').style.display = 'none';
        } else if (state.selectedConnection) {
            state.connections = state.connections.filter(c => c.id !== state.selectedConnection);
            state.selectedConnection = null;
            renderAllConnections();
        }
        pruneGroups();   // drop deleted members; groups need at least two
    }

    document.addEventListener('paste', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        if (state.inlineEditing && state.inlineEditing.element.contains(e.target)) return;
        const items = e.clipboardData?.items;
        if (!items) return;
        for (const item of items) {
            if (item.type.startsWith('image/')) {
                e.preventDefault();
                const blob = item.getAsFile();
                const reader = new FileReader();
                reader.onload = (ev) => {
                    const img = new Image();
                    img.onload = () => {
                        const container = document.getElementById('canvas-container');
                        const maxW = 400;
                        let w = img.width, h = img.height;
                        if (w > maxW) { h = Math.round(h * maxW / w); w = maxW; }
                        // Extreme aspect ratios must not snap a side to 0
                        // (an invisible-but-present object)
                        w = Math.max(GRID_SIZE, snapToGrid(w));
                        h = Math.max(GRID_SIZE, snapToGrid(h));
                        const cx = snapToGrid(container.scrollLeft + container.clientWidth / 2 - w / 2);
                        const cy = snapToGrid(container.scrollTop + container.clientHeight / 2 - h / 2);
                        const pastedImage = {
                            id: genId(),
                            x: cx,
                            y: cy,
                            w: w,
                            h: h,
                            dataURL: ev.target.result,
                            label: '',
                            spans: [[{ text: '', bold: false, italic: false }]],
                            labelPosition: 'bottom',
                            fontSize: DEFAULT_FONT_SIZE,
                            fontColor: DEFAULT_FONT_COLOR,
                            fontFamily: DEFAULT_FONT_FAMILY || undefined,
                            attachmentPoints: defaultAPsFor(w, h)
                        };
                        pushUndo();
                        ensureTierVisible('images');
                        state.images.push(pastedImage);
                        clearMultiSelect();
                        selectImage(pastedImage.id);
                        renderImage(pastedImage);
                        updateCanvasSize();
                    };
                    img.src = ev.target.result;
                };
                reader.readAsDataURL(blob);
                return;
            }
        }
    });

    // --- Find on canvas (Ctrl+F) -------------------------------------------
    // Locate a device (or zone) on a big board by label / Hostname / IP -
    // pans to the match, selects it, Enter / Shift+Enter cycle, Esc closes.
    // The palette search finds stencils; this finds what's already placed.
    const findBox = document.getElementById('canvas-find');
    const findInput = document.getElementById('canvas-find-input');
    const findCountEl = document.getElementById('canvas-find-count');
    let findMatches = [], findIdx = -1;
    function canvasFindMatches(q) {
        q = q.trim().toLowerCase();
        if (!q) return [];
        const hit = (s) => s && String(s).toLowerCase().includes(q);
        const out = [];
        state.devices.forEach(d => {
            if (hit(d.label) || (d.fields && (hit(d.fields.Hostname) || hit(d.fields['IP-Address'])))) {
                out.push({ kind: 'device', obj: d });
            }
        });
        state.zones.forEach(z => { if (hit(z.label)) out.push({ kind: 'zone', obj: z }); });
        return out;
    }
    // Three separable jobs, kept separate: the count label render, showing an
    // ABSOLUTE match index, and the +/-1 wrap arithmetic (keydown handler).
    function renderFindCount() {
        findCountEl.textContent = findMatches.length
            ? (findIdx + 1) + '/' + findMatches.length
            : (findInput.value.trim() ? '0' : '');
    }
    function showFindMatch(idx) {
        findIdx = findMatches.length ? idx : -1;
        renderFindCount();
        if (findIdx < 0) return;
        const m = findMatches[findIdx];
        const o = m.obj;
        container.scrollLeft = (o.x + o.w / 2) * state.zoom - container.clientWidth / 2;
        container.scrollTop = (o.y + o.h / 2) * state.zoom - container.clientHeight / 2;
        // Skip the re-select when the match hasn't changed - selectDevice
        // does a full board re-render, and per-keystroke teardown on a
        // 500-device import is exactly the case find exists for.
        if (m.kind === 'device') {
            if (state.selectedDevice !== o.id) selectDevice(o.id);
        } else if (state.selectedZone !== o.id) {
            selectZone(o.id);
        }
    }
    function stepFindMatch(step) {
        if (!findMatches.length) { showFindMatch(0); return; }
        showFindMatch(((findIdx + step) % findMatches.length + findMatches.length) % findMatches.length);
    }
    function runCanvasFind() {
        findMatches = canvasFindMatches(findInput.value);
        showFindMatch(0);
    }
    function openCanvasFind() {
        findBox.style.display = 'flex';
        findInput.select();
        findInput.focus();
        if (findInput.value) runCanvasFind();
    }
    function closeCanvasFind() {
        findBox.style.display = 'none';
        findInput.blur();
    }
    findInput.addEventListener('input', runCanvasFind);
    findInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); stepFindMatch(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); closeCanvasFind(); }
        e.stopPropagation();
    });

    // Alt is a drag modifier here (fine move/resize, zone marquee) - its
    // release must not activate the browser's menu bar, which Firefox does
    // on Alt keyup: with the menu bar hidden that reflows the page and
    // bounces the viewport mid-edit. Suppress the default outside text
    // inputs; typing fields and Alt-based IME input stay untouched.
    document.addEventListener('keyup', (e) => {
        if (e.key !== 'Alt') return;
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' ||
            e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        e.preventDefault();
    });

    document.addEventListener('keydown', (e) => {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
        if (state.inlineEditing) return;
        // A modal dialog owns the keyboard: canvas shortcuts must not fire
        // behind it (Delete would silently remove the hidden selection), and
        // Ctrl+F should stay the browser's own find so an open Help page is
        // searchable. Escape still closes the dialog natively.
        if (document.querySelector('dialog[open]')) return;

        // Ctrl+F - find on canvas (override the browser's page find)
        if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
            e.preventDefault();
            openCanvasFind();
            return;
        }

        // "?" opens the keyboard-shortcuts help (no modifiers)
        if (e.key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault();
            showHelp('shortcuts', 'Keyboard Shortcuts');
            return;
        }

        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            undo();
            return;
        }
        if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
            e.preventDefault();
            redo();
            return;
        }

        // Ctrl+S - save (override the browser's page-save)
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveDiagram();
            return;
        }
        // Ctrl+O - open (the File menu advertised this but it wasn't wired,
        // so it fell through to the browser's own open dialog)
        if ((e.ctrlKey || e.metaKey) && e.key === 'o') {
            e.preventDefault();
            if (state.dirty && !confirm('You have unsaved changes. Discard them and load a new diagram?')) return;
            document.getElementById('file-load').click();
            return;
        }
        // Ctrl+A - select all
        if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
            e.preventDefault();
            selectAll();
            return;
        }
        // Ctrl+D - duplicate selection
        if ((e.ctrlKey || e.metaKey) && e.key === 'd') {
            e.preventDefault();
            if (copySelection()) pasteClipboard();
            return;
        }
        // Ctrl+G - group selection; Ctrl+Shift+G - ungroup
        if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
            e.preventDefault();
            if (e.shiftKey) ungroupSelection();
            else groupSelection();
            return;
        }
        // Zoom: Ctrl + / Ctrl - / Ctrl 0
        if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
            e.preventDefault();
            setZoom(state.zoom * 1.2);
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === '-') {
            e.preventDefault();
            setZoom(state.zoom / 1.2);
            return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === '0') {
            e.preventDefault();
            setZoom(1);
            return;
        }

        // Escape - cancel an in-progress connection or an armed text tool,
        // else deselect everything
        if (e.key === 'Escape') {
            if (state.connecting) {
                const tl = document.getElementById('temp-connection');
                if (tl) tl.remove();
                state.connecting = null;
                if (state.tool === 'connect') setTool('select');
            } else if (state.tool === 'text') {
                setTool('select');
            } else {
                deselectAll();
            }
            return;
        }

        // Arrow keys - nudge selection (full grid; Shift for 5px fine, Alt for 1px)
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            const step = e.altKey ? 1 : (e.shiftKey ? GRID_SIZE / 2 : GRID_SIZE);
            let dx = 0, dy = 0;
            if (e.key === 'ArrowLeft') dx = -step;
            else if (e.key === 'ArrowRight') dx = step;
            else if (e.key === 'ArrowUp') dy = -step;
            else dy = step;
            if (nudgeSelection(dx, dy)) e.preventDefault();
            return;
        }

        if (e.key === 'Delete') {
            deleteSelected();
            return;
        }

        if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1) {
            let input = null;
            if (state.selectedDevice) {
                input = document.getElementById('device-label');
            } else if (state.selectedZone) {
                input = document.getElementById('zone-label');
            } else if (state.selectedConnection) {
                input = document.getElementById('conn-label');
            } else if (state.selectedTextBox) {
                input = document.getElementById('textbox-text');
            }
            if (input) {
                e.preventDefault();
                input.textContent = e.key;
                input.focus();
                // Place cursor at end
                const sel = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(input);
                range.collapse(false);
                sel.removeAllRanges();
                sel.addRange(range);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }
        }

        // Copy: Ctrl+C
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            if (copySelection()) e.preventDefault();
        }

        // Paste: Ctrl+V
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
            if (state.clipboard) e.preventDefault();
            pasteClipboard();
        }
    });

    function copySelection() {
        const devicesToCopy = [];
        const zonesToCopy = [];
        const imagesToCopy = [];
        const textBoxesToCopy = [];
        const connectionsToCopy = [];
        const clone = o => JSON.parse(JSON.stringify(o));

        const devIds = new Set(state.selectedDevices); if (state.selectedDevice) devIds.add(state.selectedDevice);
        const zoneIds = new Set(state.selectedZones); if (state.selectedZone) zoneIds.add(state.selectedZone);
        const imgIds = new Set(state.selectedImages); if (state.selectedImage) imgIds.add(state.selectedImage);
        const tbIds = new Set(state.selectedTextBoxes); if (state.selectedTextBox) tbIds.add(state.selectedTextBox);

        devIds.forEach(id => { const d = state.devices.find(x => x.id === id); if (d) devicesToCopy.push(clone(d)); });
        zoneIds.forEach(id => { const z = state.zones.find(x => x.id === id); if (z) zonesToCopy.push(clone(z)); });
        imgIds.forEach(id => { const im = state.images.find(x => x.id === id); if (im) imagesToCopy.push(clone(im)); });
        tbIds.forEach(id => { const t = state.textBoxes.find(x => x.id === id); if (t) textBoxesToCopy.push(clone(t)); });

        // Copy connections whose both endpoints are among the copied nodes
        const nodeIds = new Set([...devIds, ...zoneIds, ...imgIds]);
        state.connections.forEach(c => {
            if (nodeIds.has(c.fromDevice) && nodeIds.has(c.toDevice)) connectionsToCopy.push(clone(c));
        });

        // Copy groups whose members are all among the copied objects
        const copiedIds = new Set([...devIds, ...zoneIds, ...imgIds, ...tbIds]);
        const groupsToCopy = state.groups
            .filter(g => g.members.length && g.members.every(m => copiedIds.has(m)))
            .map(clone);

        if (devicesToCopy.length || zonesToCopy.length || imagesToCopy.length || textBoxesToCopy.length) {
            state.clipboard = { devices: devicesToCopy, zones: zonesToCopy, images: imagesToCopy, textBoxes: textBoxesToCopy, connections: connectionsToCopy, groups: groupsToCopy };
            return true;
        }
        return false;
    }

    function pasteClipboard() {
        if (!state.clipboard) return;
        pushUndo();

        const offset = GRID_SIZE;
        clearMultiSelect();
        selectDevice(null);
        selectZone(null);

        const idMap = {};
        const newDeviceIds = [];
        const newZoneIds = [];
        const newImageIds = [];
        const newTextBoxIds = [];
        const clone = o => JSON.parse(JSON.stringify(o));

        state.clipboard.devices.forEach(src => {
            const newId = genId();
            idMap[src.id] = newId;
            const newDevice = clone(src);
            newDevice.id = newId;
            newDevice.x += offset;
            newDevice.y += offset;
            state.devices.push(newDevice);
            renderDevice(newDevice);
            newDeviceIds.push(newId);
        });

        state.clipboard.zones.forEach(src => {
            const newId = genId();
            idMap[src.id] = newId;
            const newZone = clone(src);
            newZone.id = newId;
            newZone.x += offset;
            newZone.y += offset;
            state.zones.push(newZone);
            renderZone(newZone);
            newZoneIds.push(newId);
        });

        (state.clipboard.images || []).forEach(src => {
            const newId = genId();
            idMap[src.id] = newId;
            const newImg = clone(src);
            newImg.id = newId;
            newImg.x += offset;
            newImg.y += offset;
            state.images.push(newImg);
            renderImage(newImg);
            newImageIds.push(newId);
        });

        (state.clipboard.textBoxes || []).forEach(src => {
            const newId = genId();
            idMap[src.id] = newId;
            const newTb = clone(src);
            newTb.id = newId;
            newTb.x += offset;
            newTb.y += offset;
            state.textBoxes.push(newTb);
            renderTextBox(newTb);
            newTextBoxIds.push(newId);
        });

        (state.clipboard.connections || []).forEach(src => {
            const newConn = clone(src);
            newConn.id = genId();
            newConn.fromDevice = idMap[src.fromDevice];
            newConn.toDevice = idMap[src.toDevice];
            if (newConn.waypoints) {
                newConn.waypoints = newConn.waypoints.map(w => ({ x: w.x + offset, y: w.y + offset }));
            }
            if (newConn.fromDevice && newConn.toDevice) {
                state.connections.push(newConn);
                renderConnection(newConn);
            }
        });

        // Re-create copied groups over the pasted objects' new ids
        (state.clipboard.groups || []).forEach(src => {
            const members = src.members.map(m => idMap[m]).filter(Boolean);
            if (members.length >= 2) state.groups.push({ id: genId(), members });
        });

        const totalNew = newDeviceIds.length + newZoneIds.length + newImageIds.length + newTextBoxIds.length;
        if (totalNew === 1 && newDeviceIds.length === 1) {
            selectDevice(newDeviceIds[0]);
        } else if (totalNew === 1 && newZoneIds.length === 1) {
            selectZone(newZoneIds[0]);
        } else if (totalNew === 1 && newImageIds.length === 1) {
            selectImage(newImageIds[0]);
        } else if (totalNew === 1 && newTextBoxIds.length === 1) {
            selectTextBox(newTextBoxIds[0]);
        } else {
            state.selectedDevices = newDeviceIds;
            state.selectedZones = newZoneIds;
            state.selectedImages = newImageIds;
            state.selectedTextBoxes = newTextBoxIds;
            renderAllDevices();
            renderAllZones();
            renderAllImages();
        }
        updateCanvasSize();
    }

    // --- Z-order / arrange ---
    // Stacking within a render layer follows array order (later = on top),
    // except devices and text boxes: they share the devices layer, so they
    // interleave on a per-object stackZ key. Objects without stackZ sort as
    // front-most (new objects land on top; the stable sort keeps untouched
    // diagrams in the historical order - devices first, text boxes above).
    // stackZ is materialized for the whole shared layer on the first arrange
    // and persists through save/undo like any other object field.
    // All arrange entry points (menu, toolbar, context menu) accept
    // multi-selections and preserve the selection's relative order.

    // Reorder the members of `ids` within arr; returns the new array, or null
    // when nothing would move.
    function reorderSet(arr, ids, mode) {
        if (!arr.some(o => ids.has(o.id))) return null;
        let out;
        if (mode === 'front') {
            out = arr.filter(o => !ids.has(o.id)).concat(arr.filter(o => ids.has(o.id)));
        } else if (mode === 'back') {
            out = arr.filter(o => ids.has(o.id)).concat(arr.filter(o => !ids.has(o.id)));
        } else {
            // Step each selected object past its unselected neighbor
            out = arr.slice();
            if (mode === 'forward') {
                for (let i = out.length - 2; i >= 0; i--) {
                    if (ids.has(out[i].id) && !ids.has(out[i + 1].id)) {
                        const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t;
                    }
                }
            } else if (mode === 'backward') {
                for (let i = 1; i < out.length; i++) {
                    if (ids.has(out[i].id) && !ids.has(out[i - 1].id)) {
                        const t = out[i]; out[i] = out[i - 1]; out[i - 1] = t;
                    }
                }
            }
        }
        return out.some((o, i) => o !== arr[i]) ? out : null;
    }

    // Devices + text boxes in visual stacking order (back to front).
    function deviceLayerStack() {
        const zOf = (o) => o.stackZ === undefined ? Infinity : o.stackZ;
        return [...state.devices, ...state.textBoxes].sort((a, b) => zOf(a) - zOf(b));
    }

    function arrangeSelected(mode) {
        const devIds = new Set(state.selectedDevices); if (state.selectedDevice) devIds.add(state.selectedDevice);
        const tbIds = new Set(state.selectedTextBoxes); if (state.selectedTextBox) tbIds.add(state.selectedTextBox);
        const zoneIds = new Set(state.selectedZones); if (state.selectedZone) zoneIds.add(state.selectedZone);
        const imgIds = new Set(state.selectedImages); if (state.selectedImage) imgIds.add(state.selectedImage);
        const devLayerIds = new Set([...devIds, ...tbIds]);

        const newStack = devLayerIds.size ? reorderSet(deviceLayerStack(), devLayerIds, mode) : null;
        const newZones = zoneIds.size ? reorderSet(state.zones, zoneIds, mode) : null;
        const newImages = imgIds.size ? reorderSet(state.images, imgIds, mode) : null;
        if (!newStack && !newZones && !newImages) return;
        pushUndo();
        if (newStack) { newStack.forEach((o, i) => { o.stackZ = i; }); renderAllDevices(); }
        if (newZones) { state.zones = newZones; renderAllZones(); }
        if (newImages) { state.images = newImages; renderAllImages(); }
    }

    // Build a small, representative sample network so a fresh visitor / shared
    // link shows something real instead of a blank canvas. Constructed at runtime
    // from the loaded stencil library so it uses the real icons (no embedded
    // base64) and works on file://. Loads without marking the diagram dirty.
    // Single reset for every diagram-replacing path (New, sample, importers).
    // The hand-rolled copies of this list had drifted - images, groups and
    // the connection multi-selection were missing from some, which leaked
    // content and phantom groups across documents.
    function resetDocumentState() {
        state.devices = [];
        state.zones = [];
        state.connections = [];
        state.textBoxes = [];
        state.images = [];
        state.groups = [];
        state.selectedDevice = null;
        state.selectedZone = null;
        state.selectedConnection = null;
        state.selectedTextBox = null;
        state.selectedImage = null;
        state.selectedDevices = [];
        state.selectedZones = [];
        state.selectedTextBoxes = [];
        state.selectedImages = [];
        state.selectedConnections = [];
        clearAnnotationSelection();
        state.clipboard = null;
    }

    function buildSampleDiagram() {
        resetDocumentState();
        state.nextId = 1;

        const tmpl = name => state.deviceTemplates.find(t => t.name === name);
        // Samples inherit the active theme via the shared themed-device
        // factory (fixed-8 APs: the conn() hookups below use AP indices).
        function dev(name, label, x, y) {
            const d = makeThemedDevice(tmpl(name), label, x, y, {
                w: 60, labelPosition: 'left', labelVAlign: 'top', fontSize: 16,
                aps: getDefaultAttachmentPoints(60, 60)
            });
            state.devices.push(d);
            return d;
        }
        function conn(from, fromAP, to, toAP) {
            state.connections.push({
                id: genId(), fromDevice: from.id, fromAP: fromAP, toDevice: to.id, toAP: toAP,
                color: DEFAULT_CONN_COLOR, thickness: 2, dash: 'solid', routing: 'rounded',
                label: '', labelPosition: 'top', labelVAlign: 'top', fontSize: 16, fontColor: DEFAULT_FONT_COLOR,
                lineFormats: [], spans: [], startArrow: 'none', endArrow: 'none', annotations: []
            });
        }

        // A LAN zone behind the bottom cluster (shows zones + an inside label)
        state.zones.push({
            id: genId(), shape: 'rectangle', x: 120, y: 440, w: 520, h: 280,
            label: 'LAN Segment', labelPosition: 'top-inside', labelVAlign: 'top',
            fontSize: 16, fontColor: defaultZoneBorder(), lineFormats: [],
            spans: [[{ text: 'LAN Segment', bold: true, italic: false }]],
            fill: DEFAULT_ZONE_FILL || '#e8f4fd', borderColor: defaultZoneBorder(), opacity: 1,
            attachmentPoints: getDefaultAttachmentPoints(520, 280)
        });

        const internet = dev('Cloud', 'Internet', 360, 60);
        const fw = dev('Firewall', 'Firewall', 360, 200);
        const router = dev('Router', 'Router', 360, 320);
        const sw = dev('Switch', 'Switch', 360, 480);
        // DB Server sits left of Web Server so Web Server's left-side label
        // stays inside the LAN zone instead of clipping over its border.
        const db = dev('Server', 'DB Server', 200, 620);
        const web = dev('Server', 'Web Server', 360, 620);
        const ws = dev('Client', 'Workstation', 520, 620);

        conn(internet, 4, fw, 0);
        conn(fw, 4, router, 0);
        conn(router, 4, sw, 0);
        conn(sw, 5, db, 0);
        conn(sw, 4, web, 0);
        conn(sw, 3, ws, 0);

        state.diagramTitle = 'network-diagram';
        state.diagramVersion = 1;
        setDirty(false);
        undoStack.length = 0;
        redoStack.length = 0;
        updateUndoRedoButtons();
        updateTitleVersionUI();
        renderAll();
        updateCanvasSize();
    }

    function loadSampleDiagram() {
        if (state.dirty && !confirm('You have unsaved changes. Discard them and load the sample diagram?')) return;
        buildSampleDiagram();
    }

    // A bigger showcase: multi-site enterprise network - HQ with VLAN zones,
    // two branch offices, a cloud environment, WAN/VPN links and a colored
    // legend. Same runtime construction as the small sample (real library
    // icons, no embedded base64, works on file://).
    function buildComplexSampleDiagram() {
        resetDocumentState();
        state.nextId = 1;

        const tmpl = name => state.deviceTemplates.find(t => t.name === name);
        // Theme-aware like the small sample: devices, default zones, and the
        // primary link color follow the active theme; the green/amber accent
        // zones and the VPN/Wi-Fi link colors stay fixed (they're the "user
        // customized these" part of the showcase and read on any theme).
        function dev(name, label, x, y, w, h) {
            const dw = w || 60, dh = h || w || 60;
            const d = makeThemedDevice(tmpl(name), label, x, y, {
                w: dw, h: dh, fontSize: 14,
                aps: getDefaultAttachmentPoints(dw, dh)
            });
            state.devices.push(d);
            return d;
        }
        // Nearest AP to a fractional point of the node box - self-documenting
        // hookups without hardcoding layout indexes.
        function apAt(node, fx, fy) {
            let best = 0, bd = Infinity;
            node.attachmentPoints.forEach((ap, i) => {
                const d = (ap.rx - fx * node.w) ** 2 + (ap.ry - fy * node.h) ** 2;
                if (d < bd) { bd = d; best = i; }
            });
            return best;
        }
        function conn(a, afx, afy, b, bfx, bfy, opts) {
            const o = opts || {};
            const c = {
                id: genId(),
                fromDevice: a.id, fromAP: apAt(a, afx, afy),
                toDevice: b.id, toAP: apAt(b, bfx, bfy),
                color: o.color || DEFAULT_CONN_COLOR, thickness: o.thickness || 2,
                dash: o.dash || 'solid', routing: 'rounded',
                label: o.label || '', labelPosition: 'top', labelVAlign: 'top',
                fontSize: 13, fontColor: o.color || DEFAULT_FONT_COLOR,
                lineFormats: [], spans: o.label ? [[{ text: o.label, bold: false, italic: false }]] : [],
                startArrow: 'none', endArrow: o.endArrow || 'none', annotations: []
            };
            state.connections.push(c);
            return c;   // the curated layout hangs manual bends on some
        }
        function zone(label, x, y, w, h, fill, border, fontColor) {
            const z = {
                id: genId(), shape: 'rectangle', x: x, y: y, w: w, h: h,
                label: label, labelPosition: 'top-inside', labelVAlign: 'top',
                fontSize: 15, fontColor: fontColor || border || defaultZoneBorder(),
                lineFormats: [{ bold: true, italic: false }],
                spans: [[{ text: label, bold: true, italic: false }]],
                fill: fill || (DEFAULT_ZONE_FILL || '#e8f4fd'), borderColor: border || defaultZoneBorder(),
                opacity: 1,
                attachmentPoints: getDefaultAttachmentPoints(w, h)
            };
            state.zones.push(z);
            return z;
        }

        const FIBER = DEFAULT_DEVICE_TINT || STENCIL_FRAME_BLUE, VPN = '#7a3fb5', WIFI = '#8a8a8a';
        const zLeaf = DEFAULT_ZONE_FILL || '#e8f4fd';
        const zParent = lightenHex(zLeaf, PARENT_ZONE_LIGHTEN);   // HQ encloses the VLANs

        // Zones (back-to-front: sites first, VLANs on top). HQ takes the
        // parent tint so the VLAN nesting reads; theme-default zones pass no
        // colors; the accent zones keep their explicit green/amber sets.
        zone('Headquarters - Building A', 60, 460, 760, 640, zParent);
        zone('Server VLAN 20', 100, 680, 325, 390);
        zone('User VLAN 30', 440, 680, 340, 160, '#e6f5e6', '#5a9e5a', '#3c6e3c');
        zone('Voice & IoT VLAN 40', 440, 860, 340, 120, '#fdf2df', '#c9a04a', '#8a6a24');
        zone('Cloud - Production VPC', 880, 60, 520, 320);
        zone('Branch Office 1 - Retail', 850, 460, 280, 380, '#fdf6e3', '#c9a04a', '#8a6a24');
        zone('Branch Office 2 - Warehouse', 1190, 460, 280, 380, '#eef7ee', '#5a9e5a', '#3c6e3c');

        const internet = dev('Globe', 'Internet', 700, 280, 70);
        const remotestaff = dev('User', 'Remote Staff', 120, 240);
        const loadbalancer = dev('LoadBalancer', 'Load Balancer', 930, 180);
        const appvm1 = dev('VM', 'App VM 1', 1090, 120);
        const appvm2 = dev('VM', 'App VM 2', 1090, 250);
        const objectstorage = dev('Storage', 'Object Storage', 1250, 120);
        const mgmtjumpbox = dev('ClientVM', 'Mgmt Jumpbox', 1250, 250);
        const edgefirewall = dev('Firewall', 'Edge Firewall\n(HA pair)', 400, 495);
        const coreswitch = dev('Multilayer Switch', 'Core Switch', 400, 600);
        const idsips = dev('Shield', 'IDS / IPS', 195, 570);
        const wirelesscontroller = dev('Wireless Controller', 'Wireless Controller', 640, 570);
        const webserver = dev('Server', 'Web Server', 130, 740);
        const erpserver = dev('Server', 'ERP Server', 240, 740);
        const backupnas = dev('NAS', 'Backup NAS', 340, 740);
        const directoryserver = dev('LDAP', 'Directory Server', 130, 855);
        const nacserver = dev('Fingerprint', 'NAC Server', 240, 855);
        const monitoringserver = dev('Statistics', 'Monitoring Server', 340, 855);
        const virtualizationcluster = dev('ServerCluster', 'Virtualization Cluster', 180, 970, 150, 75);
        const accessswitch = dev('Switch', 'Access Switch', 500, 692);
        const financews = dev('Client', 'Finance WS', 470, 770, 50);
        const printer = dev('Printer', 'Printer', 580, 770, 50);
        const laptop = dev('Laptop', 'Laptop', 700, 770, 50);
        const wifiap = dev('WifiAP', 'WiFi AP', 470, 895, 50);
        const voipphone = dev('VOIPPhone', 'VoIP Phone', 585, 895, 50);
        const poecamera = dev('Camera', 'POE Camera', 700, 895, 50);
        const branch1router = dev('Router', 'Branch 1 Router', 960, 520);
        const switchDev = dev('Switch', 'Switch', 960, 630);
        const posterminal = dev('Client', 'POS Terminal', 905, 730, 50);
        const camera = dev('Camera', 'Camera', 1030, 730, 50);
        const satellite = dev('Satellite', 'Satellite', 1450, 300);
        const branch2router = dev('Router', 'Branch 2 Router', 1300, 520);
        const satmodem = dev('Satellite Dish', 'Sat Modem', 1395, 525, 50);
        const switchDev2 = dev('Switch', 'Switch', 1300, 630);
        const wifiap2 = dev('WifiAP', 'WiFi AP', 1225, 730, 50);
        const conveyor = dev('PLC', 'Conveyor\nPLC', 1305, 730, 50);
        const labelprinter = dev('Printer', 'Label Printer', 1385, 730, 50);

        // Connections - endpoints as AP fractions of each device box;
        // hand-tuned bends from the curated layout ride on the returned conn.
        conn(edgefirewall, 0.5, 0, internet, 0.5, 1, { color: FIBER, thickness: 3, label: '1 Gb Fiber' }).bends = { '1': 445 };
        conn(loadbalancer, 0, 0.5, internet, 1, 0, { color: FIBER, thickness: 3, label: 'Cloud Uplink' });
        conn(branch1router, 0.5, 0, internet, 1, 1, { color: VPN, dash: 'dash-md', label: 'IPsec VPN' }).bends = { '1': 440, '2': 790 };
        conn(branch2router, 0.5, 0, internet, 1, 0.5, { color: VPN, dash: 'dash-md', label: 'IPsec VPN' }).bends = { '1': 400, '2': 830 };
        conn(remotestaff, 1, 0.5, internet, 0, 0.5, { color: VPN, dash: 'dash-sm', label: 'Client VPN' });
        conn(loadbalancer, 1, 0, appvm1, 0, 0.5);
        conn(loadbalancer, 1, 0.5, appvm2, 0, 0.5);
        conn(appvm1, 1, 0.5, objectstorage, 0, 0.5);
        conn(appvm2, 1, 0.5, mgmtjumpbox, 0, 0.5);
        conn(edgefirewall, 0.5, 1, coreswitch, 0.5, 0);
        conn(coreswitch, 0, 0, idsips, 1, 0.5, { dash: 'dash-sm', label: 'SPAN' });
        conn(coreswitch, 1, 0, wirelesscontroller, 0, 0.5);
        conn(coreswitch, 0, 0.5, webserver, 0.5, 0).bends = { '1': 350 };
        conn(coreswitch, 0, 1, erpserver, 0.5, 0).bends = { '1': 360, '2': 720 };
        conn(coreswitch, 0, 1, virtualizationcluster, 1, 0).bends = { '1': 730, '2': 305 };
        conn(virtualizationcluster, 0, 0, directoryserver, 0.5, 1);
        conn(virtualizationcluster, 0.5, 0, nacserver, 0.5, 1);
        conn(virtualizationcluster, 1, 0, monitoringserver, 0.5, 1);
        conn(coreswitch, 1, 0.5, accessswitch, 0.5, 0);
        conn(accessswitch, 0, 1, financews, 0.5, 0);
        conn(accessswitch, 1, 0.5, printer, 0.5, 0);
        conn(accessswitch, 1, 0.5, voipphone, 0.5, 0).bends = { '1': 575, '2': 855 };
        conn(accessswitch, 1, 0.5, poecamera, 0.5, 0).bends = { '1': 575, '2': 855 };
        conn(wifiap, 1, 0.5, laptop, 0.5, 1, { color: WIFI, dash: 'dash-sm', label: 'Wi-Fi' }).bends = { '2': 845 };
        conn(branch1router, 0.5, 1, switchDev, 0.5, 0);
        conn(switchDev, 0, 1, posterminal, 0.5, 0);
        conn(switchDev, 1, 1, camera, 0.5, 0);
        conn(branch2router, 0.5, 1, switchDev2, 0.5, 0);
        conn(branch2router, 1, 0.5, satmodem, 0, 0.5);
        conn(satmodem, 0.5, 0, satellite, 0.5, 1, { color: WIFI, dash: 'dash-sm', label: 'Backup WAN' });
        conn(switchDev2, 0, 1, wifiap2, 0.5, 0);
        conn(switchDev2, 0.5, 1, conveyor, 0.5, 0);
        conn(switchDev2, 1, 1, labelprinter, 0.5, 0);
        conn(backupnas, 0.5, 0, coreswitch, 0, 1).bends = { '1': 740, '2': 395, '3': 740 };
        conn(wifiap, 0.5, 0, accessswitch, 1, 0.5).bends = { '1': 855, '2': 575 };

        // Title + colored legend (per-span colors, like an imported Gliffy legend)
        state.textBoxes.push({
            id: genId(), x: 615, y: 30, text: 'Acme Corp - Global Network',
            fontSize: 24, fontColor: darkenHex(FIBER, 0.35), textAlign: 'left',
            lineFormats: [{ bold: true, italic: false }],
            spans: [[{ text: 'Acme Corp - Global Network', bold: true, italic: false }]]
        });
        state.textBoxes.push({
            id: genId(), x: 80, y: 60,
            text: 'Legend:\n— Fiber uplink\n— IPsec VPN\n— Wireless',
            fontSize: 14, fontColor: DEFAULT_FONT_COLOR, textAlign: 'left',
            lineFormats: [{ bold: true, italic: false }, {}, {}, {}],
            spans: [
                [{ text: 'Legend:', bold: true, italic: false }],
                [{ text: '— Fiber uplink', bold: false, italic: false, color: FIBER }],
                [{ text: '- IPsec VPN', bold: false, italic: false, color: VPN }],
                [{ text: '- Wireless', bold: false, italic: false, color: WIFI }]
            ]
        });

        state.diagramTitle = 'acme-global-network';
        state.diagramVersion = 1;
        setDirty(false);
        undoStack.length = 0;
        redoStack.length = 0;
        updateUndoRedoButtons();
        updateTitleVersionUI();
        renderAll();
        updateCanvasSize();
    }

    function loadComplexSampleDiagram() {
        if (state.dirty && !confirm('You have unsaved changes. Discard them and load the complex sample?')) return;
        buildComplexSampleDiagram();
    }

    // --- Save / Load ---
    function newDiagram() {
        if (state.dirty && !confirm('You have unsaved changes. Discard them and start a new diagram?')) return;
        resetDocumentState();
        state.nextId = 1;
        state.diagramTitle = 'network-diagram';
        state.diagramVersion = 1;
        setDirty(false);
        clearAutosave();
        undoStack.length = 0;
        redoStack.length = 0;
        updateUndoRedoButtons();
        updateTitleVersionUI();
        resetTiers();
        renderAll();
    }

    // Derive the diagram title (and version) from a chosen filename, e.g.
    // "my-diagram_v3.json" -> title "my-diagram", version 3. A trailing
    // "_v<number>" is treated as the version; if absent, the version is kept.
    function applyChosenFileName(fileName) {
        if (!fileName) return;
        let base = fileName.replace(/\.(xcanvas|netdraw|json)$/i, '');
        const m = base.match(/^(.*)_v(\d+)$/);
        if (m) {
            base = m[1];
            state.diagramVersion = Math.max(1, parseInt(m[2], 10));
        }
        if (base) state.diagramTitle = base;
    }

    async function saveDiagram(embedImages) {
        // Build the JSON from current state at call time, so a filename the user
        // chooses in the Save dialog can be folded in before we write. Delegates
        // to serializeDiagram - the ONE place the format is defined - so the
        // save and autosave payloads can never drift apart (a private copy here
        // once shipped without the groups field). embedImages = self-contained
        // archival save (library icons embedded instead of referenced by name).
        const buildJson = () => JSON.stringify(serializeDiagram(embedImages), null, 2);

        // A "board" (PingCanvas board, whiteboard, etc.) wants a STABLE filename -
        // the kiosk + status feed reference it by name - so skip the auto-version
        // suffix when the title is about a board: the standalone word or a known
        // compound. A bare substring test disabled versioning for "Keyboard
        // Matrix" / "Onboarding" / "Billboard" - 'board' the syllable, not the
        // thing you pin to a wall.
        const isBoard = /(?:^|[\s_-])(?:white|dash|noc|status|wall)?boards?(?:$|[\s_.-])/i.test(state.diagramTitle || '');
        const suggestedName = sanitizedTitle() +
            (isBoard ? '' : ('_v' + state.diagramVersion)) + '.xcanvas';

        let saved = false;
        if (window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: suggestedName,
                    types: [{
                        description: 'CrossCanvas Diagram',
                        accept: { 'application/json': ['.xcanvas'] }
                    }]
                });
                // Sync the in-app title/version to the name the user picked, then
                // write so the embedded title matches the file on disk.
                applyChosenFileName(handle.name);
                const writable = await handle.createWritable();
                await writable.write(buildJson());
                await writable.close();
                saved = true;
            } catch (err) {
                if (err.name === 'AbortError') return;
            }
        }

        if (!saved) {
            triggerDownload(new Blob([buildJson()], { type: 'application/json' }), suggestedName);
        }

        setDirty(false);
        clearAutosave();
        // Record the saved state (slim form regardless of embed choice),
        // before the version auto-increments so the snapshot matches the file
        recordRecent();
        // Auto-increment version after each save
        state.diagramVersion++;
        updateTitleVersionUI();
    }

    // Imported stencil type (the last segment of a Gliffy tid or a draw.io
    // shape= key) → bundled device name. Shared by the Gliffy and draw.io
    // importers; names come from devices.js - if a name is missing, each
    // importer's fuzzy matcher and generic-icon fallback still apply.
    const IMPORT_STENCIL_MAP = {
        server: 'Server', servers: 'Server', rack_server: 'Server', database: 'Storage', db: 'Storage',
        switch: 'Switch', l2switch: 'Switch', hub: 'Switch',
        switch_layer_3: 'Multilayer Switch', l3_switch: 'Multilayer Switch',
        layer3switch: 'Multilayer Switch', l3switch: 'Multilayer Switch',
        multilayer_switch: 'Multilayer Switch', switch_multilayer: 'Multilayer Switch',
        router: 'Router', gateway: 'Router',
        firewall: 'Firewall', cloud: 'Cloud', internet: 'Cloud',
        globe: 'Globe', world: 'Globe',
        desktop: 'Client', pc: 'Client', workstation: 'Client', computer: 'Client', monitor: 'Client', client: 'Client',
        laptop: 'Laptop', notebook: 'Laptop',
        tablet: 'Tablet', mobile: 'Mobile Phone', smartphone: 'Mobile Phone',
        printer: 'Printer', mfp: 'Printer',
        camera: 'Camera', ip_camera: 'Camera', cctv: 'Camera',
        phone: 'VOIPPhone', ip_phone: 'VOIPPhone', voip: 'VOIPPhone', voip_phone: 'VOIPPhone', telephone: 'VOIPPhone',
        wireless_access_point: 'WifiAP', access_point: 'WifiAP', wifi: 'WifiAP', wap: 'WifiAP', wireless: 'WifiAP', accesspoint: 'WifiAP',
        wireless_hub: 'WifiAP',
        modem: 'Modem', wireless_modem: 'Modem', cable_modem: 'Modem', dsl_modem: 'Modem', ont: 'Modem',
        load_balancer: 'LoadBalancer', loadbalancer: 'LoadBalancer', lb: 'LoadBalancer',
        nas: 'NAS', san: 'Storage', storage: 'Storage', disk: 'Storage', disk_array: 'Storage',
        user: 'User', person: 'User', users: 'User', actor: 'User',
        house: 'House', home: 'House',
        office: 'Office', building: 'Office',
        vm: 'VM', virtual_machine: 'VM', virtual_server: 'VM', vda: 'VM',
        virtual_desktop: 'ClientVM',
        esx_esxi: 'Server', esxi: 'Server', esx: 'Server', hypervisor: 'Server',
        esxi_host: 'Server', hyper_v_host: 'Server', proxy: 'Server',
        active_directory: 'LDAP', ldap: 'LDAP', directory_server: 'LDAP',
        datastore: 'Storage', elastic_load_balancing: 'LoadBalancer',
        netscaler_gateway: 'LoadBalancer', sd_wan: 'Router',
        ec2: 'VM', s3: 'Storage', nat_gateway: 'Router', storefront: 'Server',
        ibm_mainframe: 'Server', ibm_mini_as400: 'Server', mainframe: 'Server', as400: 'Server',
        ipad: 'Tablet', iphone: 'Tablet', netbook: 'Laptop', monitor_tower: 'Client',
        scanner: 'Printer', bus: 'EthernetRJ45', token: 'EthernetRJ45',
        server_cluster: 'ServerCluster', cluster: 'ServerCluster', server_farm: 'ServerCluster',
        ethernet: 'EthernetRJ45', rj45: 'EthernetRJ45',
        // Affinity expansion set (v4.0) - network/telecom
        vrf: 'VRF',
        wlc: 'Wireless Controller', wireless_lan_controller: 'Wireless Controller',
        wireless_controller: 'Wireless Controller',
        router_cloud: 'Cloud Router', cloud_router: 'Cloud Router', wan_router: 'Cloud Router',
        interconnect: 'Interconnect', link: 'Link',
        dslam: 'Modem',
        satellite: 'Satellite', satellite_dish: 'Satellite Dish', earth_station: 'Satellite Dish',
        phone_cloud: 'Cloud Phone', cloud_phone: 'Cloud Phone',
        phone_old: 'Analog Phone', analog_phone: 'Analog Phone', pots_phone: 'Analog Phone',
        phone_wireless: 'Mobile Phone', cordless_phone: 'Mobile Phone', cell_phone: 'Mobile Phone',
        mobile_phone: 'Mobile Phone',
        // Tabler infrastructure set (v4.1)
        ups: 'UPS', battery_backup: 'UPS', uninterruptible_power_supply: 'UPS',
        patch_panel: 'Patch Panel', patchpanel: 'Patch Panel',
        rack: 'Rack', server_rack: 'Rack', rack_frame: 'Rack',
        badge_reader: 'Badge Reader', card_reader: 'Badge Reader', nfc: 'Badge Reader',
        sensor: 'Sensor', detector: 'Sensor', iot_sensor: 'Sensor',
        plc: 'PLC', scada: 'PLC',
        // security
        shield: 'Shield', security: 'Shield',
        fingerprint: 'Fingerprint', biometric: 'Fingerprint',
        bug: 'Bug', virus: 'Bug', malware: 'Bug',
        inspect: 'Inspect', magnifier: 'Inspect', magnifying_glass: 'Inspect',
        // places & general
        factory: 'Factory', industry: 'Factory', plant: 'Factory', warehouse: 'Factory',
        pinpoint: 'Map Pin', map_pin: 'Map Pin', location: 'Map Pin', marker: 'Map Pin',
        cog: 'Cog', gear: 'Cog', gears: 'Cog', settings: 'Cog',
        conversation: 'Communications', chat: 'Communications', speech_bubble: 'Communications',
        communications: 'Communications',
        grid: 'Grid', mesh: 'Grid',
        light_bulb: 'Light Bulb', lightbulb: 'Light Bulb', idea: 'Light Bulb', bulb: 'Light Bulb',
        statistics: 'Statistics', bar_chart: 'Statistics', chart: 'Statistics',
        graph: 'Statistics', analytics: 'Statistics',
        xml: 'XML', code: 'XML'
    };

    // Shared import-name matching rules - ONE copy of the normalization and
    // the squished-substring comparison, used by customImportTemplate and
    // resolveVisioTemplate so a future tweak (new separator, floor change)
    // can't silently apply to one and not the other.
    // Normalize: Visio appends ".NNN" dedup suffixes to master names, and
    // stencil vocabularies mix spaces/underscores/hyphens.
    function normalizeStencilKey(v) {
        return String(v || '').toLowerCase()
            .replace(/\.\d+$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    // Squished comparison with a 4-char floor so short names (VM, NAS, AP)
    // can't false-positive mid-word.
    function squishStencil(v) { return v.replace(/[^a-z0-9]/g, ''); }
    function squishedStencilMatch(a, b) {
        const as = squishStencil(a), bs = squishStencil(b);
        return as.length >= 4 && bs.length >= 4 && (as.includes(bs) || bs.includes(as));
    }

    // User/team stencils outrank the bundled set when resolving imported
    // shapes: someone who imported their own "Cisco Switch" icon wants it on
    // every switch, not ours. Exact (normalized) name first, then the same
    // substring/squish fuzzy the importers use - but scanned over custom
    // templates only, BEFORE the built-in maps get a say.
    function customImportTemplate(sourceName) {
        const key = normalizeStencilKey(sourceName);
        if (!key) return null;
        const customs = state.deviceTemplates.filter(t => !t.isDefault && !t.isBundled);
        if (!customs.length) return null;
        let hit = customs.find(t => normalizeStencilKey(t.name) === key);
        if (hit) return hit;
        return customs.find(t => {
            const tn = normalizeStencilKey(t.name);
            // Plain-substring matches take the same 4-char floor on the
            // CONTAINED string: without it a custom stencil named "AP"
            // captures every imported "laptop". Short names still win via
            // the exact match above.
            if ((key.length >= 4 && tn.includes(key)) ||
                (tn.length >= 4 && key.includes(tn))) return true;
            return squishedStencilMatch(tn, key);
        }) || null;
    }

    // --- Gliffy Import ---
    // quiet: suppress the per-file summary dialog and throw instead of alert -
    // used by the batch converter, which reports one roll-up at the end.
    function importGliffy(gliffyData, fileName, quiet) {
        const rawObjects = gliffyData.stage && gliffyData.stage.objects || [];
        if (rawObjects.length === 0) {
            if (quiet) throw new Error('no objects found in Gliffy file');
            alert('No objects found in Gliffy file.');
            return;
        }

        // Flatten Gliffy groups: pull leaf Shape/Text/Line objects out of any
        // group/container, converting their positions to absolute, so grouped
        // devices aren't lost. Shape/Text/Line keep their own children (labels).
        let flattenedGroups = 0;
        function flattenGliffy(objs, ox, oy, out, depth) {
            (objs || []).forEach(o => {
                const gt = o.graphic && o.graphic.type;
                if (gt === 'Shape' || gt === 'Text' || gt === 'Line') {
                    out.push(Object.assign({}, o, { x: (o.x || 0) + ox, y: (o.y || 0) + oy }));
                } else if (o.children && o.children.length && depth < 25) {
                    flattenedGroups++;
                    flattenGliffy(o.children, (o.x || 0) + ox, (o.y || 0) + oy, out, depth + 1);
                }
            });
            return out;
        }
        const objects = flattenGliffy(rawObjects, 0, 0, [], 0);
        const stencilMap = IMPORT_STENCIL_MAP;

        // Find the template for a Gliffy stencil (null = use the generic icon)
        function resolveTemplate(tid) {
            if (!tid) return null;
            // Extract the last part of the stencil ID (e.g. "server", "switch", "camera")
            const parts = tid.split('.');
            const typeName = parts[parts.length - 1] || 'unknown';
            // Normalized key: drop a trailing rack-unit size (e.g. _1u, _42u) and
            // trailing underscores so rack_server_1u, rack_server_2u, etc. all map.
            const normalized = typeName.replace(/_\d+u$/, '').replace(/_+$/, '');

            // Prefer non-isDefault stencils. The built-in Default_ templates are
            // gone, but legacy localStorage imports may still carry the flag.
            const byName = (name) =>
                state.deviceTemplates.find(t => t.name === name && !t.isDefault) ||
                state.deviceTemplates.find(t => t.name === name);

            // 0. A user/team stencil matching the source name always wins
            const custom = customImportTemplate(typeName) || customImportTemplate(normalized);
            if (custom) return { template: custom, wasPlaceholder: false, typeName };

            // 1. Check known mapping (exact, then normalized)
            const mapped = stencilMap[typeName] || stencilMap[normalized];
            if (mapped) {
                const tmpl = byName(mapped);
                if (tmpl) return { template: tmpl, wasPlaceholder: false, typeName };
            }

            // 2. Fuzzy match against existing templates (non-default first)
            const lower = typeName.toLowerCase();
            const matches = (t) =>
                t.name.toLowerCase().includes(lower) || lower.includes(t.name.toLowerCase().replace('default_', ''));
            const fuzzy = state.deviceTemplates.find(t => !t.isDefault && matches(t)) ||
                state.deviceTemplates.find(t => matches(t));
            if (fuzzy) return { template: fuzzy, wasPlaceholder: false, typeName };

            // 3. No match: generic template icon inline - no placeholder
            // template, so unknown types never reach the palette.
            return { template: null, wasPlaceholder: true, typeName };
        }

        // Parse Gliffy HTML label → our spans format
        function parseGliffyHTML(html) {
            if (!html) return [[{ text: '', bold: false, italic: false }]];
            // Reuse existing htmlToSpans (expects innerHTML)
            const spans = htmlToSpans(html);
            if (spans.length === 0) return [[{ text: '', bold: false, italic: false }]];
            return spans;
        }

        // Extract label text + spans from a Gliffy object's children
        // Dominant font size in a Gliffy label's HTML (e.g. "font-size: 12px").
        function gliffyFontSize(html) {
            const counts = {};
            for (const m of (html || '').matchAll(/font-size:\s*(\d+)px/g)) {
                counts[m[1]] = (counts[m[1]] || 0) + 1;
            }
            let best = null, bn = 0;
            for (const [size, n] of Object.entries(counts)) {
                if (n > bn) { bn = n; best = parseInt(size, 10); }
            }
            return best;
        }

        // Dominant font-family in a Gliffy label's HTML, mapped onto our
        // curated stacks (null = leave the app default).
        function gliffyFontFamily(html) {
            const m = /font-family:\s*([^;"'<]+)/i.exec(html || '');
            if (!m) return null;
            const f = m[1].toLowerCase();
            if (f.includes('courier')) return 'courier';
            if (f.includes('consolas') || f.includes('mono')) return 'consolas';
            if (f.includes('georgia')) return 'georgia';
            if (f.includes('times')) return 'times';
            if (f.includes('verdana')) return 'verdana';
            if (f.includes('segoe')) return 'segoe';
            if (f.includes('arial') || f.includes('helvetica')) return 'arial';
            return null;
        }

        // Dominant per-paragraph text-align in a Gliffy label (labels mix
        // alignments line-by-line - e.g. a centered heading over a left body -
        // and our model carries one justification per label, so majority wins).
        function gliffyLabelAlign(html) {
            const counts = { left: 0, center: 0, right: 0 };
            for (const m of (html || '').matchAll(/text-align:\s*(left|center|right)/g)) {
                counts[m[1]]++;
            }
            let best = null, bn = 0;
            for (const [a, n] of Object.entries(counts)) {
                if (n > bn) { bn = n; best = a; }
            }
            return best;
        }

        // Gliffy dashStyle is a dash-array string ("8.0,2.0"); map the common
        // patterns onto the app's dash vocabulary.
        function gliffyDash(dashStyle) {
            if (!dashStyle) return 'solid';
            const nums = String(dashStyle).split(',').map(Number);
            const a = nums[0] || 0, b = nums.length > 1 ? nums[1] : a;
            if (a <= 2) return 'dot';                  // 1,1 / 2,2
            if (a >= 8 && b >= 8) return 'dash-lg';    // 8,8
            if (a >= 8) return 'dash-md';              // 8,2
            return 'dash-sm';                          // 4,4
        }

        // Gliffy encodes label placement on the Text child: vposition
        // above/below puts it outside the shape; 'none' means inside, with
        // valign picking the band. Maps cleanly onto our position vocabulary.
        function gliffyLabelPos(t) {
            if (t.hposition === 'left') return 'left';
            if (t.hposition === 'right') return 'right';
            if (t.vposition === 'above') return 'top';
            if (t.vposition === 'below') return 'bottom';
            if (t.valign === 'top') return 'top-inside';
            if (t.valign === 'bottom') return 'bottom-inside';
            return 'center';
        }

        function extractLabel(obj) {
            if (!obj.children || obj.children.length === 0) {
                return { text: '', spans: [[{ text: '', bold: false, italic: false }]], fontSize: null, pos: null, family: null, align: null };
            }
            // Find the first text child
            const textChild = obj.children.find(c => c.graphic && c.graphic.type === 'Text');
            if (!textChild) return { text: '', spans: [[{ text: '', bold: false, italic: false }]], fontSize: null, pos: null, family: null, align: null };
            const html = textChild.graphic.Text.html || '';
            const spans = parseGliffyHTML(html);
            const text = spans.map(line => line.map(s => s.text).join('')).join('\n');
            return {
                text, spans,
                fontSize: gliffyFontSize(html),
                pos: gliffyLabelPos(textChild.graphic.Text),
                family: gliffyFontFamily(html),
                align: gliffyLabelAlign(html)
            };
        }

        // Map Gliffy proportional position (px, py on bounding box) to nearest AP index
        // Resolve a Gliffy fractional anchor (px/py of the node bbox) to an
        // attachment point EXACTLY: reuse an AP within a couple of px, else
        // inject a new one at the precise contact point. Snapping to the
        // nearest existing AP used to collapse parallel lines onto one AP
        // (bowties) and dogleg every hand-routed endpoint; exact anchors keep
        // lines as authored while staying attached - unlike draw.io's frozen
        // edge points, moving the node keeps its connections live.
        // --- Phase 1: Classify objects ---
        const gliffyIdToAppId = {};
        const newDevices = [];
        const newZones = [];
        const newTextBoxes = [];
        const newConnections = [];
        const stats = { devices: 0, zones: 0, textboxes: 0, connections: 0, skipped: 0, placeholders: [] };

        // Size threshold: rectangles larger than this are zones
        const ZONE_MIN_AREA = 200 * 100;

        objects.forEach(obj => {
            const gType = obj.graphic && obj.graphic.type;
            const uid = obj.uid || '';

            if (gType === 'Shape') {
                const tid = obj.graphic.Shape.tid || '';

                // Rectangles → zone or textbox. Large boxes and ANY unlabeled
                // rectangle become zones - small unlabeled rects are color
                // chips/markers, and importing those as text boxes rendered
                // them invisible. Only labeled small rects become text boxes.
                if (tid.includes('rectangle')) {
                    const area = (obj.width || 0) * (obj.height || 0);
                    const label = extractLabel(obj);
                    if (area >= ZONE_MIN_AREA || !label.text) {
                        const zone = {
                            id: genId(),
                            shape: 'rectangle',
                            x: obj.x || 0,
                            y: obj.y || 0,
                            w: obj.width || 160,
                            h: obj.height || 120,
                            label: label.text || (area >= ZONE_MIN_AREA ? 'Zone' : ''),
                            labelPosition: label.pos || 'top-inside',
                            fontSize: label.fontSize || DEFAULT_FONT_SIZE,
                            fontColor: '#333333',
                            fontFamily: label.family || undefined,
                            labelAlign: label.align || undefined,
                            lineFormats: [{ bold: true, italic: false }],
                            spans: label.spans,
                            fill: obj.graphic.Shape.fillColor || '#e8f4fd',
                            borderColor: obj.graphic.Shape.strokeColor || STENCIL_FRAME_BLUE,
                            opacity: obj.graphic.Shape.opacity || 1,
                            attachmentPoints: distributeAttachmentPoints(obj.width || 160, obj.height || 120, 16)
                        };
                        gliffyIdToAppId[obj.id] = zone.id;
                        newZones.push(zone);
                        stats.zones++;
                    } else {
                        const tb = {
                            id: genId(),
                            x: obj.x || 0,
                            y: obj.y || 0,
                            text: label.text,
                            fontSize: label.fontSize || DEFAULT_FONT_SIZE,
                            fontColor: '#333333',
                            textAlign: 'center',
                            lineFormats: [],
                            spans: label.spans
                        };
                        gliffyIdToAppId[obj.id] = tb.id;
                        newTextBoxes.push(tb);
                        stats.textboxes++;
                    }
                    return;
                }

                // Ellipses → ellipse zone
                if (tid.includes('ellipse')) {
                    const label = extractLabel(obj);
                    const w = obj.width || 160;
                    const h = obj.height || 120;
                    const zone = {
                        id: genId(),
                        shape: 'ellipse',
                        x: obj.x || 0,
                        y: obj.y || 0,
                        w: w,
                        h: h,
                        label: label.text || '',
                        labelPosition: label.pos || 'center',
                        fontSize: label.fontSize || DEFAULT_FONT_SIZE,
                        fontColor: '#333333',
                        fontFamily: label.family || undefined,
                        labelAlign: label.align || undefined,
                        lineFormats: [],
                        spans: label.spans,
                        fill: obj.graphic.Shape.fillColor || '#e8f4fd',
                        borderColor: obj.graphic.Shape.strokeColor || STENCIL_FRAME_BLUE,
                        opacity: obj.graphic.Shape.opacity || 1,
                        attachmentPoints: distributeAttachmentPoints(w, h, 16)
                    };
                    gliffyIdToAppId[obj.id] = zone.id;
                    newZones.push(zone);
                    stats.zones++;
                    return;
                }

                // Everything else → device. Keep the ORIGINAL bounding box -
                // Gliffy stencils are mostly wide rectangles, and squaring to
                // max(w,h) inflated a 120×66 switch to 120×120 (anchored
                // top-left, so all the growth displaced neighbors downward and
                // moved every connection landing spot). The renderer handles
                // non-square devices (border uses w/h; the icon letterboxes
                // via preserveAspectRatio). 16 APs = the quarter grid Gliffy
                // diagrams are authored against (corners + 3 per side).
                const resolved = resolveTemplate(tid);
                if (!resolved) { stats.skipped++; return; }
                let { template, wasPlaceholder, typeName } = resolved;
                const label = extractLabel(obj);
                // A label INSIDE the shape means the source drew a labeled
                // box - stencil art would clash with the text. The Blank
                // stencil (empty glyph, app-drawn frame) is the faithful
                // visual; the Icon dropdown upgrades it to a specific icon.
                if (label.text && (label.pos === 'center' ||
                    label.pos === 'top-inside' || label.pos === 'bottom-inside')) {
                    const blank = state.deviceTemplates.find(t => t.name === 'Blank');
                    if (blank) { template = blank; wasPlaceholder = false; }
                }
                const dw = Math.round(obj.width) || DEVICE_SIZE;
                const dh = Math.round(obj.height) || DEVICE_SIZE;
                const gIcon = template ? template.image : TEMPLATE_ICON;
                const device = {
                    id: genId(),
                    templateId: template ? template.id : null,
                    image: gIcon,
                    originalImage: gIcon,
                    x: obj.x || 0,
                    y: obj.y || 0,
                    w: dw,
                    h: dh,
                    // template is null for unmatched stencils - keep the label
                    // blank rather than crash (mirrors the Visio importer)
                    label: label.text || (template ? template.name : ''),
                    labelPosition: label.pos || 'bottom',
                    fontSize: label.fontSize || DEFAULT_FONT_SIZE,
                    fontColor: '#333333',
                    fontFamily: label.family || undefined,
                    labelAlign: label.align || undefined,
                    lineFormats: [],
                    spans: label.spans,
                    tintColor: null,
                    attachmentPoints: distributeAttachmentPoints(dw, dh, 16)
                };
                gliffyIdToAppId[obj.id] = device.id;
                newDevices.push(device);
                stats.devices++;
                if (wasPlaceholder && !stats.placeholders.includes(typeName)) {
                    stats.placeholders.push(typeName);
                }

            } else if (gType === 'Text') {
                // Standalone text object → text box
                const html = obj.graphic.Text.html || '';
                const spans = parseGliffyHTML(html);
                const text = spans.map(line => line.map(s => s.text).join('')).join('\n');
                const tb = {
                    id: genId(),
                    x: obj.x || 0,
                    y: obj.y || 0,
                    text: text || 'Text',
                    fontSize: gliffyFontSize(html) || DEFAULT_FONT_SIZE,
                    fontColor: '#333333',
                    fontFamily: gliffyFontFamily(html) || undefined,
                    textAlign: gliffyLabelAlign(html) || 'center',
                    lineFormats: [],
                    spans: spans
                };
                gliffyIdToAppId[obj.id] = tb.id;
                newTextBoxes.push(tb);
                stats.textboxes++;

            } else if (gType === 'Line') {
                const line = obj.graphic.Line;
                const constraints = obj.constraints || {};
                const startC = constraints.startConstraint && constraints.startConstraint.StartPositionConstraint;
                const endC = constraints.endConstraint && constraints.endConstraint.EndPositionConstraint;

                // Extract all text labels on this line
                const lineLabels = [];
                if (obj.children) {
                    obj.children.forEach(c => {
                        if (c.graphic && c.graphic.type === 'Text') {
                            const tData = c.graphic.Text;
                            const spans = parseGliffyHTML(tData.html || '');
                            const text = spans.map(ln => ln.map(s => s.text).join('')).join('\n');
                            const tVal = tData.lineTValue;
                            if (text.trim()) {
                                lineLabels.push({ text, spans, t: tVal, fontSize: gliffyFontSize(tData.html), family: gliffyFontFamily(tData.html) });
                            }
                        }
                    });
                }

                // All line labels become positioned annotations so they stay at
                // their original Gliffy positions and are draggable along the path
                let annotations = [];
                lineLabels.forEach(ll => {
                    annotations.push({
                        id: genId(),
                        position: ll.t || 0.5,
                        text: ll.text,
                        spans: ll.spans,
                        fontSize: ll.fontSize || DEFAULT_FONT_SIZE,
                        fontColor: '#333333',
                        fontFamily: ll.family || undefined
                    });
                });

                // Absolute endpoint geometry, so a line whose node(s) were deleted
                // can still be imported as a free-floating connection - and the
                // intermediate control points become manual waypoints, so
                // hand-routed Gliffy lines keep their exact path.
                const cp = line.controlPath;
                let fromGeo, toGeo, waypoints = null;
                if (Array.isArray(cp) && cp.length >= 2) {
                    fromGeo = { x: (obj.x || 0) + cp[0][0], y: (obj.y || 0) + cp[0][1] };
                    toGeo = { x: (obj.x || 0) + cp[cp.length - 1][0], y: (obj.y || 0) + cp[cp.length - 1][1] };
                    if (cp.length > 2) {
                        waypoints = cp.slice(1, -1).map(p => ({
                            x: Math.round((obj.x || 0) + p[0]),
                            y: Math.round((obj.y || 0) + p[1])
                        }));
                    }
                } else {
                    fromGeo = { x: obj.x || 0, y: obj.y || 0 };
                    toGeo = { x: (obj.x || 0) + (obj.width || 0), y: (obj.y || 0) + (obj.height || 0) };
                }

                // Store connection info - endpoints resolved after all objects are created
                newConnections.push({
                    gliffyFromId: startC ? startC.nodeId : null,
                    gliffyToId: endC ? endC.nodeId : null,
                    fromPx: startC ? startC.px : 0.5,
                    fromPy: startC ? startC.py : 0.5,
                    toPx: endC ? endC.px : 0.5,
                    toPy: endC ? endC.py : 0.5,
                    fromGeo: fromGeo,
                    toGeo: toGeo,
                    color: line.strokeColor || '#333333',
                    thickness: Math.round(line.strokeWidth) || 2,
                    // Waypoint paths draw through their points, which needs a
                    // non-straight path builder; rounded matches the Gliffy
                    // house style (the corner-rounding builder is generic over
                    // arbitrary polylines, so hand-routed paths round too).
                    routing: (waypoints || line.ortho) ? 'rounded' : 'straight',
                    dash: gliffyDash(line.dashStyle),
                    label: '',
                    spans: [],
                    annotations: annotations,
                    waypoints: waypoints,
                    startArrow: line.startArrow ? 'arrow' : 'none',
                    endArrow: line.endArrow ? 'arrow' : 'none'
                });
            }
        });

        // --- Phase 2: Resolve connections ---
        const resolvedConnections = [];
        const findImportNode = id => [...newDevices, ...newZones].find(n => n.id === id);
        newConnections.forEach(c => {
            const fromAppId = c.gliffyFromId != null ? gliffyIdToAppId[c.gliffyFromId] : null;
            const toAppId = c.gliffyToId != null ? gliffyIdToAppId[c.gliffyToId] : null;
            const fromNode = fromAppId ? findImportNode(fromAppId) : null;
            const toNode = toAppId ? findImportNode(toAppId) : null;

            // Each end is anchored to a node attachment point, or - if its node was
            // deleted in the original diagram - a free-floating point from the line
            // geometry, so dangling lines survive the import.
            let fromDevice = null, fromAP = null, fromPoint = null;
            if (fromNode) {
                fromDevice = fromNode.id;
                fromAP = mapToAP(c.fromPx, c.fromPy, fromNode.attachmentPoints, fromNode.w, fromNode.h);
            } else {
                fromPoint = { x: snapToGrid(c.fromGeo.x), y: snapToGrid(c.fromGeo.y) };
            }
            let toDevice = null, toAP = null, toPoint = null;
            if (toNode) {
                toDevice = toNode.id;
                toAP = mapToAP(c.toPx, c.toPy, toNode.attachmentPoints, toNode.w, toNode.h);
            } else {
                toPoint = { x: snapToGrid(c.toGeo.x), y: snapToGrid(c.toGeo.y) };
            }

            if ((!fromDevice && !fromPoint) || (!toDevice && !toPoint)) {
                stats.skipped++;
                return;
            }

            resolvedConnections.push({
                id: genId(),
                fromDevice: fromDevice,
                fromAP: fromAP,
                fromPoint: fromPoint,
                toDevice: toDevice,
                toAP: toAP,
                toPoint: toPoint,
                color: c.color,
                thickness: c.thickness,
                dash: c.dash,
                routing: c.routing,
                label: c.label,
                labelPosition: 'top',
                fontSize: DEFAULT_FONT_SIZE,
                fontColor: '#333333',
                lineFormats: [],
                spans: c.spans,
                startArrow: c.startArrow,
                endArrow: c.endArrow,
                annotations: c.annotations,
                waypoints: c.waypoints || null
            });
            stats.connections++;
        });

        // --- Phase 3: Apply to state ---
        resetDocumentState();
        state.devices = newDevices;
        state.connections = resolvedConnections;
        state.zones = newZones;
        state.textBoxes = newTextBoxes;
        const metaTitle = gliffyData.metadata && gliffyData.metadata.title;
        const fileTitle = fileName ? fileName.replace(/\.gliffy$/i, '') : null;
        const title = (metaTitle && metaTitle !== 'untitled') ? metaTitle : (fileTitle || 'gliffy-import');
        state.diagramTitle = title;
        state.diagramVersion = 1;
        // Waypoint routes that fit the native rails become real bent
        // connections (needs the new nodes in state so endpoints resolve)
        state.connections.forEach(convertWaypointsToBends);
        setDirty(true);
        updateTitleVersionUI();
        resetTiers();
        renderDeviceList();
        renderAllZones();
        renderAllImages();
        renderAllDevices();
        renderAllConnections();
        updateCanvasSize();

        // --- Summary ---
        if (quiet) return stats;
        let msg = `Devices: ${stats.devices}\n`;
        msg += `Zones: ${stats.zones}\n`;
        msg += `Text boxes: ${stats.textboxes}\n`;
        msg += `Connections: ${stats.connections}\n`;
        if (flattenedGroups > 0) msg += `Groups flattened: ${flattenedGroups}\n`;
        if (stats.skipped > 0) msg += `Skipped: ${stats.skipped} (decorative or unlinked)\n`;
        if (stats.placeholders.length > 0) {
            msg += `\nUnrecognized types imported with the generic icon:\n`;
            msg += stats.placeholders.map(p => `  • ${p}`).join('\n');
            msg += '\n\nSwap icons via the Icon dropdown in Device Properties.';
        }
        showDialog({ title: 'Gliffy import complete', body: msg.trim() });
        return stats;
    }

    // --- Batch convert (File → Convert Diagrams…) ------------------------------
    // Runs each selected .gliffy/.drawio (or draw.io .xml) through the REAL
    // importer (same fidelity as a hand import), serializes, and writes
    // <source-name>.xcanvas. Multi-page draw.io files take the busiest page
    // (noted in the roll-up). Output goes to a picked folder where the File
    // System Access API exists (Chrome/Edge, the same capability Save already
    // uses), else falls back to one download per file. The canvas is a workbench
    // during the run: each file renders as it converts, and the last one stays
    // loaded for spot-checking.
    async function convertDiagramsBatch(files) {
        // Ask for the output folder FIRST - the picker needs the user-activation
        // window, which expires once we start awaiting file reads.
        let dirHandle = null;
        if (window.showDirectoryPicker) {
            try {
                dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            } catch (err) {
                if (err.name === 'AbortError') return;   // user cancelled = cancel batch
                dirHandle = null;                        // API blocked -> download fallback
            }
        }

        // Color treatment: imports normally preserve source styling (a theme
        // only seeds NEW objects), but a batch conversion is often a fresh
        // start - offer the same Recolor All to Theme that Bulk Actions has,
        // applied per file between import and write.
        const themeSel = document.getElementById('theme-select');
        const themeName = themeSel && themeSel.selectedOptions[0] ? themeSel.selectedOptions[0].textContent : 'Classic';
        const recolor = await showDialog({
            title: 'Batch convert - colors',
            body: (close) => {
                const wrap = document.createElement('div');
                [{ label: 'Keep source colors', note: ' - as drawn in Gliffy', value: false },
                 { label: 'Recolor to current theme', note: ' - ' + themeName, value: true }].forEach(opt => {
                    const row = document.createElement('button');
                    row.type = 'button';
                    row.className = 'dialog-list-item';
                    const name = document.createElement('span');
                    name.textContent = opt.label;
                    const note = document.createElement('span');
                    note.className = 'dialog-item-note';
                    note.textContent = opt.note;
                    row.append(name, note);
                    row.addEventListener('click', () => close(opt.value));
                    wrap.appendChild(row);
                });
                return wrap;
            },
            buttons: [{ label: 'Cancel', value: null }]
        });
        if (recolor == null) return;                     // cancelled = cancel batch
        // Recoloring? then pick which kinds, same popup as Bulk Actions.
        let recolorOpts = null;
        if (recolor) {
            recolorOpts = await recolorScopeDialog();
            if (!recolorOpts) return;                    // cancelled the picker = cancel batch
        }

        const ok = [], failed = [];
        // Tracks whether the board CURRENTLY on canvas has been written out.
        // Import flips it false, a completed write flips it true; a file that
        // fails before touching state leaves it alone - so at the end it's true
        // exactly when the canvas content is safe on disk, regardless of which
        // (if any) files failed around it.
        let canvasWritten = false;
        for (const file of files) {
            const outName = file.name.replace(/\.(gliffy|drawio|xml)$/i, '') + '.xcanvas';
            try {
                const txt = await file.text();
                let stats, pageNote = '';
                let data = null;
                try { data = JSON.parse(txt); } catch (e) { /* not JSON -> maybe draw.io XML */ }
                if (data && (data.contentType === 'application/gliffy+json' || (data.stage && data.stage.objects))) {
                    stats = importGliffy(data, file.name, true);
                } else if (!data && /<mxfile|<mxGraphModel/.test(txt)) {
                    const r = await importDrawioText(txt, file.name, true);
                    stats = r.stats;
                    if (r.pageCount > 1) pageNote = `, page “${r.pageName}” of ${r.pageCount}`;
                } else {
                    throw new Error('not a Gliffy or draw.io file');
                }
                canvasWritten = false;   // canvas now holds this import, not yet on disk
                if (recolorOpts) recolorAllToTheme(recolorOpts);
                const json = JSON.stringify(serializeDiagram(), null, 2);
                if (dirHandle) {
                    const fh = await dirHandle.getFileHandle(outName, { create: true });
                    const w = await fh.createWritable();
                    await w.write(json);
                    await w.close();
                } else {
                    triggerDownload(new Blob([json], { type: 'application/json' }), outName);
                    // Browsers throttle rapid programmatic downloads; pace them.
                    await new Promise(r => setTimeout(r, 350));
                }
                canvasWritten = true;
                ok.push(`${outName}  (${stats.devices} devices, ${stats.connections} connections${pageNote})`);
            } catch (err) {
                failed.push(`${file.name} - ${err.message}`);
            }
        }

        // If the board on canvas made it to disk, mirror Save's semantics so
        // closing doesn't nag - including clearAutosave: each import's
        // setDirty(true) armed the 4s autosave debounce, and setDirty(false)
        // alone doesn't cancel it - without this, the timer snapshots the
        // workbench board and next launch bogusly offers to "Restore unsaved
        // work" that's already saved as a .xcanvas. (Keyed on the write, not on
        // zero failures: a mixed batch whose LAST canvas content was written
        // is just as safe; only an import whose WRITE failed must stay dirty.)
        if (canvasWritten) { setDirty(false); clearAutosave(); }

        let msg = `Converted ${ok.length} of ${files.length} file(s)` +
            (dirHandle ? ' into the chosen folder.' : ' via downloads.') + '\n';
        if (ok.length) msg += '\n' + ok.map(s => '  • ' + s).join('\n') + '\n';
        if (failed.length) msg += `\nFailed:\n` + failed.map(s => '  • ' + s).join('\n') + '\n';
        if (ok.length) msg += '\nThe last converted diagram is on the canvas for spot-checking.';
        showDialog({ title: 'Batch convert', body: msg.trim() });
    }

    document.getElementById('file-convert-diagrams').addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        e.target.value = '';
        if (files.length) convertDiagramsBatch(files);
    });

    // --- Visio (.vsdx) import -------------------------------------------------
    // .vsdx is an Open Packaging Convention archive (a ZIP of XML parts). We
    // unzip it without any third-party library: parse the ZIP central directory
    // by hand and inflate entries with the browser's native DecompressionStream.
    // XML is parsed with DOMParser (inert - no scripts/subresources), matching
    // the security posture used for Gliffy labels. Nothing is fetched.

    // Inflate deflate-raw bytes, aborting early if the output exceeds maxBytes
    // (a decompression-bomb guard - read chunk by chunk instead of buffering
    // the whole stream, so a malicious part can't balloon memory first).
    async function inflateRaw(u8, maxBytes) {
        const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.length;
            if (maxBytes && total > maxBytes) {
                await reader.cancel();
                throw new Error('a compressed part decompresses too large');
            }
            chunks.push(value);
        }
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { out.set(c, off); off += c.length; }
        return out;
    }

    // Inflate the XML/rels parts of a ZIP into a { path: text } map.
    async function unzipXmlParts(arrayBuffer) {
        const u8 = new Uint8Array(arrayBuffer);
        const dv = new DataView(arrayBuffer);
        const td = new TextDecoder('utf-8');
        // Locate the End Of Central Directory record (scan back for its signature).
        let eocd = -1;
        const minPos = Math.max(0, u8.length - 22 - 65536);
        for (let i = u8.length - 22; i >= minPos; i--) {
            if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('not a valid .vsdx (ZIP directory not found)');
        const count = dv.getUint16(eocd + 10, true);
        let p = dv.getUint32(eocd + 16, true);
        const out = {};
        const MAX_PART = 40 * 1024 * 1024;    // 40 MB per decompressed part
        const MAX_TOTAL = 100 * 1024 * 1024;  // 100 MB across all parts
        let totalBytes = 0;
        for (let n = 0; n < count; n++) {
            if (dv.getUint32(p, true) !== 0x02014b50) break;       // central dir header
            const method = dv.getUint16(p + 10, true);
            const compSize = dv.getUint32(p + 20, true);
            const nameLen = dv.getUint16(p + 28, true);
            const extraLen = dv.getUint16(p + 30, true);
            const commentLen = dv.getUint16(p + 32, true);
            const localOff = dv.getUint32(p + 42, true);
            const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
            p += 46 + nameLen + extraLen + commentLen;
            // Text parts (XML/rels) plus browser-renderable embedded media -
            // Foreign shapes reference visio/media rasters (EMF/WMF vector
            // media can't render in an <image>, so it isn't extracted).
            const mediaExt = /^visio\/media\/.*\.(png|jpe?g|gif|bmp)$/i.exec(name);
            if (!/\.(xml|rels)$/i.test(name) && !mediaExt) continue;
            if (dv.getUint32(localOff, true) !== 0x04034b50) continue;
            // Local header name/extra lengths can differ from the central record.
            const lNameLen = dv.getUint16(localOff + 26, true);
            const lExtraLen = dv.getUint16(localOff + 28, true);
            const dataStart = localOff + 30 + lNameLen + lExtraLen;
            const comp = u8.subarray(dataStart, dataStart + compSize);
            let bytes;
            if (method === 0) {
                if (comp.length > MAX_PART) throw new Error('a part is too large');
                bytes = comp;                                      // stored
            } else if (method === 8) {
                bytes = await inflateRaw(comp, MAX_PART);          // deflate (size-capped)
            } else continue;
            totalBytes += bytes.length;
            if (totalBytes > MAX_TOTAL) throw new Error('the file decompresses too large');
            if (mediaExt) {
                let s = '';
                for (let i = 0; i < bytes.length; i += 32768) {
                    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
                }
                const mime = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', bmp: 'bmp' }[mediaExt[1].toLowerCase()];
                out[name] = 'data:image/' + mime + ';base64,' + btoa(s);
            } else {
                out[name] = td.decode(bytes);
            }
        }
        return out;
    }

    // Small DOM helpers that ignore the Visio default namespace via localName.
    function vXml(text) { return new DOMParser().parseFromString(text, 'application/xml'); }
    function vKids(el, name) {
        const out = [];
        for (let c = el && el.firstElementChild; c; c = c.nextElementSibling) {
            if (c.localName === name) out.push(c);
        }
        return out;
    }
    function vCell(shapeEl, name) {
        for (let c = shapeEl.firstElementChild; c; c = c.nextElementSibling) {
            if (c.localName === 'Cell' && c.getAttribute('N') === name) return c.getAttribute('V');
        }
        return null;
    }
    const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    function relTarget(parentEl, relMap) {
        const rel = vKids(parentEl, 'Rel')[0];
        if (!rel) return null;
        const id = rel.getAttributeNS(REL_NS, 'id') || rel.getAttribute('r:id');
        return id ? relMap[id] : null;
    }
    function relMapFrom(text) {
        const map = {};
        if (!text) return map;
        const doc = vXml(text);
        Array.from(doc.getElementsByTagName('Relationship')).forEach(r => {
            map[r.getAttribute('Id')] = r.getAttribute('Target');
        });
        return map;
    }

    // Visio master/shape NameU → bundled stencil name. Unknown types fall back
    // to a fuzzy match, then a generated placeholder (mirrors the Gliffy path).
    const VISIO_STENCIL_MAP = {
        router: 'Router', gateway: 'Router',
        switch: 'Switch', hub: 'Switch', ethernet: 'Switch',
        'layer 3 switch': 'Multilayer Switch', 'multilayer switch': 'Multilayer Switch',
        server: 'Server', 'file server': 'Server', 'web server': 'Server', 'mail server': 'Server',
        'e-commerce server': 'Server', 'print server': 'Server', 'proxy server': 'Server', 'application server': 'Server',
        'database server': 'Storage', storage: 'Storage', san: 'Storage', nas: 'NAS', 'disk array': 'Storage',
        pc: 'Client', 'desktop pc': 'Client', computer: 'Client', workstation: 'Client', terminal: 'Client',
        laptop: 'Laptop', notebook: 'Laptop',
        printer: 'Printer', 'multifunction printer': 'Printer', scanner: 'Printer', copier: 'Printer',
        firewall: 'Firewall', cloud: 'Cloud', internet: 'Cloud',
        'wireless access point': 'WifiAP', 'access point': 'WifiAP', 'wireless router': 'WifiAP',
        user: 'User', phone: 'VOIPPhone', 'ip phone': 'VOIPPhone',
        tablet: 'Tablet', camera: 'Camera', 'load balancer': 'LoadBalancer',
        // Azure / cloud-architecture terms (from Azure Architecture Center exports)
        'virtual machine': 'VM', 'virtual machines': 'VM', vm: 'VM',
        'virtual network gateway': 'Router', 'virtual network gateways': 'Router',
        'vpn gateway': 'Router', 'azure vpn gateway': 'Router', 'local network gateway': 'Router',
        expressroute: 'Router', 'expressroute circuit': 'Router', 'expressroute circuits': 'Router',
        'sql database': 'Storage', 'sql server': 'Storage', database: 'Storage', databases: 'Storage',
        disks: 'Storage', 'hard disk': 'Storage', vhd: 'Storage', 'vhd data disk': 'Storage',
        'blob block': 'Storage', 'cache redis': 'Storage',
        'azure load balancer': 'LoadBalancer', 'application gateway': 'LoadBalancer', 'application gateways': 'LoadBalancer',
        'availability set': 'ServerCluster', 'kubernetes services': 'ServerCluster', 'hd insight clusters': 'ServerCluster',
        'network security group': 'Firewall', 'network security groups': 'Firewall', nsg: 'Firewall',
        dns: 'Globe', 'dns zones': 'Globe', 'traffic manager': 'Globe', 'traffic manager profiles': 'Globe',
        'virtual network': 'Cloud', 'virtual networks': 'Cloud', vnet: 'Cloud',
        azure: 'Cloud', 'microsoft azure': 'Cloud',
        'app service': 'Server', 'app services': 'Server', 'app service environments': 'Server',
        'function apps': 'Server', 'logic apps': 'Server', 'api management': 'Server',
        'api management services': 'Server', bastion: 'Server',
        // Second corpus pass (AIX on-premises, IPv6 hub-spoke, AVD samples)
        'os images (classic)': 'ClientVM', 'os images': 'ClientVM',
        monitor: 'Client', manager: 'User',
        'azure netapp files': 'NAS',
        'virtual clusters': 'ServerCluster',
        'route tables': 'Router', 'route table': 'Router',
        // Normalized keys: '-' and '_' become spaces ("Wi-Fi" → "wi fi")
        wireless: 'WifiAP', 'work from home wi fi': 'WifiAP', 'wi fi': 'WifiAP',
        'web page': 'Globe', browser: 'Globe',
        'sql managed instance': 'Storage',
        'exchange on premises access': 'Server',
        groups: 'User', workspace: 'Client', 'vnet whitebck2': 'Cloud',
        // Affinity expansion set (v4.0)
        'wireless lan controller': 'Wireless Controller', wlc: 'Wireless Controller',
        satellite: 'Satellite', 'satellite dish': 'Satellite Dish', 'earth station': 'Satellite Dish',
        dslam: 'Modem',
        'directory server': 'LDAP', 'active directory': 'LDAP', 'domain controller': 'LDAP',
        'cell phone': 'Mobile Phone', 'mobile phone': 'Mobile Phone', smartphone: 'Mobile Phone',
        // Tabler infrastructure set (v4.1)
        modem: 'Modem', 'cable modem': 'Modem', 'dsl modem': 'Modem',
        ups: 'UPS', 'patch panel': 'Patch Panel',
        rack: 'Rack', 'server rack': 'Rack', 'rack frame': 'Rack',
        'badge reader': 'Badge Reader', 'card reader': 'Badge Reader',
        sensor: 'Sensor', plc: 'PLC',
        factory: 'Factory', industry: 'Factory',
        'bar chart': 'Statistics', 'pie chart': 'Statistics',
        lightbulb: 'Light Bulb', idea: 'Light Bulb',
        gear: 'Cog', gears: 'Cog'
    };

    // Search synonyms for the Devices palette. The stencil set uses terse
    // canonical names (Client, VOIPPhone, WifiAP, EthernetRJ45, Globe...), so a
    // user searching "pc", "computer", "phone", "access point" or "wifi" would
    // otherwise find nothing - and renaming a stencil isn't an option (saved
    // diagrams reference stencils by @name). We already carry a rich alias
    // vocabulary for imports, so invert the Visio map (alias -> stencil) into
    // (stencil -> aliases), fold in guessClientStencil's consumer keywords, and
    // top it up with a small curated set of everyday terms the import maps
    // don't need. One source of truth; canonical names stay terse.
    const STENCIL_ALIASES = (() => {
        const idx = new Map();  // lowercase stencil name -> Set of alias phrases
        const add = (stencil, alias) => {
            const k = String(stencil).toLowerCase();
            if (!idx.has(k)) idx.set(k, new Set());
            idx.get(k).add(String(alias).toLowerCase());
        };
        // 1. Invert the Visio import map (its values are canonical stencil names)
        for (const alias in VISIO_STENCIL_MAP) add(VISIO_STENCIL_MAP[alias], alias);
        // 2. Consumer keywords from guessClientStencil that the Visio map lacks
        [['dock', 'Laptop'], ['macbook', 'Laptop'], ['ipad', 'Tablet'],
         ['android', 'Mobile Phone'], ['windows', 'Client'], ['win10', 'Client'],
         ['win11', 'Client'], ['macos', 'Client']].forEach(([a, s]) => add(s, a));
        // 3. Curated everyday synonyms the import vocabulary doesn't carry.
        //    Kept to whole, unambiguous terms (no 2-letter aliases - search is a
        //    plain substring test, so "ap" would surface inside "laptop").
        const EXTRA = {
            Client: ['desktop', 'endpoint', 'host', 'workstation'],
            Laptop: ['notebook'],
            Tablet: ['ipad'],
            VOIPPhone: ['voip', 'handset', 'telephone', 'deskphone'],
            WifiAP: ['wifi', 'wlan', 'accesspoint', 'wireless ap'],
            Camera: ['cctv', 'webcam', 'surveillance'],
            Printer: ['mfp', 'scanner', 'copier'],
            Firewall: ['asa', 'palo alto', 'fortigate', 'security appliance'],
            NAS: ['fileshare', 'filer', 'file server'],
            Storage: ['disk', 'array', 'volume'],
            EthernetRJ45: ['ethernet', 'rj45', 'patch', 'copper', 'cable'],
            Globe: ['internet', 'web', 'dns', 'wan', 'www'],
            Cloud: ['aws', 'gcp', 'saas'],
            ServerCluster: ['cluster', 'farm', 'kubernetes'],
            LoadBalancer: ['balancer', 'reverse proxy'],
            User: ['person', 'people', 'staff', 'employee'],
            VM: ['virtual machine', 'hypervisor', 'guest'],
            Office: ['building', 'site', 'branch'],
            House: ['home', 'residence', 'remote'],
            ClientVM: ['virtual desktop', 'vdi', 'thin client'],
            // Affinity expansion set (v4.0)
            'Multilayer Switch': ['l3 switch', 'layer 3', 'core switch'],
            'Wireless Controller': ['wlc', 'wireless lan controller'],
            'Cloud Router': ['wan router', 'isp router', 'edge router'],
            'Analog Phone': ['pots', 'landline', 'rotary'],
            'Mobile Phone': ['smartphone', 'cell phone', 'mobile', 'iphone', 'cordless'],
            'Cloud Phone': ['pbx', 'cloud pbx', 'hosted voice'],
            'Interconnect': ['fabric', 'peering'],
            Link: ['chain', 'connection'],
            Shield: ['security', 'protection', 'defense'],
            Fingerprint: ['biometric', 'identity'],
            Bug: ['virus', 'malware', 'defect', 'threat'],
            Inspect: ['magnifier', 'analyze', 'audit', 'scan'],
            LDAP: ['directory', 'active directory', 'domain controller'],
            Factory: ['industry', 'plant', 'manufacturing', 'warehouse'],
            'Map Pin': ['location', 'marker', 'gps', 'geo'],
            Cog: ['gear', 'settings', 'service', 'engine'],
            Communications: ['comms', 'messaging', 'chat'],
            Grid: ['mesh', 'matrix'],
            'Light Bulb': ['idea', 'lightbulb'],
            Statistics: ['chart', 'graph', 'analytics', 'metrics', 'reporting'],
            XML: ['code', 'markup', 'api'],
            // Tabler infrastructure set (v4.1)
            Modem: ['cable modem', 'ont', 'dsl', 'broadband', 'isp'],
            UPS: ['battery', 'power backup', 'uninterruptible'],
            'Patch Panel': ['keystone', 'punchdown', 'ports'],
            Rack: ['server rack', 'cabinet', '19 inch', 'rackmount'],
            'Badge Reader': ['nfc', 'card reader', 'door access', 'access control'],
            Sensor: ['detector', 'iot', 'telemetry', 'probe'],
            PLC: ['scada', 'industrial', 'automation', 'controller']
        };
        for (const s in EXTRA) EXTRA[s].forEach(a => add(s, a));
        const out = new Map();
        idx.forEach((set, k) => out.set(k, [...set]));
        return out;
    })();

    // Generic icon for imported shapes with no stencil match: an EMPTY glyph -
    // the app-drawn stencil frame provides the whole visual (a clean framed
    // blank matching the set). Deliberately NOT a palette template: unmatched
    // imports stay visually consistent without spamming the device list, and
    // the icon rides inline on each device (templateId null).
    const TEMPLATE_ICON = svgToDataURL(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"></svg>');

    function resolveVisioTemplate(typeName) {
        const key = normalizeStencilKey(typeName);
        // Prefer non-isDefault stencils. The built-in Default_ templates are
        // gone, but legacy localStorage imports may still carry the flag.
        const byName = (name) =>
            state.deviceTemplates.find(t => t.name === name && !t.isDefault) ||
            state.deviceTemplates.find(t => t.name === name);

        // A user/team stencil matching the source name always wins
        const custom = customImportTemplate(key);
        if (custom) return { template: custom, wasPlaceholder: false, typeName };

        const mappedName = VISIO_STENCIL_MAP[key] || VISIO_STENCIL_MAP[key.replace(/\s+/g, '')];
        if (mappedName) {
            const tmpl = byName(mappedName);
            if (tmpl) return { template: tmpl, wasPlaceholder: false, typeName };
        }
        // Fuzzy: substring match both raw and space-stripped, so multi-word
        // shape names reach compound template names ("azure load balancer" →
        // "LoadBalancer"). Plain includes stays floorless here - this pass
        // runs over BUNDLED names after the map, whose entries cover the
        // short ones; the squished rule carries the shared 4-char floor.
        const matches = (t) => {
            const tn = t.name.toLowerCase().replace('default_', '');
            if (tn === key || (key && (tn.includes(key) || key.includes(tn)))) return true;
            return squishedStencilMatch(tn, key);
        };
        const fuzzy = state.deviceTemplates.find(t => !t.isDefault && matches(t)) ||
            state.deviceTemplates.find(t => matches(t));
        if (fuzzy) return { template: fuzzy, wasPlaceholder: false, typeName };
        // No match: the device gets the generic template icon inline - no
        // placeholder template, so unknown types never reach the palette.
        return { template: null, wasPlaceholder: true, typeName };
    }

    async function importVisio(file) {
        let parts;
        try {
            if (typeof DecompressionStream === 'undefined') {
                throw new Error('this browser cannot unzip .vsdx (no DecompressionStream)');
            }
            parts = await unzipXmlParts(await file.arrayBuffer());
        } catch (e) {
            alert('Failed to read Visio file: ' + e.message);
            return;
        }

        const num = (v) => (v == null ? null : parseFloat(v));
        const def = (v, d) => (v == null || (typeof v === 'number' && isNaN(v)) ? d : v);
        const SCALE = 96;   // Visio inches → CSS pixels
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

        // 1) Masters: id → { nameU, w, h } (shape geometry is inherited from here).
        const masters = {};
        if (parts['visio/masters/masters.xml']) {
            const mdoc = vXml(parts['visio/masters/masters.xml']);
            const mRels = relMapFrom(parts['visio/masters/_rels/masters.xml.rels']);
            vKids(mdoc.documentElement, 'Master').forEach(m => {
                const id = m.getAttribute('ID');
                const nameU = m.getAttribute('NameU') || m.getAttribute('Name') || '';
                let w = null, h = null, linePattern = null, lineColor = null;
                let fillForegnd = null, fillPattern = null, fillTrans = null;
                let txtPinY = null, txtLocPinY = null, txtHeight = null, verticalAlign = null;
                const target = relTarget(m, mRels);
                if (target) {
                    const mx = parts['visio/masters/' + target.split('/').pop()];
                    if (mx) {
                        const sh = vXml(mx).getElementsByTagName('Shape')[0];
                        if (sh) {
                            w = num(vCell(sh, 'Width')); h = num(vCell(sh, 'Height'));
                            // Connector/box styling and text-block placement
                            // often live on the master sheet
                            linePattern = vCell(sh, 'LinePattern');
                            lineColor = vCell(sh, 'LineColor');
                            fillForegnd = vCell(sh, 'FillForegnd');
                            fillPattern = vCell(sh, 'FillPattern');
                            fillTrans = vCell(sh, 'FillForegndTrans');
                            txtPinY = vCell(sh, 'TxtPinY');
                            txtLocPinY = vCell(sh, 'TxtLocPinY');
                            txtHeight = vCell(sh, 'TxtHeight');
                            verticalAlign = vCell(sh, 'VerticalAlign');
                        }
                    }
                }
                masters[id] = { nameU, w, h, linePattern, lineColor, fillForegnd, fillPattern, fillTrans,
                                txtPinY, txtLocPinY, txtHeight, verticalAlign };
            });
        }

        // 2) Pages. CrossCanvas has a single canvas, so when a Visio document has
        //    multiple page tabs we import one - defaulting to the first, or
        //    letting the user pick when there's more than one. Page height is
        //    needed to flip Y (Visio's origin is bottom-left, Y up).
        const pageList = [];
        if (parts['visio/pages/pages.xml']) {
            const pdoc = vXml(parts['visio/pages/pages.xml']);
            const pRels = relMapFrom(parts['visio/pages/_rels/pages.xml.rels']);
            vKids(pdoc.documentElement, 'Page').forEach((pg, i) => {
                // Background pages (Background="1") hold watermarks/frames that
                // foreground pages reference - never content worth importing.
                if (pg.getAttribute('Background') === '1') return;
                const ps = vKids(pg, 'PageSheet')[0];
                const target = relTarget(pg, pRels);
                pageList.push({
                    name: pg.getAttribute('Name') || ('Page-' + (i + 1)),
                    height: def(num(ps ? vCell(ps, 'PageHeight') : null), 8.5),
                    path: target ? 'visio/pages/' + target.split('/').pop() : null
                });
            });
        }
        let pages = pageList.filter(p => p.path && parts[p.path]);
        if (!pages.length && parts['visio/pages/page1.xml']) {
            pages = [{ name: 'Page-1', height: 8.5, path: 'visio/pages/page1.xml' }];
        }
        if (!pages.length) { showDialog({ title: 'Visio import', body: 'No pages found in the Visio file.' }); return; }
        const totalPages = pages.length;
        let chosen = pages[0];
        if (totalPages > 1) {
            // Show per-page shape counts and flag the busiest page -
            // architecture posters often put a cover image on page 1.
            pages.forEach(p => {
                try { p.shapeCount = vXml(parts[p.path]).getElementsByTagName('Shape').length; }
                catch (e) { p.shapeCount = 0; }
            });
            let busiest = 0;
            pages.forEach((p, i) => { if (p.shapeCount > pages[busiest].shapeCount) busiest = i; });
            const pickIdx = await showDialog({
                title: `Choose a page to import (${totalPages} pages)`,
                body: (close) => {
                    const wrap = document.createElement('div');
                    pages.forEach((p, i) => {
                        const row = document.createElement('button');
                        row.type = 'button';
                        row.className = 'dialog-list-item';
                        const name = document.createElement('span');
                        name.textContent = p.name;
                        const note = document.createElement('span');
                        note.className = 'dialog-item-note';
                        note.textContent = ` - ${p.shapeCount} shapes` + (i === busiest ? ' (largest)' : '');
                        row.append(name, note);
                        row.addEventListener('click', () => close(i));
                        wrap.appendChild(row);
                    });
                    return wrap;
                },
                buttons: [{ label: 'Cancel', value: null }]
            });
            if (pickIdx == null) return;                      // cancelled
            chosen = pages[pickIdx];
        }
        const pageHeight = chosen.height;
        const pagePath = chosen.path;

        const pageRoot = vXml(parts[pagePath]).documentElement;
        const shapesEl = vKids(pageRoot, 'Shapes')[0];
        const topShapes = shapesEl ? vKids(shapesEl, 'Shape') : [];
        // The page's own rels resolve Foreign-shape media references
        // (visio/pages/pageN.xml → visio/pages/_rels/pageN.xml.rels)
        const pageRelMap = relMapFrom(parts[pagePath.replace(/pages\//, 'pages/_rels/') + '.rels']) || {};

        const stats = { devices: 0, zones: 0, textboxes: 0, connections: 0, skipped: 0, placeholders: [], images: 0 };
        const newDevices = [], newZones = [], newTextBoxes = [], newImages = [];
        const shapeById = {};   // Visio shape ID → imported node (device or zone)
        const ZONE_MIN_AREA = 200 * 100;

        // Read a value from a shape's <Section N="User"> (Visio writes the marker
        // msvStructureType="Container" on container/list/callout shapes).
        const userRowValue = (s, rowName) => {
            for (const sec of vKids(s, 'Section')) {
                if (sec.getAttribute('N') !== 'User') continue;
                for (const row of vKids(sec, 'Row')) {
                    if (row.getAttribute('N') === rowName) {
                        for (const c of vKids(row, 'Cell')) {
                            if (c.getAttribute('N') === 'Value') return c.getAttribute('V');
                        }
                    }
                }
            }
            return null;
        };
        // Extract a shape's text preserving line breaks - Visio stores them as
        // literal newlines in the <Text> content, and a 20-line list must not
        // collapse into one long label. Only horizontal whitespace is squeezed.
        const shapeText = (s) => {
            const t = vKids(s, 'Text')[0];
            if (!t) return '';
            return (t.textContent || '')
                .replace(/\r\n?|\u2028|\u2029/g, '\n')
                .split('\n')
                .map(ln => ln.replace(/[ \t\u00a0]+/g, ' ').trim())
                .join('\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        };
        const multiSpans = (text) => text.split('\n').map(ln => [{ text: ln, bold: false, italic: false }]);

        // Flatten the shape tree. Mastered shapes stay atomic - their nested
        // children are stencil-icon internals materialized into the page - but
        // masterless groups are layout groupings whose children are real
        // content: recurse into them, accumulating the parent's local-origin
        // offset (in Visio inches, Y-up, applied before the Y flip). 1-D
        // connectors surface into their own list, wherever they were nested.
        // EXCEPTION: an icon-sized masterless group of multiple textless
        // vector children is a pasted vector icon (Azure exports carry their
        // service icons as raw grouped geometry, no stencil master) - it
        // imports as ONE Blank device instead of flattening into skipped
        // fragments: unnameable, but a swappable framed blank beats the icon
        // vanishing, and connectors get a node to attach to.
        const looksLikeIconGroup = (s, subEls, W, H) => {
            const longIn = Math.max(W, H), shortIn = Math.min(W, H);
            if (longIn > 1.3 || shortIn < 0.14 || longIn / shortIn > 2.2) return false;
            if (shapeText(s)) return false;
            const kids = [];
            subEls.forEach(sub => kids.push(...vKids(sub, 'Shape')));
            if (kids.length < 2) return false;
            return !kids.some(k => shapeText(k));
        };
        const flatNodes = [];        // { s, ox, oy, isGroup, isVectorIcon }
        const flatConnectors = [];   // { s, ox, oy }
        const walkShapes = (shapes, ox, oy, depth) => {
            if (depth > 10) return;
            shapes.forEach(s => {
                if (vCell(s, 'BeginX') != null) { flatConnectors.push({ s, ox, oy }); return; }
                const subEls = vKids(s, 'Shapes');
                if (s.getAttribute('Master') == null && subEls.length) {
                    const W = def(num(vCell(s, 'Width')), 1), H = def(num(vCell(s, 'Height')), 1);
                    if (looksLikeIconGroup(s, subEls, W, H)) {
                        flatNodes.push({ s, ox, oy, isGroup: false, isVectorIcon: true });
                        return;
                    }
                    flatNodes.push({ s, ox, oy, isGroup: true });
                    const pinX = def(num(vCell(s, 'PinX')), 0), pinY = def(num(vCell(s, 'PinY')), 0);
                    const locX = def(num(vCell(s, 'LocPinX')), W / 2), locY = def(num(vCell(s, 'LocPinY')), H / 2);
                    subEls.forEach(sub => walkShapes(vKids(sub, 'Shape'), ox + pinX - locX, oy + pinY - locY, depth + 1));
                    return;
                }
                flatNodes.push({ s, ox, oy, isGroup: false });
            });
        };
        walkShapes(topShapes, 0, 0, 0);

        // Mastered border/frame shapes ("dash square", "Virtual Network Box",
        // "VNet WhiteBCK2", "Subnets") are containers drawn as stencils - the
        // masterless-box rule can't see them and they'd become placeholder
        // devices sitting on top of their contents. Match by master name.
        const BOX_MASTER_RE = /\b(box|square|rectangle|frame|border|background)\b|whitebck|^subnets?$/i;
        const masterNameOf = (s, m) =>
            ((m && m.nameU) || s.getAttribute('NameU') || '').replace(/\.\d+$/, '');

        // Visio stencils are physically large (~1in ≈ 96px), which imports
        // devices far bigger than CrossCanvas's idiom and crowds the layout.
        // Normalize so the file's TYPICAL (median) device lands at the app's
        // Default Size, preserving relative size differences between shapes.
        const physSizes = [];
        flatNodes.forEach(({ s }) => {
            if (s.getAttribute('Master') == null) return;
            if (userRowValue(s, 'msvStructureType') === 'Container') return;
            const m0 = masters[s.getAttribute('Master')] || null;
            if (BOX_MASTER_RE.test(masterNameOf(s, m0))) return;  // container, not a stencil
            const W0 = def(num(vCell(s, 'Width')), def(m0 && m0.w, 1));
            const H0 = def(num(vCell(s, 'Height')), def(m0 && m0.h, 1));
            if (Math.max(W0, H0) / Math.max(0.01, Math.min(W0, H0)) > 2) return;  // skip buses/links
            physSizes.push(Math.max(W0, H0) * SCALE);
        });
        physSizes.sort((a, b) => a - b);
        // The median must reflect the file's ICONS. Diagram exports can carry
        // swarms of tiny mastered decorations (6px connection dots, ticks) -
        // enough of them drags the median to dot size, sizeNorm explodes and
        // every real shape slams into the max-size clamp. Sub-icon shapes
        // (< 24px) don't vote unless the file has nothing bigger.
        const iconSizes = physSizes.filter(p => p >= 24);
        const sizeBasis = iconSizes.length ? iconSizes : physSizes;
        const medianPhys = sizeBasis.length ? sizeBasis[Math.floor(sizeBasis.length / 2)] : 0;
        // A median below stencil size means the page has no real stencil
        // icons to normalize against (vector-art exports: cards + dots +
        // step badges are all that carry masters) - such files are already
        // at diagram scale, so scaling by badge size would only distort.
        const normalize = medianPhys >= 40;
        const sizeNorm = normalize ? DEVICE_SIZE / medianPhys : 1;

        const nodePhys = new Map();   // device → physical half-size px, for connector snapping
        const nodeSrc = new Map();    // device → source page-space box, for exact anchors

        flatNodes.forEach(({ s, ox, oy, isGroup, isVectorIcon }) => {
            const id = s.getAttribute('ID');
            const m = masters[s.getAttribute('Master')] || null;
            const hasMaster = s.getAttribute('Master') != null;
            const W = def(num(vCell(s, 'Width')), def(m && m.w, 1));
            const H = def(num(vCell(s, 'Height')), def(m && m.h, 1));
            const pinX = def(num(vCell(s, 'PinX')), 0);
            const pinY = def(num(vCell(s, 'PinY')), 0);
            const cx = (ox + pinX) * SCALE;
            const cy = (pageHeight - (oy + pinY)) * SCALE;   // flip Y (Visio origin is bottom-left)
            const label = shapeText(s);
            const wPx = Math.max(GRID_SIZE, Math.round(W * SCALE));
            const hPx = Math.max(GRID_SIZE, Math.round(H * SCALE));

            // Pasted vector icons (detected at walk time) → one Blank device
            // each, at true footprint. No stencil name exists to map, so the
            // Icon dropdown is the upgrade path; labels arrive as separate
            // text shapes in this idiom, so the device stays unlabeled.
            if (isVectorIcon) {
                const aspect0 = Math.max(W, H) / Math.max(0.01, Math.min(W, H));
                const longPx = clamp(Math.round(Math.max(W, H) * SCALE * sizeNorm), 24, 200);
                const shortPx = Math.max(16, Math.round(longPx / aspect0));
                const dw = W >= H ? longPx : shortPx;
                const dh = W >= H ? shortPx : longPx;
                const blank = state.deviceTemplates.find(t => t.name === 'Blank');
                const icon = blank ? blank.image : TEMPLATE_ICON;
                const device = {
                    id: genId(),
                    templateId: blank ? blank.id : null, image: icon, originalImage: icon,
                    x: snapToGrid(Math.round(cx - dw / 2)), y: snapToGrid(Math.round(cy - dh / 2)),
                    w: dw, h: dh,
                    label: '', labelPosition: 'bottom',
                    fontSize: DEFAULT_FONT_SIZE, fontColor: '#333333',
                    lineFormats: [], spans: multiSpans(''), tintColor: null,
                    attachmentPoints: getDefaultAttachmentPoints(dw, dh)
                };
                shapeById[id] = device;
                nodePhys.set(device, (Math.max(W, H) * SCALE) / 2);
                nodeSrc.set(device, { cx: cx, cy: cy, w0: W * SCALE, h0: H * SCALE });
                newDevices.push(device);
                stats.devices++;
                stats.vectorIcons = (stats.vectorIcons || 0) + 1;
                return;
            }

            // Foreign shapes are embedded rasters (screenshots, logos): the
            // media part becomes a first-class pasted image at the shape's
            // true footprint. EMF/WMF media isn't browser-renderable - those
            // parts aren't extracted, so the shape falls through to skip.
            const foreignEl = vKids(s, 'ForeignData')[0];
            if (foreignEl) {
                const relT = relTarget(foreignEl, pageRelMap);
                const mediaKey = relT ? 'visio/media/' + relT.split('/').pop() : null;
                const uri = (mediaKey && typeof parts[mediaKey] === 'string' &&
                             parts[mediaKey].startsWith('data:image/')) ? parts[mediaKey] : null;
                if (uri) {
                    const image = {
                        id: genId(),
                        x: snapToGrid(Math.round(cx - wPx / 2)), y: snapToGrid(Math.round(cy - hPx / 2)),
                        w: wPx, h: hPx,
                        dataURL: uri,
                        label: label || '',
                        spans: multiSpans(label || ''),
                        labelPosition: 'bottom',
                        fontSize: DEFAULT_FONT_SIZE, fontColor: '#333333',
                        attachmentPoints: getDefaultAttachmentPoints(wPx, hPx)
                    };
                    shapeById[id] = image;
                    newImages.push(image);
                    stats.images++;
                } else {
                    stats.skipped++;
                }
                return;
            }

            // Classify: containers, masterless filled/large boxes, and mastered
            // shapes far larger than the file's typical stencil (VNet-style
            // background boxes) → zones; masterless text-only shapes → text
            // boxes; anything else with a stencil master → devices.
            const isContainer = userRowValue(s, 'msvStructureType') === 'Container';
            const fillPattern = vCell(s, 'FillPattern');
            const aspect = Math.max(W, H) / Math.max(0.01, Math.min(W, H));
            // A filled shape counts as a box only above a modest area floor -
            // flattened groups contain many small filled decoration rects that
            // would otherwise become zone spam. Layout groups additionally need
            // their own fill (area alone would zone every grouping).
            const looksLikeBox = !hasMaster && ((fillPattern != null && fillPattern !== '0' && wPx * hPx >= 6000) ||
                (!isGroup && wPx * hPx >= ZONE_MIN_AREA));
            // Mastered shapes far larger than the typical stencil are background
            // boxes (VNet boxes etc.) → zones. Strongly elongated shapes are
            // buses/links, not boxes - those stay Default Size icons.
            const physPx = Math.max(W, H) * SCALE;
            const oversizedMaster = hasMaster && !isContainer && aspect <= 4 && medianPhys > 0 &&
                physPx > Math.max(240, medianPhys * 2.5);
            // Border/frame masters are containers regardless of size (above a
            // floor that keeps tiny decorative squares from becoming zones).
            const boxMaster = hasMaster && wPx * hPx >= 6000 &&
                BOX_MASTER_RE.test(masterNameOf(s, m));

            if (isContainer || looksLikeBox || oversizedMaster || boxMaster) {
                // Zone visuals from the source (theme colors arrive as plain
                // hex). Azure exports tint region bands with a strong fill at
                // high FillForegndTrans - carried over as zone opacity (which
                // renders as fill-opacity). Unfilled boxes are the white
                // cards they are in the source, not the old uniform gray.
                // LinePattern 0 = borderless; zones always stroke, so blend
                // the border toward white by the same transparency to make
                // it read borderless while staying a plain hex for the panel.
                const hex6 = (v) => /^#[0-9a-fA-F]{6}$/.test(v || '') ? v : null;
                const blendToWhite = (hex, t) => {
                    const n = parseInt(hex.slice(1), 16);
                    return '#' + [16, 8, 0].map(sh =>
                        Math.round(((n >> sh) & 255) * (1 - t) + 255 * t)
                            .toString(16).padStart(2, '0')).join('');
                };
                const zFillRaw = hex6(vCell(s, 'FillForegnd')) || (m ? hex6(m.fillForegnd) : null);
                const zFillPat = def(vCell(s, 'FillPattern'), m ? m.fillPattern : null);
                const zLineCol = hex6(vCell(s, 'LineColor')) || (m ? hex6(m.lineColor) : null);
                const zLinePat = def(vCell(s, 'LinePattern'), m ? m.linePattern : null);
                const zTransRaw = def(num(vCell(s, 'FillForegndTrans')), m ? num(m.fillTrans) : null);
                const zTrans = (zTransRaw != null && !isNaN(zTransRaw)) ? clamp(zTransRaw, 0, 0.95) : 0;
                const filled = zFillRaw && zFillPat !== '0';
                const zFill = filled ? zFillRaw : '#ffffff';
                // Label placement from the Visio text block (shape cells
                // first, master fallback scaled to the instance height).
                // Visio's DEFAULT block spans the shape with MIDDLE
                // alignment - i.e. an unadorned container has a CENTERED
                // label (this used to hardcode Top). A block anchored above
                // or below the shape maps to the outside positions.
                const mScaleY = (m && m.h > 0) ? H / m.h : 1;
                const cellOrM = (name, mv) => {
                    const own = num(vCell(s, name));
                    if (own != null && !isNaN(own)) return own;
                    const mvn = num(mv);
                    return (mvn != null && !isNaN(mvn)) ? mvn * mScaleY : null;
                };
                const txtH = def(cellOrM('TxtHeight', m && m.txtHeight), H);
                const txtPinY = def(cellOrM('TxtPinY', m && m.txtPinY), H / 2);
                const txtLocY = def(cellOrM('TxtLocPinY', m && m.txtLocPinY), txtH / 2);
                const vaRaw = vCell(s, 'VerticalAlign') != null
                    ? vCell(s, 'VerticalAlign') : (m ? m.verticalAlign : null);
                const zVA = vaRaw === '0' ? 0 : vaRaw === '2' ? 2 : 1;
                const blockBottom = txtPinY - txtLocY;   // Y-up shape-local
                const anchorY = zVA === 0 ? blockBottom + txtH
                              : zVA === 2 ? blockBottom
                              : blockBottom + txtH / 2;
                const fyTop = H > 0 ? 1 - anchorY / H : 0.5;
                const zLabelPos = anchorY > H + 0.05 ? 'top'
                    : anchorY < -0.05 ? 'bottom'
                    : fyTop < 0.3 ? 'top-inside'
                    : fyTop > 0.7 ? 'bottom-inside' : 'center';
                const zone = {
                    id: genId(), shape: 'rectangle',
                    x: snapToGrid(Math.round(cx - wPx / 2)), y: snapToGrid(Math.round(cy - hPx / 2)),
                    w: wPx, h: hPx,
                    label: label, labelPosition: zLabelPos,
                    fontSize: DEFAULT_FONT_SIZE, fontColor: '#333333',
                    lineFormats: [], spans: multiSpans(label),
                    fill: zFill,
                    borderColor: zLinePat === '0' ? blendToWhite(zFill, zTrans)
                                                  : (zLineCol || '#b0bec5'),
                    opacity: filled ? clamp(1 - zTrans, 0.05, 1) : 1,
                    attachmentPoints: getDefaultAttachmentPoints(wPx, hPx)
                };
                shapeById[id] = zone;
                newZones.push(zone);
                stats.zones++;
                return;
            }

            if (!hasMaster) {
                if (label) {
                    newTextBoxes.push({
                        id: genId(),
                        x: snapToGrid(Math.round(cx - wPx / 2)), y: snapToGrid(Math.round(cy - hPx / 2)),
                        text: label, fontSize: DEFAULT_FONT_SIZE, fontColor: '#333333',
                        textAlign: 'left', lineFormats: [], spans: multiSpans(label)
                    });
                    stats.textboxes++;
                } else {
                    stats.skipped++;
                }
                return;
            }

            // Tiny unlabeled mastered shapes are corner badges (NSG shields,
            // network-manager markers, UDR tags) - decoration in the source,
            // but size normalization would inflate them to Default Size and
            // they'd collide with the real content they annotate.
            if (!label && medianPhys > 0 && physPx < Math.max(34, medianPhys * 0.55)) {
                stats.skipped++;
                return;
            }

            // Device: keep the source ASPECT - the app draws stencil frames at
            // any proportion, so bus bars and wide appliances import as the
            // bars they are (previously everything squared, and aspect > 2
            // shapes were forced to a Default Size square to avoid dwarfing
            // the diagram). Scale still normalizes the file's median stencil
            // to the app's Default Size, centered on the shape's pin.
            const baseType = (m && m.nameU) || (s.getAttribute('NameU') || '').split('.')[0];
            const longPx = clamp(Math.round(Math.max(W, H) * SCALE * sizeNorm), 40, 200);
            const shortPx = Math.max(16, Math.round(longPx / aspect));
            const dw = W >= H ? longPx : shortPx;
            const dh = W >= H ? shortPx : longPx;
            const { template, wasPlaceholder, typeName } = resolveVisioTemplate(baseType);
            // Keep the label blank when the Visio shape had none - don't fall
            // back to the stencil name (which produced labels like "Switch").
            const text = label;
            const icon = template ? template.image : TEMPLATE_ICON;
            const device = {
                id: genId(),
                templateId: template ? template.id : null, image: icon, originalImage: icon,
                x: snapToGrid(Math.round(cx - dw / 2)), y: snapToGrid(Math.round(cy - dh / 2)),
                w: dw, h: dh,
                label: text, labelPosition: 'bottom',
                fontSize: DEFAULT_FONT_SIZE, fontColor: '#333333',
                lineFormats: [], spans: multiSpans(text), tintColor: null,
                attachmentPoints: getDefaultAttachmentPoints(dw, dh)
            };
            shapeById[id] = device;
            nodePhys.set(device, physPx / 2);   // pre-normalization footprint, for connector snapping
            // Source box in page coordinates - connector endpoints reference
            // it, and the device was resized around its pin
            nodeSrc.set(device, { cx: cx, cy: cy, w0: W * SCALE, h0: H * SCALE });
            newDevices.push(device);
            stats.devices++;
            if (wasPlaceholder && !stats.placeholders.includes(typeName)) stats.placeholders.push(typeName);
        });

        // 3) Connections, from two sources: glued <Connects> (hub-style node
        //    ownership, or a connector end glued to a node) and - the norm in
        //    Azure/architecture exports - unglued 1-D connector shapes placed
        //    purely by Begin/End geometry, which carry no <Connects> at all.
        const connectsEl = vKids(pageRoot, 'Connects')[0];
        const byOwner = {};
        const glueEnds = {};   // connector sheet → which node each END is glued to
        (connectsEl ? vKids(connectsEl, 'Connect') : []).forEach(c => {
            const f = c.getAttribute('FromSheet'), t = c.getAttribute('ToSheet');
            (byOwner[f] = byOwner[f] || []).push(t);
            // FromCell says WHICH end the glue belongs to - rows arrive in
            // arbitrary order, and a connector glued only at one end used to
            // have that node applied to its Begin, collapsing the connection
            // onto one device (the degenerate filter then dropped it).
            const cell = c.getAttribute('FromCell') || '';
            const g = (glueEnds[f] = glueEnds[f] || {});
            if (/^Begin/.test(cell)) g.begin = t;
            else if (/^End/.test(cell)) g.end = t;
        });
        const edges = [];
        Object.keys(byOwner).forEach(owner => {
            // Glue owned by a connector sheet is resolved with its geometry below
            if (!shapeById[owner]) return;
            byOwner[owner].filter(t => shapeById[t])
                .forEach(t => edges.push({ a: owner, b: t }));   // hub node → targets
        });
        const seen = new Set();
        const nearestAP = (node, other) => {
            const ocx = other.x + other.w / 2, ocy = other.y + other.h / 2;
            let best = 0, bd = Infinity;
            node.attachmentPoints.forEach((ap, i) => {
                const d = (node.x + ap.rx - ocx) ** 2 + (node.y + ap.ry - ocy) ** 2;
                if (d < bd) { bd = d; best = i; }
            });
            return best;
        };
        // Match what a hand-drawn connection would look like (panel default
        // thickness) instead of the old hardcoded 2px, which read as "thin".
        const defThickness = parseInt(document.getElementById('conn-thickness').value) || 3;
        const newConnections = [];
        const connBase = () => ({
            id: genId(), color: '#333333', thickness: defThickness, dash: 'solid', routing: 'straight',
            label: '', labelPosition: 'top', fontSize: DEFAULT_FONT_SIZE, fontColor: '#333333',
            lineFormats: [], spans: [], startArrow: 'none', endArrow: 'none', annotations: []
        });
        edges.forEach(({ a, b }) => {
            if (a === b) return;
            const key = a < b ? a + '|' + b : b + '|' + a;
            if (seen.has(key)) return;
            seen.add(key);
            const na = shapeById[a], nb = shapeById[b];
            // Hub edges replace straight bus taps in the source: route straight
            newConnections.push(Object.assign(connBase(), {
                fromDevice: na.id, fromAP: nearestAP(na, nb), fromPoint: null,
                toDevice: nb.id, toAP: nearestAP(nb, na), toPoint: null
            }));
            stats.connections++;
        });

        // Geometry connectors. Each 1-D shape becomes one connection: an end
        // glued via <Connects> wins; otherwise snap to a nearby device (its
        // pre-normalization footprint plus slack, since devices shrank around
        // their pins) or a zone border; otherwise keep the end free-floating.
        const snapNode = (px, py) => {
            let best = null, bd = Infinity;
            newDevices.forEach(n => {
                const r = (nodePhys.get(n) || Math.max(n.w, n.h) / 2) + 12;
                const d = Math.hypot(n.x + n.w / 2 - px, n.y + n.h / 2 - py);
                if (d <= r && d < bd) { bd = d; best = n; }
            });
            if (best) return best;
            let bz = null, bzd = Infinity;
            newZones.forEach(z => {
                const inside = px >= z.x && px <= z.x + z.w && py >= z.y && py <= z.y + z.h;
                const dBorder = inside
                    ? Math.min(px - z.x, z.x + z.w - px, py - z.y, z.y + z.h - py)
                    : Math.max(z.x - px, px - (z.x + z.w), 0) + Math.max(z.y - py, py - (z.y + z.h), 0);
                if (dBorder <= 12 && dBorder < bzd) { bzd = dBorder; bz = z; }
            });
            return bz;
        };
        // Visio LinePattern → CrossCanvas dash style (1/none = solid; the rest of
        // the pattern table collapses onto the nearest of our five styles).
        const dashForPattern = (p) => {
            switch (String(p)) {
                case '3': case '10': return 'dot';
                case '4': case '5': case '11': case '12': case '13': case '14': return 'dash-dot';
                case '6': case '7': case '8': case '15': return 'dash-lg';
                case '9': case '19': case '20': case '21': case '22': case '23': return 'dash-sm';
                case '2': case '16': case '17': case '18': return 'dash-md';
                default: return 'solid';
            }
        };
        // The connector's own Geometry section is its routed path in shape-
        // local coordinates (page = pin - locpin + local, then the Y flip).
        // Intermediate points become waypoints - the same vehicle as Gliffy
        // hand-routed lines - and convert to native bends after import when
        // the route fits the rails. Conservative bail-outs keep today's
        // straight-line behavior: no own geometry (masters only carry the
        // unplaced default), rotated frames (1-D geometry rides the rotated
        // axis), curve rows, or formula-only cells.
        const LINE_ROW = /^(MoveTo|LineTo|RelMoveTo|RelLineTo)$/;
        const connectorWaypoints = (s, ox, oy, bx, by, ex, ey) => {
            const geo = vKids(s, 'Section').find(sec => sec.getAttribute('N') === 'Geometry');
            if (!geo) return null;
            const rows = vKids(geo, 'Row').filter(r => r.getAttribute('Del') !== '1');
            if (rows.length < 2) return null;
            const W = def(num(vCell(s, 'Width')), 0), H = def(num(vCell(s, 'Height')), 0);
            const pinX = def(num(vCell(s, 'PinX')), 0), pinY = def(num(vCell(s, 'PinY')), 0);
            const locX = def(num(vCell(s, 'LocPinX')), W / 2), locY = def(num(vCell(s, 'LocPinY')), H / 2);
            if (Math.abs(def(num(vCell(s, 'Angle')), 0)) > 0.0001) return null;
            // A row may omit a coordinate cell that hasn't changed from the
            // previous point (omit-if-unchanged serialization), so track the
            // running point, seeded from Begin in shape-local coordinates.
            const pts = [];
            let curX = def(num(vCell(s, 'BeginX')), 0) - (pinX - locX);
            let curY = def(num(vCell(s, 'BeginY')), 0) - (pinY - locY);
            for (const row of rows) {
                const t = row.getAttribute('T') || '';
                const leading = row === rows[0];
                if (t === 'ArcTo') {
                    // Cosmetic arcs - corner rounding and line-jump "hops"
                    // over crossing lines - flatten to their endpoint (the
                    // chord lies on the route; normalize merges it away). A
                    // genuinely curved connector (big bow) keeps today's
                    // straight-line import.
                    const bow = num(vCell(row, 'A'));
                    if (bow == null || isNaN(bow) || Math.abs(bow) > 0.1) return null;
                } else if (!LINE_ROW.test(t)) {
                    return null;
                } else if ((t === 'MoveTo' || t === 'RelMoveTo') && !leading) {
                    return null;                  // mid-path jump: not one route
                }
                let x = num(vCell(row, 'X')), y = num(vCell(row, 'Y'));
                if (t === 'RelMoveTo' || t === 'RelLineTo') {
                    if (x != null && !isNaN(x)) x *= W;
                    if (y != null && !isNaN(y)) y *= H;
                }
                if (x == null || isNaN(x)) x = curX;
                if (y == null || isNaN(y)) y = curY;
                curX = x; curY = y;
                pts.push({
                    x: (ox + pinX - locX + x) * SCALE,
                    y: (pageHeight - (oy + pinY - locY + y)) * SCALE
                });
            }
            // The last endpoint is End; a leading MoveTo is Begin (dynamic
            // connectors inherit the MoveTo and serialize LineTos only) -
            // both resolve to attachment points, so only what's between them
            // matters. Line masters also pad dead-straight connectors with
            // duplicate/collinear rows: measure against the real endpoints
            // and keep only genuine corners.
            pts.pop();
            const t0 = rows[0].getAttribute('T');
            if (t0 === 'MoveTo' || t0 === 'RelMoveTo') pts.shift();
            if (!pts.length) return null;
            const full = normalizeRoute([{ x: bx, y: by }, ...pts, { x: ex, y: ey }]);
            if (full.length < 3) return null;
            return full.slice(1, -1);
        };

        flatConnectors.forEach(({ s, ox, oy }) => {
            const cid = s.getAttribute('ID');
            const cm = masters[s.getAttribute('Master')] || null;
            const lp = vCell(s, 'LinePattern') != null ? vCell(s, 'LinePattern') : (cm && cm.linePattern);
            const lc = vCell(s, 'LineColor') || (cm && cm.lineColor);
            const lineColor = /^#[0-9a-fA-F]{6}$/.test(lc || '') ? lc : '#333333';
            const bx = (ox + def(num(vCell(s, 'BeginX')), 0)) * SCALE;
            const by = (pageHeight - (oy + def(num(vCell(s, 'BeginY')), 0))) * SCALE;
            const ex2 = (ox + def(num(vCell(s, 'EndX')), 0)) * SCALE;
            const ey2 = (pageHeight - (oy + def(num(vCell(s, 'EndY')), 0))) * SCALE;
            const glue = glueEnds[cid] || {};
            const gluedBegin = glue.begin != null ? shapeById[glue.begin] : null;
            const gluedEnd = glue.end != null ? shapeById[glue.end] : null;
            const resolveEnd = (px, py, gluedNode) => {
                const n = gluedNode || snapNode(px, py);
                if (!n) {
                    const pt = { x: snapToGrid(Math.round(px)), y: snapToGrid(Math.round(py)) };
                    return { device: null, ap: null, point: pt, abs: pt };
                }
                // Exact-anchor resolution (as in the Gliffy importer): express
                // the contact point as a fraction of the SOURCE box - devices
                // were resized around their pins, so page coordinates don't
                // land on the imported node directly - then reuse an AP within
                // 2px or inject one at the precise spot.
                const src = nodeSrc.get(n);
                const bx0 = src ? src.cx - src.w0 / 2 : n.x, bw0 = src ? src.w0 : n.w;
                const by0 = src ? src.cy - src.h0 / 2 : n.y, bh0 = src ? src.h0 : n.h;
                const fx = Math.max(0, Math.min(1, (px - bx0) / Math.max(1, bw0)));
                const fy = Math.max(0, Math.min(1, (py - by0) / Math.max(1, bh0)));
                const ap = mapToAP(fx, fy, n.attachmentPoints, n.w, n.h);
                const a = n.attachmentPoints[ap];
                return { device: n.id, ap: ap, point: null, abs: { x: n.x + a.rx, y: n.y + a.ry } };
            };
            // Routes were drawn against SOURCE-sized shapes; resizing a device
            // around its pin slides the contact point along the box edge, so
            // the route's end segments come out slightly diagonal. When an end
            // segment was axis-aligned in the source, re-align it with the
            // resolved endpoint - a pure resize artifact, not a reroute. The
            // small-delta axis is the one to correct, which also keeps a
            // waypoint pair's shared rail intact.
            const alignEndSegment = (pt, end) => {
                const TOL = 24;
                const dx = Math.abs(pt.x - end.x), dy = Math.abs(pt.y - end.y);
                if (dx <= TOL && dy > TOL) pt.x = end.x;
                else if (dy <= TOL && dx > TOL) pt.y = end.y;
            };
            const A = resolveEnd(bx, by, gluedBegin);
            const B = resolveEnd(ex2, ey2, gluedEnd);
            // Degenerate: both ends on the same attachment point, or a tiny
            // free-floating scribble
            if (A.device && B.device && A.device === B.device && A.ap === B.ap) return;
            if (!A.device && !B.device && Math.hypot(ex2 - bx, ey2 - by) < 8) return;
            const beginArrow = vCell(s, 'BeginArrow'), endArrowV = vCell(s, 'EndArrow');
            // Bent connectors keep their routed path; plain two-point lines
            // stay straight (the faithful import for them).
            const wps = connectorWaypoints(s, ox, oy, bx, by, ex2, ey2);
            if (wps) {
                alignEndSegment(wps[0], A.abs);
                alignEndSegment(wps[wps.length - 1], B.abs);
            } else {
                // Straight 2-point connectors that were AXIS-ALIGNED in the
                // source can resolve a few px diagonal: the pin-centered
                // device resize slides each contact along its box edge
                // independently, and free ends grid-snap. Re-align: fix a
                // free end outright, or re-anchor the 'to' end at the
                // fraction that lines up (mapToAP injects a fresh AP, so
                // other connections sharing the old one are untouched).
                const horiz = Math.abs(by - ey2) < 1, vert = Math.abs(bx - ex2) < 1;
                if ((horiz || vert) && A.abs && B.abs) {
                    const drift = horiz ? Math.abs(A.abs.y - B.abs.y) : Math.abs(A.abs.x - B.abs.x);
                    if (drift >= 1 && drift <= 24) {
                        const fixFree = (end, other) => {
                            if (horiz) end.point.y = other.abs.y; else end.point.x = other.abs.x;
                            end.abs = { x: end.point.x, y: end.point.y };
                        };
                        if (!A.device) fixFree(A, B);
                        else if (!B.device) fixFree(B, A);
                        else {
                            const n = [...newDevices, ...newZones].find(nd => nd.id === B.device);
                            if (n) {
                                const ap0 = n.attachmentPoints[B.ap];
                                const fx = horiz ? ap0.rx / n.w
                                                 : clamp((A.abs.x - n.x) / Math.max(1, n.w), 0, 1);
                                const fy = horiz ? clamp((A.abs.y - n.y) / Math.max(1, n.h), 0, 1)
                                                 : ap0.ry / n.h;
                                B.ap = mapToAP(fx, fy, n.attachmentPoints, n.w, n.h);
                                const a2 = n.attachmentPoints[B.ap];
                                B.abs = { x: n.x + a2.rx, y: n.y + a2.ry };
                            }
                        }
                    }
                }
            }
            newConnections.push(Object.assign(connBase(), {
                fromDevice: A.device, fromAP: A.ap, fromPoint: A.point,
                toDevice: B.device, toAP: B.ap, toPoint: B.point,
                dash: dashForPattern(lp), color: lineColor,
                startArrow: beginArrow && beginArrow !== '0' ? 'arrow' : 'none',
                endArrow: endArrowV && endArrowV !== '0' ? 'arrow' : 'none',
                routing: wps ? 'rounded' : 'straight',
                waypoints: wps || null
            }));
            stats.connections++;
        });

        // 4) Apply to state (replace the current diagram, like the Gliffy import).
        resetDocumentState();
        state.devices = newDevices;
        state.connections = newConnections;
        state.zones = newZones;
        state.textBoxes = newTextBoxes;
        state.images = newImages;
        state.diagramTitle = (file.name || 'visio-import').replace(/\.(vsdx|vsdm)$/i, '');
        state.diagramVersion = 1;
        // Routed paths that fit the native rails become real bent connections
        // (needs the new nodes in state so endpoints resolve)
        state.connections.forEach(convertWaypointsToBends);
        setDirty(true);
        updateTitleVersionUI();
        resetTiers();
        renderDeviceList();
        renderAllZones();
        renderAllImages();
        renderAllDevices();
        renderAllConnections();
        updateCanvasSize();

        let msg = `Devices: ${stats.devices}\n`;
        msg += `Zones: ${stats.zones}\n`;
        msg += `Text boxes: ${stats.textboxes}\n`;
        msg += `Connections: ${stats.connections}\n`;
        if (stats.images > 0) msg += `Images: ${stats.images}\n`;
        if (stats.skipped > 0) msg += `Skipped: ${stats.skipped} (decorative/empty)\n`;
        if (stats.vectorIcons) msg += `Vector-art icons imported as Blank devices: ${stats.vectorIcons}\n`;
        if (totalPages > 1) msg += `\nImported page "${chosen.name}" of ${totalPages}.\n`;
        if (stats.placeholders.length > 0) {
            msg += `\nUnrecognized types imported with the generic icon:\n`;
            msg += stats.placeholders.map(p => `  • ${p}`).join('\n');
            msg += '\n\nSwap icons via the Icon dropdown in Device Properties.';
        } else if (stats.vectorIcons) {
            msg += '\nSwap icons via the Icon dropdown in Device Properties.';
        }
        showDialog({ title: 'Visio import complete', body: msg.trim() });
    }

    // Load a parsed native-diagram object into state (used by file load and
    // autosave restore). Performs schema migrations and template re-merge.
    function applyDiagramData(data) {
        // Validate the shape BEFORE touching state - a malformed file used to
        // replace the arrays and then throw mid-migration, destroying the
        // current diagram with no rollback (callers catch and alert, but the
        // old content was already gone).
        if (!data || typeof data !== 'object') throw new Error('not a diagram file');
        ['devices', 'connections', 'zones', 'textBoxes', 'images', 'deviceTemplates'].forEach(k => {
            if (data[k] !== undefined && !Array.isArray(data[k])) {
                throw new Error('invalid diagram file: "' + k + '" is not a list');
            }
        });

        // The shape check above catches a non-array `devices`, but not a bad
        // ELEMENT - a null in the array, spans:5, a missing attachmentPoints -
        // which passes here, gets swapped into state, then throws during
        // migration or render, leaving the editor showing half the old diagram
        // and half nothing with no way back. Snapshot the current document and
        // roll back on any throw so a malformed file is a clean no-op the
        // caller can alert on, with the open diagram intact.
        const _rollback = snapshotState();
        try {
            applyDiagramDataUnsafe(data);
        } catch (err) {
            try { restoreSnapshot(_rollback); } catch (_) { /* the snapshot was valid; best effort */ }
            throw err;
        }
    }

    // The body of applyDiagramData, split out so the public entry can wrap it
    // in a snapshot/rollback. Never call this directly - it mutates state
    // before it can know the whole file is well-formed.
    function applyDiagramDataUnsafe(data) {

        // Object ids become DOM ids at render, and getElementById is global, so
        // a file with an object id like "canvas-bg" (or any panel/control id)
        // would SHADOW real app chrome - fitToView would then re-anchor a device
        // instead of the background, ?bg= would paint the wrong element, and so
        // on. We keep the id-equals-DOM-id contract (the kiosk overlay reads
        // g.id) and instead re-mint just the offenders, cascading references.
        // Reserved = every id in the live DOM that is NOT an object-layer node
        // (those belong to the outgoing doc and are about to be cleared), so the
        // set stays correct as chrome evolves without a hand-maintained list.
        const reservedIds = new Set();
        document.querySelectorAll('[id]').forEach(el => {
            if (!el.closest('#devices-layer, #zones-layer, #connections-layer, #images-layer, #overlay-layer, #status-overlay')) {
                reservedIds.add(el.id);
            }
        });
        if (reservedIds.size) {
            let n = 0;
            const idRemap = {};
            const remap = (o) => {
                if (o && o.id != null && reservedIds.has(String(o.id))) {
                    const fresh = 'x' + (n++) + '-' + o.id;   // unique, and no chrome id starts with "x<n>-"
                    idRemap[o.id] = fresh;
                    o.id = fresh;
                }
            };
            (data.devices || []).forEach(remap);
            (data.zones || []).forEach(remap);
            (data.images || []).forEach(remap);
            (data.textBoxes || []).forEach(remap);
            (data.connections || []).forEach(remap);
            if (Object.keys(idRemap).length) {
                (data.connections || []).forEach(c => {
                    if (c && idRemap[c.fromDevice]) c.fromDevice = idRemap[c.fromDevice];
                    if (c && idRemap[c.toDevice]) c.toDevice = idRemap[c.toDevice];
                });
                (data.groups || []).forEach(g => {
                    if (g && Array.isArray(g.members)) g.members = g.members.map(m => idRemap[m] || m);
                });
            }
        }

        // Resolve slimmed image references (v6+): '#key' → imageTable,
        // '@name' → the stencil library loaded at startup (bundled templates
        // are in place before any load/restore runs). A '@' ref whose library
        // entry is missing degrades to the generic template icon so the
        // diagram stays readable; an unresolvable '#' ref stays as-is and is
        // blanked by the isSafeImageURL checks below like any bad image.
        const imgTable = data.imageTable || {};
        const libByImgName = new Map(
            state.deviceTemplates.filter(t => t.isBundled).map(t => [t.name, t.image]));
        // Stencils retired from the bundled set resolve to their nearest
        // living relative so old saves keep a meaningful icon (names not
        // listed here degrade to the generic frame like any unknown ref).
        const LEGACY_STENCILS = {
            'Hub': 'Switch', 'DSLAM': 'Modem', 'Wireless Phone': 'Mobile Phone',
            'Conversation': 'Communications'
        };
        const deref = (v) => {
            if (typeof v !== 'string') return v;
            if (v[0] === '#') return imgTable[v.slice(1)] !== undefined ? imgTable[v.slice(1)] : v;
            if (v[0] === '@') {
                const name = v.slice(1);
                if (name === '__generic__') return TEMPLATE_ICON;
                return libByImgName.get(name) ||
                       libByImgName.get(LEGACY_STENCILS[name]) || TEMPLATE_ICON;
            }
            return v;
        };
        (data.devices || []).forEach(d => { d.image = deref(d.image); d.originalImage = deref(d.originalImage); });
        (data.images || []).forEach(im => { im.dataURL = deref(im.dataURL); });
        (data.deviceTemplates || []).forEach(t => { t.image = deref(t.image); });

        state.devices = data.devices || [];
        state.connections = data.connections || [];
        state.zones = data.zones || [];
        state.textBoxes = data.textBoxes || [];
        state.textBoxes.forEach(migrateTextBox);
        state.devices.forEach(d => {
            migrateLineFormats(d, 'label');
            migrateToSpans(d, 'label');
            if (!d.originalImage) d.originalImage = d.image;
            if (d.tintColor === undefined) d.tintColor = null;
            if (!isSafeImageURL(d.image)) d.image = '';
            if (!isSafeImageURL(d.originalImage)) d.originalImage = d.image;
        });
        state.zones.forEach(z => { migrateLineFormats(z, 'label'); migrateToSpans(z, 'label'); });
        state.connections.forEach(c => {
            migrateLineFormats(c, 'label');
            migrateToSpans(c, 'label');
            if (!c.startArrow) c.startArrow = 'none';
            if (!c.endArrow) c.endArrow = 'none';
            if (!c.arrowScale) c.arrowScale = 1;
            if (!c.annotations) c.annotations = [];
        });
        state.images = (data.images || []).filter(img => isSafeImageURL(img.dataURL));
        state.images.forEach(migrateImage);

        // Saved files carry only custom templates; re-merge them onto the
        // in-memory app library (default + bundled from devices.js). Custom
        // template IDs come from another session's counter, so remap them to
        // fresh IDs to avoid colliding with the current library, and update
        // any placed devices that reference them.
        const fileTemplates = (data.deviceTemplates || []).filter(t => isSafeImageURL(t.image));
        const lib = state.deviceTemplates.filter(t => t.isDefault || t.isBundled);
        const libByName = new Map(lib.map(t => [t.name, t]));
        const tmplIdRemap = {};
        fileTemplates.forEach(t => {
            const match = libByName.get(t.name);
            if (match) { tmplIdRemap[t.id] = match.id; return; }
            const newId = genId();
            tmplIdRemap[t.id] = newId;
            const merged = { id: newId, image: t.image, name: t.name, isDefault: false, isBundled: false };
            lib.push(merged);
            libByName.set(t.name, merged);
        });
        state.deviceTemplates = lib;
        state.devices.forEach(d => {
            if (d.templateId && tmplIdRemap[d.templateId]) d.templateId = tmplIdRemap[d.templateId];
        });

        // Advance the counter past both the loaded entities and the retained
        // library so future IDs can't collide with either.
        let maxTmplNum = 0;
        lib.forEach(t => {
            const n = parseInt(String(t.id).slice(1), 10);
            if (!isNaN(n)) maxTmplNum = Math.max(maxTmplNum, n);
        });
        state.nextId = Math.max(data.nextId || 1, maxTmplNum + 1);
        state.groups = Array.isArray(data.groups)
            ? data.groups.filter(g => g && Array.isArray(g.members)).map(g => ({ id: g.id || genId(), members: g.members.slice() }))
            : [];
        pruneGroups();
        // Deselect through the normal path so open property panels close
        // (nulling the state alone left e.g. a zone panel showing the
        // pre-load object's values).
        deselectAll();
        clearAnnotationSelection();
        state.diagramTitle = data.diagramTitle || 'network-diagram';
        state.diagramVersion = data.diagramVersion || 1;
        setDirty(false);
        // Cancel a pre-load autosave timer: it would snapshot the freshly
        // loaded (clean) diagram and prompt "Restore unsaved work?" later.
        if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
        updateTitleVersionUI();
        resetTiers();
        renderDeviceList();
        renderAllZones();
        renderAllImages();
        renderAllDevices();
        renderAllConnections();
        updateCanvasSize();
    }

    // Route a diagram file to the right importer by extension/content.
    // Resolves after the import fully lands (including any page-picker
    // dialogs), so callers like Merge can compose around it. `merge` skips
    // the doc-identity side effects (filename adoption, Open Recent).
    // Commit a pre-captured document snapshot as an undo step. Split from
    // pushUndo so Open/Merge can capture BEFORE an import and commit only if
    // it lands - a failed import must leave undo/redo/dirty untouched.
    function pushUndoSnapshot(json) {
        undoStack.push(json);
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack.length = 0;
        gcSnapshotIntern();
        updateUndoRedoButtons();
        setDirty(true);
    }
    // Every importer commits by REPLACING the state arrays, so identity of
    // state.devices tells us whether an import actually landed (failure paths
    // alert-and-return leaving the arrays untouched).
    function importLanded(preDevices) {
        return state.devices !== preDevices;
    }

    async function routeDiagramFile(file, merge) {
        // A plain Open replaces the whole document - capture it first and
        // commit the undo step only if the import lands (Merge handles its
        // own snapshot with merge=true).
        let preSnap = null, preDevices = null;
        if (!merge) {
            flushDebouncedUndo();
            preSnap = snapshotState();
            preDevices = state.devices;
        }
        const finish = () => {
            if (!merge && importLanded(preDevices)) pushUndoSnapshot(preSnap);
        };
        // Visio packages are binary (ZIP); route them to the dedicated importer
        // which reads the file as an ArrayBuffer rather than text.
        if (/\.(vsdx|vsdm)$/i.test(file.name)) { await importVisio(file); finish(); return; }
        if (/\.drawio$/i.test(file.name)) { await importDrawio(file); finish(); return; }
        const text = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (ev) => resolve(ev.target.result);
            reader.onerror = () => reject(new Error('could not read file'));
            reader.readAsText(file);
        });
        try {
            const data = JSON.parse(text);
            // Detect Gliffy format
            if (data.contentType === 'application/gliffy+json' || (data.stage && data.stage.objects)) {
                importGliffy(data, file.name);
                finish();
                return;
            }
            applyDiagramData(data);
            if (!merge) {
                // The filename the user manages wins over the embedded title,
                // so a file renamed in the OS keeps its new name - mirroring
                // how Save back-parses the name chosen in the dialog.
                applyChosenFileName(file.name);
                updateTitleVersionUI();
                recordRecent();
            }
            finish();
        } catch (err) {
            // Not JSON: a draw.io file saved as .xml (or with the extension
            // stripped) is XML - sniff and route before giving up.
            const txt = String(text || '');
            if (/^\s*<\?xml|^\s*<mxfile|^\s*<mxGraphModel/.test(txt) &&
                (txt.includes('<mxfile') || txt.includes('<mxGraphModel'))) {
                await importDrawioText(txt, file.name);
                finish();
                return;
            }
            alert('Failed to load diagram: ' + err.message);
        }
    }

    document.getElementById('file-load').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        routeDiagramFile(file, false);
        e.target.value = '';
    });

    // --- Merge import: marry another diagram into the current canvas -------
    // Shift the whole (freshly imported) document by dx/dy. Manual bends are
    // stored as absolute coordinates keyed to the natural route, so capture
    // their orientations against pre-move geometry first (same rules as
    // multi-select move).
    function translateWholeDocument(dx, dy) {
        if (!dx && !dy) return;
        // Same bend semantics as multi-select move: capture orientations
        // against pre-move geometry, apply after the nodes shift.
        const bendShifts = captureBendShifts(() => true);
        [state.devices, state.zones, state.textBoxes, state.images].forEach(arr =>
            arr.forEach(o => { o.x += dx; o.y += dy; }));
        state.connections.forEach(conn => {
            if (conn.fromPoint) { conn.fromPoint.x += dx; conn.fromPoint.y += dy; }
            if (conn.toPoint) { conn.toPoint.x += dx; conn.toPoint.y += dy; }
            if (conn.waypoints) conn.waypoints.forEach(w => { w.x += dx; w.y += dy; });
        });
        applyBendShifts(bendShifts, dx, dy);
    }

    // Re-mint every object id in the (freshly imported) document and fix the
    // references. Needed for native .xcanvas/.netdraw merges, whose files
    // carry their own id space; harmless for the converters, which mint via
    // genId() anyway.
    function remapMergedIds() {
        const idMap = new Map();
        const remap = (o) => { const n = genId(); idMap.set(o.id, n); o.id = n; };
        state.devices.forEach(remap);
        state.zones.forEach(remap);
        state.textBoxes.forEach(remap);
        state.images.forEach(remap);
        state.connections.forEach(remap);
        state.connections.forEach(c => {
            if (idMap.has(c.fromDevice)) c.fromDevice = idMap.get(c.fromDevice);
            if (idMap.has(c.toDevice)) c.toDevice = idMap.get(c.toDevice);
        });
        state.groups.forEach(g => {
            g.id = genId();
            g.members = (g.members || []).map(m => idMap.get(m) || m);
        });
    }

    // Import a second (third, ...) diagram INTO the current canvas instead of
    // replacing it. The importer runs normally - replacing state with just the
    // new content - then the new content is re-id'd, placed to the right of
    // the existing content, and the saved document is put back underneath.
    // One undo step restores the pre-merge canvas.
    async function mergeDiagramFile(file) {
        flushDebouncedUndo();
        const preSnap = snapshotState();
        const saved = {
            devices: state.devices, connections: state.connections,
            zones: state.zones, textBoxes: state.textBoxes,
            images: state.images, groups: state.groups,
            templates: state.deviceTemplates,
            title: state.diagramTitle, version: state.diagramVersion,
            nextId: state.nextId, bounds: getContentBounds()
        };
        await routeDiagramFile(file, true);
        // Importers commit by REPLACING the state arrays; if state.devices is
        // still the saved array, the import failed or was cancelled and the
        // document is untouched - bail before the remap/translate/concat
        // machinery runs against aliased arrays (which would double and shift
        // everything). No undo step is recorded for a no-op.
        if (!importLanded(saved.devices)) return;
        pushUndoSnapshot(preSnap);
        // Never mint ids below either id space (native loads set nextId from
        // the file; the saved doc's counter may be higher).
        state.nextId = Math.max(state.nextId, saved.nextId);
        remapMergedIds();
        const added = getContentBounds();
        if (added && saved.bounds) {
            translateWholeDocument(saved.bounds.maxX + 80 - added.minX,
                                   saved.bounds.minY - added.minY);
        }
        // Leave the new arrivals multi-selected: shows exactly what merged in,
        // and "drag it where you want it" becomes a single gesture.
        const addedSel = {
            devices: state.devices.map(d => d.id),
            zones: state.zones.map(z => z.id),
            textBoxes: state.textBoxes.map(t => t.id),
            images: state.images.map(im => im.id),
            connections: state.connections.map(cn => cn.id)
        };
        state.devices = saved.devices.concat(state.devices);
        state.connections = saved.connections.concat(state.connections);
        state.zones = saved.zones.concat(state.zones);
        state.textBoxes = saved.textBoxes.concat(state.textBoxes);
        state.images = saved.images.concat(state.images);
        state.groups = saved.groups.concat(state.groups);
        // A native donor file rebuilds the template library as bundled +
        // its own customs (applyDiagramData's lib filter) - put the host
        // session's custom stencils back so the merge can't drop them.
        // On id collision the donor's template wins (its devices reference
        // it); host devices carry their images inline either way.
        const haveTmpl = new Set(state.deviceTemplates.map(t => t.id));
        saved.templates.forEach(t => {
            if (!t.isBundled && !t.isDefault && !haveTmpl.has(t.id)) {
                state.deviceTemplates.push(t);
            }
        });
        renderDeviceList();
        // The merged canvas keeps ITS identity - the incoming file is a
        // donor, not a replacement.
        state.diagramTitle = saved.title;
        state.diagramVersion = saved.version;
        setDirty(true);
        updateTitleVersionUI();
        renderAllZones();
        renderAllImages();
        renderAllDevices();
        renderAllConnections();
        updateCanvasSize();
        state.selectedDevices = addedSel.devices;
        state.selectedZones = addedSel.zones;
        state.selectedTextBoxes = addedSel.textBoxes;
        state.selectedImages = addedSel.images;
        state.selectedConnections = addedSel.connections;
        refreshMarqueeSelectionClasses();
    }

    document.getElementById('file-merge').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        mergeDiagramFile(file);
        e.target.value = '';
    });

    // --- draw.io (.drawio) import ----------------------------------------------
    // diagrams.net files are mxGraph XML: <mxfile> holds one <diagram> per page,
    // each either wrapping a raw <mxGraphModel> (uncompressed saves - and our own
    // export) or a base64 payload of deflate-raw(encodeURIComponent(xml)) (the
    // app's default). Decompression is the native DecompressionStream - the same
    // zero-dependency story as .vsdx. Mapping follows the Gliffy importer's
    // philosophy: exact bounding boxes, exact-anchor APs from exitX/entryX
    // fractions, mxPoint waypoints → native bends, containers/plain rects →
    // zones, HTML labels → spans. CrossCanvas's own exports round-trip: composited
    // device icons are de-composited back to glyph + frame colors, and Device
    // Details are restored from <object> data attributes.
    async function drawioModelFromDiagram(diagramEl) {
        const inline = diagramEl.getElementsByTagName('mxGraphModel')[0];
        if (inline) return inline;
        const txt = (diagramEl.textContent || '').trim();
        if (!txt) throw new Error('empty diagram page');
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('this browser cannot read compressed .drawio files (no DecompressionStream)');
        }
        let u8;
        try {
            const bin = atob(txt);
            u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        } catch (e) { throw new Error('diagram payload is not base64'); }
        const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const inflated = new TextDecoder().decode(await new Response(stream).arrayBuffer());
        const xmlStr = decodeURIComponent(inflated);
        const doc = new DOMParser().parseFromString(xmlStr, 'text/xml');
        const model = doc.getElementsByTagName('mxGraphModel')[0];
        if (!model) throw new Error('diagram payload is not an mxGraphModel');
        return model;
    }

    // draw.io style strings elide the ';base64,' marker inside data URIs
    // (';' is their delimiter) - restore it when the payload is base64.
    function drawioRestoreDataURI(uri) {
        if (!uri || uri.includes(';base64,')) return uri;
        const m = uri.match(/^data:image\/([a-z0-9.+-]+),([A-Za-z0-9+/=]+)$/i);
        return m ? 'data:image/' + m[1] + ';base64,' + m[2] : uri;
    }

    // Reverse of exportDrawio's deviceIcon(): our exports composite the
    // app-drawn frame + glyph into one SVG. If this SVG matches that exact
    // construction (one rounded rect + at most one <image>), recover the
    // original glyph URI and frame colors so re-imported devices render
    // natively instead of drawing a frame around a picture of a frame.
    function drawioDecompositeIcon(uri) {
        if (!isSVGDataURL(uri)) return null;
        try {
            const b64 = uri.split(',')[1];
            const svg = decodeURIComponent(escape(atob(b64)));
            const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
            const root = doc.documentElement;
            if (root.tagName !== 'svg') return null;
            const kids = Array.from(root.children);
            const rects = kids.filter(k => k.tagName === 'rect');
            const images = kids.filter(k => k.tagName === 'image');
            if (rects.length !== 1 || kids.length !== rects.length + images.length ||
                images.length > 1 || !rects[0].getAttribute('rx')) return null;
            const glyph = images[0] ? images[0].getAttribute('href') : '';
            if (glyph && !glyph.startsWith('data:image/')) return null;
            return {
                glyph: glyph,
                iconBg: rects[0].getAttribute('fill') || undefined,
                tint: rects[0].getAttribute('stroke') || null
            };
        } catch (e) { return null; }
    }

    // quiet: suppress the summary dialog and return stats - used by the batch
    // converter, which reports one roll-up at the end (mirrors importGliffy).
    function importDrawioModel(model, pageName, fileName, quiet) {
        const stats = { devices: 0, zones: 0, textboxes: 0, images: 0, connections: 0, skipped: 0, placeholders: [] };
        const rootEl = model.getElementsByTagName('root')[0];
        if (!rootEl) throw new Error('no <root> in mxGraphModel');

        // --- Collect cells (flat under <root>; <object>/<UserObject> wrappers
        // carry the label + Edit Data attributes, i.e. our Device Details) ---
        const cells = new Map();
        Array.from(rootEl.children).forEach(el => {
            let cellEl = el, wrapLabel = null, fields = null, id = el.getAttribute('id');
            if (el.tagName === 'object' || el.tagName === 'UserObject') {
                cellEl = el.getElementsByTagName('mxCell')[0];
                if (!cellEl) return;
                wrapLabel = el.getAttribute('label') || '';
                fields = {};
                Array.from(el.attributes).forEach(a => {
                    if (a.name !== 'label' && a.name !== 'id' && a.name !== 'placeholders') fields[a.name] = a.value;
                });
                if (!Object.keys(fields).length) fields = null;
            } else if (el.tagName !== 'mxCell') {
                return;
            } else {
                id = cellEl.getAttribute('id');
            }
            if (!id) return;
            const geo = cellEl.getElementsByTagName('mxGeometry')[0];
            const num = (e2, n, d) => { const v = parseFloat(e2 && e2.getAttribute(n)); return isFinite(v) ? v : d; };
            const rec = {
                id: id,
                parent: cellEl.getAttribute('parent'),
                vertex: cellEl.getAttribute('vertex') === '1',
                edge: cellEl.getAttribute('edge') === '1',
                style: cellEl.getAttribute('style') || '',
                value: wrapLabel != null ? wrapLabel : (cellEl.getAttribute('value') || ''),
                fields: fields,
                source: cellEl.getAttribute('source'),
                target: cellEl.getAttribute('target'),
                x: num(geo, 'x', 0), y: num(geo, 'y', 0),
                w: num(geo, 'width', 0), h: num(geo, 'height', 0),
                relative: !!(geo && geo.getAttribute('relative') === '1'),
                geoX: num(geo, 'x', 0),   // raw geometry x (edge labels: -1..1)
                points: [], sourcePoint: null, targetPoint: null
            };
            if (geo) {
                Array.from(geo.getElementsByTagName('mxPoint')).forEach(p => {
                    const pt = { x: num(p, 'x', 0), y: num(p, 'y', 0) };
                    const as = p.getAttribute('as');
                    if (as === 'sourcePoint') rec.sourcePoint = pt;
                    else if (as === 'targetPoint') rec.targetPoint = pt;
                    else if (as !== 'offset') rec.points.push(pt);
                });
            }
            // style string → map; bare tokens (ellipse, text, group…) are flags
            rec.s = {};
            rec.style.split(';').forEach(tok => {
                if (!tok) return;
                const eq = tok.indexOf('=');
                if (eq < 0) rec.s[tok.trim()] = '1';
                else rec.s[tok.slice(0, eq).trim()] = tok.slice(eq + 1);
            });
            cells.set(id, rec);
        });

        // Vertex geometry is relative to the parent VERTEX (groups/containers);
        // layers and the root contribute nothing. Depth-capped against cycles.
        const absCache = new Map();
        const absPos = (rec, depth) => {
            if (absCache.has(rec.id)) return absCache.get(rec.id);
            let ax = rec.x, ay = rec.y;
            const p = cells.get(rec.parent);
            if (p && p.vertex && !rec.relative && (depth || 0) < 60) {
                const pp = absPos(p, (depth || 0) + 1);
                ax += pp.x; ay += pp.y;
            }
            const r = { x: ax, y: ay };
            absCache.set(rec.id, r);
            return r;
        };

        // --- Label helpers -------------------------------------------------
        const plainText = (spans) => spans.map(l => l.map(sp => sp.text).join('')).join('\n').trim();
        const safeColor = (c) => (c && /^#[0-9a-fA-F]{3,8}$/.test(c.trim())) ? c.trim() : null;
        const familyFromName = (name) => {
            if (!name) return undefined;
            const n = name.toLowerCase();
            return Object.keys(FONT_STACKS).find(k => FONT_STACKS[k].toLowerCase().includes(n)) || undefined;
        };
        const labelInfo = (rec) => {
            const spans = rec.value ? htmlToSpans(rec.value) : null;
            const text = spans ? plainText(spans) : '';
            const s = rec.s;
            let pos;
            if (s.verticalLabelPosition === 'top') pos = 'top';
            else if (s.verticalLabelPosition === 'bottom') pos = 'bottom';
            else if (s.labelPosition === 'left') pos = 'left';
            else if (s.labelPosition === 'right') pos = 'right';
            else if (s.verticalAlign === 'top') pos = 'top-inside';
            else if (s.verticalAlign === 'bottom') pos = 'bottom-inside';
            else if (s.verticalAlign === 'middle') pos = 'center';
            return {
                text: text, spans: text ? spans : null, pos: pos,
                fontSize: parseInt(s.fontSize, 10) || DEFAULT_FONT_SIZE,
                fontColor: safeColor(s.fontColor) || '#333333',
                family: familyFromName(s.fontFamily),
                align: (s.align === 'left' || s.align === 'right') ? s.align : undefined
            };
        };

        // --- Stencil resolution (shared curated map, then fuzzy - the same
        // two-step the Gliffy importer uses) ---
        const byName = (name) => state.deviceTemplates.find(t => t.name === name && !t.isDefault) ||
            state.deviceTemplates.find(t => t.name === name);
        const resolveTemplate = (typeName) => {
            const key = String(typeName || '').toLowerCase().replace(/[\s-]+/g, '_');
            const flat = key.replace(/_/g, '');
            // Variant/size suffixes (internet_alt2, router_2, iPad_128x128)
            // fall back to the base term. Pattern rules: *_instance (EC2) is a
            // VM; *_hub is a Switch; DCS-* (Arista SKUs) are Switches.
            const base = key.replace(/_\d+x\d+$/, '').replace(/_alt\d*$/, '').replace(/_\d+$/, '');
            // A user/team stencil matching the source name always wins
            const custom = customImportTemplate(key) || customImportTemplate(base);
            if (custom) return { template: custom, wasPlaceholder: false };
            const hinted = IMPORT_STENCIL_MAP[key] || IMPORT_STENCIL_MAP[flat] ||
                IMPORT_STENCIL_MAP[base] ||
                (/(^|_)instances?$/.test(key) ? 'VM'
                    : /_hub$/.test(base) ? 'Switch'
                    : /^dcs_/.test(key) ? 'Switch' : null);
            if (hinted) { const t = byName(hinted); if (t) return { template: t, wasPlaceholder: false }; }
            const lower = flat;
            const fuzzy = state.deviceTemplates.find(t => !t.isDefault &&
                    (t.name.toLowerCase().includes(lower) || lower.includes(t.name.toLowerCase()))) ||
                state.deviceTemplates.find(t =>
                    t.name.toLowerCase().includes(lower) || lower.includes(t.name.toLowerCase()));
            if (fuzzy) return { template: fuzzy, wasPlaceholder: false };
            return { template: null, wasPlaceholder: true };
        };

        // --- Classify vertices ----------------------------------------------
        const ZONE_MIN_AREA = 200 * 100;
        const newDevices = [], newZones = [], newTextBoxes = [], newImages = [];
        const idMap = {};            // drawio cell id → app node id (connectables)
        const edgeLabelRecs = [];    // annotation cells, resolved after edges
        let flattenedGroups = 0;

        const makeDevice = (rec, template, wasPlaceholder, typeName, iconOverride) => {
            const li = labelInfo(rec);
            const pos = absPos(rec);
            const dw = Math.round(rec.w) || DEVICE_SIZE, dh = Math.round(rec.h) || DEVICE_SIZE;
            let image = iconOverride != null ? iconOverride : (template ? template.image : TEMPLATE_ICON);
            let tint = null, iconBg;
            if (iconOverride && iconOverride.deco) {   // de-composited CrossCanvas icon
                image = iconOverride.deco.glyph ||
                    (byName('Blank') ? byName('Blank').image : TEMPLATE_ICON);
                tint = iconOverride.deco.tint;
                iconBg = iconOverride.deco.iconBg;
            }
            const device = {
                id: genId(),
                templateId: template ? template.id : null,
                image: image, originalImage: image,
                x: Math.round(pos.x), y: Math.round(pos.y), w: dw, h: dh,
                label: li.text || (template ? template.name : ''),
                labelPosition: li.pos || 'bottom',
                fontSize: li.fontSize, fontColor: li.fontColor,
                fontFamily: li.family, labelAlign: li.align,
                lineFormats: [], spans: li.spans,
                tintColor: tint,
                attachmentPoints: distributeAttachmentPoints(dw, dh, 16)
            };
            if (iconBg) device.iconBg = iconBg;
            if (rec.fields) device.fields = rec.fields;
            if (wasPlaceholder && typeName && !stats.placeholders.includes(typeName)) stats.placeholders.push(typeName);
            idMap[rec.id] = device.id;
            newDevices.push(device);
            stats.devices++;
        };
        const makeZone = (rec, shape) => {
            const li = labelInfo(rec);
            const pos = absPos(rec);
            const zw = rec.w || 160, zh = rec.h || 120;
            const zone = {
                id: genId(), shape: shape,
                x: Math.round(pos.x), y: Math.round(pos.y), w: zw, h: zh,
                label: li.text || '',
                labelPosition: li.pos || 'top-inside',
                fontSize: li.fontSize, fontColor: li.fontColor,
                fontFamily: li.family, labelAlign: li.align,
                lineFormats: [{ bold: true, italic: false }],
                spans: li.spans,
                fill: (rec.s.fillColor === 'none') ? 'transparent' : (safeColor(rec.s.fillColor) || '#e8f4fd'),
                borderColor: safeColor(rec.s.strokeColor) || STENCIL_FRAME_BLUE,
                opacity: rec.s.fillOpacity != null ? Math.max(0, Math.min(1, parseFloat(rec.s.fillOpacity) / 100)) :
                         (rec.s.opacity != null ? Math.max(0, Math.min(1, parseFloat(rec.s.opacity) / 100)) : 1),
                attachmentPoints: distributeAttachmentPoints(zw, zh, 16)
            };
            idMap[rec.id] = zone.id;
            newZones.push(zone);
            stats.zones++;
        };
        const makeTextBox = (rec) => {
            const li = labelInfo(rec);
            if (!li.text) { stats.skipped++; return; }
            const pos = absPos(rec);
            newTextBoxes.push({
                id: genId(), x: Math.round(pos.x), y: Math.round(pos.y),
                text: li.text, fontSize: li.fontSize, fontColor: li.fontColor,
                fontFamily: li.family,
                textAlign: rec.s.align || 'left',
                lineFormats: [], spans: li.spans
            });
            stats.textboxes++;
        };

        cells.forEach(rec => {
            if (rec.edge) return;                                   // edges: next pass
            if (!rec.vertex) return;                                // root/layer cells
            const s = rec.s;
            if (s.edgeLabel) { edgeLabelRecs.push(rec); return; }   // annotation on an edge
            if (rec.relative) { stats.skipped++; return; }          // other relative decorations
            if (s.group && !s.shape) { flattenedGroups++; return; } // children absolutize via absPos
            if (!rec.w && !rec.h) { stats.skipped++; return; }

            if (s.text) { makeTextBox(rec); return; }

            // Decorative drawing shapes (arrow glyphs, bracket rects, plain
            // lines - matched on the last segment, e.g. mxgraph.arrows2.arrow)
            // aren't devices - skip rather than minting generic-icon noise.
            const shapeKey = s.shape || '';
            const shapeLeaf = shapeKey.split('.').pop();
            if (/^(arrow|singleArrow|doubleArrow|partialRectangle|line|link)$/.test(shapeLeaf)) {
                stats.skipped++; return;
            }

            const image = s.image ? drawioRestoreDataURI(s.image) : null;
            // Image nodes whose source is a relative/external URL can't be
            // fetched (no outbound requests by design) - but the NODE is still
            // hardware ("speakers.svg" on a Gliffy conversion). Import it as a
            // device named after the file so the summary says what it was.
            if (s.image && (!image || !image.startsWith('data:image/'))) {
                const stem = String(s.image).split('/').pop().replace(/\.[a-z0-9]+$/i, '') || 'image';
                const r0 = resolveTemplate(stem);
                makeDevice(rec, r0.template, r0.wasPlaceholder, stem, null);
                return;
            }
            if (image && image.startsWith('data:image/')) {
                const deco = drawioDecompositeIcon(image);
                if (deco) { makeDevice(rec, null, false, null, { deco: deco }); return; }
                if (isSVGDataURL(image)) {                          // foreign SVG icon → tintable device
                    makeDevice(rec, null, false, null, normalizeImportedSVG(image)); return;
                }
                const pos = absPos(rec);                            // raster → pasted image
                const li = labelInfo(rec);
                const image2 = {
                    id: genId(), x: Math.round(pos.x), y: Math.round(pos.y),
                    w: rec.w || 120, h: rec.h || 120, dataURL: image,
                    label: li.text || '', spans: li.spans,
                    labelPosition: li.pos || 'bottom',
                    fontSize: li.fontSize, fontColor: li.fontColor,
                    attachmentPoints: getDefaultAttachmentPoints(rec.w || 120, rec.h || 120)
                };
                idMap[rec.id] = image2.id;
                newImages.push(image2);
                stats.images++;
                return;
            }

            const shape = s.shape || '';
            const leaf = shape.split('.').pop();
            // AWS-style group containers (mxgraph.aws4.group + grIcon corner
            // badge) are region/VPC/subnet boxes → zones; the separate
            // groupCenter cell is the container's corner-icon chrome → skip.
            if (leaf === 'group' && (s.grIcon || rec.w * rec.h >= ZONE_MIN_AREA)) { makeZone(rec, 'rectangle'); return; }
            if (leaf === 'groupCenter') { stats.skipped++; return; }
            if (s.swimlane || shape === 'swimlane' || s.container === '1') { makeZone(rec, 'rectangle'); return; }
            if (s.ellipse || shape === 'ellipse') { makeZone(rec, 'ellipse'); return; }
            if (s.rhombus || shape === 'rhombus') { makeZone(rec, 'diamond'); return; }
            if (shape === 'parallelogram') { makeZone(rec, 'parallelogram'); return; }
            if (shape === 'cylinder' || shape === 'cylinder3') { makeZone(rec, 'cylinder'); return; }
            if (!shape || shape === 'rect' || shape === 'rectangle') {
                // Plain rectangle: pill if fully rounded, else the Gliffy rule -
                // big or unlabeled = zone, small + labeled = text box.
                if (s.rounded === '1' && parseInt(s.arcSize, 10) >= 40) { makeZone(rec, 'pill'); return; }
                const li = labelInfo(rec);
                if ((rec.w * rec.h) >= ZONE_MIN_AREA || !li.text) { makeZone(rec, 'rectangle'); return; }
                makeTextBox(rec); return;
            }

            // Anything else is a stencil shape → device. Type name preference:
            // resIcon/prIcon (parameterized shapes - mxgraph.aws4.resourceIcon,
            // mxgraph.cisco19 - carry the real type there, sometimes as a full
            // dotted path) → last dotted segment of shape= → the label itself.
            const leafOf = (v) => String(v || '').split('.').pop();
            const typeName = leafOf(s.resIcon) || leafOf(s.prIcon) || leaf || plainText(htmlToSpans(rec.value || ''));
            const r = resolveTemplate(typeName);
            makeDevice(rec, r.template, r.wasPlaceholder, typeName, null);
        });

        // --- Edges → connections --------------------------------------------
        const ARROW_IN = {
            none: 'none', block: 'arrow', classic: 'arrow', classicThin: 'arrow',
            blockThin: 'arrow', open: 'open-arrow', openThin: 'open-arrow', openAsync: 'open-arrow',
            async: 'open-arrow', diamond: 'diamond', diamondThin: 'diamond', oval: 'circle'
        };
        const DASH_IN = (s) => {
            if (s.dashed !== '1') return null;
            const first = parseFloat(String(s.dashPattern || '').trim().split(/[\s,]+/)[0]);
            if (!isFinite(first)) return 'dash-md';
            if (first <= 1) return 'dot';
            if (first <= 4) return 'dash-sm';
            if (first <= 6) return String(s.dashPattern).trim().split(/[\s,]+/).length >= 4 ? 'dash-dot' : 'dash-md';
            return 'dash-lg';
        };
        const nodeByCellId = (cid) => {
            const appId = cid && idMap[cid];
            if (!appId) return null;
            return newDevices.find(d => d.id === appId) || newZones.find(z => z.id === appId) ||
                newImages.find(i => i.id === appId) || null;
        };
        const resolvedConnections = [];
        const connByCellId = {};
        cells.forEach(rec => {
            if (!rec.edge) return;
            const s = rec.s;
            const fromNode = nodeByCellId(rec.source);
            const toNode = nodeByCellId(rec.target);
            // Edge points are relative to the edge's parent vertex (if any)
            const pOff = (() => {
                const p = cells.get(rec.parent);
                return (p && p.vertex) ? absPos(p) : { x: 0, y: 0 };
            })();
            const off = (pt) => pt ? { x: Math.round(pt.x + pOff.x), y: Math.round(pt.y + pOff.y) } : null;
            const waypoints = rec.points.map(off);
            const frac = (v) => Math.max(0, Math.min(1, parseFloat(v)));
            let fromDevice = null, fromAP = null, fromPoint = null, toDevice = null, toAP = null, toPoint = null;
            if (fromNode) {
                fromDevice = fromNode.id;
                if (s.exitX != null && s.exitY != null) {
                    fromAP = mapToAP(frac(s.exitX), frac(s.exitY), fromNode.attachmentPoints, fromNode.w, fromNode.h);
                } else {
                    const toward = toNode ? { x: toNode.x + toNode.w / 2, y: toNode.y + toNode.h / 2 }
                        : (waypoints[0] || off(rec.targetPoint) || { x: fromNode.x, y: fromNode.y });
                    fromAP = nearestAPIndex(fromNode, toward.x, toward.y);
                }
            } else {
                const p = off(rec.sourcePoint) || waypoints[0];
                if (p) fromPoint = { x: snapToGrid(p.x), y: snapToGrid(p.y) };
            }
            if (toNode) {
                toDevice = toNode.id;
                if (s.entryX != null && s.entryY != null) {
                    toAP = mapToAP(frac(s.entryX), frac(s.entryY), toNode.attachmentPoints, toNode.w, toNode.h);
                } else {
                    const toward = fromNode ? { x: fromNode.x + fromNode.w / 2, y: fromNode.y + fromNode.h / 2 }
                        : (waypoints[waypoints.length - 1] || off(rec.sourcePoint) || { x: toNode.x, y: toNode.y });
                    toAP = nearestAPIndex(toNode, toward.x, toward.y);
                }
            } else {
                const p = off(rec.targetPoint) || waypoints[waypoints.length - 1];
                if (p) toPoint = { x: snapToGrid(p.x), y: snapToGrid(p.y) };
            }
            if ((!fromDevice && !fromPoint) || (!toDevice && !toPoint)) { stats.skipped++; return; }
            const li = labelInfo(rec);
            const edgeStyle = s.edgeStyle || 'none';
            const conn = {
                id: genId(),
                fromDevice: fromDevice, fromAP: fromAP, fromPoint: fromPoint,
                toDevice: toDevice, toAP: toAP, toPoint: toPoint,
                color: safeColor(s.strokeColor) || '#333333',
                thickness: Math.max(1, Math.round(parseFloat(s.strokeWidth)) || 2),
                dash: DASH_IN(s),
                routing: edgeStyle === 'none' ? 'straight'
                    : (s.rounded === '1' ? 'rounded' : 'orthogonal'),
                label: li.text, labelPosition: 'top',
                fontSize: li.fontSize, fontColor: li.fontColor,
                lineFormats: [], spans: li.spans,
                // draw.io renders a classic arrowhead when endArrow is absent
                startArrow: ARROW_IN[s.startArrow] || (s.startArrow ? 'arrow' : 'none'),
                endArrow: s.endArrow == null ? 'arrow' : (ARROW_IN[s.endArrow] || 'arrow'),
                annotations: [],
                waypoints: waypoints.length ? waypoints : null
            };
            connByCellId[rec.id] = conn;
            resolvedConnections.push(conn);
            stats.connections++;
        });

        // Edge labels (vertex cells with edgeLabel style, parented to an edge)
        // → draggable annotations; geometry x runs -1..1 along the path.
        edgeLabelRecs.forEach(rec => {
            const conn = connByCellId[rec.parent];
            if (!conn) { stats.skipped++; return; }
            const spans = htmlToSpans(rec.value || '');
            const text = plainText(spans);
            if (!text) return;
            conn.annotations.push({
                id: genId(),
                text: text,
                position: Math.max(0, Math.min(1, (rec.geoX + 1) / 2)),
                fontSize: parseInt(rec.s.fontSize, 10) || 14,
                fontColor: safeColor(rec.s.fontColor) || '#333333'
            });
        });

        // --- Apply to state (mirrors the Gliffy importer's Phase 3) ---------
        resetDocumentState();
        state.devices = newDevices;
        state.connections = resolvedConnections;
        state.zones = newZones;
        state.textBoxes = newTextBoxes;
        state.images = newImages;
        const fileTitle = fileName ? fileName.replace(/\.(drawio|xml)$/i, '') : null;
        const title = (pageName && !/^Page-?\d*$/i.test(pageName)) ? pageName : (fileTitle || 'drawio-import');
        state.diagramTitle = title;
        state.diagramVersion = 1;
        state.connections.forEach(convertWaypointsToBends);
        setDirty(true);
        updateTitleVersionUI();
        resetTiers();
        renderDeviceList();
        renderAllZones();
        renderAllImages();
        renderAllDevices();
        renderAllConnections();
        updateCanvasSize();

        if (quiet) return stats;
        let msg = `Devices: ${stats.devices}\n`;
        msg += `Zones: ${stats.zones}\n`;
        msg += `Text boxes: ${stats.textboxes}\n`;
        if (stats.images) msg += `Images: ${stats.images}\n`;
        msg += `Connections: ${stats.connections}\n`;
        if (flattenedGroups > 0) msg += `Groups flattened: ${flattenedGroups}\n`;
        if (stats.skipped > 0) msg += `Skipped: ${stats.skipped} (decorative or unresolved)\n`;
        if (stats.placeholders.length > 0) {
            msg += `\nUnrecognized shapes imported with the generic icon:\n`;
            msg += stats.placeholders.map(p => `  • ${p}`).join('\n');
            msg += '\n\nSwap icons via the Icon dropdown in Device Properties.';
        }
        showDialog({ title: 'draw.io import complete', body: msg.trim() });
        return stats;
    }

    // quiet (batch use): errors rethrow instead of alerting, multi-page files
    // take the busiest page without prompting, and {stats, pageName, pageCount}
    // comes back for the batch roll-up.
    async function importDrawioText(text, fileName, quiet) {
        try {
            const doc = new DOMParser().parseFromString(text, 'text/xml');
            if (doc.getElementsByTagName('parsererror').length) throw new Error('not valid XML');
            let diagrams = Array.from(doc.getElementsByTagName('diagram'));
            let model, pageName = null;
            const pageCount = Math.max(1, diagrams.length);
            if (!diagrams.length) {
                // A bare <mxGraphModel> saved as .xml is also valid draw.io output
                model = doc.getElementsByTagName('mxGraphModel')[0];
                if (!model) throw new Error('no <diagram> or <mxGraphModel> found');
            } else if (diagrams.length === 1 || quiet) {
                if (diagrams.length > 1) {
                    // Batch: no prompt - take the busiest page (the picker's
                    // own "largest" hint), noted in the roll-up.
                    let busiest = 0, busiestCount = -1;
                    for (let i = 0; i < diagrams.length; i++) {
                        try {
                            const m = await drawioModelFromDiagram(diagrams[i]);
                            const c = m.getElementsByTagName('mxCell').length;
                            if (c > busiestCount) { busiest = i; busiestCount = c; model = m; }
                        } catch (e) { /* undecodable page: skip */ }
                    }
                    if (!model) throw new Error('no decodable page');
                    pageName = diagrams[busiest].getAttribute('name');
                } else {
                    model = await drawioModelFromDiagram(diagrams[0]);
                    pageName = diagrams[0].getAttribute('name');
                }
            } else {
                // Multi-page: decode every page for cell counts, then prompt
                // (same pattern as the Visio page picker).
                const pages = [];
                for (const d of diagrams) {
                    let m = null, count = 0;
                    try { m = await drawioModelFromDiagram(d); count = m.getElementsByTagName('mxCell').length; }
                    catch (e) { /* undecodable page: listed with 0 cells */ }
                    pages.push({ name: d.getAttribute('name') || ('Page ' + (pages.length + 1)), model: m, count: count });
                }
                let busiest = 0;
                pages.forEach((p, i) => { if (p.count > pages[busiest].count) busiest = i; });
                const pickIdx = await showDialog({
                    title: `Choose a page to import (${pages.length} pages)`,
                    body: (close) => {
                        const wrap = document.createElement('div');
                        pages.forEach((p, i) => {
                            const row = document.createElement('button');
                            row.type = 'button';
                            row.className = 'dialog-list-item';
                            const name = document.createElement('span');
                            name.textContent = p.name;
                            const note = document.createElement('span');
                            note.className = 'dialog-item-note';
                            note.textContent = ` - ${p.count} cells` + (i === busiest ? ' (largest)' : '');
                            row.append(name, note);
                            row.addEventListener('click', () => close(i));
                            wrap.appendChild(row);
                        });
                        return wrap;
                    },
                    buttons: [{ label: 'Cancel', value: null }]
                });
                if (pickIdx == null) return;
                if (!pages[pickIdx].model) { alert('That page could not be decoded.'); return; }
                model = pages[pickIdx].model;
                pageName = pages[pickIdx].name;
            }
            const stats = importDrawioModel(model, pageName, fileName, quiet);
            return { stats: stats, pageName: pageName, pageCount: pageCount };
        } catch (err) {
            if (quiet) throw err;
            alert('Failed to import draw.io file: ' + err.message);
        }
    }

    async function importDrawio(file) {
        // The return matters: routeDiagramFile's contract is "resolves after
        // the import fully lands", and Import & Merge composes around it.
        return importDrawioText(await file.text(), file.name);
    }

    // --- Recent diagrams (File → Open Recent) ---
    // Complete slim (v6) snapshots in localStorage: @name/#key refs make a
    // typical diagram 10-20 KB, so keeping the last 10 whole is affordable.
    // Recorded on save and on file load; newest first, deduped by title.
    const RECENTS_KEY = 'crosscanvas-recents';
    function loadRecents() {
        try {
            const list = JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]');
            return Array.isArray(list) ? list : [];
        } catch (e) { return []; }
    }
    function recordRecent() {
        try {
            const data = JSON.stringify(serializeDiagram());
            if (data.length > 400 * 1024) return;   // quota safety (image-heavy diagrams)
            const title = state.diagramTitle || 'network-diagram';
            const list = loadRecents().filter(r => r && r.title !== title);
            list.unshift({ title: title, savedAt: Date.now(), data: data });
            localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, 10)));
        } catch (e) { /* quota / unavailable */ }
    }
    function rebuildRecentFlyout() {
        const fly = document.getElementById('recent-flyout');
        if (!fly) return;
        fly.innerHTML = '';
        const list = loadRecents();
        if (!list.length) {
            const none = document.createElement('button');
            none.disabled = true;
            const s = document.createElement('span');
            s.textContent = 'No recent diagrams';
            none.appendChild(s);
            fly.appendChild(none);
            return;
        }
        list.forEach(r => {
            const btn = document.createElement('button');
            const name = document.createElement('span');
            name.textContent = r.title;
            const when = document.createElement('span');
            when.className = 'shortcut-key';
            when.textContent = new Date(r.savedAt).toLocaleDateString();
            btn.append(name, when);
            btn.addEventListener('click', () => {
                closeMenus();
                if (state.dirty && !confirm(`You have unsaved changes. Discard them and load "${r.title}"?`)) return;
                try {
                    applyDiagramData(JSON.parse(r.data));
                } catch (err) {
                    alert('Could not load recent diagram: ' + err.message);
                }
            });
            fly.appendChild(btn);
        });
        const sep = document.createElement('div');
        sep.className = 'menu-separator';
        fly.appendChild(sep);
        const clear = document.createElement('button');
        const cs = document.createElement('span');
        cs.textContent = 'Clear Recent';
        clear.appendChild(cs);
        clear.addEventListener('click', () => {
            closeMenus();
            try { localStorage.removeItem(RECENTS_KEY); } catch (e) { /* unavailable */ }
        });
        fly.appendChild(clear);
    }

    // --- Autosave + restore ---
    const AUTOSAVE_KEY = 'crosscanvas-autosave';
    function serializeDiagram(embedImages) {
        // Slim embedded images (v6). Two mechanisms, resolved on load by
        // applyDiagramData (this also shrinks the localStorage autosave,
        // which shares this serializer):
        // - Icons that came from the stencil library (devices.js /
        //   customdevices.js, loaded fresh every startup) are referenced BY
        //   NAME as '@<name>' and not embedded at all. If a file lands where
        //   that library entry is missing (e.g. another site's team layer),
        //   the device degrades to the generic template icon - readable,
        //   labeled, fixable via the Icon dropdown.
        // - Everything else (personal imports, tinted icons, pasted images)
        //   is content-deduplicated into imageTable and referenced '#<key>'.
        // Neither '@' nor '#' can start a real data URI.
        // embedImages (File → Save with Embedded Images): skip the by-name
        // mechanism so the file is self-contained for archival/off-site use -
        // library icons then ride in imageTable like everything else.
        const bundledRef = new Map();
        if (!embedImages) {
            state.deviceTemplates.forEach(t => {
                if (t.isBundled && typeof t.image === 'string' && !bundledRef.has(t.image)) {
                    bundledRef.set(t.image, '@' + t.name);
                }
            });
            bundledRef.set(TEMPLATE_ICON, '@__generic__');
        }
        const imageTable = {};
        const keyByData = new Map();
        let imgN = 0;
        const ref = (v) => {
            if (typeof v !== 'string' || !v.startsWith('data:')) return v;
            const b = bundledRef.get(v);
            if (b) return b;
            let k = keyByData.get(v);
            if (!k) { k = 'i' + (++imgN); keyByData.set(v, k); imageTable[k] = v; }
            return '#' + k;
        };
        return {
            version: 6,
            appVersion: APP_VERSION,
            savedAt: new Date().toISOString(),
            diagramTitle: state.diagramTitle || 'network-diagram',
            diagramVersion: state.diagramVersion,
            devices: state.devices.map(d => Object.assign({}, d, { image: ref(d.image), originalImage: ref(d.originalImage) })),
            connections: state.connections,
            zones: state.zones,
            textBoxes: state.textBoxes,
            images: state.images.map(im => Object.assign({}, im, { dataURL: ref(im.dataURL) })),
            groups: state.groups,
            deviceTemplates: state.deviceTemplates.filter(t => !t.isDefault && !t.isBundled)
                .map(t => Object.assign({}, t, { image: ref(t.image) })),
            imageTable: imageTable,
            nextId: state.nextId
        };
    }
    let autosaveTimer = null;
    function scheduleAutosave() {
        if (EMBED || CCTEST) return;   // embedders and the test harness never write the editor's autosave slot
        if (autosaveTimer) clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(() => {
            autosaveTimer = null;
            // The document may have gone clean during the debounce (a sample
            // or load replaced it wholesale) - writing THAT over the slot
            // would destroy the very work the slot was protecting.
            if (!state.dirty) return;
            try {
                const empty = !state.devices.length && !state.zones.length && !state.connections.length && !state.textBoxes.length && !state.images.length;
                if (empty) { localStorage.removeItem(AUTOSAVE_KEY); return; }
                localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ savedAt: Date.now(), title: state.diagramTitle, data: serializeDiagram() }));
            } catch (e) { /* quota / unavailable */ }
        }, 4000);
    }
    function clearAutosave() {
        // Also cancel a pending timer - a save/load within the 4s debounce
        // otherwise re-autosaves the clean diagram and triggers a spurious
        // "Restore unsaved work?" prompt next launch.
        if (autosaveTimer) { clearTimeout(autosaveTimer); autosaveTimer = null; }
        try { localStorage.removeItem(AUTOSAVE_KEY); } catch (e) { /* ignore */ }
    }
    // Returns true if autosaved work was restored.
    function maybeRestoreAutosave() {
        let raw;
        try { raw = localStorage.getItem(AUTOSAVE_KEY); } catch (e) { return false; }
        if (!raw) return false;
        let entry;
        try { entry = JSON.parse(raw); } catch (e) { clearAutosave(); return false; }
        if (!entry || !entry.data) { clearAutosave(); return false; }
        const when = entry.savedAt ? new Date(entry.savedAt).toLocaleString() : 'a previous session';
        if (confirm(`Restore unsaved work "${entry.title || 'Untitled'}" from ${when}?`)) {
            try { applyDiagramData(entry.data); setDirty(true); return true; } catch (e) { alert('Could not restore autosave: ' + e.message); }
        } else {
            clearAutosave();
        }
        return false;
    }

    function canvasLabelPos(pos, ox, oy, w, h, fs) {
        switch (pos) {
            case 'top':          return { x: ox + w / 2, y: oy - fs / 2, align: 'center' };
            case 'left':         return { x: ox - 6, y: oy + h / 2 + fs / 3, align: 'right' };
            case 'right':        return { x: ox + w + 6, y: oy + h / 2 + fs / 3, align: 'left' };
            case 'center':       return { x: ox + w / 2, y: oy + h / 2 + fs / 3, align: 'center' };
            case 'top-inside':   return { x: ox + w / 2, y: oy + fs + 4, align: 'center' };
            case 'bottom-inside':return { x: ox + w / 2, y: oy + h - 6, align: 'center' };
            default:             return { x: ox + w / 2, y: oy + h + fs + 3, align: 'center' };
        }
    }

    // Font stack for canvas ctx.font strings; falls back to the historical
    // generic sans-serif when the object has no explicit family.
    function ctxFamilyOf(obj) {
        return fontStackOf(obj) || 'sans-serif';
    }

    // Widest rendered line of a spans block at font size fs (canvas measurement).
    function ctxSpansWidth(ctx, spans, fs, family) {
        let maxW = 0;
        spans.forEach(lineSpans => {
            let w = 0;
            lineSpans.forEach(span => {
                let f = `${fs}px ${family || 'sans-serif'}`;
                if (span.italic) f = 'italic ' + f;
                if (span.bold) f = 'bold ' + f;
                ctx.font = f;
                w += ctx.measureText(span.text).width;
            });
            maxW = Math.max(maxW, w);
        });
        return maxW;
    }

    // Draw a node's multi-line label onto the export canvas (devices, zones
    // and images all route through here). Mirrors renderMultiLineLabel,
    // including the explicit labelAlign justification override.
    function drawObjLabelToCanvas(ctx, obj, fallbackColor) {
        if (!obj.label) return;
        const fillColor = obj.fontColor || fallbackColor || '#333';
        const fs = obj.fontSize || 20;
        const spans = obj.spans || [[{ text: obj.label, bold: false, italic: false }]];
        const lineH = fs * 1.3;
        const lpos = obj.labelPosition || 'bottom';
        const pos = canvasLabelPos(lpos, obj.x, obj.y, obj.w, obj.h, fs);
        const vertOff = -getVAlignOffset(effectiveVAlign(lpos, obj.labelVAlign), spans.length, lineH);
        const family = ctxFamilyOf(obj);
        const explicit = obj.labelAlign && obj.labelAlign !== 'auto' && spans.length > 1 ? obj.labelAlign : null;
        const maxW = explicit ? ctxSpansWidth(ctx, spans, fs, family) : 0;
        const blockLeft = pos.align === 'center' ? pos.x - maxW / 2 :
                          pos.align === 'right' ? pos.x - maxW : pos.x;
        spans.forEach((lineSpans, i) => {
            const y = pos.y + i * lineH - vertOff;
            const fontFor = span => {
                let f = `${fs}px ${family}`;
                if (span.italic) f = 'italic ' + f;
                if (span.bold) f = 'bold ' + f;
                return f;
            };
            let totalW = 0;
            lineSpans.forEach(span => { ctx.font = fontFor(span); totalW += ctx.measureText(span.text).width; });
            let startX;
            if (explicit === 'left') startX = blockLeft;
            else if (explicit === 'right') startX = blockLeft + maxW - totalW;
            else if (explicit === 'center') startX = blockLeft + (maxW - totalW) / 2;
            else if (pos.align === 'center') startX = pos.x - totalW / 2;
            else if (pos.align === 'right') startX = pos.x - totalW;
            else startX = pos.x;
            lineSpans.forEach(span => {
                ctx.font = fontFor(span);
                ctx.textAlign = 'left';
                ctx.fillStyle = (span.color && isSafeCSSColor(span.color)) ? span.color : fillColor;
                ctx.fillText(span.text, startX, y);
                startX += ctx.measureText(span.text).width;
            });
        });
    }

    // --- Export JPEG ---
    function getContentBounds() {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        // Labels have WIDTH too: left/right labels overhang sideways and wide
        // centered labels overhang both sides - measure instead of hoping the
        // crop padding covers it (it clipped mid-text on edge objects).
        const mctx = document.createElement('canvas').getContext('2d');
        const labelSideExtents = (obj, w) => {
            if (!obj.label) return { left: 0, right: 0 };
            const fs = obj.fontSize || 20;
            const spans = obj.spans || [[{ text: obj.label, bold: false, italic: false }]];
            const maxW = ctxSpansWidth(mctx, spans, fs, ctxFamilyOf(obj));
            const pos = obj.labelPosition || 'bottom';
            if (pos === 'left') return { left: maxW + 6, right: 0 };
            if (pos === 'right') return { left: 0, right: maxW + 6 };
            const over = Math.max(0, (maxW - w) / 2);   // centered positions
            return { left: over, right: over };
        };

        const nodeBounds = (o) => {
            const fs = o.fontSize || 20;
            const lineCount = (o.label || '').split('\n').length;
            const labelPad = fs * 1.3 * lineCount + 10;
            const ext = labelSideExtents(o, o.w);
            minX = Math.min(minX, o.x - ext.left);
            minY = Math.min(minY, o.y - (o.labelPosition === 'top' ? labelPad : 0));
            maxX = Math.max(maxX, o.x + o.w + ext.right);
            maxY = Math.max(maxY, o.y + o.h + (o.labelPosition === 'bottom' ? labelPad : 0));
        };
        state.devices.forEach(nodeBounds);
        state.zones.forEach(nodeBounds);

        state.textBoxes.forEach(tb => {
            const fs = tb.fontSize || 20;
            const lineH = fs * 1.3;
            const spans = tb.spans || [[{ text: tb.text || '', bold: false, italic: false }]];
            const w = ctxSpansWidth(mctx, spans, fs, ctxFamilyOf(tb)) + 16;
            minX = Math.min(minX, tb.x);
            minY = Math.min(minY, tb.y);
            maxX = Math.max(maxX, tb.x + w);
            // Height from spans (the render source of truth), not tb.text -
            // a spans-but-stale-text object would otherwise be counted as 1 line.
            maxY = Math.max(maxY, tb.y + spans.length * lineH + 8);
        });

        state.images.forEach(nodeBounds);   // images carry labels too

        state.connections.forEach(conn => {
            const start = resolveConnEndpoint(conn, 'from');
            const end = resolveConnEndpoint(conn, 'to');
            if (!start || !end) return;
            const points = connRoutePoints(conn, start, end);
            points.forEach(p => {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            });
            // Labels and annotations have text extent beyond the route line -
            // measure them like node labels, or pills at the diagram's edge
            // get cropped out of exports.
            if (conn.label) {
                const mid = Math.floor(points.length / 2);
                const even = points.length % 2 === 0;
                const mx = even ? (points[mid - 1].x + points[mid].x) / 2 : points[mid].x;
                const my = even ? (points[mid - 1].y + points[mid].y) / 2 : points[mid].y;
                const fs = conn.fontSize || 20;
                const spans = conn.spans || [[{ text: conn.label, bold: false, italic: false }]];
                const w = ctxSpansWidth(mctx, spans, fs, ctxFamilyOf(conn));
                const lp = conn.labelPosition || 'top';
                let tx = mx, ty = my, anchor = 'middle';
                if (lp === 'top') ty = my - fs / 2 - 4;
                else if (lp === 'bottom') ty = my + fs + 4;
                else if (lp === 'left') { tx = mx - 8; anchor = 'end'; ty = my + fs / 3; }
                else if (lp === 'right') { tx = mx + 8; anchor = 'start'; ty = my + fs / 3; }
                else ty = my + fs / 3;
                const x0 = anchor === 'end' ? tx - w : anchor === 'start' ? tx : tx - w / 2;
                minX = Math.min(minX, x0);
                maxX = Math.max(maxX, x0 + w);
                // Mirror renderConnection's white label box exactly, INCLUDING
                // the labelVAlign shift: a multi-line 'bottom'/'center' label
                // grows upward from ty, so without this term the top line(s) sit
                // above the bounds and get cropped out of PNG/SVG/PDF exports.
                const lineH = fs * 1.3;
                const vOff = -getVAlignOffset(conn.labelVAlign || 'top', spans.length, lineH);
                const boxTop = ty - fs - 1 - vOff;
                minY = Math.min(minY, boxTop);
                maxY = Math.max(maxY, boxTop + spans.length * lineH + 8);
            }
            (conn.annotations || []).forEach(ann => {
                const pos = getPointAlongPath(points, ann.position);
                const fs = ann.fontSize || DEFAULT_FONT_SIZE;
                const spans = ann.spans || [[{ text: ann.text || '', bold: false, italic: false }]];
                const w = Math.max(ctxSpansWidth(mctx, spans, fs, ctxFamilyOf(ann)), 20);
                minX = Math.min(minX, pos.x - w / 2 - 3);
                maxX = Math.max(maxX, pos.x + w / 2 + 3);
                minY = Math.min(minY, pos.y - fs - 3);
                maxY = Math.max(maxY, pos.y - fs - 3 + spans.length * fs * 1.3 + 8);
            });
        });

        if (minX === Infinity) return null;
        return { minX, minY, maxX, maxY };
    }

    // Build a minimal single-page PDF embedding the canvas as a JPEG (DCTDecode).
    // Hand-rolled so the app stays dependency-free.
    // Deflate (zlib / RFC 1950) so the bytes can be embedded with PDF /FlateDecode.
    async function deflateBytes(bytes) {
        const cs = new CompressionStream('deflate');
        const writer = cs.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const reader = cs.readable.getReader();
        const out = [];
        let total = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            out.push(value);
            total += value.length;
        }
        const result = new Uint8Array(total);
        let pos = 0;
        for (const ch of out) { result.set(ch, pos); pos += ch.length; }
        return result;
    }

    async function exportCanvasToPDF(c, scale) {
        // Convert px (96dpi) to PDF points (72dpi). An Image Scale > 1 means
        // the canvas carries extra pixels for the SAME diagram - divide the
        // EFFECTIVE scale (may be clamped below the menu setting on huge
        // boards) back out so the page stays diagram-sized and becomes DPI.
        const s = scale || 1;
        const pw = (c.width * 0.75 / s).toFixed(2);
        const ph = (c.height * 0.75 / s).toFixed(2);

        // Embed a lossless image (raw RGB, FlateDecode) for sharp text/lines -
        // much better than JPEG for diagrams. Fall back to JPEG/DCTDecode if the
        // browser lacks CompressionStream.
        let imgBytes, filter;
        if (typeof CompressionStream !== 'undefined') {
            const ctx = c.getContext('2d');
            const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
            const rgb = new Uint8Array(c.width * c.height * 3);
            for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
                rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2];
            }
            imgBytes = await deflateBytes(rgb);
            filter = '/FlateDecode';
        } else {
            const dataURL = c.toDataURL('image/jpeg', 0.95);
            const bin = atob(dataURL.split(',')[1]);
            imgBytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) imgBytes[i] = bin.charCodeAt(i);
            filter = '/DCTDecode';
        }

        const enc = new TextEncoder();
        const chunks = [];
        let offset = 0;
        const offsets = [];
        function push(strOrBytes) {
            const b = typeof strOrBytes === 'string' ? enc.encode(strOrBytes) : strOrBytes;
            chunks.push(b);
            offset += b.length;
        }

        push('%PDF-1.4\n');
        offsets[1] = offset;
        push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
        offsets[2] = offset;
        push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
        offsets[3] = offset;
        push(`3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`);
        offsets[4] = offset;
        push(`4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${c.width} /Height ${c.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter ${filter} /Length ${imgBytes.length} >>\nstream\n`);
        push(imgBytes);
        push('\nendstream\nendobj\n');
        const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im1 Do Q`;
        offsets[5] = offset;
        push(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
        const xrefStart = offset;
        let xref = 'xref\n0 6\n0000000000 65535 f \n';
        for (let i = 1; i <= 5; i++) {
            xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
        }
        push(xref);
        push(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

        triggerDownload(new Blob(chunks, { type: 'application/pdf' }), sanitizedTitle() + '.pdf');
    }

    // ---- Inventory import -------------------------------------------
    // Turns a device inventory into a laid-out starting diagram: devices in
    // grids, grouped into zones by their Location paths, ready for manual
    // arrangement (NOT auto-topology - no connections are drawn).
    //
    // Column spec (header row required; names case-insensitive; the user
    // builds external formatters against this, so keep it stable):
    //   label        device label (falls back to Hostname)
    //   stencil      icon name - resolved against the library with the same
    //                vocabulary + fuzzy matching as the Visio importer;
    //                unknown/absent → the Blank stencil
    //   Hostname, IP-Address, Serial-Number, Asset-Tag, Description,
    //   Location     the standing Device Details fields
    //   x, y         explicit canvas position (px); such rows are placed
    //                as-is and skip the auto-layout
    //   (any other column) → custom data field named by its header
    //
    // Location groups devices into zones. '/' or '|' delimited paths nest
    // (Catalyst Center style: Campus/Building/Floor) - every path level
    // becomes a zone wrapping its children; devices without a Location land
    // in a loose grid outside any zone. New objects use the Default
    // Settings (tint, zone colors, AP count) - there is no source styling
    // to be faithful to, so the active theme applies.

    // Minimal RFC 4180 parser: quoted cells may hold commas, quotes ("")
    // and newlines; accepts CRLF/LF and a leading BOM.
    function parseCSV(text, delim = ',') {
        const rows = [];
        let row = [], cell = '', inQ = false;
        const src = text.replace(/^\uFEFF/, '');
        for (let i = 0; i < src.length; i++) {
            const ch = src[i];
            if (inQ) {
                if (ch === '"') {
                    if (src[i + 1] === '"') { cell += '"'; i++; }
                    else inQ = false;
                } else cell += ch;
            } else if (ch === '"') {
                inQ = true;
            } else if (ch === delim) {
                row.push(cell); cell = '';
            } else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && src[i + 1] === '\n') i++;
                row.push(cell); cell = '';
                if (row.length > 1 || row[0] !== '') rows.push(row);
                row = [];
            } else {
                cell += ch;
            }
        }
        if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
        return rows;
    }

    // Delimiter sniff: cell ranges copied out of Excel / LibreOffice / Google
    // Sheets land on the clipboard TAB-separated, while files are commas. A
    // tab on the first line decides it - labels can contain commas, never tabs.
    function parseDelimited(text) {
        const nl = text.indexOf('\n');
        const firstLine = nl < 0 ? text : text.slice(0, nl);
        return parseCSV(text, firstLine.includes('\t') ? '\t' : ',');
    }

    // Trim a reverse-lookup FQDN down to its short hostname for the on-canvas
    // label ("finance-pc-042.corp.example.com" -> "finance-pc-042"). Guarded so
    // an IPv4 literal or a MAC that landed in the hostname slot is left intact
    // (stripping at the first dot would wreck an IP). The full FQDN is kept in
    // the Hostname field, so nothing is lost - only the label reads cleaner.
    function shortHostname(name) {
        if (!name) return name;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return name;   // IPv4
        if (name.includes(':')) return name;                  // IPv6 / MAC
        const dot = name.indexOf('.');
        return dot > 0 ? name.slice(0, dot) : name;
    }

    // Catalyst Center / ISE emit "--" (or "-") when a device never reported a
    // hostname - e.g. MAB endpoints with no 802.1X. Treat an all-dashes value as
    // absent so the label falls back to the MAC and no junk Hostname is stored.
    function realHostname(h) {
        h = String(h == null ? '' : h).trim();
        return /^-+$/.test(h) ? '' : h;
    }

    // Blend a hex color toward white by fraction t (0..1). Used to derive a
    // "parent zone" fill a fair bit lighter than the leaf/theme fill, so nested
    // zones read (enclosing boxes recede, innermost device zones stay fuller).
    function lightenHex(hex, t) {
        const m = String(hex || '').trim().match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
        if (!m) return hex;
        let h = m[1];
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        const mix = (c) => Math.round(c + (255 - c) * t);
        const to2 = (c) => c.toString(16).padStart(2, '0');
        return '#' + to2(mix(parseInt(h.slice(0, 2), 16))) +
                     to2(mix(parseInt(h.slice(2, 4), 16))) +
                     to2(mix(parseInt(h.slice(4, 6), 16)));
    }
    // How far a parent zone's fill is pushed toward white vs its leaf zones -
    // higher = paler parents, more separation between nesting tiers.
    const PARENT_ZONE_LIGHTEN = 0.72;

    // Map an endpoint's descriptive text (ISE profiler policy, or a Catalyst
    // Center Device/Endpoint Type) to a stencil name. A keyword is a plain
    // substring (includes) OR a RegExp (test), matched top-to-bottom, first
    // hit wins - so specific device types sit above the generic client
    // catch-alls. No match → '' (imports as Blank, silently - no noise for the
    // endpoint mass). Shared by every client-style vendor profile.
    function guessClientStencil(text) {
        const p = String(text || '').toLowerCase();
        const KEYWORDS = [
            ['printer', 'printer'], ['camera', 'camera'],
            ['dock', 'laptop'], ['macbook', 'laptop'], ['laptop', 'laptop'],
            ['ipad', 'tablet'], ['tablet', 'tablet'],
            ['iphone', 'mobile phone'], ['android', 'mobile phone'], ['phone', 'phone'],
            ['workstation', 'client'], ['windows', 'client'],
            ['win10', 'client'], ['win11', 'client'], ['computer', 'client'],
            // "pc" as a whole token (PC, PC-01, corp_pc, pc01) but NOT embedded
            // in a larger word (pcoip, epcot) - a bare includes('pc') is too
            // trigger-happy
            [/(^|[^a-z])pc([^a-z]|$)/, 'client'],
            ['macos', 'client'],
            ['server', 'server'], ['switch', 'switch'], ['router', 'router'],
            ['access point', 'access point'], ['-ap', 'access point']
        ];
        for (const [k, s] of KEYWORDS) {
            if (k instanceof RegExp ? k.test(p) : p.includes(k)) return s;
        }
        return '';
    }

    // One infrastructure keyword→stencil classifier for every inventory
    // profile (Catalyst Center, NetBox, future vendors) - previously each
    // profile carried its own if/else ladder and they had already diverged.
    // Most-specific rules first, so "wireless controller" can't land on the
    // switch rule via role names like "access-switch". An optional third
    // element is a qualifier both patterns must satisfy (core/L3 switches).
    // Returns '' when nothing matches - callers decide their own fallback.
    const INFRA_STENCIL_RULES = [
        [/firewall|security/, 'firewall'],
        [/wireless controller|\bwlc\b/, 'wireless lan controller'],
        [/unified ap|access point|\bap\b/, 'access point'],
        [/\bsensor\b/, 'sensor'],
        [/switch/, 'multilayer switch', /\bcore\b|layer 3|\bl3\b|multilayer/],
        [/switch/, 'switch'],
        [/router|gateway|\bborder\b/, 'router'],
        [/load balancer/, 'load balancer'],
        [/patch panel/, 'patch panel'],
        [/\bpdu\b|\bups\b|power/, 'ups'],
        [/storage|\bnas\b|\bsan\b/, 'nas'],
        [/server|hypervisor/, 'server'],
        [/camera/, 'camera'],
        [/modem|\bont\b/, 'modem']
    ];
    function guessInfraStencil(text) {
        const hint = String(text || '').toLowerCase().replace(/[-_]+/g, ' ');
        for (const [re, stencil, qualifier] of INFRA_STENCIL_RULES) {
            if (re.test(hint) && (!qualifier || qualifier.test(hint))) return stencil;
        }
        return '';
    }

    // --- Vendor CSV profiles -------------------------------------------
    // Shared profile postProcess: group clients under the network device they
    // connect through, from a SINGLE export (no separate device file, no
    // cross-source Location reconciliation). Each record carries `_switch`
    // (NAD name), `_switchIP` (NAD IP), and `_loc` (the client's site path).
    // Every unique NAD becomes a synthetic device inside a zone named for it;
    // its clients nest in that zone, and the NAD's site path (from its first
    // client) supplies the Building/Floor tiers above. Used by the Catalyst
    // Center wired-client profile (NADs are switches) and the ISE profile
    // (NADs are switches OR WLCs - a WLC gets the wireless glyph by name).
    function groupBySwitch(records) {
        const nads = new Map();   // shortKey -> {short, full, ip, loc}
        records.forEach(r => {
            if (!r._switch) return;
            const key = shortHostname(r._switch).toLowerCase();
            if (!nads.has(key)) {
                nads.set(key, { short: shortHostname(r._switch), full: r._switch,
                                ip: r._switchIP, loc: r._loc });
            }
        });
        const pathFor = (info) => info.loc ? info.loc + '/' + info.short : info.short;
        const out = [];
        nads.forEach(info => {
            // NAD is usually a switch; a WLC (wireless clients report against
            // it) takes the wireless glyph when the name gives it away
            const stencil = /wlc|9800|wism/i.test(info.full) ? 'access point' : 'switch';
            const f = { Hostname: info.full };
            if (info.ip) f['IP-Address'] = info.ip;
            f.Location = pathFor(info);
            out.push({ label: info.short, stencilName: stencil, fields: f, x: null, y: null });
        });
        records.forEach(r => {
            if (r._switch) {
                const info = nads.get(shortHostname(r._switch).toLowerCase());
                r.fields.Location = pathFor(info);
                r.fields['Network Device'] = info.short;
            } else if (r._loc) {
                r.fields.Location = r._loc;
            }
            delete r._switch; delete r._switchIP; delete r._loc;
            out.push(r);
        });
        return out;
    }

    // Normalize the wildly inconsistent MAC spellings across sources
    // (Windows arp "00-50-56-a9-dc-34", DHCP Unique ID "005056a9dc34",
    // net-tools "0:50:56:a9:dc:34") to AA:BB:CC:DD:EE:FF. Anything that
    // isn't recognizably a 6-octet MAC is returned untouched.
    function normalizeMAC(v) {
        const s = String(v || '').trim();
        const parts = s.split(/[:-]/);
        if (parts.length === 6 && parts.every(p => /^[0-9a-fA-F]{1,2}$/.test(p))) {
            return parts.map(p => p.padStart(2, '0').toUpperCase()).join(':');
        }
        const hex = s.replace(/[^0-9a-fA-F]/g, '');
        if (hex.length === 12 && /^[0-9a-fA-F]+$/.test(hex)) {
            return hex.toUpperCase().match(/../g).join(':');
        }
        return s;
    }

    // Shared filters for text-based network dumps: multicast/broadcast aren't
    // devices. (224-239.x, 255.255.255.255, 0.0.0.0; ff:ff.. broadcast,
    // 01:00:5e.. IPv4 multicast, 33:33.. IPv6 multicast MACs.)
    const isJunkNetIP = (ip) => {
        const o1 = parseInt(ip.split('.')[0], 10);
        return (o1 >= 224 && o1 <= 239) || ip === '255.255.255.255' || ip === '0.0.0.0';
    };
    const isJunkNetMAC = (m) => /^(ff:ff:ff|01:00:5e|33:33:)/i.test(m);
    // The per-line \d{1,3} octets accept 999.888.777.666 - validate matches
    // before importing so a corrupt line can't become a device with a bogus IP.
    const isValidIPv4 = (ip) => ip.split('.').every(o => { const n = +o; return o !== '' && n >= 0 && n <= 255; });

    // ARP / neighbor-table dumps pasted as plain text (.txt) - the fastest
    // homelab inventory: every device the host has talked to, IP + MAC. Covers
    // the common dialects with per-line patterns:
    //   Windows arp -a   "  192.168.4.1        00-50-56-a9-dc-34     dynamic"
    //   Cisco show ip arp "Internet  192.168.4.1  5  0050.56a9.dc34  ARPA  Gi0/1"
    //   ip neigh          "192.168.4.1 dev ens18 lladdr 00:50:56:a9:dc:34 REACHABLE"
    //   net-tools/macOS   "_gateway (192.168.4.1) at 00:50:56:a9:dc:34 [ether] on ens18"
    // Incomplete/failed neighbours are counted as skipped; junk filtered.
    // Returns null when no line matches, so the CSV path proceeds normally.
    function parseARPText(text) {
        const PATTERNS = [
            // Type word is \S+ not \w+: localized Windows prints e.g.
            // "динамический"/"动态", and JS \w is ASCII-only.
            { name: 'Windows arp -a', re: /^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{2}(?:-[0-9a-fA-F]{2}){5})\s+\S+/,
              get: (m) => ({ ip: m[1], mac: m[2] }) },
            { name: 'Cisco show ip arp', re: /^\s*Internet\s+(\d{1,3}(?:\.\d{1,3}){3})\s+\S+\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+(?:ARPA|SNAP|SAP)/i,
              get: (m) => ({ ip: m[1], mac: m[2] }) },
            { name: 'ip neigh', re: /^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+\S+\s+lladdr\s+([0-9a-fA-F:]{11,17})\s+\w+/,
              get: (m) => ({ ip: m[1], mac: m[2] }) },
            { name: 'arp -a (net-tools/macOS)', re: /^(\S+)\s+\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-fA-F:]{11,17})\b/,
              get: (m) => ({ host: m[1] === '?' ? '' : m[1], ip: m[2], mac: m[3] }) }
        ];
        const incomplete = /(<incomplete>|\(incomplete\)|\bFAILED\b|\bINCOMPLETE\b)/i;
        const records = [];
        const fmts = new Set();
        const seen = new Set();   // dedupe: multi-interface dumps repeat hosts (Wi-Fi + Ethernet, vSwitches)
        let skipped = 0, matchedAny = false;

        String(text).split(/\r?\n/).forEach(line => {
            for (const p of PATTERNS) {
                const m = line.match(p.re);
                if (!m) continue;
                matchedAny = true;
                const r = p.get(m), ip = r.ip, mac = normalizeMAC(r.mac);
                if (!isValidIPv4(ip) || isJunkNetIP(ip) || isJunkNetMAC(mac)) { skipped++; return; }
                if (seen.has(ip)) { skipped++; return; }
                seen.add(ip);
                const fields = { 'IP-Address': ip, 'MAC Address': mac };
                if (r.host) fields.Hostname = r.host;
                records.push({ label: r.host || ip, stencilName: '', fields: fields, x: null, y: null });
                fmts.add(p.name);
                return;
            }
            // an incomplete/failed neighbour line (has an IP) is a skipped device
            if (incomplete.test(line) && /\d{1,3}(?:\.\d{1,3}){3}/.test(line)) skipped++;
        });
        if (!matchedAny) return null;
        return {
            name: fmts.size === 1 ? [...fmts][0] : 'ARP / neighbour table',
            records: records, skipped: skipped
        };
    }

    // dnsmasq leases (/var/lib/misc/dnsmasq.leases - Pi-hole, OpenWrt, many
    // home routers): "1720560000 00:50:56:a9:dc:34 192.168.4.101 desktop 01:..."
    // = expiry-epoch, MAC, IP, hostname ('*' = unknown), client-id. No header;
    // detected by the epoch+MAC+IP shape. Returns null if it doesn't look like one.
    function parseDnsmasqLeases(text) {
        const LEASE = /^(\d+)\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s+(\d{1,3}(?:\.\d{1,3}){3})\s+(\S+)/;
        const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const hits = lines.filter(l => LEASE.test(l));
        // "Most lines must fit" - but judge only against v4-shaped lines: a
        // dual-stack file's IPv6 leases (v6 address in the 3rd field) and the
        // 'duid' metadata line would otherwise outvote perfectly good v4 leases.
        const denom = lines.filter(l => !/^duid\b/i.test(l) && !/^\d+\s+\S+\s+\S*:/.test(l));
        if (!hits.length || hits.length < denom.length * 0.6) return null;
        const records = [];
        const seen = new Set();
        let skipped = 0;
        hits.forEach(l => {
            const m = l.match(LEASE);
            const mac = normalizeMAC(m[2]), ip = m[3], host = m[4] === '*' ? '' : m[4];
            if (!isValidIPv4(ip) || isJunkNetIP(ip) || isJunkNetMAC(mac) || seen.has(ip)) { skipped++; return; }
            seen.add(ip);
            const fields = { 'IP-Address': ip, 'MAC Address': mac };
            if (host) fields.Hostname = host;
            records.push({ label: host || ip, stencilName: '', fields: fields, x: null, y: null });
        });
        return { name: 'dnsmasq leases', records: records, skipped: skipped + (lines.length - hits.length) };
    }

    // nmap ping-scan ("nmap -sn 192.168.0.0/24"): multi-line records -
    //   "Nmap scan report for pihole.lan (192.168.4.53)"
    //   "MAC Address: B8:27:EB:12:34:56 (Raspberry Pi Foundation)"
    // The MAC line is optional (absent for the scanning host / non-root runs);
    // the vendor in parens is carried as Description. Returns null if not nmap.
    function parseNmap(text) {
        if (!/Nmap scan report for/i.test(text)) return null;
        const records = [];
        const seen = new Set();
        let cur = null;
        const flush = () => {
            if (!cur) return;
            if (!isValidIPv4(cur.ip) || seen.has(cur.ip)) { cur = null; return; }
            seen.add(cur.ip);
            const fields = { 'IP-Address': cur.ip };
            if (cur.host) fields.Hostname = cur.host;
            if (cur.mac) fields['MAC Address'] = cur.mac;
            if (cur.vendor) fields.Description = cur.vendor;
            records.push({ label: cur.host ? shortHostname(cur.host) : cur.ip,
                           stencilName: '', fields: fields, x: null, y: null });
            cur = null;
        };
        String(text).split(/\r?\n/).forEach(line => {
            let m = line.match(/Nmap scan report for (?:(\S+)\s+\((\d{1,3}(?:\.\d{1,3}){3})\)|(\d{1,3}(?:\.\d{1,3}){3}))/i);
            if (m) { flush(); cur = { host: m[1] || '', ip: m[2] || m[3], mac: '', vendor: '' }; return; }
            m = line.match(/MAC Address:\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})\s*(?:\(([^)]*)\))?/i);
            if (m && cur) { cur.mac = normalizeMAC(m[1]); cur.vendor = (m[2] || '').trim(); }
        });
        flush();
        return { name: 'nmap ping scan', records: records, skipped: 0 };
    }

    // ISC dhcpd lease DB - the classic isc-dhcp-server format, and what older
    // pfSense / OPNsense wrote before Kea (/var/dhcpd/var/db/dhcpd.leases).
    // Curly-brace blocks, not CSV:
    //   lease 192.168.4.10 {
    //     binding state active;
    //     hardware ethernet 00:50:56:a9:dc:34;
    //     client-hostname "desktop";
    //   }
    // The file APPENDS (each renewal writes a fresh block), so fold
    // newest-wins per IP, then keep only active leases (free/expired/
    // abandoned/backup are dropped). "binding state" is anchored so the
    // "next binding state" / "rewind binding state" lines don't fool it.
    // isc-dhcp is EOL/frozen (2022) so this grammar won't drift. Returns
    // null when the text isn't a dhcpd.leases file.
    function parseISCDhcpdLeases(text) {
        if (!/^\s*lease\s+\d{1,3}(?:\.\d{1,3}){3}\s*\{/m.test(text) ||
            !/^\s*binding state /m.test(text)) return null;
        const byIP = new Map();   // ip -> latest block (file is chronological)
        let cur = null;
        String(text).split(/\r?\n/).forEach(raw => {
            const line = raw.trim();
            let m = line.match(/^lease\s+(\d{1,3}(?:\.\d{1,3}){3})\s*\{/);
            if (m) { cur = { ip: m[1], state: '', mac: '', host: '' }; return; }
            if (!cur) return;
            if (line.charAt(0) === '}') { byIP.set(cur.ip, cur); cur = null; return; }
            if ((m = line.match(/^binding state (\w+)/))) { cur.state = m[1]; return; }
            if ((m = line.match(/^hardware ethernet ([0-9a-fA-F:]{11,17})/))) { cur.mac = m[1]; return; }
            if ((m = line.match(/^client-hostname "([^"]*)"/))) { cur.host = m[1]; return; }
            // ddns 'hostname "x";' is a fallback only if no client-hostname
            if (!cur.host && (m = line.match(/^hostname "([^"]*)"/))) { cur.host = m[1]; }
        });
        const records = [];
        let skipped = 0;
        byIP.forEach((b, ip) => {
            if (b.state && b.state !== 'active') { skipped++; return; }   // free/expired/abandoned/backup
            if (!isValidIPv4(ip) || isJunkNetIP(ip)) { skipped++; return; }
            const mac = normalizeMAC(b.mac);
            if (mac && isJunkNetMAC(mac)) { skipped++; return; }
            const fields = { 'IP-Address': ip };
            if (b.host) fields.Hostname = b.host;
            if (mac) fields['MAC Address'] = mac;
            records.push({ label: b.host ? shortHostname(b.host) : ip, stencilName: '', fields: fields, x: null, y: null });
        });
        return { name: 'ISC dhcpd leases', records: records, skipped: skipped };
    }

    // Ansible INI inventory (the "hosts" file) - the source of truth many
    // homelabs already keep, and unlike YAML facts it's flat and stable:
    //   [core]
    //   router1 ansible_host=10.0.0.1 role=edge
    //   sw1.lan
    //   [core:vars]        <- group vars, not hosts (body skipped)
    //   [prod:children]    <- child-group refs, not hosts (body skipped)
    // Group name -> Location (zone nesting, first group a host appears in);
    // first token -> label; ansible_host / ansible_ssh_host supplies the IP
    // or hostname; ansible_* connection plumbing is dropped, but any other
    // var (role=, rack=) becomes a custom field. Returns null unless it
    // really looks like an inventory (needs an ansible_host fingerprint, or
    // real [group] headers with host-shaped bodies) so an unrelated .ini /
    // .desktop / .gitconfig can't false-match and the CSV path proceeds.
    function parseAnsibleInventory(text) {
        const isIPv4 = (v) => v.split('.').length === 4 && isValidIPv4(v);
        const SECTION = /^\[([^\]]+)\]$/;
        const hasAnsibleVar = /\bansible_(?:host|ssh_host)\s*=/.test(text);

        let section = null;      // current group, '' = ungrouped/all, null before first header
        let skipBody = false;    // inside a :vars / :children block
        const byName = new Map();
        let hostLines = 0, bodyLines = 0, skipped = 0, sawSection = false;

        String(text).split(/\r?\n/).forEach(raw => {
            const line = raw.replace(/[;#].*$/, '').trim();   // ; and # are INI comments
            if (!line) return;
            const sm = line.match(SECTION);
            if (sm) {
                sawSection = true;
                const name = sm[1].trim();
                if (name.indexOf(':') >= 0) { skipBody = true; section = null; }   // :vars / :children
                else {
                    skipBody = false;
                    const low = name.toLowerCase();
                    section = (low === 'all' || low === 'ungrouped') ? '' : name;
                }
                return;
            }
            if (skipBody) return;
            bodyLines++;
            const tok = line.split(/\s+/);
            const host = tok[0];
            // Host line = bare first token; reject a spaced "key = value"
            // (tok[1] === '=') so config-style INIs don't read as hosts.
            if (!host || host.includes('=') || tok[1] === '=') { skipped++; return; }
            hostLines++;

            const fields = {};
            let ip = '', hostname = '';
            if (isIPv4(host)) ip = host;
            else if (host.includes('.')) hostname = host;

            for (let i = 1; i < tok.length; i++) {
                const eq = tok[i].indexOf('=');
                if (eq < 1) continue;
                const k = tok[i].slice(0, eq), v = tok[i].slice(eq + 1);
                if (!v) continue;
                if (/^ansible_(?:host|ssh_host)$/i.test(k)) {
                    if (isIPv4(v)) ip = v; else hostname = hostname || v;
                } else if (/^ansible_/i.test(k)) {
                    /* connection plumbing (user/port/connection/become/...) - drop */
                } else {
                    fields[k] = v;   // user-defined var -> custom field
                }
            }
            if (ip) fields['IP-Address'] = ip;
            if (hostname) fields.Hostname = hostname;
            const label = hostname ? shortHostname(hostname) : host;
            if (byName.has(label)) return;   // same host in another group; first group wins
            if (section) fields.Location = section;
            byName.set(label, { label: label, stencilName: '', fields: fields, x: null, y: null });
        });

        if (!byName.size) return null;
        // Confidence gate: the ansible_host fingerprint is decisive; without
        // it, require real section headers AND a host-dominated body so a
        // "[section] key = value" config file is rejected.
        if (!hasAnsibleVar && (!sawSection || hostLines < bodyLines * 0.6)) return null;
        return { name: 'Ansible inventory', records: [...byName.values()], skipped: skipped };
    }

    // Auto-detected translations for known network-management exports, so
    // those files import as-is with no manual column cleanup. Each profile
    // maps a curated subset of columns onto the native schema and DROPS
    // the rest - a Catalyst Center export carries ~55 columns and an ISE
    // endpoint export 100+, and hauling them all in as custom fields
    // would bury Device Details in noise. Detection keys on column
    // combinations unique to each product, so plain CrossCanvas CSVs (or
    // anything else) can never false-positive.
    const VENDOR_CSV_PROFILES = [
        {
            name: 'Cisco Catalyst Center inventory',
            detect: (lower) => lower.includes('device name') &&
                lower.includes('device family') && lower.includes('reachability'),
            translate: (headers, lower, dataRows) => {
                const col = (n) => lower.indexOf(n);
                const iName = col('device name'), iIP = col('ip address'),
                    iSerial = col('serial number'), iSite = col('site'),
                    iPlatform = col('platform'), iMAC = col('mac address'),
                    iRole = col('device role'), iVer = col('image version'),
                    iFamily = col('device family');
                const records = [];
                let skipped = 0;
                dataRows.forEach(r => {
                    if (!r.length || r.every(c => !String(c == null ? '' : c).trim())) return;
                    const g = (i) => (i >= 0 && i < r.length) ? String(r[i] == null ? '' : r[i]).trim() : '';
                    const rawName = g(iName);
                    if (!rawName) { skipped++; return; }
                    const label = shortHostname(rawName);   // clean label, full name kept below
                    const fields = { Hostname: rawName };
                    const set = (k, v) => { if (v) fields[k] = v; };
                    set('IP-Address', g(iIP));
                    set('Serial-Number', g(iSerial));
                    set('Description', g(iPlatform));
                    set('MAC Address', g(iMAC));
                    set('Device Role', g(iRole));
                    set('Image Version', g(iVer));
                    // Site is a /-path rooted at the constant "Global" node
                    // every CC install shares - drop it so the top-level
                    // zone isn't a single all-enclosing "Global" box
                    set('Location', g(iSite).split('/').map(s => s.trim())
                        .filter(s => s && s.toLowerCase() !== 'global').join('/'));
                    const fam = (g(iFamily) + ' ' + g(iRole)).toLowerCase();
                    const stencil = guessInfraStencil(fam);
                    // isWLC marks controllers for the hybrid import: clients
                    // ISE reports against a WLC group by their own ISE
                    // location, not the controller's
                    records.push({ label: label, stencilName: stencil, fields: fields, x: null, y: null,
                                   isWLC: fam.includes('wireless controller') });
                });
                return { records: records, skipped: skipped };
            }
        },
        {
            name: 'Cisco ISE endpoints',
            detect: (lower) => lower.includes('macaddress') && lower.includes('endpointpolicy'),
            translate: (headers, lower, dataRows) => {
                const col = (n) => lower.indexOf(n);
                const iMAC = col('macaddress'), iHost = col('host-name'), iIP = col('ip'),
                    iDesc = col('description'), iLoc = col('location'),
                    iAsset = col('ea-cmdbassettag'), iSerial = col('ea-cmdbserialnumber'),
                    iPolicy = col('endpointpolicy'),
                    iOS = col('operating-system'), iOS2 = col('endpointoperatingsystem'),
                    iNAD = col('networkdevicename'), iNADAddr = col('nadaddress');
                const records = [];
                let skipped = 0;
                dataRows.forEach(r => {
                    if (!r.length || r.every(c => !String(c == null ? '' : c).trim())) return;
                    // ISE wraps most field values in single quotes ('192.168.1.1',
                    // 'policy-name', '<switch>', and even the whole Location
                    // string). Strip the surrounding pair so downstream parsing
                    // (IP, Location #-hierarchy roots, stencil keywords, and the
                    // hybrid NAD↔switch match) sees clean values. Internal
                    // apostrophes (e.g. "Bob's iPhone") are preserved.
                    const g = (i) => {
                        if (i < 0 || i >= r.length) return '';
                        let v = String(r[i] == null ? '' : r[i]).trim();
                        if (v.length >= 2 && v[0] === "'" && v[v.length - 1] === "'") v = v.slice(1, -1).trim();
                        return v;
                    };
                    const host = realHostname(g(iHost)), mac = g(iMAC);
                    const label = shortHostname(host) || mac;   // MACs are always present in ISE exports
                    if (!label) { skipped++; return; }
                    const fields = {};
                    const set = (k, v) => { if (v) fields[k] = v; };
                    if (host) fields.Hostname = host;   // keep the full FQDN in Details
                    set('IP-Address', g(iIP));
                    set('Description', g(iDesc));
                    set('Asset-Tag', g(iAsset));
                    set('Serial-Number', g(iSerial));
                    set('MAC Address', mac);
                    const policy = g(iPolicy);
                    set('Endpoint Policy', policy);
                    set('OS', g(iOS) || g(iOS2));
                    // The NAD the endpoint authenticated through - the hybrid
                    // import matches this against Catalyst Center device names;
                    // standalone, groupBySwitch nests clients under it
                    set('Network Device', g(iNAD));
                    // ISE hierarchies are #-delimited under constant roots
                    // ("Location#All Locations#SJC#Bldg1") - strip the roots
                    // and re-join as a /-path for the zone layout
                    const iseLoc = g(iLoc).split('#').map(s => s.trim())
                        .filter(s => s && s.toLowerCase() !== 'location' && s.toLowerCase() !== 'all locations')
                        .join('/');
                    set('Location', iseLoc);   // the hybrid reads this for wireless/unmatched clients
                    records.push({
                        label: label, stencilName: guessClientStencil(policy),
                        fields: fields, x: null, y: null,
                        // Grouping hints for the standalone postProcess (ignored
                        // by the hybrid, which does its own CC-device matching):
                        // NetworkDeviceName + NADAddress = the switch/WLC.
                        _switch: g(iNAD), _switchIP: g(iNADAddr), _loc: iseLoc
                    });
                });
                return { records: records, skipped: skipped };
            },
            // Standalone ISE: nest clients under their NAD (switch or WLC) the
            // same way the CC wired-client profile does. The hybrid path calls
            // translate() directly and never runs this, so no double-grouping.
            postProcess: groupBySwitch
        },
        {
            // NetBox Devices-list export (the DCIM source-of-truth tool):
            // the stock "Current View" export is a stable 10-column set and
            // "All Data" is a superset with the same verbose-name headers
            // (device_type exports as "Type", primary_ip as "IP Address").
            // Site/Location/Rack re-join as the Location path, so the DCIM
            // containment hierarchy lands as nested zones. Nautobot 2.x
            // exports a different snake_case dialect - deliberately not
            // matched here.
            name: 'NetBox devices',
            detect: (lower) => lower.includes('name') && lower.includes('site') &&
                lower.includes('role') && lower.includes('manufacturer') &&
                (lower.includes('rack') || lower.includes('location')),
            translate: (headers, lower, dataRows) => {
                const col = (n) => lower.indexOf(n);
                const iName = col('name'), iSite = col('site'), iLoc = col('location'),
                    iRack = col('rack'), iRole = col('role'), iMfr = col('manufacturer'),
                    iType = col('type') >= 0 ? col('type') : col('device type'),
                    iIP = col('ip address'), iIP4 = col('ipv4 address'),
                    iSerial = col('serial') >= 0 ? col('serial') : col('serial number'),
                    iAsset = col('asset tag');
                const records = [];
                let skipped = 0;
                dataRows.forEach(r => {
                    if (!r.length || r.every(c => !String(c == null ? '' : c).trim())) return;
                    const g = (i) => (i >= 0 && i < r.length) ? String(r[i] == null ? '' : r[i]).trim() : '';
                    const rawName = g(iName);
                    if (!rawName) { skipped++; return; }
                    const fields = { Hostname: rawName };
                    const set = (k, v) => { if (v) fields[k] = v; };
                    // The primary IP carries its prefix length (10.0.0.1/24) - strip it
                    set('IP-Address', (g(iIP) || g(iIP4)).replace(/\/\d+$/, ''));
                    set('Serial-Number', g(iSerial));
                    set('Asset-Tag', g(iAsset));
                    set('Description', (g(iMfr) + ' ' + g(iType)).trim());
                    set('Device Role', g(iRole));
                    set('Location', [g(iSite), g(iLoc), g(iRack)].filter(Boolean).join('/'));
                    // Role names are free-form ("Access Switch", "core-sw",
                    // "Wireless AP") - the shared infra classifier handles
                    // normalization and rule order; endpoints not matched
                    // there fall through to the client-device guesser.
                    const hint = g(iRole) + ' ' + g(iType);
                    const stencil = guessInfraStencil(hint) || guessClientStencil(hint.toLowerCase());
                    records.push({ label: shortHostname(rawName), stencilName: stencil,
                                   fields: fields, x: null, y: null });
                });
                return { records: records, skipped: skipped };
            }
        },
        {
            name: 'Cisco Catalyst Center wired clients',
            // A client export carries Switch IP Address + Endpoint Type, which
            // neither the device export nor an ISE export has
            detect: (lower) => lower.includes('switch ip address') && lower.includes('endpoint type'),
            translate: (headers, lower, dataRows) => {
                const col = (n) => lower.indexOf(n);
                const iHost = col('hostname'), iIP = col('ipv4 address'), iMAC = col('mac address'),
                    iType = col('device type'), iEnd = col('endpoint type'),
                    iMfr = col('hardware manufacturer'), iOS = col('os'),
                    iSwitch = col('switch'), iSwIP = col('switch ip address'),
                    iPort = col('port'), iVLAN = col('vlan id'), iSGT = col('security group (tag)'),
                    iLoc = col('location');
                const records = [];
                let skipped = 0;
                dataRows.forEach(r => {
                    if (!r.length || r.every(c => !String(c == null ? '' : c).trim())) return;
                    const g = (i) => (i >= 0 && i < r.length) ? String(r[i] == null ? '' : r[i]).trim() : '';
                    const host = realHostname(g(iHost)), mac = g(iMAC);
                    const label = shortHostname(host) || mac;
                    if (!label) { skipped++; return; }
                    const fields = {};
                    const set = (k, v) => { if (v) fields[k] = v; };
                    if (host) fields.Hostname = host;
                    set('IP-Address', g(iIP));
                    set('MAC Address', mac);
                    set('OS', g(iOS));
                    set('Device Type', g(iType));
                    set('Switch Port', g(iPort));
                    set('VLAN', g(iVLAN));
                    set('Security Group', g(iSGT));
                    records.push({
                        label: label, fields: fields, x: null, y: null,
                        stencilName: guessClientStencil(g(iType) + ' ' + g(iEnd) + ' ' + g(iMfr) + ' ' + g(iOS)),
                        // Grouping hints for postProcess: which switch (name +
                        // IP) this client is on, and its CC site path
                        _switch: g(iSwitch),
                        _switchIP: g(iSwIP),
                        _loc: g(iLoc).split('/').map(s => s.trim())
                            .filter(s => s && s.toLowerCase() !== 'global').join('/')
                    });
                });
                return { records: records, skipped: skipped };
            },
            // Single-source switch grouping (Switch / Switch IP columns) -
            // shared with the ISE profile; see groupBySwitch above.
            postProcess: groupBySwitch
        },
        {
            // DNS Manager -> zone -> right-click -> Export List. Columns:
            // Name, Type, Data, Timestamp. Only "Host (A)" records carry an
            // IP in Data; zone plumbing (_msdcs/_sites/_tcp/_udp/
            // DomainDnsZones/ForestDnsZones subfolder rows, NS/SOA, and the
            // "(same as parent folder)" apex records) is skipped.
            name: 'Windows DNS zone export',
            detect: (lower) => lower.includes('name') && lower.includes('type') &&
                lower.includes('data') && lower.includes('timestamp') &&
                !lower.includes('label') && !lower.includes('ip-address'),
            translate: (headers, lower, dataRows) => {
                const col = (n) => lower.indexOf(n);
                const iName = col('name'), iType = col('type'), iData = col('data');
                const IGNORE = new Set(['_msdcs', '_sites', '_tcp', '_udp',
                    'domaindnszones', 'forestdnszones', '(same as parent folder)']);
                const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
                const records = [];
                const seen = new Set();
                let skipped = 0;
                dataRows.forEach(r => {
                    if (!r.length || r.every(c => !String(c == null ? '' : c).trim())) return;
                    const g = (i) => (i >= 0 && i < r.length) ? String(r[i] == null ? '' : r[i]).trim() : '';
                    const name = g(iName), type = g(iType).toLowerCase(), data = g(iData);
                    if (!name || IGNORE.has(name.toLowerCase())) { skipped++; return; }
                    // "host (a)" matches A but not AAAA (closing paren)
                    if (!type.includes('host (a)') || !IPV4.test(data)) { skipped++; return; }
                    const key = name.toLowerCase() + '|' + data;
                    if (seen.has(key)) { skipped++; return; }
                    seen.add(key);
                    records.push({
                        label: shortHostname(name), stencilName: '',
                        fields: { Hostname: name, 'IP-Address': data },
                        x: null, y: null
                    });
                });
                return { records: records, skipped: skipped };
            }
        },
        {
            // ISC Kea DHCPv4 lease file (kea-leases4.csv) - the modern dhcpd
            // replacement, already CSV: address, hwaddr, ..., hostname, state.
            // The memfile is an APPEND LOG between LFC compactions: every renewal
            // adds a row and a release adds a valid_lifetime=0 row, so rows are
            // folded newest-wins per address first, THEN filtered. Keep only
            // active leases (state 0, non-zero lifetime); 1=declined, 2=expired.
            name: 'Kea DHCP leases (kea-leases4.csv)',
            detect: (lower) => lower.includes('address') && lower.includes('hwaddr') &&
                lower.includes('valid_lifetime'),
            translate: (headers, lower, dataRows) => {
                const col = (n) => lower.indexOf(n);
                const iIP = col('address'), iMAC = col('hwaddr'),
                    iHost = col('hostname'), iState = col('state'),
                    iLife = col('valid_lifetime');
                const byAddr = new Map();   // address -> latest row (file is chronological)
                let skipped = 0;
                dataRows.forEach(r => {
                    if (!r.length || r.every(c => !String(c == null ? '' : c).trim())) return;
                    const g = (i) => (i >= 0 && i < r.length) ? String(r[i] == null ? '' : r[i]).trim() : '';
                    const ip = g(iIP);
                    if (!ip) { skipped++; return; }
                    byAddr.set(ip, r);
                });
                const records = [];
                byAddr.forEach((r, ip) => {
                    const g = (i) => (i >= 0 && i < r.length) ? String(r[i] == null ? '' : r[i]).trim() : '';
                    if (iState >= 0 && g(iState) && g(iState) !== '0') { skipped++; return; }
                    if (iLife >= 0 && g(iLife) === '0') { skipped++; return; }   // released lease
                    const host = g(iHost).replace(/\.$/, '');
                    const mac = normalizeMAC(g(iMAC));
                    const fields = { 'IP-Address': ip };
                    if (host) fields.Hostname = host;
                    if (mac) fields['MAC Address'] = mac;
                    records.push({ label: shortHostname(host) || ip, stencilName: '', fields: fields, x: null, y: null });
                });
                return { records: records, skipped: skipped };
            }
        },
        {
            // DHCP MMC -> scope -> Address Leases -> Export List. Unique ID is
            // the client MAC (usually bare hex); Name is often an FQDN with a
            // trailing dot.
            name: 'Windows DHCP leases export',
            detect: (lower) => lower.includes('client ip address') && lower.includes('unique id'),
            translate: (headers, lower, dataRows) => {
                const col = (n) => lower.indexOf(n);
                const iIP = col('client ip address'), iName = col('name'),
                    iUID = col('unique id'), iDesc = col('description');
                const records = [];
                let skipped = 0;
                dataRows.forEach(r => {
                    if (!r.length || r.every(c => !String(c == null ? '' : c).trim())) return;
                    const g = (i) => (i >= 0 && i < r.length) ? String(r[i] == null ? '' : r[i]).trim() : '';
                    const ip = g(iIP);
                    if (!ip) { skipped++; return; }
                    const name = g(iName).replace(/\.$/, '');
                    const fields = { 'IP-Address': ip };
                    if (name) fields.Hostname = name;
                    const mac = normalizeMAC(g(iUID));
                    if (mac) fields['MAC Address'] = mac;
                    const desc = g(iDesc);
                    if (desc) fields.Description = desc;
                    records.push({
                        label: shortHostname(name) || ip, stencilName: '',
                        fields: fields, x: null, y: null
                    });
                });
                return { records: records, skipped: skipped };
            }
        }
    ];

    // --- Column mapper -------------------------------------------------
    // Opens when a CSV matches no vendor profile AND the plain template finds
    // no label column: instead of "0 imported", the user assigns each column
    // over a preview of their data. A confirmed mapping is remembered per
    // exact header set, so the next export from the same tool needs one click.
    const INVENTORY_MAP_KEY = 'crosscanvas-inventory-maps';
    // Mapping targets: '' = ignore, '@custom' = keep as a custom field named
    // by its own header, anything else = a canonical template column.
    const INVENTORY_MAP_TARGETS = [
        ['',              '- ignore -'],
        ['label',         'Label'],
        ['stencil',       'Stencil / type'],
        ['Hostname',      'Hostname'],
        ['IP-Address',    'IP Address'],
        ['Serial-Number', 'Serial Number'],
        ['Asset-Tag',     'Asset Tag'],
        ['Description',   'Description'],
        ['Location',      'Location (zones)'],
        ['x',             'X position'],
        ['y',             'Y position'],
        ['@custom',       'Custom field']
    ];
    // Header guesses, first match wins (checked against the header lowercased
    // and stripped to a-z0-9). Conservative: anything unrecognized becomes a
    // custom field, which loses nothing.
    const INVENTORY_MAP_GUESSES = [
        ['label',         /^(label|name|devicename|displayname|device|title)$/],
        ['Hostname',      /^(hostname|host|fqdn|dnsname|computername|nodename)$/],
        ['IP-Address',    /^(ip|ipaddress|ipv4|ipv4address|address|mgmtip|managementip|primaryip)$/],
        ['stencil',       /^(stencil|icon|type|devicetype|role|category)$/],
        ['Serial-Number', /^(serial|serialnumber|serialno|sn)$/],
        ['Asset-Tag',     /^(assettag|asset|assetid|assetnumber|inventorytag)$/],
        ['Description',   /^(description|desc|notes|comment|comments)$/],
        ['Location',      /^(location|site|building|floor|room|rack|zone|area)$/],
        ['x',             /^x$/],
        ['y',             /^y$/]
    ];
    function guessMapTarget(header) {
        const h = String(header).toLowerCase().replace(/[^a-z0-9]/g, '');
        const hit = INVENTORY_MAP_GUESSES.find(g => g[1].test(h));
        return hit ? hit[0] : '@custom';
    }
    function headerSignature(headers) {
        return headers.map(h => String(h).trim().toLowerCase()).join('');
    }
    function loadSavedMaps() {
        try { return JSON.parse(localStorage.getItem(INVENTORY_MAP_KEY)) || {}; }
        catch (e) { return {}; }
    }
    function saveInventoryMap(sig, choices) {
        try {
            const maps = loadSavedMaps();
            maps[sig] = choices;
            localStorage.setItem(INVENTORY_MAP_KEY, JSON.stringify(maps));
        } catch (e) { /* unavailable */ }
    }

    function openInventoryMapper(rows, fileName) {
        const headers = rows[0].map(h => String(h == null ? '' : h).trim());
        const dataRows = rows.slice(1);
        const sig = headerSignature(headers);
        const saved = loadSavedMaps()[sig];
        const restored = !!(saved && saved.length === headers.length);
        const choices = restored ? saved.slice() : headers.map(guessMapTarget);
        // Guesses can collide (two name-ish columns); uniques keep the first,
        // later duplicates fall back to custom fields.
        const UNIQUE = new Set(INVENTORY_MAP_TARGETS.map(t => t[0]));
        UNIQUE.delete(''); UNIQUE.delete('@custom');
        const seen = new Set();
        choices.forEach((c, i) => {
            if (!UNIQUE.has(c)) return;
            if (seen.has(c)) choices[i] = '@custom'; else seen.add(c);
        });

        showDialog({
            title: 'Map columns - ' + fileName,
            wide: true,
            buttons: [],
            body: (close) => {
                const box = document.createElement('div');
                box.className = 'inv-mapper';

                const intro = document.createElement('div');
                intro.className = 'dialog-line';
                intro.textContent = restored ?
                    'Restored your saved mapping for these headers. Adjust if needed, then Import.' :
                    'No known format matched, so choose what each column is. Only Label (or Hostname) is required; unmapped data keeps its own header as a custom field.';
                box.appendChild(intro);

                const scroll = document.createElement('div');
                scroll.className = 'inv-map-scroll';
                const table = document.createElement('table');
                table.className = 'inv-map-table';

                const selects = [];
                const selRow = document.createElement('tr');
                headers.forEach((h, i) => {
                    const th = document.createElement('th');
                    const sel = document.createElement('select');
                    INVENTORY_MAP_TARGETS.forEach(([v, lab]) => {
                        const o = document.createElement('option');
                        o.value = v; o.textContent = lab;
                        sel.appendChild(o);
                    });
                    sel.value = choices[i];
                    sel.addEventListener('change', () => {
                        // A unique target picked here evicts its previous owner
                        // to Custom field (nothing silently discarded).
                        if (UNIQUE.has(sel.value)) {
                            selects.forEach(s => {
                                if (s !== sel && s.value === sel.value) s.value = '@custom';
                            });
                        }
                        refreshImportState();
                    });
                    selects.push(sel);
                    th.appendChild(sel);
                    selRow.appendChild(th);
                });
                table.appendChild(selRow);

                const headRow = document.createElement('tr');
                headers.forEach(h => {
                    const th = document.createElement('th');
                    th.className = 'inv-map-header';
                    th.textContent = h || '(blank)';
                    headRow.appendChild(th);
                });
                table.appendChild(headRow);

                dataRows.slice(0, 8).forEach(r => {
                    const tr = document.createElement('tr');
                    headers.forEach((h, i) => {
                        const td = document.createElement('td');
                        const v = String(r[i] == null ? '' : r[i]).trim();
                        td.textContent = v.length > 40 ? v.slice(0, 40) + '…' : v;
                        if (v.length > 40) td.title = v;
                        tr.appendChild(td);
                    });
                    table.appendChild(tr);
                });
                scroll.appendChild(table);
                box.appendChild(scroll);

                const foot = document.createElement('div');
                foot.className = 'inv-map-foot';
                const count = document.createElement('span');
                count.className = 'inv-map-count';
                count.textContent = dataRows.length + ' row' + (dataRows.length === 1 ? '' : 's');
                foot.appendChild(count);
                const btnCancel = document.createElement('button');
                btnCancel.type = 'button';
                btnCancel.className = 'dialog-btn';
                btnCancel.textContent = 'Cancel';
                btnCancel.addEventListener('click', () => close(null));
                const btnImport = document.createElement('button');
                btnImport.type = 'button';
                btnImport.className = 'dialog-btn primary';
                btnImport.textContent = 'Import';
                btnImport.addEventListener('click', () =>
                    close({ choices: selects.map(s => s.value) }));
                foot.appendChild(btnCancel);
                foot.appendChild(btnImport);
                box.appendChild(foot);

                function refreshImportState() {
                    const ok = selects.some(s => s.value === 'label' || s.value === 'Hostname');
                    btnImport.disabled = !ok;
                    btnImport.title = ok ? '' : 'Map one column to Label or Hostname first';
                }
                refreshImportState();
                return box;
            }
        }).then(result => {
            if (!result) return;
            saveInventoryMap(sig, result.choices);
            applyInventoryMapping(headers, dataRows, result.choices, fileName);
        });
    }

    function applyInventoryMapping(headers, dataRows, choices, fileName) {
        // Rewrite the header row to canonical names, drop ignored columns, and
        // feed the result straight back through the plain-template reader - the
        // mapper never grows its own import path.
        const outHeaders = [];
        const keep = [];
        choices.forEach((c, i) => {
            if (!c) return;
            keep.push(i);
            outHeaders.push(c === '@custom' ? (headers[i] || 'Column ' + (i + 1)) : c);
        });
        const outRows = dataRows.map(r => keep.map(i => r[i] == null ? '' : r[i]));
        const out = genericInventoryRecords(outHeaders, outHeaders.map(h => h.toLowerCase()), outRows);
        finishInventoryImport(out.records, out.skipped, fileName,
            'Columns mapped by hand - remembered for files with these exact headers.');
    }

    // File > Paste Inventory: the same importer without a file. Accepts cell
    // ranges copied from a spreadsheet (tab-separated), CSV text, or any of
    // the plain-text formats (arp, nmap, lease files) - one box, same brain.
    function openInventoryPaste() {
        if (state.dirty && !confirm('You have unsaved changes. Discard them and import pasted inventory?')) return;
        showDialog({
            title: 'Paste Inventory',
            wide: true,
            buttons: [],
            body: (close) => {
                const box = document.createElement('div');
                const ta = document.createElement('textarea');
                ta.className = 'inv-paste-text';
                ta.placeholder = 'Paste spreadsheet cells, CSV, arp / nmap output, or a lease file…';
                box.appendChild(ta);
                const foot = document.createElement('div');
                foot.className = 'inv-map-foot';
                const lbl = document.createElement('label');
                lbl.className = 'inv-paste-headers';
                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = true;
                lbl.appendChild(cb);
                lbl.appendChild(document.createTextNode(' First row is headers'));
                foot.appendChild(lbl);
                const btnCancel = document.createElement('button');
                btnCancel.type = 'button';
                btnCancel.className = 'dialog-btn';
                btnCancel.textContent = 'Cancel';
                btnCancel.addEventListener('click', () => close(null));
                const btnGo = document.createElement('button');
                btnGo.type = 'button';
                btnGo.className = 'dialog-btn primary';
                btnGo.textContent = 'Continue';
                btnGo.addEventListener('click', () => {
                    if (ta.value.trim()) close({ text: ta.value, headers: cb.checked });
                });
                foot.appendChild(btnCancel);
                foot.appendChild(btnGo);
                box.appendChild(foot);
                setTimeout(() => ta.focus(), 0);
                return box;
            }
        }).then(r => {
            if (!r) return;
            importInventoryCSV(r.text, 'pasted data', { synthHeaders: !r.headers });
        });
    }

    // The plain-template reader: label / stencil / x / y / Device Details
    // columns matched by name, anything else kept as a custom field. Also the
    // landing path for the column mapper, which rewrites foreign headers to
    // these canonical names and re-enters here.
    function genericInventoryRecords(headers, lower, dataRows) {
        const iLabel = lower.indexOf('label');
        const iStencil = lower.indexOf('stencil');
        const iX = lower.indexOf('x');
        const iY = lower.indexOf('y');
        const FIXED_LOWER = FIXED_DEVICE_FIELDS.map(f => f.toLowerCase());
        const known = new Set(['label', 'stencil', 'x', 'y'].concat(FIXED_LOWER));

        const records = [];
        let skipped = 0;
        dataRows.forEach(r => {
            if (!r.length || r.every(c => !String(c == null ? '' : c).trim())) return;
            const get = (i) => (i >= 0 && i < r.length) ? String(r[i] == null ? '' : r[i]).trim() : '';
            const fields = {};
            headers.forEach((h, i) => {
                const v = String(r[i] == null ? '' : r[i]).trim();
                if (!v) return;
                const fi = FIXED_LOWER.indexOf(lower[i]);
                if (fi >= 0) fields[FIXED_DEVICE_FIELDS[fi]] = v;
                else if (!known.has(lower[i])) fields[h] = v;
            });
            const label = get(iLabel) || fields.Hostname || '';
            if (!label) { skipped++; return; }
            const xv = parseFloat(get(iX)), yv = parseFloat(get(iY));
            records.push({
                label: label,
                stencilName: get(iStencil),
                fields: fields,
                x: (iX >= 0 && !isNaN(xv)) ? xv : null,
                y: (iY >= 0 && !isNaN(yv)) ? yv : null
            });
        });
        return { records, skipped };
    }

    function importInventoryCSV(text, fileName, opts) {
        opts = opts || {};
        // Plain-text formats first - arp/neighbour dumps, dnsmasq leases, and
        // nmap output aren't CSV at all. Each returns null when it doesn't match.
        const textParsed = parseARPText(text) || parseDnsmasqLeases(text) || parseNmap(text) ||
                           parseISCDhcpdLeases(text) || parseAnsibleInventory(text);
        if (textParsed) {
            finishInventoryImport(textParsed.records, textParsed.skipped, fileName,
                'Detected format: ' + textParsed.name);
            return;
        }
        const rows = parseDelimited(text);
        // Headerless data (a cell range pasted without its header row): give
        // every column a placeholder name so the mapper has handles to hang on.
        if (opts.synthHeaders && rows.length) {
            rows.unshift(rows[0].map((_, i) => 'Column ' + (i + 1)));
        }
        if (rows.length < 2) {
            showDialog({
                title: 'Inventory import',
                body: 'No data rows found.\n\nExpected a CSV with a header row: label, stencil, ' +
                    FIXED_DEVICE_FIELDS.join(', ') + ', x, y - plus any custom field columns. ' +
                    'Only "label" (or Hostname) is required. Vendor exports (Catalyst Center, ' +
                    'ISE, NetBox), Windows DNS zone / DHCP lease exports, Kea and ISC dhcpd lease ' +
                    'files, and pasted arp / nmap output are detected and mapped automatically - ' +
                    'see Help > Inventory Import Formats for the full list.'
            });
            return;
        }
        const headers = rows[0].map(h => h.trim());
        const lower = headers.map(h => h.toLowerCase());

        const profile = VENDOR_CSV_PROFILES.find(p => p.detect(lower));
        let records = [];
        let skipped = 0;
        if (profile) {
            const out = profile.translate(headers, lower, rows.slice(1));
            records = out.records;
            skipped = out.skipped;
            if (profile.postProcess) records = profile.postProcess(records);
        } else {
            const out = genericInventoryRecords(headers, lower, rows.slice(1));
            records = out.records;
            skipped = out.skipped;
            if (!records.length) {
                // Right data, wrong headers - the exact case that used to dead-end
                // in "No usable rows". Let the user assign the columns themselves.
                openInventoryMapper(rows, fileName);
                return;
            }
        }
        finishInventoryImport(records, skipped, fileName,
            profile ? 'Detected format: ' + profile.name : '');
    }

    // Route the Import Inventory picker: one file behaves as always; a
    // Catalyst Center device export + an ISE endpoint export selected
    // together trigger the hybrid import.
    function importInventoryFiles(files) {
        if (files.length === 1) { importInventoryCSV(files[0].text, files[0].name); return; }
        if (files.length === 2) {
            const detected = files.map(f => {
                const rows = parseCSV(f.text);
                const lower = rows.length ? rows[0].map(h => String(h).trim().toLowerCase()) : [];
                return VENDOR_CSV_PROFILES.find(p => p.detect(lower)) || null;
            });
            const ccIdx = detected.findIndex(p => p && p.name.indexOf('Catalyst') >= 0);
            const iseIdx = detected.findIndex(p => p && p.name.indexOf('ISE') >= 0);
            if (ccIdx >= 0 && iseIdx >= 0 && ccIdx !== iseIdx) {
                importInventoryHybrid(files[ccIdx], files[iseIdx]);
                return;
            }
        }
        showDialog({
            title: 'Inventory import',
            body: 'Multiple files selected. For a hybrid import, pick exactly one ' +
                'Catalyst Center device export and one ISE endpoint export together - ' +
                'otherwise import one CSV at a time.'
        });
    }

    // Hybrid import: CC provides the authoritative location tree and the
    // infrastructure; ISE provides the clients. A wired client nests inside
    // a zone named for the switch ISE saw it on (NetworkDeviceName ↔ CC
    // Device Name, matched on short hostname) - containment, not topology.
    // Clients ISE reports against a WLC group under their own ISE building
    // in a "Wireless" sub-zone instead, so they don't all pile into the
    // building the controller happens to live in. Unmatched clients fall
    // back to plain ISE Location grouping. A switch only becomes a zone
    // when it has clients to contain; client-less gear stays plain devices.
    function importInventoryHybrid(ccFile, iseFile) {
        const parse = (text) => {
            const rows = parseCSV(text);
            const headers = rows[0].map(h => h.trim());
            return { headers: headers, lower: headers.map(h => h.toLowerCase()), data: rows.slice(1) };
        };
        const ccProfile = VENDOR_CSV_PROFILES.find(p => p.name.indexOf('Catalyst') >= 0);
        const iseProfile = VENDOR_CSV_PROFILES.find(p => p.name.indexOf('ISE') >= 0);
        const c = parse(ccFile.text), s = parse(iseFile.text);
        const ccOut = ccProfile.translate(c.headers, c.lower, c.data);
        const iseOut = iseProfile.translate(s.headers, s.lower, s.data);

        const byName = new Map();
        ccOut.records.forEach(r => byName.set(r.label.toLowerCase(), r));
        const hosts = new Set();
        let wired = 0, wireless = 0, unmatched = 0;
        iseOut.records.forEach(r => {
            const nad = shortHostname(r.fields['Network Device'] || '').toLowerCase();
            const sw = nad ? byName.get(nad) : null;
            if (sw && !sw.isWLC) {
                const base = sw.fields.Location || '';
                r.fields.Location = base ? base + '/' + sw.label : sw.label;
                hosts.add(sw);
                wired++;
            } else if (sw && sw.isWLC) {
                r.fields.Location = (r.fields.Location ? r.fields.Location + '/' : '') + 'Wireless';
                wireless++;
            } else {
                unmatched++;
            }
        });
        // A switch that hosts clients moves inside its own zone
        hosts.forEach(sw => {
            const base = sw.fields.Location || '';
            sw.fields.Location = base ? base + '/' + sw.label : sw.label;
        });

        const note = 'Detected format: Hybrid - Catalyst Center devices + ISE endpoints\n' +
            'Wired clients grouped under ' + hosts.size + ' switch' + (hosts.size === 1 ? '' : 'es') + ': ' + wired + '\n' +
            (wireless ? 'Wireless clients (grouped by ISE location): ' + wireless + '\n' : '') +
            (unmatched ? 'Clients without a matching switch (ISE location): ' + unmatched + '\n' : '');
        const title = ccFile.name.replace(/\.csv$/i, '') + ' + ' + iseFile.name.replace(/\.csv$/i, '');
        finishInventoryImport(ccOut.records.concat(iseOut.records),
            ccOut.skipped + iseOut.skipped, title, note);
    }

    // Shared tail of every inventory import: records → devices/zones →
    // recursive layout → state swap → summary dialog.
    function finishInventoryImport(records, skipped, fileName, formatNote) {
        if (!records.length) {
            showDialog({ title: 'Inventory import', body: 'No usable rows - every row needs a label (or Hostname).' });
            return;
        }

        // Devices mirror a palette drop (Default Settings apply)
        const blankTpl = state.deviceTemplates.find(t => t.name === 'Blank');
        const placeholders = [];
        function makeInventoryDevice(rec, x, y) {
            let template = blankTpl || null;
            if (rec.stencilName) {
                const res = resolveVisioTemplate(rec.stencilName);
                if (res && res.template) template = res.template;
                if (!res || !res.template || res.wasPlaceholder) {
                    if (!placeholders.includes(rec.stencilName)) placeholders.push(rec.stencilName);
                    if (!res || !res.template) template = blankTpl || null;
                }
            }
            const dev = makeThemedDevice(template, rec.label, x, y);
            if (Object.keys(rec.fields).length) dev.fields = rec.fields;
            return dev;
        }

        // Location tree: every path level is a zone wrapping its children
        const root = { name: '', children: new Map(), devices: [] };
        const explicit = [];
        records.forEach(rec => {
            if (rec.x != null && rec.y != null) { explicit.push(rec); return; }
            const loc = rec.fields.Location || '';
            const parts = loc ? loc.split(/[/|]/).map(s => s.trim()).filter(Boolean) : [];
            let node = root;
            parts.forEach(p => {
                if (!node.children.has(p)) {
                    node.children.set(p, { name: p, children: new Map(), devices: [] });
                }
                node = node.children.get(p);
            });
            node.devices.push(rec);
        });

        // Optional per-zone device sort (Default Settings → Import Sort).
        // Sort is stable, so equal keys keep CSV order; an empty key (a
        // synthetic switch/WLC has no MAC) sorts first, keeping the zone's
        // network device at the top when sorting by MAC. 'file' = no sort.
        if (IMPORT_SORT !== 'file') {
            const sortKey = (rec) => {
                if (IMPORT_SORT === 'mac') return ((rec.fields && rec.fields['MAC Address']) || '').toLowerCase();
                if (IMPORT_SORT === 'type') return rec.stencilName || '';
                return (rec.label || '').toLowerCase();   // 'label'
            };
            const cmp = (a, b) => sortKey(a).localeCompare(sortKey(b));
            const sortNode = (node) => { node.devices.sort(cmp); node.children.forEach(sortNode); };
            sortNode(root);
            explicit.sort(cmp);
        }

        // Bottom-up sizing: device grids ~4 wide; parents shelf-pack their
        // children left-to-right, wrapping toward a wide-screen shape
        // PAD and HEAD are grid multiples (grid = 20) so a snapped zone's
        // padding + header land back on the grid - see the snap note in place().
        // CELL_W/CELL_H carry the user's Import Spacing multipliers (Default
        // Settings); left un-snapped so 100% matches the historical packing
        // exactly - each device's x/y is snapped individually at placement.
        const CELL_W = 120 * IMPORT_HSPACE, CELL_H = 110 * IMPORT_VSPACE;
        const PAD = 20, HEAD = 40, GAP = 30;

        // Bottom-left skyline packing: place each block (in order) at the
        // lowest - then leftmost - spot its width fits within the target width,
        // so short zones tuck into the vertical gaps beside a tall one instead
        // of starting a fresh row far below it. Handles uniform AND mixed widths
        // (plain shelf packing wasted the space under short zones that happened
        // to share a row with a very tall one). The skyline is a list of
        // breakpoints {x, y}: from x[i] to x[i+1] the packed top sits at y[i].
        function packBlocks(blocks, targetW) {
            const limit = blocks.reduce((m, b) => Math.max(m, b.w), targetW);   // never narrower than the widest block
            let sky = [{ x: 0, y: 0 }];
            const heightAt = (x) => { let y = 0; for (const p of sky) { if (p.x <= x + 0.01) y = p.y; else break; } return y; };
            const topOver = (x, w) => {
                let y = heightAt(x);
                for (const p of sky) { if (p.x > x + 0.01 && p.x < x + w - 0.01) y = Math.max(y, p.y); }
                return y;
            };
            const raise = (x, w, top) => {
                const x2 = x + w, yRight = heightAt(x2);
                sky = sky.filter(p => p.x < x - 0.01 || p.x > x2 + 0.01);
                sky.push({ x: x, y: top }, { x: x2, y: yRight });
                sky.sort((a, b) => a.x - b.x);
                sky = sky.filter((p, i) => i === 0 || Math.abs(p.y - sky[i - 1].y) > 0.01);
            };
            let usedW = 0, usedH = 0;
            blocks.forEach(b => {
                const bw = b.w + GAP;
                let best = { x: 0, y: Infinity };
                sky.forEach(p => {
                    if (p.x + bw > limit + 0.01) return;
                    const y = topOver(p.x, bw);
                    if (y < best.y - 0.01 || (Math.abs(y - best.y) < 0.01 && p.x < best.x)) best = { x: p.x, y: y };
                });
                if (best.y === Infinity) best = { x: 0, y: heightAt(0) };   // safety (block wider than limit)
                b.relX = best.x; b.relY = best.y;
                raise(best.x, bw, best.y + b.h + GAP);
                usedW = Math.max(usedW, best.x + b.w);
                usedH = Math.max(usedH, best.y + b.h);
            });
            return { w: usedW, h: usedH };
        }

        function measure(node) {
            const blocks = [];
            if (node.devices.length) {
                const n = node.devices.length;
                const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(n))));
                blocks.push({
                    grid: node.devices, cols: cols,
                    w: Math.min(n, cols) * CELL_W,
                    h: Math.ceil(n / cols) * CELL_H
                });
            }
            node.children.forEach(c => blocks.push(measure(c)));
            const totalArea = blocks.reduce((a, b) => a + b.w * b.h, 0);
            const targetW = Math.max(500, Math.sqrt(totalArea * 1.7));
            const packed = packBlocks(blocks, targetW);
            node.blocks = blocks;
            const isRoot = node === root;
            node.w = packed.w + (isRoot ? 0 : PAD * 2);
            node.h = packed.h + (isRoot ? 0 : PAD + HEAD);
            return node;
        }
        function place(node, ax, ay, outZones, outDevices) {
            node.blocks.forEach(b => {
                const bx = ax + b.relX, by = ay + b.relY;
                if (b.grid) {
                    b.grid.forEach((rec, i) => {
                        // Exact centered position - NOT grid-snapped. A 60px device
                        // centered in a 120px cell sits at offset 30, off the 20px
                        // grid, so snapToGrid would round it and push it ~10px off
                        // the zone's center (visible with a single/odd device under
                        // a zone label). The cell origins are already grid-aligned;
                        // the centering offset is the only sub-grid part, and we
                        // want to keep it exact so devices sit dead-center.
                        const gx = bx + (i % b.cols) * CELL_W + (CELL_W - DEVICE_SIZE) / 2;
                        const gy = by + Math.floor(i / b.cols) * CELL_H + 8;
                        outDevices.push(makeInventoryDevice(rec, gx, gy));
                    });
                } else {
                    // Snap the zone box, then recurse from that SAME snapped
                    // origin. If we drew snapped but laid children out from the
                    // un-snapped point, the two snap errors compound and the
                    // label-to-child header gap comes out uneven (e.g. 40px at
                    // one nesting level, 20px at the next). Since PAD and HEAD
                    // are grid multiples, snapped + PAD/HEAD stays on the grid.
                    const zx = snapToGrid(bx), zy = snapToGrid(by);
                    // Every zone inherits the active theme: fill from the Zone
                    // Color default, label + border from the Zone Border color.
                    // Parent zones (holding further zones) take a lighter tint of
                    // that fill so the nesting reads and the innermost device
                    // zones stay the fuller color. (Imported *diagrams* keep their
                    // source styling; a CSV has none, so the theme applies -
                    // matching Recolor All to Theme, no post-import recolor needed.)
                    const zoneCol = DEFAULT_ZONE_FILL || '#e8f4fd';
                    const zoneBd = defaultZoneBorder();
                    outZones.push({
                        id: genId(), shape: 'rectangle',
                        x: zx, y: zy, w: b.w, h: b.h,
                        label: b.name, labelPosition: 'top-inside', labelVAlign: 'top',
                        fontSize: 15, fontColor: zoneBd,
                        lineFormats: [{ bold: true, italic: false }],
                        spans: [[{ text: b.name, bold: true, italic: false }]],
                        fill: b.children.size ? lightenHex(zoneCol, PARENT_ZONE_LIGHTEN) : zoneCol,
                        borderColor: zoneBd, opacity: 1,
                        attachmentPoints: defaultAPsFor(b.w, b.h)
                    });
                    place(b, zx + PAD, zy + HEAD, outZones, outDevices);
                }
            });
        }

        measure(root);
        const newZones = [], newDevices = [];
        explicit.forEach(rec => {
            newDevices.push(makeInventoryDevice(rec, snapToGrid(rec.x), snapToGrid(rec.y)));
        });
        place(root, 60, 60, newZones, newDevices);

        resetDocumentState();
        state.devices = newDevices;
        state.zones = newZones;
        state.diagramTitle = (fileName || 'inventory').replace(/\.csv$/i, '');
        state.diagramVersion = 1;
        setDirty(true);
        updateTitleVersionUI();
        resetTiers();
        renderAll();
        updateCanvasSize();

        let msg = formatNote ? formatNote.trim() + '\n' : '';
        msg += `Devices: ${newDevices.length}\n`;
        msg += `Zones (from Location): ${newZones.length}\n`;
        if (skipped > 0) msg += `Skipped: ${skipped} (blank, duplicate, or non-device rows)\n`;
        if (placeholders.length > 0) {
            msg += `\nUnrecognized stencils imported as Blank:\n`;
            msg += placeholders.map(p => `  • ${p}`).join('\n');
            msg += '\n\nSwap icons via the Icon dropdown in Device Properties.';
        }
        showDialog({ title: 'Inventory import complete', body: msg.trim() });
    }

    // Data export: one row per object with a shared column set - the
    // human-readable columns (type, label, endpoint names) lead, geometry
    // follows, styling and internal ids trail. The shape an inventory/CMDB
    // consumer wants to skim in a spreadsheet; the ids at the far end keep
    // it useful as machine input later (inventory import round-trips).
    function exportCSV() {
        const esc = (v) => {
            let s = String(v == null ? '' : v);
            // Neutralize spreadsheet formula injection: a cell that starts
            // with a formula trigger (= @ + - tab CR) gets a leading
            // apostrophe so Excel/Sheets treat it as text. Labels/fields can
            // come from untrusted imports. Exception: a plain signed number
            // (like -40.5) stays numeric - but "-2+3" is a formula, not a
            // number, so only a whole-string number match is exempt.
            if (/^[=@\t\r]/.test(s) || (/^[+\-]/.test(s) && !/^[+\-]?\d+(\.\d+)?$/.test(s))) {
                s = "'" + s;
            }
            return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        };
        const nodeById = (id) => state.devices.find(d => d.id === id) ||
            state.zones.find(z => z.id === id) || state.images.find(i => i.id === id);
        const stencilName = (d) => {
            const t = state.deviceTemplates.find(tp => tp.id === d.templateId);
            return t ? t.name : '';
        };
        const BASE = ['type', 'label', 'hostname', 'stencil', 'shape', 'from', 'to',
            'x', 'y', 'width', 'height',
            'fill', 'border', 'color', 'tint', 'background',
            'fontSize', 'fontColor', 'labelPosition', 'routing', 'dash',
            'thickness', 'opacity', 'id', 'fromId', 'toId'];
        // Device data fields become columns of their own, right after
        // hostname: the standing fields first (in their panel order), then
        // any custom keys (skipping collisions with base columns). Hostname
        // is the base column itself.
        const usedKeys = new Set();
        state.devices.forEach(d => Object.keys(d.fields || {}).forEach(k => usedKeys.add(k)));
        const fieldKeys = FIXED_DEVICE_FIELDS.slice(1).filter(k => usedKeys.has(k));
        usedKeys.forEach(k => {
            if (k !== 'Hostname' && !FIXED_DEVICE_FIELDS.includes(k) &&
                !BASE.includes(k) && !fieldKeys.includes(k)) fieldKeys.push(k);
        });
        const HEADERS = BASE.slice(0, 3).concat(fieldKeys, BASE.slice(3));
        // Custom-field names become header cells and are user-supplied (the
        // inventory mapper takes them verbatim from a source column header), so
        // the header row needs the same formula-guard + quoting as the data.
        const rows = [HEADERS.map(esc)];
        const row = (obj) => rows.push(HEADERS.map(h => esc(obj[h])));
        state.devices.forEach(d => {
            const f = d.fields || {};
            const r = {
                type: 'device', label: d.label,
                hostname: f.Hostname || (d.label || '').split('\n')[0],
                stencil: stencilName(d),
                x: d.x, y: d.y, width: d.w, height: d.h,
                tint: d.tintColor, background: d.iconBg,
                fontSize: d.fontSize, fontColor: d.fontColor,
                labelPosition: d.labelPosition, id: d.id
            };
            fieldKeys.forEach(k => { r[k] = f[k]; });
            row(r);
        });
        state.zones.forEach(z => row({
            type: 'zone', label: z.label, shape: z.shape || 'rectangle',
            x: z.x, y: z.y, width: z.w, height: z.h,
            fill: z.fill, border: z.borderColor, opacity: z.opacity,
            fontSize: z.fontSize, fontColor: z.fontColor,
            labelPosition: z.labelPosition, id: z.id
        }));
        state.images.forEach(im => row({
            type: 'image', label: im.label,
            x: im.x, y: im.y, width: im.w, height: im.h,
            fontSize: im.fontSize, fontColor: im.fontColor,
            labelPosition: im.labelPosition, id: im.id
        }));
        state.textBoxes.forEach(tb => row({
            type: 'text', label: tb.text,
            x: tb.x, y: tb.y,
            fontSize: tb.fontSize, fontColor: tb.fontColor, id: tb.id
        }));
        // Connection endpoints by NAME (the readable half), ids trailing;
        // free-floating ends carry their coordinates instead
        const endName = (devId, pt) => {
            if (devId) { const n = nodeById(devId); return n ? (n.label || n.id) : devId; }
            return pt ? 'point(' + Math.round(pt.x) + ',' + Math.round(pt.y) + ')' : '';
        };
        state.connections.forEach(c => row({
            type: 'connection', label: c.label,
            from: endName(c.fromDevice, c.fromPoint), to: endName(c.toDevice, c.toPoint),
            color: c.color, routing: c.routing, dash: c.dash, thickness: c.thickness,
            fontSize: c.fontSize, fontColor: c.fontColor, labelPosition: c.labelPosition,
            id: c.id, fromId: c.fromDevice || '', toId: c.toDevice || ''
        }));
        // UTF-8 BOM + CRLF so Excel opens it correctly out of the box
        const csv = '\ufeff' + rows.map(r => r.join(',')).join('\r\n') + '\r\n';
        triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), sanitizedTitle() + '.csv');
    }

    // Vector export: the canvas IS SVG, so clone it, strip the interactive
    // chrome (handles, attachment points, selection, overlay) and crop the
    // viewBox to content bounds. Always exports the LIGHT look (like the
    // raster exports): if dark mode is on, the layers re-render light for
    // the clone and dark is restored after - adaptive label/line flips are
    // baked into the live DOM, so post-processing the clone can't undo them.
    function exportSVG(showGrid) {
        const bounds = getContentBounds();
        if (!bounds) return;
        const wasDark = document.body.classList.contains('dark-mode');
        if (wasDark) {
            document.body.classList.remove('dark-mode');
            renderAllConnections(); renderAllDevices(); renderAllImages();
        }
        try {
            const clone = canvas.cloneNode(true);
            clone.removeAttribute('id');
            clone.removeAttribute('style');
            // Interactive chrome has no place in a document export
            const strip = ['#overlay-layer', '.attachment-point', '.resize-handle', '[data-axis]',
                '.conn-bend-handle', '.conn-waypoint-handle', '.conn-endpoint-handle',
                '.device-selection-outline', '#marquee-rect', '#temp-connection',
                '#temp-endpoint-drag'];
            strip.forEach(sel => clone.querySelectorAll(sel).forEach(el => el.remove()));
            clone.querySelectorAll('.selected, .multi-selected').forEach(el => {
                el.classList.remove('selected', 'multi-selected');
            });
            // Hidden tiers export as displayed (WYSIWYG, matching raster)
            [['zones', '#zones-layer'], ['images', '#images-layer'],
             ['connections', '#connections-layer'], ['devices', '#devices-layer']]
                .forEach(([tier, sel]) => {
                    if (tierHidden(tier)) { const l = clone.querySelector(sel); if (l) l.remove(); }
                });
            const pad = 20;
            const x = bounds.minX - pad, y = bounds.minY - pad;
            const w = bounds.maxX - bounds.minX + pad * 2;
            const h = bounds.maxY - bounds.minY + pad * 2;
            clone.setAttribute('viewBox', x + ' ' + y + ' ' + w + ' ' + h);
            clone.setAttribute('width', w);
            clone.setAttribute('height', h);
            // Standalone, the .svg loses the app's body CSS, so default-font
            // labels would reflow to the viewer's serif and overflow the white
            // boxes/crop bounds measured under this stack. Set it on the root as
            // an INHERITED presentation attribute - text with its own explicit
            // font-family attribute still overrides it, so custom fonts survive.
            clone.setAttribute('font-family', "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif");
            // Background + grid: size the 100% rects to the exported area
            const bg = clone.querySelector('#canvas-bg');
            if (bg) {
                bg.removeAttribute('id');
                bg.setAttribute('x', x); bg.setAttribute('y', y);
                bg.setAttribute('width', w); bg.setAttribute('height', h);
                bg.setAttribute('fill', 'white');
            }
            const grid = clone.querySelector('#grid-overlay');
            if (grid) {
                if (showGrid) {
                    grid.removeAttribute('id');
                    grid.setAttribute('x', x); grid.setAttribute('y', y);
                    grid.setAttribute('width', w); grid.setAttribute('height', h);
                } else {
                    grid.remove();
                    const pat = clone.querySelector('#grid-pattern');
                    if (pat) pat.remove();
                }
            }
            const gl = clone.querySelector('#grid-line');
            if (gl) { gl.setAttribute('stroke', '#e0e0e0'); gl.removeAttribute('id'); }
            const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
                new XMLSerializer().serializeToString(clone);
            triggerDownload(new Blob([xml], { type: 'image/svg+xml' }), sanitizedTitle() + '.svg');
        } finally {
            if (wasDark) {
                document.body.classList.add('dark-mode');
                renderAllConnections(); renderAllDevices(); renderAllImages();
            }
        }
    }

    // ---- draw.io export ---------------------------------------------------
    // Uncompressed mxGraph XML (.drawio) - draw.io / diagrams.net opens it
    // directly, and can itself re-export .vsdx, bridging to Visio. Fidelity
    // choices: device icons composite the app-drawn frame + glyph into one
    // per-device SVG data URI (draw.io has no two-layer icon concept);
    // connection endpoints pin to the exact attachment fractions via
    // exitX/entryX styles; our actual route points ride as edge waypoints;
    // Device Details become draw.io "shape data" (an <object> wrapper -
    // right-click → Edit Data); annotations become edge label children.
    function exportDrawio() {
        const xmlEsc = (v) => String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/\n/g, '&#10;');
        // draw.io styles are ;-delimited, so data URIs inside them drop the
        // ";base64" marker (draw.io's own convention)
        const styleURI = (uri) => uri.replace(';base64,', ',');
        // draw.io cells carry html=1, so their value/label is XML-decoded and
        // then rendered AS HTML. The bold/italic/font tags below are injected
        // deliberately (as &lt;b&gt; etc., from structured span flags) - but the
        // span TEXT must be HTML-escaped first, or a label like
        // "<img src=x onerror=...>" (trivial to introduce via the inventory
        // mapper) decodes to a live element on reopen. Escape text -> &lt;img&gt;
        // survives as visible literal, our own markup still renders.
        const htmlEsc = (t) => String(t == null ? '' : t)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const labelHTML = (spans, label) => {
            const src = spans && spans.length ? spans : [[{ text: label || '', bold: false, italic: false }]];
            return src.map(line => line.map(s => {
                let h = xmlEsc(htmlEsc(s.text)).replace(/&#10;/g, '');
                if (s.bold) h = '&lt;b&gt;' + h + '&lt;/b&gt;';
                if (s.italic) h = '&lt;i&gt;' + h + '&lt;/i&gt;';
                if (s.color && isSafeCSSColor(s.color)) h = '&lt;font color=&quot;' + s.color.trim() + '&quot;&gt;' + h + '&lt;/font&gt;';
                return h;
            }).join('')).join('&lt;br&gt;');
        };
        const fontStyle = (obj) => {
            let s = 'fontSize=' + (obj.fontSize || 20) + ';fontColor=' + (obj.fontColor || '#333333') + ';';
            const ff = fontStackOf(obj);
            if (ff) s += 'fontFamily=' + ff.split(',')[0].replace(/["']/g, '').trim() + ';';
            return s;
        };
        const ARROWS = { arrow: 'block', 'open-arrow': 'open', diamond: 'diamond', circle: 'oval' };
        const DASHES = {
            'dash-sm': '4 3', 'dash-md': '6 4', 'dash-lg': '10 5',
            dot: '1 3', 'dash-dot': '6 3 1 3'
        };
        const ZONE_LABEL_POS = {
            'top': 'verticalLabelPosition=top;verticalAlign=bottom;',
            'top-inside': 'verticalAlign=top;',
            'bottom': 'verticalLabelPosition=bottom;verticalAlign=top;',
            'bottom-inside': 'verticalAlign=bottom;',
            'left': 'labelPosition=left;align=right;',
            'right': 'labelPosition=right;align=left;',
            'center': 'verticalAlign=middle;'
        };
        const cells = [];
        // Cell with optional data fields: fields ride an <object> wrapper so
        // draw.io shows them under Edit Data
        // Style strings hold colors that may come from an untrusted loaded
        // file; a stray " or < would break the XML (or the attribute). They
        // never legitimately contain markup, so escaping is a safe no-op for
        // well-formed styles.
        const emit = (id, value, style, geo, extra, fields) => {
            const cellAttrs = ' vertex="1"' + (extra || '') + ' parent="1"';
            if (fields && Object.keys(fields).length) {
                let attrs = '';
                Object.entries(fields).forEach(([k, v]) => {
                    if (/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(k) && k !== 'label' && k !== 'id') {
                        attrs += ' ' + k + '="' + xmlEsc(v) + '"';
                    }
                });
                cells.push('<object label="' + value + '"' + attrs + ' id="' + id + '">' +
                    '<mxCell style="' + xmlEsc(style) + '"' + cellAttrs + '>' + geo + '</mxCell></object>');
            } else {
                cells.push('<mxCell id="' + id + '" value="' + value + '" style="' + xmlEsc(style) + '"' +
                    cellAttrs + '>' + geo + '</mxCell>');
            }
        };
        const rectGeo = (o) => '<mxGeometry x="' + o.x + '" y="' + o.y + '" width="' + o.w +
            '" height="' + o.h + '" as="geometry"/>';

        // Zones (back-most)
        state.zones.forEach(z => {
            let shape = 'rounded=0;';
            if (z.shape === 'ellipse') shape = 'ellipse;';
            else if (z.shape === 'diamond') shape = 'rhombus;';
            else if (z.shape === 'parallelogram') shape = 'shape=parallelogram;';
            else if (z.shape === 'pill') shape = 'rounded=1;arcSize=50;';
            else if (z.shape === 'cylinder') shape = 'shape=cylinder3;boundedLbl=1;';
            const style = shape + 'whiteSpace=wrap;html=1;' +
                'fillColor=' + (z.fill || '#e8f4fd') + ';' +
                'strokeColor=' + (z.borderColor || STENCIL_FRAME_BLUE) + ';' +
                (z.opacity != null && z.opacity < 1 ? 'fillOpacity=' + Math.round(z.opacity * 100) + ';' : '') +
                (ZONE_LABEL_POS[z.labelPosition || 'top'] || 'verticalAlign=top;') +
                fontStyle(z);
            emit(z.id, labelHTML(z.spans, z.label), style, rectGeo(z));
        });

        // Pasted images
        state.images.forEach(im => {
            const style = 'shape=image;html=1;imageAspect=0;' +
                'image=' + styleURI(im.dataURL) + ';' +
                'verticalLabelPosition=bottom;verticalAlign=top;' + fontStyle(im);
            emit(im.id, labelHTML(im.spans, im.label), style, rectGeo(im));
        });

        // Devices: frame + glyph composited into one SVG so draw.io shows
        // exactly what CrossCanvas draws
        const deviceIcon = (d) => {
            const fw = Math.max(1.5, Math.min(d.w, d.h) * 16 / 300);
            const fr = Math.max(2, Math.min(d.w, d.h) * 30 / 300 - fw / 2);
            const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + d.w + ' ' + d.h + '">' +
                '<rect x="' + (fw / 2) + '" y="' + (fw / 2) + '" width="' + (d.w - fw) + '" height="' + (d.h - fw) +
                '" rx="' + fr + '" fill="' + (d.iconBg || 'rgb(255,254,254)') + '" stroke="' +
                (d.tintColor || STENCIL_FRAME_BLUE) + '" stroke-width="' + fw + '"/>' +
                (d.image ? '<image href="' + d.image + '" width="' + d.w + '" height="' + d.h +
                    '" preserveAspectRatio="xMidYMid meet"/>' : '') +
                '</svg>';
            return styleURI(svgToDataURL(svg));
        };
        state.devices.forEach(d => {
            const lp = d.labelPosition || 'bottom';
            const labelPos = lp === 'top' ? 'verticalLabelPosition=top;verticalAlign=bottom;'
                : lp === 'left' ? 'labelPosition=left;align=right;verticalAlign=middle;'
                : lp === 'right' ? 'labelPosition=right;align=left;verticalAlign=middle;'
                : lp === 'center' ? 'verticalAlign=middle;'
                : lp === 'top-inside' ? 'verticalAlign=top;'
                : lp === 'bottom-inside' ? 'verticalAlign=bottom;'
                : 'verticalLabelPosition=bottom;verticalAlign=top;';
            const style = 'shape=image;html=1;imageAspect=0;labelBackgroundColor=none;' +
                'image=' + deviceIcon(d) + ';' + labelPos + fontStyle(d);
            emit(d.id, labelHTML(d.spans, d.label), style, rectGeo(d), null, d.fields);
        });

        // Text boxes
        state.textBoxes.forEach(tb => {
            const spans = tb.spans || [[{ text: tb.text || '', bold: false, italic: false }]];
            const est = measureSpansWidth(spans, tb.fontSize || 20, fontStackOf(tb)) + 16;
            const style = 'text;html=1;align=' + (tb.textAlign || 'left') + ';verticalAlign=top;' + fontStyle(tb);
            emit(tb.id, labelHTML(spans, tb.text), style,
                '<mxGeometry x="' + tb.x + '" y="' + tb.y + '" width="' + Math.ceil(est) +
                '" height="' + Math.ceil(spans.length * (tb.fontSize || 20) * 1.3 + 8) + '" as="geometry"/>');
        });

        // Connections: exact anchor fractions + our actual route as waypoints
        const nodeById = (id) => state.devices.find(d => d.id === id) ||
            state.zones.find(z => z.id === id) || state.images.find(i => i.id === id);
        state.connections.forEach(c => {
            const from = nodeById(c.fromDevice), to = nodeById(c.toDevice);
            const start = resolveConnEndpoint(c, 'from'), end = resolveConnEndpoint(c, 'to');
            if (!start || !end) return;
            let style = (c.routing === 'straight' ? 'edgeStyle=none;' : 'edgeStyle=orthogonalEdgeStyle;rounded=1;') +
                'html=1;strokeColor=' + (c.color || '#333333') + ';strokeWidth=' + (c.thickness || 2) + ';' +
                'startArrow=' + (ARROWS[c.startArrow] || 'none') + ';startFill=1;' +
                'endArrow=' + (ARROWS[c.endArrow] || 'none') + ';endFill=1;' +
                fontStyle(c);
            if (DASHES[c.dash]) style += 'dashed=1;dashPattern=' + DASHES[c.dash] + ';';
            const frac = (node, apIdx, prefix) => {
                const ap = node.attachmentPoints && node.attachmentPoints[apIdx];
                if (!ap) return '';
                return prefix + 'X=' + (ap.rx / node.w).toFixed(4) + ';' +
                       prefix + 'Y=' + (ap.ry / node.h).toFixed(4) + ';' +
                       prefix + 'Dx=0;' + prefix + 'Dy=0;';
            };
            if (from) style += frac(from, c.fromAP, 'exit');
            if (to) style += frac(to, c.toAP, 'entry');
            let geo = '<mxGeometry relative="1" as="geometry">';
            if (!from) geo += '<mxPoint x="' + start.x + '" y="' + start.y + '" as="sourcePoint"/>';
            if (!to) geo += '<mxPoint x="' + end.x + '" y="' + end.y + '" as="targetPoint"/>';
            if (c.routing !== 'straight') {
                const pts = connRoutePoints(c, start, end).slice(1, -1);
                if (pts.length) {
                    geo += '<Array as="points">' +
                        pts.map(p => '<mxPoint x="' + Math.round(p.x) + '" y="' + Math.round(p.y) + '"/>').join('') +
                        '</Array>';
                }
            }
            geo += '</mxGeometry>';
            const src = from ? ' source="' + from.id + '"' : '';
            const tgt = to ? ' target="' + to.id + '"' : '';
            cells.push('<mxCell id="' + c.id + '" value="' + labelHTML(c.spans, c.label) + '" style="' + xmlEsc(style) +
                '" edge="1" parent="1"' + src + tgt + '>' + geo + '</mxCell>');
            // Annotations ride as relative edge labels (x: -1..1 along the path)
            (c.annotations || []).forEach(a => {
                // Match on-canvas render: bold/italic/per-span colors + multi-line
                // via labelHTML (not flat xmlEsc), the ann.fontColor -> conn ink
                // color chain, the real default font size, and the font family.
                const aColor = a.fontColor || c.fontColor || c.color || '#333333';
                let aStyle = 'edgeLabel;html=1;resizable=0;fontSize=' + (a.fontSize || DEFAULT_FONT_SIZE) +
                    ';fontColor=' + aColor + ';';
                const aff = fontStackOf(a);
                if (aff) aStyle += 'fontFamily=' + aff.split(',')[0].replace(/["']/g, '').trim() + ';';
                cells.push('<mxCell id="' + c.id + '-' + a.id + '" value="' + labelHTML(a.spans, a.text) +
                    '" style="' + xmlEsc(aStyle) + '" vertex="1" connectable="0" parent="' + c.id + '">' +
                    '<mxGeometry x="' + ((a.position || 0.5) * 2 - 1).toFixed(3) +
                    '" relative="1" as="geometry"><mxPoint as="offset"/></mxGeometry></mxCell>');
            });
        });

        const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<mxfile host="app.diagrams.net" agent="CrossCanvas" version="24.0.0" type="device">' +
            '<diagram id="crosscanvas-1" name="' + xmlEsc(state.diagramTitle || 'Page-1') + '">' +
            '<mxGraphModel dx="1000" dy="700" grid="1" gridSize="20" guides="1" tooltips="1" connect="1" ' +
            'arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0">' +
            '<root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
            cells.join('') +
            '</root></mxGraphModel></diagram></mxfile>';
        triggerDownload(new Blob([xml], { type: 'application/xml' }), sanitizedTitle() + '.drawio');
    }

    // Raster/PDF export ('png' | 'jpeg' | 'pdf'), always cropped to content
    // bounds. (Formerly exportJPEG with a dead un-cropped branch and a dead
    // confirm() fallback - every caller passed explicit arguments.)
    function exportRaster(format, showGrid, transparent) {
        // Hidden tiers export as displayed (WYSIWYG); locked tiers are visible
        // and export normally. Devices and text boxes draw in their shared
        // stacking order, matching the canvas.
        const expZones = tierHidden('zones') ? [] : state.zones;
        const expConns = tierHidden('connections') ? [] : state.connections;
        const expImages = tierHidden('images') ? [] : state.images;
        const expDevLayer = tierHidden('devices') ? [] : deviceLayerStack();
        const expDevSet = new Set(state.devices);
        const bounds = getContentBounds();
        if (!bounds) return;
        const pad = 40;
        const offX = bounds.minX - pad;
        const offY = bounds.minY - pad;
        const cWidth = bounds.maxX - bounds.minX + pad * 2;
        const cHeight = bounds.maxY - bounds.minY + pad * 2;

        // Image Scale (Export menu): the canvas gets s-times the pixels while
        // every draw below keeps thinking in diagram coordinates. Browsers
        // silently zero out canvases past ~16384px per side (lower on some
        // Safari versions), so clamp the effective scale to what the board
        // fits - a big diagram at 4x exports at the largest scale that works
        // instead of producing nothing.
        const MAX_CANVAS_DIM = 16384;
        const scale = Math.min(EXPORT_SCALE,
            MAX_CANVAS_DIM / Math.max(cWidth, cHeight));
        const c = document.createElement('canvas');
        c.width = Math.floor(cWidth * scale);
        c.height = Math.floor(cHeight * scale);
        const ctx = c.getContext('2d');

        ctx.scale(scale, scale);
        ctx.translate(-offX, -offY);

        // White background - skipped for a transparent PNG so the diagram can
        // be laid over any backdrop. (Only PNG carries alpha; JPEG/PDF ignore
        // the flag and stay white.)
        if (!(transparent && format === 'png')) {
            ctx.fillStyle = 'white';
            ctx.fillRect(offX, offY, cWidth, cHeight);
        }

        // Draw grid - at the VISIBLE spacing (20px), not the snap step: halving
        // GRID_SIZE to 10 must not make exports busier than the on-screen grid.
        if (showGrid) {
            ctx.strokeStyle = '#e0e0e0';
            ctx.lineWidth = 0.5;
            const gridStartX = Math.floor(offX / VISIBLE_GRID) * VISIBLE_GRID;
            const gridStartY = Math.floor(offY / VISIBLE_GRID) * VISIBLE_GRID;
            for (let x = gridStartX; x <= offX + cWidth; x += VISIBLE_GRID) {
                ctx.beginPath(); ctx.moveTo(x, offY); ctx.lineTo(x, offY + cHeight); ctx.stroke();
            }
            for (let y = gridStartY; y <= offY + cHeight; y += VISIBLE_GRID) {
                ctx.beginPath(); ctx.moveTo(offX, y); ctx.lineTo(offX + cWidth, y); ctx.stroke();
            }
        }

        // Draw zones. Opacity fades the FILL only - the border stays solid,
        // matching the canvas renderer (fill-opacity on the shape).
        expZones.forEach(zone => {
            ctx.save();
            ctx.fillStyle = zone.fill;
            ctx.strokeStyle = zone.borderColor;
            ctx.lineWidth = 2;
            if (zone.shape === 'ellipse') {
                ctx.beginPath();
                ctx.ellipse(zone.x + zone.w / 2, zone.y + zone.h / 2, zone.w / 2, zone.h / 2, 0, 0, Math.PI * 2);
                ctx.globalAlpha = zone.opacity;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.stroke();
            } else if (zone.shape === 'diamond') {
                ctx.beginPath();
                ctx.moveTo(zone.x + zone.w / 2, zone.y);
                ctx.lineTo(zone.x + zone.w, zone.y + zone.h / 2);
                ctx.lineTo(zone.x + zone.w / 2, zone.y + zone.h);
                ctx.lineTo(zone.x, zone.y + zone.h / 2);
                ctx.closePath();
                ctx.globalAlpha = zone.opacity;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.stroke();
            } else if (zone.shape === 'parallelogram') {
                const k = parallelogramSkew(zone.w);
                ctx.beginPath();
                ctx.moveTo(zone.x + k, zone.y);
                ctx.lineTo(zone.x + zone.w, zone.y);
                ctx.lineTo(zone.x + zone.w - k, zone.y + zone.h);
                ctx.lineTo(zone.x, zone.y + zone.h);
                ctx.closePath();
                ctx.globalAlpha = zone.opacity;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.stroke();
            } else if (zone.shape === 'pill') {
                ctx.beginPath();
                ctx.roundRect(zone.x, zone.y, zone.w, zone.h, zone.h / 2);
                ctx.globalAlpha = zone.opacity;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.stroke();
            } else if (zone.shape === 'document') {
                const dy = documentWave(zone.h);
                ctx.beginPath();
                ctx.moveTo(zone.x, zone.y);
                ctx.lineTo(zone.x + zone.w, zone.y);
                ctx.lineTo(zone.x + zone.w, zone.y + zone.h - dy / 2);
                ctx.quadraticCurveTo(zone.x + zone.w * 0.75, zone.y + zone.h - dy,
                    zone.x + zone.w / 2, zone.y + zone.h - dy / 2);
                ctx.quadraticCurveTo(zone.x + zone.w * 0.25, zone.y + zone.h,
                    zone.x, zone.y + zone.h - dy / 2);
                ctx.closePath();
                ctx.globalAlpha = zone.opacity;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.stroke();
            } else if (zone.shape === 'cylinder') {
                const e2 = cylinderCap(zone.h);
                const cx2 = zone.x + zone.w / 2;
                ctx.beginPath();
                ctx.ellipse(cx2, zone.y + e2, zone.w / 2, e2, 0, Math.PI, 0);
                ctx.lineTo(zone.x + zone.w, zone.y + zone.h - e2);
                ctx.ellipse(cx2, zone.y + zone.h - e2, zone.w / 2, e2, 0, 0, Math.PI);
                ctx.closePath();
                ctx.globalAlpha = zone.opacity;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.stroke();
                // top-cap rim line
                ctx.beginPath();
                ctx.ellipse(cx2, zone.y + e2, zone.w / 2, e2, 0, 0, Math.PI);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.rect(zone.x, zone.y, zone.w, zone.h);
                ctx.globalAlpha = zone.opacity;
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.stroke();
            }
            if (zone.label) {
                // Match renderZone: the opacity boost only applies to a label
                // with NO explicit fontColor (it rides the faded fill); a
                // custom-colored label renders fully opaque, on screen AND here.
                ctx.globalAlpha = !zone.fontColor ? Math.min(1, zone.opacity + 0.4) : 1;
                drawObjLabelToCanvas(ctx, zone, zone.borderColor);
            }
            ctx.restore();
        });

        // Draw pasted images
        const pastedImagePromises = expImages.map(img => {
            return new Promise((resolve) => {
                const el = new Image();
                el.crossOrigin = 'anonymous';
                el.onload = () => resolve({ img, el });
                el.onerror = () => resolve({ img, el: null });
                el.src = img.dataURL;
            });
        });

        // Draw connections
        expConns.forEach(conn => {
            const start = resolveConnEndpoint(conn, 'from');
            const end = resolveConnEndpoint(conn, 'to');
            if (!start || !end) return;

            const points = connRoutePoints(conn, start, end);

            // Trim ends for arrow markers (mirrors renderConnection) and record
            // the original tips so the arrowheads can be drawn at them.
            const startArrow = conn.startArrow || 'none';
            const endArrow = conn.endArrow || 'none';
            const origStart = { x: points[0].x, y: points[0].y };
            const origEnd = { x: points[points.length - 1].x, y: points[points.length - 1].y };
            let startMarkerSize = 0, endMarkerSize = 0;
            if (startArrow !== 'none' && points.length >= 2) {
                startMarkerSize = trimPointsForMarker(points, arrowSizeFor(conn, startArrow), true);
            }
            if (endArrow !== 'none' && points.length >= 2) {
                endMarkerSize = trimPointsForMarker(points, arrowSizeFor(conn, endArrow), false);
            }

            ctx.strokeStyle = conn.color;
            ctx.lineWidth = conn.thickness;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            const dash = getDashArray(conn.dash, conn.thickness);
            ctx.setLineDash(dash === 'none' ? [] : dash.split(' ').map(Number));

            if (conn.routing === 'rounded' && points.length > 2) {
                ctx.beginPath();
                ctx.moveTo(points[0].x, points[0].y);
                const radius = 10;
                for (let i = 1; i < points.length - 1; i++) {
                    const prev = points[i - 1], curr = points[i], next = points[i + 1];
                    const d1x = curr.x - prev.x, d1y = curr.y - prev.y;
                    const d2x = next.x - curr.x, d2y = next.y - curr.y;
                    const len1 = Math.sqrt(d1x * d1x + d1y * d1y);
                    const len2 = Math.sqrt(d2x * d2x + d2y * d2y);
                    const r = Math.min(radius, len1 / 2, len2 / 2);
                    ctx.lineTo(curr.x - (d1x / len1) * r, curr.y - (d1y / len1) * r);
                    ctx.quadraticCurveTo(curr.x, curr.y, curr.x + (d2x / len2) * r, curr.y + (d2y / len2) * r);
                }
                ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.moveTo(points[0].x, points[0].y);
                for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
                ctx.stroke();
            }
            ctx.setLineDash([]);

            // Draw the arrowheads the SVG markers produce on the canvas: the
            // marker occupies the trimmed gap, tip at the original endpoint.
            const drawArrowhead = (type, tip, base, size) => {
                let dx = tip.x - base.x, dy = tip.y - base.y;
                const len = Math.hypot(dx, dy);
                if (len < 0.5) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
                const px = -dy, py = dx;                     // perpendicular
                const w = size * 2 / Math.sqrt(3);           // equilateral, matches the SVG marker
                ctx.fillStyle = conn.color;
                ctx.strokeStyle = conn.color;
                if (type === 'arrow' || type === 'open-arrow') {
                    const bx1 = tip.x - dx * size + px * w / 2, by1 = tip.y - dy * size + py * w / 2;
                    const bx2 = tip.x - dx * size - px * w / 2, by2 = tip.y - dy * size - py * w / 2;
                    ctx.beginPath();
                    if (type === 'arrow') {
                        ctx.moveTo(tip.x, tip.y); ctx.lineTo(bx1, by1); ctx.lineTo(bx2, by2);
                        ctx.closePath(); ctx.fill();
                    } else {
                        ctx.lineWidth = Math.max(1.5, size / 9);
                        ctx.moveTo(bx1, by1); ctx.lineTo(tip.x, tip.y); ctx.lineTo(bx2, by2);
                        ctx.stroke();
                    }
                } else if (type === 'diamond') {
                    const mx2 = tip.x - dx * size / 2, my2 = tip.y - dy * size / 2;
                    ctx.beginPath();
                    ctx.moveTo(tip.x, tip.y);
                    ctx.lineTo(mx2 + px * size / 2, my2 + py * size / 2);
                    ctx.lineTo(tip.x - dx * size, tip.y - dy * size);
                    ctx.lineTo(mx2 - px * size / 2, my2 - py * size / 2);
                    ctx.closePath(); ctx.fill();
                } else if (type === 'circle') {
                    ctx.beginPath();
                    ctx.arc(tip.x - dx * size / 2, tip.y - dy * size / 2, size / 2 - 0.5, 0, Math.PI * 2);
                    ctx.fill();
                }
            };
            if (startArrow !== 'none' && startMarkerSize > 2) drawArrowhead(startArrow, origStart, points[0], startMarkerSize);
            if (endArrow !== 'none' && endMarkerSize > 2) drawArrowhead(endArrow, origEnd, points[points.length - 1], endMarkerSize);

            if (conn.label) {
                const mid = Math.floor(points.length / 2);
                let mx, my;
                if (points.length % 2 === 0) {
                    mx = (points[mid - 1].x + points[mid].x) / 2;
                    my = (points[mid - 1].y + points[mid].y) / 2;
                } else {
                    mx = points[mid].x;
                    my = points[mid].y;
                }
                const cfs = conn.fontSize || 20;
                const cFamily = ctxFamilyOf(conn);
                const cSpans = conn.spans || [[{ text: conn.label, bold: false, italic: false }]];
                const cLineH = cfs * 1.3;

                const lp = conn.labelPosition || 'top';
                let tx = mx, ty = my, align = 'center';
                switch (lp) {
                    case 'top':    ty = my - cfs / 2 - 4; break;
                    case 'bottom': ty = my + cfs + 4; break;
                    case 'left':   tx = mx - 8; align = 'right'; ty = my + cfs / 3; break;
                    case 'right':  tx = mx + 8; align = 'left'; ty = my + cfs / 3; break;
                    case 'center': ty = my + cfs / 3; break;
                }

                let maxTextW = 0;
                cSpans.forEach(lineSpans => {
                    let lineW = 0;
                    lineSpans.forEach(span => {
                        let fStr = `${cfs}px ${cFamily}`;
                        if (span.italic) fStr = 'italic ' + fStr;
                        if (span.bold) fStr = 'bold ' + fStr;
                        ctx.font = fStr;
                        lineW += ctx.measureText(span.text).width;
                    });
                    maxTextW = Math.max(maxTextW, lineW);
                });
                const pad = 3;
                const cValign = conn.labelVAlign || 'top';
                const cVertOff = -getVAlignOffset(cValign, cSpans.length, cLineH);
                let bgX;
                if (align === 'right') bgX = tx - maxTextW - pad;
                else if (align === 'left') bgX = tx - pad;
                else bgX = tx - maxTextW / 2 - pad;
                const bgY = ty - cfs - pad + 2 - cVertOff;

                ctx.fillStyle = 'white';
                ctx.globalAlpha = 0.85;
                ctx.fillRect(bgX, bgY, maxTextW + pad * 2, cSpans.length * cLineH + pad * 2 + 2);
                ctx.globalAlpha = 1;

                const connFillColor = conn.fontColor || conn.color;
                // Explicit justification (labelAlign) re-anchors lines inside
                // the block; the block itself stays where the position put it.
                const cExplicit = conn.labelAlign && conn.labelAlign !== 'auto' && cSpans.length > 1 ? conn.labelAlign : null;
                const cBlockLeft = align === 'center' ? tx - maxTextW / 2 :
                                   align === 'right' ? tx - maxTextW : tx;
                cSpans.forEach((lineSpans, i) => {
                    const y = ty + i * cLineH - cVertOff;
                    let totalW = 0;
                    lineSpans.forEach(span => {
                        let fStr = `${cfs}px ${cFamily}`;
                        if (span.italic) fStr = 'italic ' + fStr;
                        if (span.bold) fStr = 'bold ' + fStr;
                        ctx.font = fStr;
                        totalW += ctx.measureText(span.text).width;
                    });
                    let startX;
                    if (cExplicit === 'left') startX = cBlockLeft;
                    else if (cExplicit === 'right') startX = cBlockLeft + maxTextW - totalW;
                    else if (cExplicit === 'center') startX = cBlockLeft + (maxTextW - totalW) / 2;
                    else if (align === 'center') startX = tx - totalW / 2;
                    else if (align === 'right') startX = tx - totalW;
                    else startX = tx;
                    lineSpans.forEach(span => {
                        let fStr = `${cfs}px ${cFamily}`;
                        if (span.italic) fStr = 'italic ' + fStr;
                        if (span.bold) fStr = 'bold ' + fStr;
                        ctx.font = fStr;
                        ctx.textAlign = 'left';
                        ctx.fillStyle = (span.color && isSafeCSSColor(span.color)) ? span.color : connFillColor;
                        ctx.fillText(span.text, startX, y);
                        startX += ctx.measureText(span.text).width;
                    });
                });
            }

            // Draw connection annotations
            if (conn.annotations && conn.annotations.length > 0) {
                conn.annotations.forEach(ann => {
                    const annPos = getPointAlongPath(points, ann.position);
                    const annFs = ann.fontSize || DEFAULT_FONT_SIZE;
                    const annSpans = ann.spans || [[{ text: ann.text || '', bold: false, italic: false }]];
                    const annLineH = annFs * 1.3;
                    const annColor = ann.fontColor || conn.fontColor || conn.color;
                    const aFamily = ctxFamilyOf(ann);

                    // Measure widest line for the background box
                    let annMaxW = 0;
                    annSpans.forEach(lineSpans => {
                        let lineW = 0;
                        lineSpans.forEach(span => {
                            let fStr = `${annFs}px ${aFamily}`;
                            if (span.italic) fStr = 'italic ' + fStr;
                            if (span.bold) fStr = 'bold ' + fStr;
                            ctx.font = fStr;
                            lineW += ctx.measureText(span.text).width;
                        });
                        annMaxW = Math.max(annMaxW, lineW);
                    });
                    annMaxW = Math.max(annMaxW, 20);   // min pill width, matching render + bounds

                    const annPad = 3;
                    ctx.fillStyle = 'white';
                    ctx.globalAlpha = 0.85;
                    ctx.fillRect(annPos.x - annMaxW / 2 - annPad, annPos.y - annFs - annPad,
                        annMaxW + annPad * 2, annSpans.length * annLineH + annPad * 2 + 2);
                    ctx.globalAlpha = 1;

                    const annExplicit = ann.align && ann.align !== 'center' && annSpans.length > 1 ? ann.align : null;
                    const annBlockLeft = annPos.x - annMaxW / 2;
                    annSpans.forEach((lineSpans, i) => {
                        const y = annPos.y + i * annLineH;
                        let lineW = 0;
                        lineSpans.forEach(span => {
                            let fStr = `${annFs}px ${aFamily}`;
                            if (span.italic) fStr = 'italic ' + fStr;
                            if (span.bold) fStr = 'bold ' + fStr;
                            ctx.font = fStr;
                            lineW += ctx.measureText(span.text).width;
                        });
                        let startX = annExplicit === 'left' ? annBlockLeft :
                                     annExplicit === 'right' ? annBlockLeft + annMaxW - lineW :
                                     annPos.x - lineW / 2;
                        lineSpans.forEach(span => {
                            let fStr = `${annFs}px ${aFamily}`;
                            if (span.italic) fStr = 'italic ' + fStr;
                            if (span.bold) fStr = 'bold ' + fStr;
                            ctx.font = fStr;
                            ctx.textAlign = 'left';
                            ctx.fillStyle = (span.color && isSafeCSSColor(span.color)) ? span.color : annColor;
                            ctx.fillText(span.text, startX, y);
                            startX += ctx.measureText(span.text).width;
                        });
                    });
                });
            }
        });

        // Draw devices (load images then draw)
        const imagePromises = expDevLayer.filter(o => expDevSet.has(o)).map(device => {
            return new Promise((resolve) => {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                img.onload = () => resolve({ device, img });
                img.onerror = () => resolve({ device, img: null });
                img.src = device.image;
            });
        });

        Promise.all(pastedImagePromises).then(piResults => {
            piResults.forEach(({ img, el }) => {
                if (!el) return;
                ctx.drawImage(el, img.x, img.y, img.w, img.h);
                drawObjLabelToCanvas(ctx, img, '#333');
            });
            return Promise.all(imagePromises);
        }).then(results => {
            const imgByDevice = new Map(results.map(r => [r.device, r.img]));
            const drawDeviceNode = (device) => {
                const img = imgByDevice.get(device);
                // Mirror renderDevice's app-drawn stencil frame
                const frameW = Math.max(1.5, Math.min(device.w, device.h) * 16 / 300);
                const frameR = Math.max(2, Math.min(device.w, device.h) * 30 / 300 - frameW / 2);
                ctx.fillStyle = device.iconBg || 'rgb(255,254,254)';
                ctx.strokeStyle = device.tintColor || STENCIL_FRAME_BLUE;
                ctx.lineWidth = frameW;
                ctx.beginPath();
                ctx.roundRect(device.x + frameW / 2, device.y + frameW / 2,
                    device.w - frameW, device.h - frameW, frameR);
                ctx.fill();
                ctx.stroke();

                if (img) {
                    ctx.drawImage(img, device.x, device.y, device.w, device.h);
                }

                drawObjLabelToCanvas(ctx, device, '#333');
            };

            const drawTextBoxNode = (tb) => {
                const fs = tb.fontSize || 20;
                const tFamily = ctxFamilyOf(tb);
                const tbSpans = tb.spans || [[{ text: tb.text || '', bold: false, italic: false }]];
                const lineH = fs * 1.3;
                const align = tb.textAlign || 'left';

                // Measure max width for alignment
                let maxW = 0;
                tbSpans.forEach(lineSpans => {
                    let lineW = 0;
                    lineSpans.forEach(span => {
                        let fStr = `${fs}px ${tFamily}`;
                        if (span.italic) fStr = 'italic ' + fStr;
                        if (span.bold) fStr = 'bold ' + fStr;
                        ctx.font = fStr;
                        lineW += ctx.measureText(span.text || ' ').width;
                    });
                    maxW = Math.max(maxW, lineW);
                });
                const padX = 8;
                const boxW = maxW + padX * 2;

                tbSpans.forEach((lineSpans, i) => {
                    const y = tb.y + 4 + fs + i * lineH;
                    let baseX;
                    if (align === 'center') baseX = tb.x + boxW / 2;
                    else if (align === 'right') baseX = tb.x + boxW - padX;
                    else baseX = tb.x + padX;

                    if (align === 'center' || align === 'right') {
                        let totalW = 0;
                        lineSpans.forEach(span => {
                            let fStr = `${fs}px ${tFamily}`;
                            if (span.italic) fStr = 'italic ' + fStr;
                            if (span.bold) fStr = 'bold ' + fStr;
                            ctx.font = fStr;
                            totalW += ctx.measureText(span.text).width;
                        });
                        let startX = align === 'center' ? baseX - totalW / 2 : baseX - totalW;
                        lineSpans.forEach(span => {
                            let fStr = `${fs}px ${tFamily}`;
                            if (span.italic) fStr = 'italic ' + fStr;
                            if (span.bold) fStr = 'bold ' + fStr;
                            ctx.font = fStr;
                            ctx.textAlign = 'left';
                            ctx.fillStyle = (span.color && isSafeCSSColor(span.color)) ? span.color : (tb.fontColor || '#333333');
                            ctx.fillText(span.text, startX, y);
                            startX += ctx.measureText(span.text).width;
                        });
                    } else {
                        let currentX = baseX;
                        lineSpans.forEach(span => {
                            let fStr = `${fs}px ${tFamily}`;
                            if (span.italic) fStr = 'italic ' + fStr;
                            if (span.bold) fStr = 'bold ' + fStr;
                            ctx.font = fStr;
                            ctx.textAlign = 'left';
                            ctx.fillStyle = (span.color && isSafeCSSColor(span.color)) ? span.color : (tb.fontColor || '#333333');
                            ctx.fillText(span.text, currentX, y);
                            currentX += ctx.measureText(span.text).width;
                        });
                    }
                });
            };

            expDevLayer.forEach(node => expDevSet.has(node) ? drawDeviceNode(node) : drawTextBoxNode(node));

            if (format === 'pdf') {
                exportCanvasToPDF(c, scale);
                return;
            }
            const isPng = format === 'png';
            c.toBlob((blob) => {
                // A null blob means the canvas was unusable (out of memory /
                // over a limit the clamp didn't anticipate) - say so instead
                // of throwing inside the callback with no visible effect.
                if (!blob) {
                    showDialog({ title: 'Export failed',
                        body: 'The browser could not produce the image - the board may be too large at this Image Scale. Try a lower scale (Export → Image Scale).' });
                    return;
                }
                triggerDownload(blob, sanitizedTitle() + (isPng ? '.png' : '.jpg'));
            }, isPng ? 'image/png' : 'image/jpeg', isPng ? undefined : 0.95);
        });
    }

    // --- Add some default device templates ---
    function svgToDataURL(svg) {
        return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    }

    // --- Inline Canvas Text Editing ---
    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // A span color is only ever emitted into markup if it looks like a plain
    // color literal - spans loaded from files are untrusted.
    function isSafeCSSColor(c) {
        return typeof c === 'string' && /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\))$/.test(c.trim());
    }

    function spansToHTML(spans) {
        return spans.map(lineSpans => {
            return lineSpans.map(s => {
                let html = escapeHTML(s.text);
                if (s.bold && s.italic) html = '<b><i>' + html + '</i></b>';
                else if (s.bold) html = '<b>' + html + '</b>';
                else if (s.italic) html = '<i>' + html + '</i>';
                if (s.color && isSafeCSSColor(s.color)) {
                    html = '<span style="color:' + s.color.trim() + '">' + html + '</span>';
                }
                return html;
            }).join('');
        }).join('<br>');
    }

    function htmlToSpans(html) {
        // Parse with DOMParser rather than innerHTML so untrusted HTML (e.g. from
        // an imported Gliffy label) is inert: no scripts run, no inline event
        // handlers fire, and no subresources load. We only read text + bold/italic.
        const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
        const tmp = doc.body;

        // Normalize: browsers may wrap lines in <div>s or use <br>
        // First, convert the innerHTML to a flat structure of lines
        const lines = [];
        let currentLine = [];

        function hasBold(node) {
            if (!node || node.nodeType !== 1) return false;
            const tag = node.tagName;
            if (tag === 'B' || tag === 'STRONG') return true;
            const fw = node.style && node.style.fontWeight;
            if (fw === 'bold' || parseInt(fw) >= 700) return true;
            return node.parentElement ? hasBold(node.parentElement) : false;
        }

        function hasItalic(node) {
            if (!node || node.nodeType !== 1) return false;
            const tag = node.tagName;
            if (tag === 'I' || tag === 'EM') return true;
            const fs = node.style && node.style.fontStyle;
            if (fs === 'italic') return true;
            return node.parentElement ? hasItalic(node.parentElement) : false;
        }

        // Nearest ancestor color (inline style or legacy <font color>) - lets
        // a single label mix colors, e.g. a Gliffy legend of colored link
        // names. Null = inherit the label's fontColor.
        function spanColor(node) {
            if (!node || node.nodeType !== 1) return null;
            const c = node.style && node.style.color;
            if (c) return c;
            if (node.tagName === 'FONT' && node.getAttribute('color')) return node.getAttribute('color');
            return node.parentElement ? spanColor(node.parentElement) : null;
        }

        function walkNode(node) {
            if (node.nodeType === 3) {
                // Text node - split on newlines to handle \n in pre-wrap content
                const text = node.textContent;
                if (text.length === 0) return;
                const bold = hasBold(node.parentElement);
                const italic = hasItalic(node.parentElement);
                const color = spanColor(node.parentElement);
                const parts = text.split('\n');
                parts.forEach((part, idx) => {
                    if (idx > 0) {
                        lines.push(currentLine);
                        currentLine = [];
                    }
                    if (part.length > 0) {
                        const span = { text: part, bold: bold, italic: italic };
                        if (color) span.color = color;
                        currentLine.push(span);
                    }
                });
                return;
            }
            if (node.nodeType !== 1) return;
            const tag = node.tagName;
            if (tag === 'BR') {
                lines.push(currentLine);
                currentLine = [];
                return;
            }
            if (tag === 'DIV' || tag === 'P') {
                // If currentLine has content, push it as a line
                if (currentLine.length > 0) {
                    lines.push(currentLine);
                    currentLine = [];
                }
                for (const child of node.childNodes) {
                    walkNode(child);
                }
                if (currentLine.length > 0) {
                    lines.push(currentLine);
                    currentLine = [];
                }
                return;
            }
            for (const child of node.childNodes) {
                walkNode(child);
            }
        }

        for (const child of tmp.childNodes) {
            walkNode(child);
        }
        if (currentLine.length > 0) {
            lines.push(currentLine);
        }

        // Merge adjacent spans with same formatting
        const result = lines.map(lineSpans => {
            if (lineSpans.length === 0) return [{ text: '', bold: false, italic: false }];
            const merged = [lineSpans[0]];
            for (let i = 1; i < lineSpans.length; i++) {
                const prev = merged[merged.length - 1];
                const cur = lineSpans[i];
                if (prev.bold === cur.bold && prev.italic === cur.italic) {
                    prev.text += cur.text;
                } else {
                    merged.push(cur);
                }
            }
            return merged;
        });

        return result.length > 0 ? result : [[{ text: '', bold: false, italic: false }]];
    }

    function commitInlineEdit() {
        if (!state.inlineEditing) return;
        const { type, id, element, labelField } = state.inlineEditing;
        const html = element.innerHTML;
        const newSpans = htmlToSpans(html);
        const plainText = getPlainText(newSpans);

        // Handle annotation type separately
        if (type === 'annotation') {
            const conn = state.connections.find(c => c.id === id);
            if (conn && conn.annotations) {
                const annId = state.inlineEditing.annotationId;
                const annIdx = conn.annotations.findIndex(a => a.id === annId);
                if (annIdx !== -1) {
                    if (plainText.trim() === '') {
                        // Remove empty annotation
                        pushUndo();
                        conn.annotations.splice(annIdx, 1);
                    } else {
                        pushUndo();
                        conn.annotations[annIdx].spans = newSpans;
                        conn.annotations[annIdx].text = plainText;
                    }
                    renderConnection(conn);
                }
            }
            element.remove();
            state.inlineEditing = null;
            return;
        }

        let obj;
        if (type === 'device') obj = state.devices.find(d => d.id === id);
        else if (type === 'zone') obj = state.zones.find(z => z.id === id);
        else if (type === 'connection') obj = state.connections.find(c => c.id === id);
        else if (type === 'textbox') obj = state.textBoxes.find(t => t.id === id);

        if (obj) {
            pushUndo();
            obj.spans = newSpans;
            obj[labelField] = plainText;
            obj.lineFormats = newSpans.map(lineSpans => {
                const allBold = lineSpans.length > 0 && lineSpans.every(s => s.bold);
                const allItalic = lineSpans.length > 0 && lineSpans.every(s => s.italic);
                return { bold: allBold, italic: allItalic };
            });

            // Re-render
            if (type === 'device') renderDevice(obj);
            else if (type === 'zone') renderZone(obj);
            else if (type === 'connection') renderConnection(obj);
            else if (type === 'textbox') renderTextBox(obj);

            // Update sidebar rich editor if this element is selected
            const sidebarHTML = spansToHTML(newSpans);
            if (type === 'device' && state.selectedDevice === id) {
                document.getElementById('device-label').innerHTML = sidebarHTML;
            } else if (type === 'zone' && state.selectedZone === id) {
                document.getElementById('zone-label').innerHTML = sidebarHTML;
            } else if (type === 'connection' && state.selectedConnection === id) {
                document.getElementById('conn-label').innerHTML = sidebarHTML;
            } else if (type === 'textbox' && state.selectedTextBox === id) {
                document.getElementById('textbox-text').innerHTML = sidebarHTML;
            }
        }

        element.remove();
        state.inlineEditing = null;
    }

    function cancelInlineEdit() {
        if (!state.inlineEditing) return;
        const { type, id, annotationId } = state.inlineEditing;
        state.inlineEditing.element.remove();
        if (type === 'annotation') {
            // If cancelling a new empty annotation, remove it
            const conn = state.connections.find(c => c.id === id);
            if (conn && conn.annotations) {
                const ann = conn.annotations.find(a => a.id === annotationId);
                if (ann && (!ann.text || ann.text.trim() === '')) {
                    conn.annotations = conn.annotations.filter(a => a.id !== annotationId);
                }
                renderConnection(conn);
            }
            state.inlineEditing = null;
        } else {
            state.inlineEditing = null;
            showOriginalLabel(type, id);
        }
    }

    function hideOriginalLabel(type, id) {
        if (type === 'device') {
            const node = document.getElementById(id);
            if (node) node.querySelectorAll('text').forEach(t => t.style.display = 'none');
        } else if (type === 'textbox') {
            const node = document.getElementById(id);
            if (node) node.querySelectorAll('text').forEach(t => t.style.display = 'none');
        } else if (type === 'zone') {
            const node = document.getElementById(id);
            if (node) node.querySelectorAll('text').forEach(t => t.style.display = 'none');
        } else if (type === 'connection') {
            const node = document.getElementById(id);
            if (node) {
                node.querySelectorAll('.connection-label, .connection-label-bg').forEach(el => el.style.display = 'none');
            }
        }
    }

    function showOriginalLabel(type, id) {
        const node = document.getElementById(id);
        if (!node) return;
        if (type === 'connection') {
            node.querySelectorAll('.connection-label, .connection-label-bg').forEach(el => el.style.display = '');
        } else {
            node.querySelectorAll('text').forEach(t => t.style.display = '');
        }
    }

    function startInlineEdit(type, id, obj, labelField, svgX, svgY, fontSize, align, anchorCenter) {
        if (state.inlineEditing) {
            commitInlineEdit();
        }

        const container = document.getElementById('canvas-container');
        const canvasRect = canvas.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // Convert SVG (user) coordinates to container CONTENT coordinates,
        // accounting for zoom only: the editor is an absolutely-positioned
        // child of the scroll container, so it lives in (and scrolls with)
        // the content space - subtracting scrollLeft/Top here displaced the
        // editor by exactly the scroll amount on big scrolled boards.
        const z = state.zoom;
        const pixelX = svgX * z;
        const pixelY = svgY * z;

        const div = document.createElement('div');
        div.className = 'inline-editor';
        div.contentEditable = 'true';
        div.style.fontSize = ((fontSize || 20) * z) + 'px';
        div.style.textAlign = align || 'left';
        const editFf = fontStackOf(obj);
        if (editFf) div.style.fontFamily = editFf;

        if (anchorCenter) {
            // Position so the editor is centered on svgX
            div.style.left = pixelX + 'px';
            div.style.top = pixelY + 'px';
            div.style.transform = 'translateX(-50%)';
        } else {
            div.style.left = pixelX + 'px';
            div.style.top = pixelY + 'px';
        }

        // Hide the original SVG label while editing
        hideOriginalLabel(type, id);

        // Populate with HTML from spans
        const spans = obj.spans || [[{ text: obj[labelField] || '', bold: false, italic: false }]];
        div.innerHTML = spansToHTML(spans);

        state.inlineEditing = { type, id, element: div, labelField };

        container.appendChild(div);
        div.focus();

        // Select all text
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(div);
        sel.removeAllRanges();
        sel.addRange(range);

        // Handle keydown for Escape, Enter, and formatting shortcuts
        div.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancelInlineEdit();
            } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                commitInlineEdit();
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
                e.preventDefault();
                e.stopPropagation();
                document.execCommand('bold');
            } else if ((e.ctrlKey || e.metaKey) && e.key === 'i') {
                e.preventDefault();
                e.stopPropagation();
                document.execCommand('italic');
            }
        });

        // Handle blur
        div.addEventListener('blur', () => {
            // Use setTimeout to allow click events to fire first
            setTimeout(() => {
                if (state.inlineEditing && state.inlineEditing.element === div) {
                    commitInlineEdit();
                }
            }, 100);
        });
    }

    function handleCanvasDblClick(point) {
        // Use coordinate hit-testing (DOM elements may have been recreated by selectDevice on mousedown)
        const onConnectionLine = (p) => state.connections.some(conn => {
            const s = resolveConnEndpoint(conn, 'from');
            const e = resolveConnEndpoint(conn, 'to');
            if (!s || !e) return false;
            return getNearestT(connRoutePoints(conn, s, e), p.x, p.y).distance < 15;
        });
        const lineHit = onConnectionLine(point);

        // Approximate bounding box of an object's rendered label text, using
        // the same anchor/valign geometry the renderer uses.
        const labelTextBBox = (obj, defaultPos) => {
            if (!obj.label) return null;
            const fs = obj.fontSize || 20;
            const spans = obj.spans || [[{ text: obj.label, bold: false, italic: false }]];
            const pos = obj.labelPosition || defaultPos;
            const anchor = getLabelAnchor(pos, obj.w, obj.h, fs);
            const lineH = fs * 1.3;
            const vOffset = getVAlignOffset(effectiveVAlign(pos, obj.labelVAlign), spans.length, lineH);
            // Measure the real rendered width (renderConnection/label use the
            // same measureSpansWidth) - the old maxLen*fs*0.6 estimate mis-sized
            // bold/wide/CJK/custom-font labels, so the hit-test stole or dropped
            // double-clicks meant for the label vs the line beneath it.
            const w = Math.max(24, measureSpansWidth(spans, fs, fontStackOf(obj)));
            let left = obj.x + anchor.x;
            if (anchor.anchor === 'middle') left -= w / 2;
            else if (anchor.anchor === 'end') left -= w;
            const top = obj.y + anchor.y + vOffset - fs;
            return { left: left - 4, right: left + w + 4, top: top - 2, bottom: top + spans.length * lineH + 4 };
        };
        const inBBox = (bb) => !!bb && point.x >= bb.left && point.x <= bb.right &&
            point.y >= bb.top && point.y <= bb.bottom;

        // Check for device. The ±40 padding lets a double-click land on the
        // device's label (which renders just outside the body). But vertical
        // connections exit through exactly that band, so when a connection line
        // is under the cursor the padding only claims the click if it is on the
        // label text itself - otherwise the line stays annotatable. Clicks on
        // the device body always win.
        const device = state.devices.find(d => {
            const inBody = point.x >= d.x && point.x <= d.x + d.w && point.y >= d.y && point.y <= d.y + d.h;
            if (inBody) return true;
            const inPad = point.x >= d.x && point.x <= d.x + d.w && point.y >= d.y - 40 && point.y <= d.y + d.h + 40;
            if (!inPad) return false;
            return !lineHit || inBBox(labelTextBBox(d, 'bottom'));
        });
        if (device) {
            if (!device.label) device.label = '';
            if (!device.spans) device.spans = [[{ text: '', bold: false, italic: false }]];
            const fs = device.fontSize || 20;
            const anchor = getLabelAnchor(device.labelPosition || 'bottom', device.w, device.h, fs);
            const lineHeight = fs * 1.3;
            const valign = effectiveVAlign(device.labelPosition || 'bottom', device.labelVAlign);
            const vOffset = getVAlignOffset(valign, device.spans.length, lineHeight);
            const svgX = device.x + anchor.x;
            const svgY = device.y + anchor.y + vOffset - fs;
            const anchorMiddle = anchor.anchor === 'middle';
            const textAlign = anchorMiddle ? 'center' : anchor.anchor === 'end' ? 'right' : 'left';
            startInlineEdit('device', device.id, device, 'label', svgX, svgY, fs, textAlign, anchorMiddle);
            return;
        }

        // Check for textbox
        const tb = state.textBoxes.find(t => {
            const r = textBoxRect(t);   // real measured size, not a 200px guess
            return point.x >= t.x && point.x <= t.x + r.w && point.y >= t.y && point.y <= t.y + r.h;
        });
        if (tb) {
            const fs = tb.fontSize || 20;
            const align = tb.textAlign || 'left';
            startInlineEdit('textbox', tb.id, tb, 'text', tb.x, tb.y, fs, align);
            return;
        }

        // Check for zone. Zones sit behind everything, so a connection crossing
        // one must stay annotatable: when a line is under the cursor, the zone
        // only claims the click if it lands on the zone's label text.
        const zone = state.zones.find(z => {
            const inRegion = point.x >= z.x && point.x <= z.x + z.w &&
                point.y >= z.y - 40 && point.y <= z.y + z.h + 40;
            if (!inRegion) return false;
            return !lineHit || inBBox(labelTextBBox(z, 'bottom'));
        });
        if (zone) {
            if (!zone.label) zone.label = '';
            if (!zone.spans) zone.spans = [[{ text: '', bold: false, italic: false }]];
            const fs = zone.fontSize || 20;
            const anchor = getLabelAnchor(zone.labelPosition || 'bottom', zone.w, zone.h, fs);
            const lineHeight = fs * 1.3;
            const valign = effectiveVAlign(zone.labelPosition || 'bottom', zone.labelVAlign);
            const vOffset = getVAlignOffset(valign, zone.spans.length, lineHeight);
            const svgX = zone.x + anchor.x;
            const svgY = zone.y + anchor.y + vOffset - fs;
            const anchorMiddle = anchor.anchor === 'middle';
            const textAlign = anchorMiddle ? 'center' : anchor.anchor === 'end' ? 'right' : 'left';
            startInlineEdit('zone', zone.id, zone, 'label', svgX, svgY, fs, textAlign, anchorMiddle);
            return;
        }

        // Check for connection annotation or line hit via coordinate-based testing.
        // resolveConnEndpoint (not findNode) so free-ended connections - those
        // drawn from/to empty canvas, with no device at an end - are annotatable.
        for (const conn of state.connections) {
            const startPt = resolveConnEndpoint(conn, 'from');
            const endPt = resolveConnEndpoint(conn, 'to');
            if (!startPt || !endPt) continue;
            const cPoints = connRoutePoints(conn, startPt, endPt);

            // Check if click is near an existing annotation
            if (conn.annotations && conn.annotations.length > 0) {
                let hitAnn = null;
                for (const ann of conn.annotations) {
                    const annPos = getPointAlongPath(cPoints, ann.position);
                    const dist = Math.sqrt((point.x - annPos.x) ** 2 + (point.y - annPos.y) ** 2);
                    if (dist < 30) {
                        hitAnn = ann;
                        break;
                    }
                }
                if (hitAnn) {
                    const annPos = getPointAlongPath(cPoints, hitAnn.position);
                    const annFs = hitAnn.fontSize || DEFAULT_FONT_SIZE;
                    if (!hitAnn.spans) hitAnn.spans = [[{ text: hitAnn.text || '', bold: false, italic: false }]];
                    // Hide just this annotation
                    const connNode = document.getElementById(conn.id);
                    if (connNode) {
                        connNode.querySelectorAll(`.connection-annotation[data-ann-id="${hitAnn.id}"], .connection-annotation-bg[data-ann-id="${hitAnn.id}"]`).forEach(el => el.style.display = 'none');
                    }
                    state.inlineEditing = {
                        type: 'annotation',
                        id: conn.id,
                        annotationId: hitAnn.id,
                        element: null,
                        labelField: 'text'
                    };
                    // Reuse startInlineEdit pattern but manually. Content
                    // coordinates - the editor scrolls with the container
                    // (see startInlineEdit).
                    const container = document.getElementById('canvas-container');
                    const z = state.zoom;
                    const pixelX = annPos.x * z;
                    const pixelY = (annPos.y - annFs) * z;
                    const div = document.createElement('div');
                    div.className = 'inline-editor';
                    div.contentEditable = 'true';
                    div.style.fontSize = (annFs * z) + 'px';
                    div.style.textAlign = 'center';
                    div.style.left = pixelX + 'px';
                    div.style.top = pixelY + 'px';
                    div.style.transform = 'translateX(-50%)';
                    const spans = hitAnn.spans || [[{ text: hitAnn.text || '', bold: false, italic: false }]];
                    div.innerHTML = spansToHTML(spans);
                    state.inlineEditing.element = div;
                    container.appendChild(div);
                    div.focus();
                    const sel = window.getSelection();
                    const range = document.createRange();
                    range.selectNodeContents(div);
                    sel.removeAllRanges();
                    sel.addRange(range);
                    div.addEventListener('keydown', (e) => {
                        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelInlineEdit(); }
                        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitInlineEdit(); }
                        else if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); e.stopPropagation(); document.execCommand('bold'); }
                        else if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); e.stopPropagation(); document.execCommand('italic'); }
                    });
                    div.addEventListener('blur', () => {
                        setTimeout(() => {
                            if (state.inlineEditing && state.inlineEditing.element === div) commitInlineEdit();
                        }, 100);
                    });
                    return;
                }
            }

            // Check if click is near the connection line itself (for creating new annotation)
            const nearest = getNearestT(cPoints, point.x, point.y);
            if (nearest.distance < 15) {
                // Check if this is near the main label area first
                if (conn.label) {
                    const mid = Math.floor(cPoints.length / 2);
                    let mx, my;
                    if (cPoints.length % 2 === 0) {
                        mx = (cPoints[mid - 1].x + cPoints[mid].x) / 2;
                        my = (cPoints[mid - 1].y + cPoints[mid].y) / 2;
                    } else {
                        mx = cPoints[mid].x;
                        my = cPoints[mid].y;
                    }
                    const fs = conn.fontSize || 20;
                    // Size the label target to the REAL label, not a fixed 60x30
                    // box: a wide/multi-line label used to overflow it, so a click
                    // on the visible text fell through and created a phantom empty
                    // annotation on top of the label. Keep the old box as a floor
                    // so small labels stay comfortably clickable.
                    const lSpans = conn.spans || [[{ text: conn.label, bold: false, italic: false }]];
                    const lHalfW = Math.max(60, measureSpansWidth(lSpans, fs, fontStackOf(conn)) / 2 + 8);
                    const lHalfH = Math.max(30, lSpans.length * fs * 1.3 / 2 + fs);
                    if (Math.abs(point.x - mx) < lHalfW && Math.abs(point.y - my) < lHalfH) {
                        if (!conn.spans) conn.spans = lSpans;
                        startInlineEdit('connection', conn.id, conn, 'label', mx, my - fs, fs, 'center', true);
                        return;
                    }
                }

                // Create new annotation at this position
                if (!conn.annotations) conn.annotations = [];
                const newAnn = {
                    id: genId(),
                    // Keep new annotations off the exact endpoints (same clamp
                    // the annotation drag uses), so an end-adjacent double-click
                    // doesn't drop text directly on an attachment point
                    position: Math.max(0.02, Math.min(0.98, nearest.t)),
                    text: '',
                    spans: [[{ text: '', bold: false, italic: false }]],
                    fontSize: DEFAULT_FONT_SIZE
                };
                pushUndo();
                conn.annotations.push(newAnn);
                renderConnection(conn);

                // Open inline editor for the new annotation
                const annPos = getPointAlongPath(cPoints, newAnn.position);
                const annFs = newAnn.fontSize;
                const connNode = document.getElementById(conn.id);
                if (connNode) {
                    connNode.querySelectorAll(`.connection-annotation[data-ann-id="${newAnn.id}"], .connection-annotation-bg[data-ann-id="${newAnn.id}"]`).forEach(el => el.style.display = 'none');
                }
                state.inlineEditing = {
                    type: 'annotation',
                    id: conn.id,
                    annotationId: newAnn.id,
                    element: null,
                    labelField: 'text'
                };
                const container = document.getElementById('canvas-container');
                const z = state.zoom;
                // Content coordinates - the editor scrolls with the container
                // (see startInlineEdit).
                const pixelX = annPos.x * z;
                const pixelY = (annPos.y - annFs) * z;
                const div = document.createElement('div');
                div.className = 'inline-editor';
                div.contentEditable = 'true';
                div.style.fontSize = (annFs * z) + 'px';
                div.style.textAlign = 'center';
                div.style.left = pixelX + 'px';
                div.style.top = pixelY + 'px';
                div.style.transform = 'translateX(-50%)';
                div.innerHTML = '';
                state.inlineEditing.element = div;
                container.appendChild(div);
                div.focus();
                div.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelInlineEdit(); }
                    else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitInlineEdit(); }
                    else if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); e.stopPropagation(); document.execCommand('bold'); }
                    else if ((e.ctrlKey || e.metaKey) && e.key === 'i') { e.preventDefault(); e.stopPropagation(); document.execCommand('italic'); }
                });
                div.addEventListener('blur', () => {
                    setTimeout(() => {
                        if (state.inlineEditing && state.inlineEditing.element === div) commitInlineEdit();
                    }, 100);
                });
                return;
            }
        }

        // Check for connection label via coordinate hit-testing (fallback for labels not near path)
        for (const conn of state.connections) {
            if (!conn.label) continue;
            const start = resolveConnEndpoint(conn, 'from');
            const end = resolveConnEndpoint(conn, 'to');
            if (!start || !end) continue;
            const points = connRoutePoints(conn, start, end);
            const mid = Math.floor(points.length / 2);
            let mx, my;
            if (points.length % 2 === 0) {
                mx = (points[mid - 1].x + points[mid].x) / 2;
                my = (points[mid - 1].y + points[mid].y) / 2;
            } else {
                mx = points[mid].x;
                my = points[mid].y;
            }
            const fs = conn.fontSize || 20;
            // Check if click is near the label midpoint
            if (Math.abs(point.x - mx) < 60 && Math.abs(point.y - my) < 30) {
                if (!conn.spans) conn.spans = [[{ text: conn.label, bold: false, italic: false }]];
                startInlineEdit('connection', conn.id, conn, 'label', mx, my - fs, fs, 'center', true);
                return;
            }
        }
    }

    window.addEventListener('beforeunload', (e) => {
        if (state.dirty && !EMBED) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // --- Embed hook (read-only hosts: the PingCanvas kiosk fork) -----------
    // Additive and inert unless called; the editor never touches it. Kept
    // deliberately tiny so embedders reuse the renderer without forking it:
    // load a diagram, fit it to the viewport, and read (not mutate) state.
    window.CrossCanvas = {
        // Load a parsed .xcanvas document (same path as File → Open).
        load: (data) => { applyDiagramData(data); },
        // Bounding box of all content in canvas units, or null when empty.
        contentBounds: () => {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            const add = (x, y, w, h) => {
                minX = Math.min(minX, x); minY = Math.min(minY, y);
                maxX = Math.max(maxX, x + w); maxY = Math.max(maxY, y + h);
            };
            state.devices.forEach(d => add(d.x, d.y, d.w, d.h));
            state.zones.forEach(z => add(z.x, z.y, z.w, z.h));
            state.images.forEach(im => add(im.x, im.y, im.w, im.h));
            state.textBoxes.forEach(tb => { const r = textBoxRect(tb); add(tb.x, tb.y, r.w, r.h); });
            if (minX === Infinity) return null;
            return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        },
        // Frame all content, centered, with a margin (canvas units). Drives the
        // SVG viewBox directly instead of the editor's zoom/scroll (which can't
        // center a small board - its canvas clamps to ~viewport size). The
        // viewBox is grown to the VIEWPORT's aspect ratio so nothing letterboxes
        // (no black bars), and the white bg + grid rects are re-anchored to fill
        // it edge-to-edge (the "infinite canvas" feel). Recenters on resize.
        fitToView: (margin) => {
            margin = margin == null ? 40 : margin;
            const b = window.CrossCanvas.contentBounds();
            if (!b) return;
            const container = document.getElementById('canvas-container');
            let w = b.w + margin * 2, h = b.h + margin * 2;
            const vpW = container.clientWidth, vpH = container.clientHeight;
            if (vpW > 0 && vpH > 0) {
                const vpAspect = vpW / vpH;
                if (w / h < vpAspect) { w = h * vpAspect; } else { h = w / vpAspect; }
            }
            const vbX = (b.x + b.w / 2) - w / 2, vbY = (b.y + b.h / 2) - h / 2;
            canvas.setAttribute('viewBox', `${vbX} ${vbY} ${w} ${h}`);
            canvas.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            canvas.style.width = '100%';
            canvas.style.height = '100%';
            // #canvas-bg (white) and #grid-overlay are anchored at (0,0) with
            // 100% size - fine for the editor's origin-anchored viewBox, but a
            // centered viewBox leaves them behind. Re-anchor to the viewBox window.
            ['canvas-bg', 'grid-overlay'].forEach(id => {
                const r = document.getElementById(id);
                if (r) {
                    r.setAttribute('x', vbX); r.setAttribute('y', vbY);
                    r.setAttribute('width', w); r.setAttribute('height', h);
                }
            });
        },
        devices: () => state.devices,
        zones: () => state.zones,
        zoom: () => state.zoom,
        svg: () => canvas,
        // --- Themes (for the kiosk's rotate-to-avoid-burn-in mode) ----------
        // theme() applies a theme's chrome vars exactly as the editor does.
        // persist defaults to FALSE here: an embedder cycling themes on a timer
        // must not stomp the operator's own saved editor preference.
        // NOTE it restyles CHROME + defaults-for-new-objects only; existing
        // devices/zones/connections keep their own colors (recolorAllToTheme is
        // the editor-side, undoable op for that and is deliberately NOT exposed
        // - it re-renders every layer, which would wipe a kiosk overlay's
        // in-place DOM patches).
        theme: (key, persist) => { applyTheme(key, persist === true); return key; },
        // Restyle EXISTING objects to the active theme (same op as the editor's
        // Recolor to Theme, same per-kind opts). Silent by default here: no undo
        // snapshot, no dirty flag, and the embedder never saves - the board file
        // on disk is untouched, only the in-memory copy is restyled.
        // CAUTION for embedders: this re-renders the device, zone and connection
        // layers, so any DOM an overlay patched in place is destroyed and its
        // cached element references go stale. Re-scan after calling.
        recolor: (opts) => {
            // Copy, never mutate the caller's object: an embedder that passes
            // the same opts every rotation would otherwise find it silently
            // gaining a `silent` key it never set.
            const o = Object.assign({ silent: true }, opts || {});
            recolorAllToTheme(o);
        },
        // [{ id, label, group, canvasDark }] - canvasDark is the theme's own
        // canvas color, so a host can background-match a theme without picking
        // hexes by hand. null on 'classic' (which clears rather than sets).
        themes: () => THEME_GROUPS.flatMap(([group, ids]) => ids.map(id => ({
            id,
            label: (THEMES[id] && THEMES[id].label) || id,
            group,
            canvasDark: (THEMES[id] && THEMES[id].chrome &&
                         THEMES[id].chrome['--se-canvas-dark']) || null
        }))).filter(t => THEMES[t.id])
    };
    // Pre-rename alias: kiosk layers built against window.NetDraw keep working
    // against a newer app.js during the CrossCanvas transition.
    window.NetDraw = window.CrossCanvas;

    loadImportedTemplates();
    loadBundledTemplates();
    // Theme startup already seeded the tint via a dispatched input event,
    // which armed the 120ms debounced palette re-render. This render uses
    // the seeded tint directly - cancel the pending one or every themed
    // launch tints all ~56 stencils twice and throws the first away.
    clearTimeout(tintPreviewTimer);
    renderDeviceList();
    updateCanvasSize();
    updateZoomLabel();
    // Startup content: restore autosaved work if present; otherwise show the
    // sample diagram once, on the first ever visit, so the canvas isn't blank.
    // Embed mode skips all of it - the host page loads its own content and a
    // kiosk must never block on a confirm() prompt.
    // CCTEST skips restore too: the prompt fires before tests.html can stub
    // confirm(), and a Cancel there would clearAutosave() the developer's slot.
    const restored = (EMBED || CCTEST) ? false : maybeRestoreAutosave();
    if (!restored && !EMBED) {
        let firstVisit = true;
        try { firstVisit = !localStorage.getItem('crosscanvas-visited'); } catch (e) { /* ignore */ }
        if (firstVisit) buildSampleDiagram();
    }
    if (!EMBED) { try { localStorage.setItem('crosscanvas-visited', '1'); } catch (e) { /* ignore */ } }

    // URL params for demos, docs, and screenshot tooling - shareable looks:
    //   ?theme=blueprint       apply a theme for this visit
    //   ?sample=small|complex  open a built-in sample (overrides autosave)
    //   ?board=<path>          open a hosted .xcanvas by same-origin URL
    //   ?recolor=1             then snap it to the theme (Recolor All)
    //   ?fit=1                 zoom to fit the whole diagram
    if (!EMBED) {
        const q = new URLSearchParams(location.search);
        const qTheme = q.get('theme');
        if (qTheme && THEMES[qTheme]) applyTheme(qTheme, false);   // for this visit only - don't overwrite the saved choice
        const qSample = q.get('sample');
        if (qSample === 'complex') buildComplexSampleDiagram();
        else if (qSample === 'small') buildSampleDiagram();
        const finishQuery = () => {
            if ((qSample || q.get('board')) && q.get('recolor') === '1') recolorAllToTheme();
            if (q.get('fit') === '1') window.CrossCanvas.fitToView(50);
        };
        const qBoard = q.get('board');
        let boardURL = null;
        if (qBoard) {
            // Same-origin only, enforced HERE: the CSP header exists only on
            // deployments that honor web.config, and "any static host" is a
            // supported layout - without this check a crafted cross-origin
            // ?board= link could render an attacker's diagram under our URL.
            try { boardURL = new URL(qBoard, location.href); } catch (e) { /* malformed */ }
            if (boardURL && boardURL.origin !== location.origin) boardURL = null;
        }
        if (qBoard && !boardURL) {
            alert('Board URLs must be same-origin: a path next to the app, like ?board=boards/lab.xcanvas');
        } else if (boardURL) {
            fetch(boardURL, { cache: 'no-store' })
                .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
                .then(data => { applyDiagramData(data); finishQuery(); })
                .catch(err => alert('Could not open board from URL: ' + err.message));
        } else {
            finishQuery();
        }
    }

    // --- Test hook (opt-in via ?cctest) ------------------------------------
    // Exposes internals for tests.html to drive. Gated on the URL param, which
    // normal use and the kiosk/EMBED build never carry, so it adds no surface
    // (and everything here is already in the page's own client-side state - no
    // boundary is crossed). Keeps the suite testing the REAL app in its real
    // DOM, zero build step, zero dependency - the app's own philosophy.
    if (location.search.indexOf('cctest') >= 0) {
        window.__cctest = {
            // pure helpers
            normalizeMAC, isValidIPv4, shortHostname, realHostname,
            textBoxRect, measureSpansWidth, fontStackOf, isSVGDataURL,
            lightenHex, darkenHex, getVAlignOffset, effectiveVAlign, getLabelAnchor,
            parseCSV, parseDelimited, guessMapTarget,
            // inventory / text parsers (string -> {records,skipped,name} | null)
            parseARPText, parseDnsmasqLeases, parseNmap, parseISCDhcpdLeases,
            parseAnsibleInventory, genericInventoryRecords,
            // pipeline (round-trip + theme regression)
            state, serializeDiagram, applyDiagramData, importGliffy,
            resetDocumentState, newDiagram, applyTheme, recolorAllToTheme,
            buildComplexSampleDiagram,
            // live theme constants for assertions
            consts: () => ({ STENCIL_FRAME_BLUE, DEFAULT_CONN_COLOR, DEFAULT_DEVICE_TINT,
                             DEFAULT_ZONE_FILL, DEFAULT_FONT_COLOR })
        };
    }
})();
